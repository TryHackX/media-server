/**
 * Not vendored: voltviz's AI beat tracking (the log-mel front end feeding an onnxruntime-web
 * model, ./neural upstream) is left out of this build. The Analyzer imports these names for that
 * path only; analysisCore.ts creates it with `neural: false`, so nothing here is ever built.
 */
export const N_MELS = 128;
export const MODEL_FPS = 50;

export class MelFrontend {
  readonly firstAvailableFrame = 0;

  constructor() {
    throw new Error("VoltViz: AI beat tracking is not part of this build");
  }

  reset(): void { /* never built */ }

  push(): void { /* never built */ }

  latestPadded(): number {
    return 0;
  }
}
