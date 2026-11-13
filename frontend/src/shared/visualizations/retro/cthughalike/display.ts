/**
 * Displays: how the 8-bit picture reaches the screen. As it is, mirrored left to right (the
 * originals' favourite: a picture drawn once, shown twice), turned over on the right, mirrored top
 * to bottom, both (four quarters), or folded eight ways like a kaleidoscope. The palette turns
 * values into colours on the way.
 *
 * The mirrors are written straight: each pixel of the part shown goes to its two or four places.
 * The kaleidoscope needs a map from screen pixel to picture pixel, made once per size.
 */

export type DisplayKind = "normal" | "mirror" | "mirrorFlip" | "mirrorDown" | "quad" | "kaleido";

export const DISPLAY_KINDS: readonly DisplayKind[] = ["normal", "mirror", "mirrorFlip", "mirrorDown", "quad", "kaleido"];

/** For each screen pixel, the picture pixel the kaleidoscope shows there. */
export function kaleidoMap(width: number, height: number): Int32Array {
  const map = new Int32Array(width * height);
  const halfX = width / 2;
  const halfY = height / 2;
  for (let y = 0; y < height; y += 1) {
    const v0 = Math.abs(y + 0.5 - halfY);
    for (let x = 0; x < width; x += 1) {
      // Distances from the centre, folded so the larger is across: the eight triangles of the
      // square about the centre all show the top left one (and the sides beyond it, mirrored).
      const u0 = Math.abs(x + 0.5 - halfX);
      const u = u0 > v0 ? u0 : v0;
      const v = u0 > v0 ? v0 : u0;
      let sx = Math.floor(halfX - u);
      let sy = Math.floor(halfY - v);
      if (sx < 0) sx = 0;
      if (sy < 0) sy = 0;
      map[y * width + x] = sy * width + sx;
    }
  }
  return map;
}

/** Which part of the picture a display shows: to draw where it will be seen. */
export function shownPart(kind: DisplayKind): { right: boolean; bottom: boolean } {
  switch (kind) {
    case "mirror":
    case "mirrorFlip":
      return { right: false, bottom: true };
    case "mirrorDown":
      return { right: true, bottom: false };
    case "quad":
    case "kaleido":
      return { right: false, bottom: false };
    default:
      return { right: true, bottom: true };
  }
}

/**
 * The picture through a display and a palette into `out` (both `width × height`). Works for
 * colours (Int32Array words) and for values (a Uint8Array with an identity palette) alike.
 * `kaleido` is kaleidoMap's for this size (needed for that display only).
 */
export function present(
  kind: DisplayKind, picture: Uint8Array, width: number, height: number,
  palette: ArrayLike<number>, out: Int32Array | Uint8Array, kaleido: Int32Array | null
): void {
  const halfX = width >> 1;
  const halfY = height >> 1;
  switch (kind) {
    case "mirror":
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < halfX; x += 1) {
          const colour = palette[picture[row + x]!]!;
          out[row + x] = colour;
          out[row + width - 1 - x] = colour;
        }
      }
      return;
    case "mirrorFlip":
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        const turned = (height - 1 - y) * width + width - 1;
        for (let x = 0; x < halfX; x += 1) {
          const colour = palette[picture[row + x]!]!;
          out[row + x] = colour;
          out[turned - x] = colour;
        }
      }
      return;
    case "mirrorDown":
      for (let y = 0; y < halfY; y += 1) {
        const row = y * width;
        const mirrored = (height - 1 - y) * width;
        for (let x = 0; x < width; x += 1) {
          const colour = palette[picture[row + x]!]!;
          out[row + x] = colour;
          out[mirrored + x] = colour;
        }
      }
      return;
    case "quad":
      for (let y = 0; y < halfY; y += 1) {
        const row = y * width;
        const mirrored = (height - 1 - y) * width;
        for (let x = 0; x < halfX; x += 1) {
          const colour = palette[picture[row + x]!]!;
          out[row + x] = colour;
          out[row + width - 1 - x] = colour;
          out[mirrored + x] = colour;
          out[mirrored + width - 1 - x] = colour;
        }
      }
      return;
    case "kaleido":
      if (kaleido) {
        for (let index = 0, count = width * height; index < count; index += 1) out[index] = palette[picture[kaleido[index]!]!]!;
        return;
      }
      break;
    default:
      break;
  }
  for (let index = 0, count = width * height; index < count; index += 1) out[index] = palette[picture[index]!]!;
}

/** 0…255 as itself: present() with it folds the values themselves. */
export const IDENTITY = Uint8Array.from({ length: 256 }, (_, index) => index);
