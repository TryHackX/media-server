import { BLOCK_HEIGHT, BLOCK_WIDTH, blockGlyph } from "./font-block";
import { markStrokes, serifs, strokeGlyph, strokeMarks } from "./font-stroke";
import { fillContours, line, penStroke, stamp, type Picture } from "./raster";

/**
 * Writing into the picture: song titles in the stroke font (several faces), and the block font's
 * letters extruded into 3D and turned, as wireframes or solid. Both are drawn as palette values,
 * so they burn and flow with everything else.
 */

export type TextFace = "sans" | "bold" | "light" | "serif" | "mono" | "italic" | "boldItalic" | "wide";

export const TEXT_FACES: readonly TextFace[] = ["sans", "bold", "light", "serif", "mono", "italic", "boldItalic", "wide"];

interface Face {
  /** Pen radius, grid units. */
  pen: number;
  shear: number;
  /** Extra room between letters, grid units; a fixed pitch for the typewriter face. */
  spacing: number;
  pitch: number;
  serif: number;
  stretch: number;
}

const FACES: Record<TextFace, Face> = {
  sans: { pen: 0.72, shear: 0, spacing: 2.3, pitch: 0, serif: 0, stretch: 1 },
  bold: { pen: 1.15, shear: 0, spacing: 3, pitch: 0, serif: 0, stretch: 1.05 },
  light: { pen: 0.42, shear: 0, spacing: 2, pitch: 0, serif: 0, stretch: 1 },
  serif: { pen: 0.55, shear: 0, spacing: 2.6, pitch: 0, serif: 1.3, stretch: 1 },
  mono: { pen: 0.45, shear: 0, spacing: 0, pitch: 9.5, serif: 1.4, stretch: 1 },
  italic: { pen: 0.65, shear: 0.24, spacing: 2.3, pitch: 0, serif: 0, stretch: 1 },
  boldItalic: { pen: 1.05, shear: 0.22, spacing: 2.9, pitch: 0, serif: 0, stretch: 1.05 },
  wide: { pen: 0.7, shear: 0, spacing: 3.2, pitch: 0, serif: 0, stretch: 1.45 }
};

export interface TextMask {
  mask: Uint8Array;
  width: number;
  height: number;
}

/** The width a text takes in grid units in a face. */
export function textUnits(text: string, face: TextFace): number {
  const style = FACES[face];
  let units = 0;
  for (const char of text) {
    if (style.pitch) {
      units += style.pitch;
      continue;
    }
    const glyph = strokeGlyph(char);
    units += glyph ? (glyph.right - glyph.left) * style.stretch + style.spacing + style.pen * 2 : 4.5;
  }
  return units;
}

/**
 * A text as a coverage mask, capitals `cap` pixels tall. Its baseline is 11 grid units below the
 * top of the mask; descenders fit below.
 */
export function textMask(text: string, face: TextFace, cap: number): TextMask {
  const style = FACES[face];
  const scale = cap / 10;
  const margin = 2;
  const units = textUnits(text, face) + Math.abs(style.shear) * 13;
  const width = Math.max(1, Math.ceil(units * scale + margin * 2 + style.pen * 2 * scale));
  const height = Math.max(1, Math.ceil(15 * scale + margin * 2));
  const mask = new Uint8Array(width * height);
  const radius = Math.max(0.6, style.pen * scale);
  const baseline = margin + 11 * scale;
  let cursor = 0;
  const place = (x: number, y: number): [number, number] => [
    margin + radius + (x + style.shear * (y + 1)) * scale,
    baseline - y * scale
  ];
  for (const char of text) {
    const glyph = strokeGlyph(char);
    if (!glyph) {
      cursor += style.pitch || 4.5;
      continue;
    }
    const glyphWidth = (glyph.right - glyph.left) * style.stretch;
    const offset = style.pitch ? cursor + (style.pitch - glyphWidth) / 2 : cursor + style.pen;
    // Accents over (or under) the letter they belong to; capitals and tall letters carry them higher.
    const marks = strokeMarks(char);
    const top = /[A-Z0-9bdfhklt]/.test(char.normalize("NFD")[0] ?? "") ? 10 : 7;
    const accents = marks.flatMap((mark) => markStrokes(mark, glyph.left, glyph.right, top));
    const strokes = [...glyph.strokes, ...(style.serif ? serifs(glyph, style.serif) : []), ...accents];
    for (const stroke of strokes) {
      const count = stroke.length >> 1;
      if (count === 1) {
        const [x, y] = place(offset + (stroke[0]! - glyph.left) * style.stretch, stroke[1]!);
        penStroke(mask, width, height, x, y, x, y, radius);
      }
      for (let k = 0; k + 1 < count; k += 1) {
        const [x0, y0] = place(offset + (stroke[k * 2]! - glyph.left) * style.stretch, stroke[k * 2 + 1]!);
        const [x1, y1] = place(offset + (stroke[k * 2 + 2]! - glyph.left) * style.stretch, stroke[k * 2 + 3]!);
        penStroke(mask, width, height, x0, y0, x1, y1, radius);
      }
    }
    cursor += style.pitch || glyphWidth + style.spacing + style.pen * 2;
  }
  return { mask, width, height };
}

/** A text into the picture with its left end at `left` and its middle at `middle`. */
export function writeText(picture: Picture, text: string, face: TextFace, cap: number, left: number, middle: number, value: number): TextMask {
  const mask = textMask(text, face, cap);
  stamp(picture, mask.mask, mask.width, mask.height, left, middle - mask.height / 2, value);
  return mask;
}

export interface LetterPose {
  /** Turns about the upright, the across and the viewing axes (radians). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Where the letter's middle is, and how tall it stands (pixels). */
  x: number;
  y: number;
  size: number;
  /** Extrusion depth in grid units, and the camera's distance (in letter heights). */
  depth: number;
  distance: number;
}

export type LetterStyle = "wire" | "solid";

/**
 * One block letter in 3D: its outline extruded `depth` deep, turned, seen in perspective. As a
 * wireframe (front and back outlines and the edges joining them) or solid (the sides and the
 * face towards the camera filled, darker as they turn from the light, the outline on top).
 * Returns false when the font has no such letter.
 */
export function drawBlockLetter(picture: Picture, char: string, pose: LetterPose, style: LetterStyle, value: number, fill: number): boolean {
  const contours = blockGlyph(char);
  if (!contours) return false;
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const cr = Math.cos(pose.roll);
  const sr = Math.sin(pose.roll);
  const unit = pose.size / BLOCK_HEIGHT;
  const distance = pose.distance * BLOCK_HEIGHT;
  const half = pose.depth / 2;
  // Each contour's front and back points, projected: [x, y, depth] per point.
  const project = (gx: number, gy: number, gz: number): [number, number, number] => {
    let x = gx - BLOCK_WIDTH / 2;
    let y = gy - BLOCK_HEIGHT / 2;
    let z = gz;
    // roll, then yaw, then pitch
    let t = x * cr - y * sr;
    y = x * sr + y * cr;
    x = t;
    t = x * cy + z * sy;
    z = -x * sy + z * cy;
    x = t;
    t = y * cp - z * sp;
    z = y * sp + z * cp;
    y = t;
    const perspective = distance / Math.max(0.5, distance + z);
    return [pose.x + x * unit * perspective, pose.y - y * unit * perspective, z];
  };
  const fronts: [number, number, number][][] = [];
  const backs: [number, number, number][][] = [];
  for (const contour of contours) {
    const front: [number, number, number][] = [];
    const back: [number, number, number][] = [];
    for (let k = 0; k < contour.length; k += 2) {
      front.push(project(contour[k]!, contour[k + 1]!, -half));
      back.push(project(contour[k]!, contour[k + 1]!, half));
    }
    fronts.push(front);
    backs.push(back);
  }
  if (style === "solid") {
    // The sides, far ones first, each shaded by how squarely it faces the viewer.
    const sides: { depth: number; points: number[]; shade: number }[] = [];
    for (let c = 0; c < fronts.length; c += 1) {
      const front = fronts[c]!;
      const back = backs[c]!;
      for (let k = 0; k < front.length; k += 1) {
        const n = (k + 1) % front.length;
        const quad = [front[k]!, front[n]!, back[n]!, back[k]!];
        const area = quad.reduce((sum, p, i) => {
          const q = quad[(i + 1) % 4]!;
          return sum + p[0] * q[1] - q[0] * p[1];
        }, 0);
        const edge = Math.hypot(front[n]![0] - front[k]![0], front[n]![1] - front[k]![1]);
        const depthOfSide = Math.hypot(back[k]![0] - front[k]![0], back[k]![1] - front[k]![1]);
        const shade = Math.min(1, Math.abs(area) / Math.max(1, edge * Math.max(1, depthOfSide)) * 0.9 + 0.25);
        sides.push({ depth: quad.reduce((sum, p) => sum + p[2], 0), points: quad.flatMap((p) => [p[0], p[1]]), shade });
      }
    }
    sides.sort((a, b) => b.depth - a.depth);
    for (const side of sides) fillContours(picture, [side.points], Math.max(1, Math.round(fill * side.shade)));
    // The face nearer the camera.
    const frontDepth = fronts.flat().reduce((sum, p) => sum + p[2], 0);
    const backDepth = backs.flat().reduce((sum, p) => sum + p[2], 0);
    const face = frontDepth <= backDepth ? fronts : backs;
    fillContours(picture, face.map((points) => points.flatMap((p) => [p[0], p[1]])), fill);
    for (const points of face) {
      for (let k = 0; k < points.length; k += 1) {
        const a = points[k]!;
        const b = points[(k + 1) % points.length]!;
        line(picture, a[0], a[1], b[0], b[1], value);
      }
    }
    return true;
  }
  for (let c = 0; c < fronts.length; c += 1) {
    const front = fronts[c]!;
    const back = backs[c]!;
    for (let k = 0; k < front.length; k += 1) {
      const n = (k + 1) % front.length;
      line(picture, front[k]![0], front[k]![1], front[n]![0], front[n]![1], value);
      line(picture, back[k]![0], back[k]![1], back[n]![0], back[n]![1], value);
      line(picture, front[k]![0], front[k]![1], back[k]![0], back[k]![1], value);
    }
  }
  return true;
}
