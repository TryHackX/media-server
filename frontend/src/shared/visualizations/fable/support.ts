/**
 * Whether this browser can draw the Fable visualizations: WebGL 2 with a float format to draw
 * into (the HDR pipeline). Asked once; Internal's list and the panel's search both go by it, so
 * neither offers a preset the other does not.
 */
let supported: boolean | null = null;

export function fableSupported(): boolean {
  if (supported !== null) return supported;
  supported = false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) {
      supported = Boolean(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
      // The probe's context is given back at once: browsers allow only so many.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    supported = false;
  }
  return supported;
}
