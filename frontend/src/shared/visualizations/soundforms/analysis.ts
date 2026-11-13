/**
 * The arithmetic of Formy dźwięku's listening (audio.ts), without imports so the tests run it as
 * it is (soundforms.test.ts).
 */

/**
 * Where `bands` bands from `minHz` to `maxHz`, spaced evenly on a logarithmic scale, begin and end,
 * in bins of `binHz` each (fractional): bands + 1 edges.
 */
export function bandEdges(bands: number, minHz: number, maxHz: number, binHz: number): Float32Array {
  const edges = new Float32Array(bands + 1);
  const ratio = maxHz / minHz;
  for (let band = 0; band <= bands; band += 1) edges[band] = (minHz * ratio ** (band / bands)) / binHz;
  return edges;
}

/**
 * One band of a byte spectrum (getByteFrequencyData) between two fractional bins, 0–1: a band
 * narrower than a bin reads between its two neighbours, a wider one mixes its loudest bin with
 * its mean. Treble is lifted a little (`position` 0–1 from bass to treble), since music has less
 * of it than the eye expects, and the result is curved so quiet bins stay low.
 */
export function bandValue(bytes: ArrayLike<number>, usable: number, from: number, to: number, position: number): number {
  const last = Math.max(0, Math.min(bytes.length, usable) - 1);
  let value: number;
  if (to - from < 1) {
    const center = Math.min(last, Math.max(0, (from + to) / 2));
    const below = Math.floor(center);
    const above = Math.min(last, below + 1);
    const fraction = center - below;
    value = ((bytes[below] ?? 0) * (1 - fraction) + (bytes[above] ?? 0) * fraction) / 255;
  } else {
    const first = Math.max(0, Math.min(last, Math.floor(from)));
    const end = Math.max(first, Math.min(last, Math.ceil(to) - 1));
    let peak = 0, sum = 0;
    for (let bin = first; bin <= end; bin += 1) {
      const byte = bytes[bin] ?? 0;
      peak = Math.max(peak, byte);
      sum += byte;
    }
    value = (peak * 0.5 + (sum / (end - first + 1)) * 0.5) / 255;
  }
  const lifted = value * (0.92 + 0.3 * position);
  const clamped = Math.min(1, Math.max(0, lifted));
  return clamped * clamped * (0.6 + 0.4 * clamped);
}

/**
 * The gain that brings music whose spectrum has lately averaged `loudness` (0–1) towards loud
 * music's ~0.34: none for loud music, at most 2.6× for the quietest. Silence times any gain is
 * still silence.
 */
export function autoGain(loudness: number): number {
  return Math.min(2.6, Math.max(1, 0.34 / Math.max(0.04, loudness)));
}

/** One step of a follower that rises with time constant `attack` and falls with `release` (s). */
export function envelope(previous: number, target: number, dt: number, attack: number, release: number): number {
  const time = target > previous ? attack : release;
  return previous + (target - previous) * (1 - Math.exp(-dt / Math.max(1e-4, time)));
}

/**
 * Where to start reading `length` samples so the waveform stands still on a steady tone: the
 * first rising zero crossing that leaves room for them, else the newest samples.
 */
export function triggerIndex(samples: ArrayLike<number>, length: number): number {
  const latest = samples.length - length;
  if (latest <= 0) return 0;
  for (let index = Math.max(1, latest - Math.floor(length / 2)); index <= latest; index += 1) {
    if ((samples[index - 1] ?? 0) < 0 && (samples[index] ?? 0) >= 0) return index;
  }
  return latest;
}
