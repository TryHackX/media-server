export interface VisualizerFrame {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  analyser: AnalyserNode;
  frequency: Uint8Array<ArrayBuffer>;
  waveform: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  time: number;
  delta: number;
}

export interface VisualizerPlugin {
  id: string;
  label: string;
  fftSize?: number;
  smoothing?: number;
  render(frame: VisualizerFrame): void;
  reset?(): void;
}
