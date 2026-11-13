/**
 * Drawing into the 8-bit picture of the Cthugha-like scenes: points, lines, circles, filled
 * outlines and soft pen strokes. A pixel holds a palette value (0–255); drawing sets it, as the
 * originals' waves did, so the newest line is sharp on top of the burning trails.
 */

export interface Picture {
  readonly width: number;
  readonly height: number;
  /** `width × height` values, plus one at the end that stays 0. */
  readonly data: Uint8Array;
}

export function makePicture(width: number, height: number): Picture {
  return { width, height, data: new Uint8Array(width * height + 1) };
}

export function plot(picture: Picture, x: number, y: number, value: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= picture.width || py >= picture.height) return;
  picture.data[py * picture.width + px] = value;
}

/** A point `size` pixels across (1–4), centred. */
export function dot(picture: Picture, x: number, y: number, value: number, size: number): void {
  if (size <= 1) {
    plot(picture, x, y, value);
    return;
  }
  const from = -Math.floor((size - 1) / 2);
  const px = Math.round(x);
  const py = Math.round(y);
  for (let dy = from; dy < from + size; dy += 1) {
    const yy = py + dy;
    if (yy < 0 || yy >= picture.height) continue;
    for (let dx = from; dx < from + size; dx += 1) {
      const xx = px + dx;
      if (xx >= 0 && xx < picture.width) picture.data[yy * picture.width + xx] = value;
    }
  }
}

/** True when a segment can touch the picture at all. */
function touches(picture: Picture, x0: number, y0: number, x1: number, y1: number): boolean {
  return !((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= picture.width && x1 >= picture.width) || (y0 >= picture.height && y1 >= picture.height));
}

/** A line of one value, from (x0, y0) to (x1, y1) both included. */
export function line(picture: Picture, x0: number, y0: number, x1: number, y1: number, value: number): void {
  lineShaded(picture, x0, y0, x1, y1, value, value);
}

/** A line whose value runs from `from` to `to` along it. */
export function lineShaded(picture: Picture, x0: number, y0: number, x1: number, y1: number, from: number, to: number): void {
  if (!Number.isFinite(x0 + y0 + x1 + y1) || !touches(picture, x0, y0, x1, y1)) return;
  const { width, height, data } = picture;
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  const steps = Math.max(dx, -dy);
  // A runaway segment (a projection gone to infinity) is cut short rather than walked.
  if (steps > 4 * (width + height)) return;
  let error = dx + dy;
  const slope = steps > 0 ? (to - from) / steps : 0;
  let value = from;
  for (let step = 0; step <= steps; step += 1) {
    if (ax >= 0 && ay >= 0 && ax < width && ay < height) data[ay * width + ax] = value;
    value += slope;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      ax += sx;
    }
    if (twice <= dx) {
      error += dx;
      ay += sy;
    }
  }
}

/** Joined lines through `points` (x0, y0, x1, y1, …); `closed` joins the last to the first. */
export function polyline(picture: Picture, points: ArrayLike<number>, count: number, value: number, closed: boolean): void {
  for (let k = 0; k + 1 < count; k += 1) {
    line(picture, points[k * 2]!, points[k * 2 + 1]!, points[k * 2 + 2]!, points[k * 2 + 3]!, value);
  }
  if (closed && count > 2) line(picture, points[(count - 1) * 2]!, points[(count - 1) * 2 + 1]!, points[0]!, points[1]!, value);
}

/** A circle's outline. */
export function circle(picture: Picture, cx: number, cy: number, radius: number, value: number): void {
  const segments = Math.max(12, Math.min(160, Math.round(radius * 1.2)));
  let px = cx + radius;
  let py = cy;
  for (let k = 1; k <= segments; k += 1) {
    const angle = (2 * Math.PI * k) / segments;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    line(picture, px, py, x, y, value);
    px = x;
    py = y;
  }
}

/** A filled disc. */
export function disc(picture: Picture, cx: number, cy: number, radius: number, value: number): void {
  const { width, height, data } = picture;
  const top = Math.max(0, Math.ceil(cy - radius));
  const bottom = Math.min(height - 1, Math.floor(cy + radius));
  for (let y = top; y <= bottom; y += 1) {
    const half = Math.sqrt(Math.max(0, radius * radius - (y - cy) * (y - cy)));
    const from = Math.max(0, Math.ceil(cx - half));
    const to = Math.min(width - 1, Math.floor(cx + half));
    if (to >= from) data.fill(value, y * width + from, y * width + to + 1);
  }
}

/**
 * Outlines filled by the even-odd rule (holes stay open): each contour a flat list x0, y0, x1, …
 * Pixels whose centres are inside get `value`.
 */
export function fillContours(picture: Picture, contours: readonly ArrayLike<number>[], value: number): void {
  const { width, height, data } = picture;
  let top = Infinity;
  let bottom = -Infinity;
  for (const contour of contours) {
    for (let k = 1; k < contour.length; k += 2) {
      top = Math.min(top, contour[k]!);
      bottom = Math.max(bottom, contour[k]!);
    }
  }
  if (!Number.isFinite(top)) return;
  const yFrom = Math.max(0, Math.ceil(top - 0.5));
  const yTo = Math.min(height - 1, Math.floor(bottom - 0.5));
  const crossings: number[] = [];
  for (let y = yFrom; y <= yTo; y += 1) {
    const sample = y + 0.5;
    crossings.length = 0;
    for (const contour of contours) {
      const count = contour.length >> 1;
      for (let k = 0; k < count; k += 1) {
        const ax = contour[k * 2]!;
        const ay = contour[k * 2 + 1]!;
        const next = (k + 1) % count;
        const bx = contour[next * 2]!;
        const by = contour[next * 2 + 1]!;
        if ((ay <= sample && by > sample) || (by <= sample && ay > sample)) {
          crossings.push(ax + ((sample - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k]! - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[k + 1]! - 0.5));
      if (to >= from) data.fill(value, y * width + from, y * width + to + 1);
    }
  }
}

/**
 * A soft pen stroke into a coverage mask (0–255, `width × height`): every pixel within `radius`
 * of the segment, its edge smoothed over a pixel. Coverage only ever grows.
 */
export function penStroke(mask: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, radius: number): void {
  const left = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
  const right = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
  const top = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length2 = dx * dx + dy * dy;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      const t = length2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const distance = Math.sqrt(ex * ex + ey * ey);
      const cover = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (cover > 0) {
        const value = Math.round(cover * 255);
        const at = y * width + x;
        if (value > mask[at]!) mask[at] = value;
      }
    }
  }
}

/**
 * A coverage mask laid into the picture at (left, top): where it covers, the picture takes
 * `value` scaled by the coverage (or keeps what it had, if that was brighter).
 */
export function stamp(picture: Picture, mask: Uint8Array, maskWidth: number, maskHeight: number, left: number, top: number, value: number): void {
  const { width, height, data } = picture;
  const ox = Math.round(left);
  const oy = Math.round(top);
  for (let y = 0; y < maskHeight; y += 1) {
    const py = oy + y;
    if (py < 0 || py >= height) continue;
    for (let x = 0; x < maskWidth; x += 1) {
      const cover = mask[y * maskWidth + x]!;
      if (!cover) continue;
      const px = ox + x;
      if (px < 0 || px >= width) continue;
      const at = py * width + px;
      const shaded = (value * cover + 127) / 255 | 0;
      if (shaded > data[at]!) data[at] = shaded;
    }
  }
}
