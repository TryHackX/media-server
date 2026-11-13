/**
 * The player's AudioContext runs at the output device's rate: 44.1 or 48 kHz on most machines,
 * 96 or 192 kHz on some. Every visualizer was tuned at 44.1/48 kHz — a window of N samples,
 * N/2 bins reaching ~22 kHz — and read at 192 kHz the same N samples are a quarter of that
 * window (AVS's oscilloscope showed 3 ms instead of Winamp's 13), while the audible part of the
 * spectrum filled the first quarter of the bins and the rest was empty.
 *
 * So a faster context is read as if it ran at 44.1/48 kHz: an analyser `factor` times longer,
 * its waveform averaged down by `factor`, and only its first 1/factor bins — the same window
 * and the same bins a 44.1/48 kHz context would give. What is heard is not touched; the factor
 * is 1 at 44.1 and 48 kHz, where everything stays as it was. (voltviz does the same in its own
 * audio/host/rate.ts.)
 */
export function rateFactor(sampleRate: number): number {
  let factor = 1;
  while (sampleRate / (factor * 2) >= 44100) factor *= 2;
  return factor;
}

/** The longest window an AnalyserNode takes. */
const MAX_FFT = 32768;

/** The analyser length that gives `nominal` samples at the visualizers' rate. */
export function scaledFftSize(nominal: number, factor: number): number {
  return Math.min(MAX_FFT, nominal * factor);
}

/**
 * `out.length` samples from the newest `out.length * factor` of `source`, each the mean of
 * `factor` neighbours (a box filter, enough to keep what lies above 22 kHz out of a picture).
 */
export function decimate<T extends Uint8Array | Float32Array>(source: T, factor: number, out: T): T {
  const count = out.length;
  const start = Math.max(0, source.length - count * factor);
  if (factor <= 1) {
    out.set(source.subarray(start, start + count));
    return out;
  }
  const bytes = out instanceof Uint8Array;
  for (let index = 0; index < count; index += 1) {
    const from = start + index * factor;
    let sum = 0;
    for (let step = 0; step < factor; step += 1) sum += source[from + step] ?? 0;
    out[index] = bytes ? Math.round(sum / factor) : sum / factor;
  }
  return out;
}

/** Left, right and their mean, `samples` each, 0–255 like getByteTimeDomainData. */
export interface StereoSamples {
  mono: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

/**
 * Left and right of `source`'s signal at the visualizers' rate: two analysers `factor` times
 * longer behind a channel splitter (as butterchurn splits its own), read down to `samples`;
 * the middle is their mean, as an analyser mixes stereo down.
 */
export function stereoTap(source: AudioNode, samples: number, factor: number): {
  read(): StereoSamples;
  disconnect(): void;
} {
  const context = source.context;
  const span = scaledFftSize(samples, factor);
  const splitter = context.createChannelSplitter(2);
  const channel = (): AnalyserNode => {
    const node = context.createAnalyser();
    node.fftSize = span;
    node.smoothingTimeConstant = 0;
    return node;
  };
  const leftNode = channel();
  const rightNode = channel();
  source.connect(splitter);
  splitter.connect(leftNode, 0);
  splitter.connect(rightNode, 1);
  const rawLeft = new Uint8Array(new ArrayBuffer(span));
  const rawRight = new Uint8Array(new ArrayBuffer(span));
  const out: StereoSamples = {
    mono: new Uint8Array(new ArrayBuffer(samples)),
    left: new Uint8Array(new ArrayBuffer(samples)),
    right: new Uint8Array(new ArrayBuffer(samples))
  };
  return {
    read(): StereoSamples {
      leftNode.getByteTimeDomainData(rawLeft);
      rightNode.getByteTimeDomainData(rawRight);
      decimate(rawLeft, factor, out.left);
      decimate(rawRight, factor, out.right);
      for (let index = 0; index < samples; index += 1) {
        out.mono[index] = (out.left[index]! + out.right[index]! + 1) >> 1;
      }
      return out;
    },
    disconnect(): void {
      source.disconnect(splitter);
      splitter.disconnect();
    }
  };
}

/**
 * The context as a visualizer that sets its bands from `sampleRate` should see it when it is
 * handed samples read down: the rate they are at. Everything else is the context itself.
 */
export function atRate(context: BaseAudioContext, factor: number): BaseAudioContext {
  return new Proxy(context, {
    get(target, key) {
      if (key === "sampleRate") return target.sampleRate / factor;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}
