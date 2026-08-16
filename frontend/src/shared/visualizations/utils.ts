import type { VisualizerFrame } from "./types";

export function amplitude(values: Uint8Array, from = 0, to = values.length): number {
  const end = Math.min(values.length, Math.max(from + 1, to));
  let total = 0;
  for (let index = from; index < end; index += 1) total += values[index] ?? 0;
  return total / (end - from) / 255;
}

export function frequencyValue(
  frame: Pick<VisualizerFrame, "analyser" | "frequency">,
  progress: number,
  minHz = 35,
  maxHz = 16000
): number {
  const nyquist = frame.analyser.context.sampleRate / 2;
  const upper = Math.max(minHz + 1, Math.min(maxHz, nyquist));
  const ratio = Math.max(0, Math.min(1, progress));
  const frequency = minHz * Math.pow(upper / minHz, ratio);
  const exact = frequency / nyquist * Math.max(0, frame.frequency.length - 1);
  const lower = Math.max(0, Math.min(frame.frequency.length - 1, Math.floor(exact)));
  const upperIndex = Math.min(frame.frequency.length - 1, lower + 1);
  const blend = exact - lower;
  return (((frame.frequency[lower] ?? 0) * (1 - blend)) + ((frame.frequency[upperIndex] ?? 0) * blend)) / 255;
}

export function frequencyAverage(
  frame: Pick<VisualizerFrame, "analyser" | "frequency">,
  minHz = 35,
  maxHz = 16000
): number {
  const nyquist = frame.analyser.context.sampleRate / 2;
  const from = Math.max(0, Math.floor(minHz / nyquist * frame.frequency.length));
  const to = Math.min(frame.frequency.length, Math.max(from + 1, Math.ceil(maxHz / nyquist * frame.frequency.length)));
  return amplitude(frame.frequency, from, to);
}

export function clear(frame: VisualizerFrame, inner: string, outer = "#03060a"): void {
  const { context, width, height } = frame;
  const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.72);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

export function title(frame: VisualizerFrame, label: string): void {
  frame.context.font = "700 12px system-ui, sans-serif";
  frame.context.fillStyle = "rgb(255 255 255 / 72%)";
  frame.context.textAlign = "center";
  frame.context.fillText(label.toUpperCase(), frame.width / 2, 24);
}

export function seeded(index: number, salt = 1): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export function hsla(hue: number, alpha: number, lightness = 62): string {
  return `hsla(${hue % 360}, 92%, ${lightness}%, ${Math.max(0, Math.min(1, alpha))})`;
}
