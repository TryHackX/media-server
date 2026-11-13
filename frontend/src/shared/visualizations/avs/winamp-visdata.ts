/**
 * The audio Winamp handed its vis plugins, and what AVS 2.81 made of it — byte for byte.
 *
 * Winamp built every vis frame from one block of the decoder's 16-bit PCM, each channel on
 * its own (vsa_addpcmdata in VIS.cpp of the Winamp 5 source published in 2024, read for its
 * arithmetic only; the code below is written from that description):
 * - **waveform:** 576 signed bytes, the top byte of each sample;
 * - **spectrum:** 576 bytes from the top bytes of the block's first 512 samples:
 *   - a DC blocker, y = x − x₁ + 0.99·y₁ (from rest at the block's start),
 *   - a Hann window, 0.5 − 0.5·cos(2πn/511),
 *   - a 512-point real FFT without scaling,
 *   - |X[k]| / 16 capped at 255 for the bins 0…255, bin 0 taking DC and Nyquist together,
 *   - each bin written twice, the first time halfway from the bin before it (0 before bin
 *     0), and the last 64 bytes halving the top bin again and again,
 *   - rounded to the nearest integer, halves to the even one (the x87's fistp).
 *
 * AVS 2.81 then put every spectrum byte through a log table (main.cpp, g_logtab): a byte x
 * becomes (int)(255 · log(1 + 60x/255) / log 60), so quiet partials stand far higher than a
 * linear scale would put them.
 *
 * Pure (no imports), so the tests load it with plain Node.
 */

/** The bytes per channel and kind that a vis plugin got. */
export const AVS_SAMPLES = 576;
const FFT_SIZE = 512;

/** AVS 2.81's spectrum table: 255 · log(1 + 60x/255) / log 60, cut to an integer. */
export const AVS_LOG_TABLE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  for (let x = 0; x < 256; x += 1) {
    const t = Math.trunc((Math.log((x * 60) / 255 + 1) / Math.log(60)) * 255);
    table[x] = t < 0 ? 0 : t > 255 ? 255 : t;
  }
  return table;
})();

const HANN = (() => {
  const window = new Float32Array(FFT_SIZE);
  for (let n = 0; n < FFT_SIZE; n += 1) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1));
  return window;
})();

const BIT_REVERSED = (() => {
  const order = new Uint16Array(FFT_SIZE);
  for (let i = 0, j = 0; i < FFT_SIZE; i += 1) {
    order[i] = j;
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  return order;
})();

const COS = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / FFT_SIZE));
const SIN = Float64Array.from({ length: FFT_SIZE / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / FFT_SIZE));

/** In place: the unscaled DFT of `re` (+ i·`im`), radix 2. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const j = BIT_REVERSED[i]!;
    if (i < j) {
      const r = re[i]!;
      re[i] = re[j]!;
      re[j] = r;
      const m = im[i]!;
      im[i] = im[j]!;
      im[j] = m;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = COS[k * step]!;
        const wi = SIN[k * step]!;
        const a = start + k;
        const b = a + half;
        const vr = re[b]! * wr - im[b]! * wi;
        const vi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - vr;
        im[b] = im[a]! - vi;
        re[a] = re[a]! + vr;
        im[a] = im[a]! + vi;
      }
    }
  }
}

/** The x87's fistp in its default mode, for the non-negative values here: halves to even. */
const nearestEven = (value: number): number => {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
};

const f = Math.fround;
const POLE = f(0.99);

/** A float sample (−1…1) as the top byte of the 16-bit PCM a decoder gave Winamp: −128…127. */
export function pcmTopByte(sample: number): number {
  let pcm = Math.floor(sample * 32768 + 0.5);
  if (!(pcm >= -32768)) pcm = -32768; // NaN too
  else if (pcm > 32767) pcm = 32767;
  return pcm >> 8;
}

const scratchRe = new Float64Array(FFT_SIZE);
const scratchIm = new Float64Array(FFT_SIZE);

/**
 * Winamp's 576 spectrum bytes (before AVS's log table) from a block's top bytes (at least
 * 512 of them, −128…127).
 */
export function winampSpectrum(top: ArrayLike<number>, out: Uint8Array): Uint8Array {
  let x1 = 0;
  let y1 = 0;
  for (let n = 0; n < FFT_SIZE; n += 1) {
    const x = top[n] ?? 0;
    const y = f(f(x - x1) + f(POLE * y1));
    y1 = y;
    x1 = x;
    scratchRe[n] = f(y * HANN[n]!);
    scratchIm[n] = 0;
  }
  fft(scratchRe, scratchIm);
  let at = 0;
  let previous = 0;
  for (let k = 0; k < FFT_SIZE / 2; k += 1) {
    // Bin 0 sits beside the Nyquist term in the packed real FFT, and is read as a pair with it.
    const a = f(scratchRe[k]!);
    const b = f(k === 0 ? scratchRe[FFT_SIZE / 2]! : scratchIm[k]!);
    let value = f(f(Math.sqrt(f(f(a * a) + f(b * b)))) / 16);
    // min(value, 255) in single precision, the branchless way Winamp computed it.
    let t = f(255 - value);
    t = f(t + Math.abs(t));
    t = f(t * 0.5);
    value = f(255 - t);
    out[at++] = nearestEven(f(f(value + previous) / 2)) & 255;
    out[at++] = nearestEven(value) & 255;
    previous = value;
  }
  while (at < AVS_SAMPLES) {
    previous = f(previous / 2);
    out[at++] = nearestEven(previous) & 255;
  }
  return out;
}

/** AVS's visdata of one frame: [left, right] of each kind. */
export interface AvsVisdata {
  /** Winamp's spectrum through AVS 2.81's log table: 0…255. */
  spectrum: [Uint8Array, Uint8Array];
  /** Winamp's waveform: −128…127. */
  waveform: [Int8Array, Int8Array];
  /**
   * When made with createVisdata(true): the WebAssembly memory the four arrays are views of, at
   * VISDATA_OFFSETS (preset code compiled to WebAssembly reads getosc/getspec from it directly).
   */
  memory?: WebAssembly.Memory;
}

/** Byte offsets of the arrays in a visdata memory: spectrum left, right, waveform left, right. */
export const VISDATA_OFFSETS = [0, AVS_SAMPLES, 2 * AVS_SAMPLES, 3 * AVS_SAMPLES] as const;

/**
 * Visdata arrays for one frame at a time. `shared`: views of one page of WebAssembly memory
 * (`memory`, VISDATA_OFFSETS), where the engine can have them; plain arrays otherwise.
 */
export function createVisdata(shared = false): AvsVisdata {
  if (shared && typeof WebAssembly === "object") {
    try {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
      const buffer = memory.buffer;
      return {
        spectrum: [new Uint8Array(buffer, VISDATA_OFFSETS[0], AVS_SAMPLES), new Uint8Array(buffer, VISDATA_OFFSETS[1], AVS_SAMPLES)],
        waveform: [new Int8Array(buffer, VISDATA_OFFSETS[2], AVS_SAMPLES), new Int8Array(buffer, VISDATA_OFFSETS[3], AVS_SAMPLES)],
        memory
      };
    } catch {
      // no memory to be had: plain arrays
    }
  }
  return {
    spectrum: [new Uint8Array(AVS_SAMPLES), new Uint8Array(AVS_SAMPLES)],
    waveform: [new Int8Array(AVS_SAMPLES), new Int8Array(AVS_SAMPLES)]
  };
}

/**
 * One frame's visdata from the newest 576 samples of each channel (−1…1, oldest first): the
 * waveform as Winamp's bytes, the spectrum as Winamp's bytes through AVS's log table.
 */
export function avsVisdataFrom(left: ArrayLike<number>, right: ArrayLike<number>, out: AvsVisdata): AvsVisdata {
  const channels = [left, right];
  for (let channel = 0; channel < 2; channel += 1) {
    const samples = channels[channel]!;
    const wave = out.waveform[channel]!;
    for (let index = 0; index < AVS_SAMPLES; index += 1) wave[index] = pcmTopByte(samples[index] ?? 0);
    const spectrum = winampSpectrum(wave, out.spectrum[channel]!);
    for (let index = 0; index < AVS_SAMPLES; index += 1) spectrum[index] = AVS_LOG_TABLE[spectrum[index]!]!;
  }
  return out;
}

/**
 * AVS's centre channel as its effects build it (r_simple.cpp, r_sscope.cpp, r_oscstar.cpp,
 * r_oscring.cpp, r_timescope.cpp): `visdata[0][x]/2 + visdata[1][x]/2` on C's signed chars,
 * kept as an unsigned byte. Right for the waveform; for the spectrum a byte from 128 up is
 * negative there, so channels on either side of 128 meet wrongly (200 and 50 give 253),
 * exactly as AVS drew it. Returns raw bytes, as `fa_data` read them.
 */
export function avsCenter(left: ArrayLike<number>, right: ArrayLike<number>, out: Uint8Array): Uint8Array {
  for (let index = 0; index < AVS_SAMPLES; index += 1) {
    const a = ((left[index] ?? 0) << 24) >> 24;
    const b = ((right[index] ?? 0) << 24) >> 24;
    out[index] = (Math.trunc(a / 2) + Math.trunc(b / 2)) & 255;
  }
  return out;
}

/**
 * getspec() and getosc() in code (avs_eelif.cpp, getvis): `band` and `width` in 0…1 of the
 * 576 values (at least one value, centred, cut at the ends), channel 0 (both), 1 (left) or
 * 2 (right), anything else 0.
 * - getspec: the mean byte / 255 (both channels: their sum / 255 / 2, which is the mean too);
 * - getosc: one channel's mean / 127.5, both channels' sum / 255 (−0.5…0.5 each).
 */
export function avsGetvis(visdata: AvsVisdata, waveform: boolean, band: number, width: number, channel: number): number {
  const which = cInt(channel + 0.5);
  if (which !== 0 && which !== 1 && which !== 2) return 0;
  let bw = cInt(width * AVS_SAMPLES);
  let bc = cInt(band * AVS_SAMPLES);
  if (bw < 1) bw = 1;
  bc -= Math.trunc(bw / 2);
  if (bc < 0) {
    bw += bc;
    bc = 0;
  }
  if (bc > AVS_SAMPLES - 1) bc = AVS_SAMPLES - 1;
  if (bc + bw > AVS_SAMPLES) bw = AVS_SAMPLES - bc;
  const kind = waveform ? visdata.waveform : visdata.spectrum;
  let accum = 0;
  if (which === 0) {
    for (let x = 0; x < bw; x += 1) accum += (kind[0][bc + x] ?? 0) + (kind[1][bc + x] ?? 0);
    const value = accum / (bw * 255);
    return waveform ? value : value * 0.5;
  }
  const data = kind[which - 1]!;
  for (let x = 0; x < bw; x += 1) accum += data[bc + x] ?? 0;
  const value = accum / (bw * 127.5);
  return waveform ? value : value * 0.5;
}

/** C's (int) of a double on x86: truncated, and 0x80000000 when out of range or NaN. */
function cInt(value: number): number {
  return value > -2147483649 && value < 2147483648 ? Math.trunc(value) : -2147483648;
}
