/**
 * Not upstream: voltviz's analysis and its visualizations are tuned for an AudioContext at
 * 44.1 or 48 kHz (fixed FFT lengths, fixed spectrum bins). The player's context runs at the
 * output device's rate, which can be 96 or 192 kHz; read as it is, the audible spectrum then
 * fills only the first half or quarter of every bin array. So a faster context is read as if
 * it ran at 44.1/48 kHz: the analysis gets the signal decimated by this factor
 * (analysisCore.ts), the display analysers an FFT this many times longer of which only the
 * audible part is handed out, and waveforms of the same duration (analyserPool.ts).
 * At 44.1 and 48 kHz the factor is 1 and everything is exactly upstream's.
 */
export function rateFactor(sampleRate: number): number {
  let factor = 1;
  while (sampleRate / (factor * 2) >= 44100) factor *= 2;
  return factor;
}
