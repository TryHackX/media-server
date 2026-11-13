/**
 * Dynamic Movement's pixels, as r_dmove.cpp (AVS 2.81d) interpolates its grid: integer for
 * integer, so every pixel samples where AVS's did.
 *
 * The grid holds, per point, the source position in 16.16 fixed point and alpha·255 in 8.16
 * (`grid`, XRES × YRES × 3 ints). AVS walks the screen in cells of (w << 16) / (XRES − 1) by
 * (h << 16) / (YRES − 1): down a cell it adds a step per row, (lower − upper) / rows rounded
 * towards zero, and across a row a step per pixel the same way. Without wrap a position is held
 * to [0, w_adj − 1] (w_adj = (w − 2) << 16 with subpixel, (w − 1) << 16 without) before each
 * pixel and the walk goes on from there; with wrap it is folded into [0, w_adj) once per pixel.
 * The steps are kept in a work area right after the grid, which the last rows read past the
 * grid's end, as AVS did (the area is emulated with the grid in one array). A cell less than a
 * pixel wide or tall ends the frame early: AVS left the remaining pixels as they were.
 *
 * dmovePixels walks every pixel on the CPU. Per output pixel `out` gets: the source column and
 * row (x >> 16, y >> 16), BLEND4_16's two fractions as fx + 256·fy ((x >> 8) & 255,
 * (y >> 8) & 255), and alpha (a >> 16); −1 in the first slot for a pixel AVS did not write.
 *
 * dmoveRows does the same walk down to each cell of each row and leaves the pixels to the GPU:
 * a pixel j steps into its cell is start + j·step, which the shader can add exactly in floats
 * when both are split into a high part (>> 8) and a low byte (dmoveAt shows the arithmetic).
 * Pure (no imports): the tests load it with plain Node.
 */

/** XRES and YRES as AVS clamps the grid size (grid_w + 1 points across, 2…256). */
export function dmoveResolution(gridW: number, gridH: number): [number, number] {
  const clamp = (value: number) => Math.max(2, Math.min(256, value));
  return [clamp(Math.trunc(Number(gridW) || 0) + 1), clamp(Math.trunc(Number(gridH) || 0) + 1)];
}

/** A grid table plus AVS's work area behind it (XRES·6 + 6 ints for one thread). */
export function dmoveGridArray(xres: number, yres: number): Int32Array {
  return new Int32Array(xres * yres * 3 + xres * 6 + 6);
}

/** The code's variables as r_dmove.cpp hands them over: one shared set, read and written by every section. */
export interface DmoveCode {
  x: unknown;
  y: unknown;
  d: unknown;
  r: unknown;
  alpha: unknown;
  perPixel(): void;
}

/** (int) of a double, as x86 does it: out of range (and NaN) is 0x80000000. */
const cInt = (value: number): number => (Math.abs(value) < 2147483648 ? Math.trunc(value) : -2147483648);

/**
 * r_dmove.cpp's smp_begin grid: per point the code gets x, y (−1…1), d (1 at a corner) and r, and
 * its result becomes a 16.16 source position (polar: d·max_screen_d·65536 along r − π/2), held to
 * the screen without wrap, and alpha·255 in 8.16, into `grid`. As in AVS, polar mode leaves d and r
 * converted in the variables (*var_d *= max_screen_d; *var_r -= M_PI*0.5), so the next frame's
 * per-frame code sees the last point's that way. `runPoint` false: no per-point code.
 */
export function dmoveGrid(code: DmoveCode, w: number, h: number, xres: number, yres: number,
                          subpixel: boolean, wrap: boolean, rect: boolean, runPoint: boolean, grid: Int32Array): void {
  const wAdj = (subpixel ? w - 2 : w - 1) * 65536;
  const hAdj = (subpixel ? h - 2 : h - 1) * 65536;
  const xsc = 2.0 / w;
  const ysc = 2.0 / h;
  const dw2 = w * 32768.0;
  const dh2 = h * 32768.0;
  let maxScreenD = Math.sqrt(w * w + h * h) * 0.5;
  const divmaxD = 1.0 / maxScreenD;
  maxScreenD *= 65536.0;
  const xcDpos = Math.trunc((w * 65536) / (xres - 1));
  const ycDpos = Math.trunc((h * 65536) / (yres - 1));
  let ycPos = 0;
  let at = 0;
  for (let y = 0; y < yres; y++) {
    let xcPos = 0;
    for (let x = 0; x < xres; x++) {
      const xd = (xcPos - dw2) * (1.0 / 65536.0);
      const yd = (ycPos - dh2) * (1.0 / 65536.0);
      xcPos += xcDpos;
      code.x = xd * xsc;
      code.y = yd * ysc;
      code.d = Math.sqrt(xd * xd + yd * yd) * divmaxD;
      code.r = Math.atan2(yd, xd) + Math.PI * 0.5;
      if (runPoint) {
        code.perPixel();
      }
      let tmp1;
      let tmp2;
      if (!rect) {
        const d = Number(code.d) * maxScreenD;
        const r = Number(code.r) - Math.PI * 0.5;
        code.d = d;
        code.r = r;
        tmp1 = cInt(dw2 + Math.cos(r) * d);
        tmp2 = cInt(dh2 + Math.sin(r) * d);
      } else {
        tmp1 = cInt((Number(code.x) + 1.0) * dw2);
        tmp2 = cInt((Number(code.y) + 1.0) * dh2);
      }
      if (!wrap) {
        if (tmp1 < 0) tmp1 = 0;
        if (tmp1 > wAdj) tmp1 = wAdj;
        if (tmp2 < 0) tmp2 = 0;
        if (tmp2 > hAdj) tmp2 = hAdj;
      }
      let va = Number(code.alpha);
      if (va < 0.0) va = 0.0;
      else if (va > 1.0) va = 1.0;
      grid[at++] = tmp1;
      grid[at++] = tmp2;
      grid[at++] = cInt(va * 255.0 * 65536.0);
    }
    ycPos += ycDpos;
  }
}

const divide = (a: number, b: number) => Math.trunc((a | 0) / b) | 0;

/**
 * Fills `out` (w·h·4) from the grid in `m` (from dmoveGridArray, its first XRES·YRES·3 ints set).
 * `still` is "no movement": only alpha is walked.
 */
export function dmovePixels(w: number, h: number, xres: number, yres: number, m: Int32Array,
                            subpixel: boolean, wrap: boolean, still: boolean, out: Float32Array): void {
  out.fill(-1);
  const wAdj = ((subpixel ? w - 2 : w - 1) * 65536) | 0;
  const hAdj = ((subpixel ? h - 2 : h - 1) * 65536) | 0;
  const interp = xres * yres * 3;
  const xr3 = xres * 3;
  const at = (index: number) => (index < m.length ? m[index]! : 0);
  const xcDpos = Math.trunc((w * 65536) / (xres - 1));
  const ycDpos = Math.trunc((h * 65536) / (yres - 1));
  let rd = 0;
  let ycPos = 0;
  let lypos = 0;
  let yl = h;
  let o = 0;
  while (yl > 0) {
    ycPos += ycDpos;
    let yseek = (ycPos >> 16) - lypos;
    if (!yseek) {
      return;
    }
    lypos = ycPos >> 16;
    for (let l = 0, st = interp; l < xres; l++, rd += 3, st += 6) {
      const t1 = at(rd);
      const t2 = at(rd + 1);
      const t3 = at(rd + 2);
      m[st] = t1;
      m[st + 1] = t2;
      m[st + 2] = divide(at(rd + xr3) - t1, yseek);
      m[st + 3] = divide(at(rd + xr3 + 1) - t2, yseek);
      m[st + 4] = t3;
      m[st + 5] = divide(at(rd + xr3 + 2) - t3, yseek);
    }
    if (yseek > yl) {
      yseek = yl;
    }
    yl -= yseek;
    while (yseek-- > 0) {
      let st = interp;
      let l = w;
      let lpos = 0;
      let xcPos = 0;
      while (l > 0) {
        xcPos += xcDpos;
        let seek = (xcPos >> 16) - lpos;
        if (!seek) {
          return;
        }
        lpos = xcPos >> 16;
        let xp = m[st]!;
        let yp = m[st + 1]!;
        let ap = m[st + 4]!;
        const dA = divide(at(st + 10) - ap, seek);
        let dX = divide(at(st + 6) - xp, seek);
        let dY = divide(at(st + 7) - yp, seek);
        m[st] = (m[st]! + m[st + 2]!) | 0;
        m[st + 1] = (m[st + 1]! + m[st + 3]!) | 0;
        m[st + 4] = (m[st + 4]! + m[st + 5]!) | 0;
        st += 6;
        if (seek > l) {
          seek = l;
        }
        l -= seek;
        if (still) {
          while (seek-- > 0) {
            out[o * 4] = 0;
            out[o * 4 + 3] = ap >> 16;
            o++;
            ap = (ap + dA) | 0;
          }
          continue;
        }
        if (!wrap) {
          while (seek-- > 0) {
            if (xp < 0) xp = 0;
            else if (xp >= wAdj) xp = wAdj - 1;
            if (yp < 0) yp = 0;
            else if (yp >= hAdj) yp = hAdj - 1;
            out[o * 4] = xp >> 16;
            out[o * 4 + 1] = yp >> 16;
            out[o * 4 + 2] = ((xp >> 8) & 255) + 256 * ((yp >> 8) & 255);
            out[o * 4 + 3] = ap >> 16;
            o++;
            xp = (xp + dX) | 0;
            yp = (yp + dY) | 0;
            ap = (ap + dA) | 0;
          }
        } else {
          xp %= wAdj;
          yp %= hAdj;
          if (xp < 0) xp += wAdj;
          if (yp < 0) yp += hAdj;
          if (dX <= -wAdj) dX = -wAdj + 1;
          else if (dX >= wAdj) dX = wAdj - 1;
          if (dY <= -hAdj) dY = -hAdj + 1;
          else if (dY >= hAdj) dY = hAdj - 1;
          while (seek-- > 0) {
            if (xp < 0) xp += wAdj;
            else if (xp >= wAdj) xp -= wAdj;
            if (yp < 0) yp += hAdj;
            else if (yp >= hAdj) yp -= hAdj;
            out[o * 4] = xp >> 16;
            out[o * 4 + 1] = yp >> 16;
            out[o * 4 + 2] = ((xp >> 8) & 255) + 256 * ((yp >> 8) & 255);
            out[o * 4 + 3] = ap >> 16;
            o++;
            xp = (xp + dX) | 0;
            yp = (yp + dY) | 0;
            ap = (ap + dA) | 0;
          }
        }
      }
      m[st] = (m[st]! + m[st + 2]!) | 0;
      m[st + 1] = (m[st + 1]! + m[st + 3]!) | 0;
      m[st + 4] = (m[st + 4]! + m[st + 5]!) | 0;
    }
  }
}

/** dmoveRows' result: the cells of a row and, per row and cell, where the walk starts and steps. */
export interface DmoveRows {
  /** Cells in a row (each row walks the same cells). */
  cells: number;
  /** Per pixel column: its cell and how many pixels into it (w × 4: cell, j, 0, 0). */
  columns: Float32Array;
  /** Per row and cell, for x, y and alpha: start >> 8, start & 255, step >> 8, step & 255. */
  rows: Float32Array;
}

/**
 * The walk of dmovePixels down to cells: false where the GPU could not follow it exactly (a cell
 * under a pixel, which ends AVS's frame early, or steps too large for float arithmetic); the
 * caller then walks the pixels itself.
 */
export function dmoveRows(w: number, h: number, xres: number, yres: number, m: Int32Array,
                          subpixel: boolean, wrap: boolean, out: DmoveRows): boolean {
  const wAdj = ((subpixel ? w - 2 : w - 1) * 65536) | 0;
  const hAdj = ((subpixel ? h - 2 : h - 1) * 65536) | 0;
  const xcDpos = Math.trunc((w * 65536) / (xres - 1));
  const ycDpos = Math.trunc((h * 65536) / (yres - 1));
  if (xcDpos < 65536 || ycDpos < 65536) {
    return false;
  }
  // The cells of a row: the same in every row.
  const seeks: number[] = [];
  const widths: number[] = [];
  if (out.columns.length !== w * 4) {
    out.columns = new Float32Array(w * 4);
  }
  let l = w;
  let lpos = 0;
  let xcPos = 0;
  let widest = 0;
  while (l > 0) {
    xcPos += xcDpos;
    const seek = (xcPos >> 16) - lpos;
    lpos = xcPos >> 16;
    const pixels = Math.min(seek, l);
    for (let j = 0; j < pixels; j++) {
      out.columns[(w - l + j) * 4] = seeks.length;
      out.columns[(w - l + j) * 4 + 1] = j;
    }
    widest = Math.max(widest, pixels);
    seeks.push(seek);
    widths.push(pixels);
    l -= pixels;
  }
  const cells = seeks.length;
  out.cells = cells;
  if (out.rows.length !== h * cells * 12) {
    out.rows = new Float32Array(h * cells * 12);
  }
  const rows = out.rows;
  const interp = xres * yres * 3;
  const xr3 = xres * 3;
  const at = (index: number) => (index < m.length ? m[index]! : 0);
  // j·step stays below |end − start| < 2^32, so (step >> 8)·j below 2^24; with wrap the start
  // is folded first and the sum must stay exact too.
  const limit = wrap ? 2 ** 30 : 2 ** 31;
  let rd = 0;
  let ycPos = 0;
  let lypos = 0;
  let yl = h;
  let y = 0;
  while (yl > 0) {
    ycPos += ycDpos;
    let yseek = (ycPos >> 16) - lypos;
    lypos = ycPos >> 16;
    for (let c = 0, st = interp; c < xres; c++, rd += 3, st += 6) {
      const t1 = at(rd);
      const t2 = at(rd + 1);
      const t3 = at(rd + 2);
      m[st] = t1;
      m[st + 1] = t2;
      m[st + 2] = divide(at(rd + xr3) - t1, yseek);
      m[st + 3] = divide(at(rd + xr3 + 1) - t2, yseek);
      m[st + 4] = t3;
      m[st + 5] = divide(at(rd + xr3 + 2) - t3, yseek);
    }
    if (yseek > yl) {
      yseek = yl;
    }
    yl -= yseek;
    while (yseek-- > 0) {
      let st = interp;
      for (let c = 0; c < cells; c++) {
        const seek = seeks[c]!;
        let xp = m[st]!;
        let yp = m[st + 1]!;
        const ap = m[st + 4]!;
        const dA = divide(at(st + 10) - ap, seek);
        let dX = divide(at(st + 6) - xp, seek);
        let dY = divide(at(st + 7) - yp, seek);
        m[st] = (m[st]! + m[st + 2]!) | 0;
        m[st + 1] = (m[st + 1]! + m[st + 3]!) | 0;
        m[st + 4] = (m[st + 4]! + m[st + 5]!) | 0;
        st += 6;
        if (!wrap) {
          if (xp < 0) xp = 0;
          else if (xp >= wAdj) xp = wAdj - 1;
          if (yp < 0) yp = 0;
          else if (yp >= hAdj) yp = hAdj - 1;
          // Held at the start, the walk stays inside unless an end lies outside (rows read past
          // the grid): then AVS held every pixel, which only the CPU walk does.
          const endX = xp + (widths[c]! - 1) * dX;
          const endY = yp + (widths[c]! - 1) * dY;
          if (endX < 0 || endX >= wAdj || endY < 0 || endY >= hAdj) {
            return false;
          }
        } else {
          xp %= wAdj;
          yp %= hAdj;
          if (xp < 0) xp += wAdj;
          if (yp < 0) yp += hAdj;
          if (dX <= -wAdj) dX = -wAdj + 1;
          else if (dX >= wAdj) dX = wAdj - 1;
          if (dY <= -hAdj) dY = -hAdj + 1;
          else if (dY >= hAdj) dY = hAdj - 1;
        }
        if (Math.abs(dX) * widest >= limit || Math.abs(dY) * widest >= limit || Math.abs(dA) * widest >= limit) {
          return false;
        }
        const o = (y * cells + c) * 12;
        rows[o] = xp >> 8;
        rows[o + 1] = xp & 255;
        rows[o + 2] = dX >> 8;
        rows[o + 3] = dX & 255;
        rows[o + 4] = yp >> 8;
        rows[o + 5] = yp & 255;
        rows[o + 6] = dY >> 8;
        rows[o + 7] = dY & 255;
        rows[o + 8] = ap >> 8;
        rows[o + 9] = ap & 255;
        rows[o + 10] = dA >> 8;
        rows[o + 11] = dA & 255;
      }
      m[st] = (m[st]! + m[st + 2]!) | 0;
      m[st + 1] = (m[st + 1]! + m[st + 3]!) | 0;
      m[st + 4] = (m[st + 4]! + m[st + 5]!) | 0;
      y++;
    }
  }
  return true;
}

/**
 * What the shader computes for one pixel from dmoveRows' data (the reference for its GLSL):
 * position >> 8 = start_hi + j·step_hi + floor((start_lo + j·step_lo) / 256), folded with wrap.
 * Returns [source column, source row, fx + 256·fy, alpha] as dmovePixels writes them.
 */
export function dmoveAt(rows: DmoveRows, w: number, h: number, x: number, y: number,
                        subpixel: boolean, wrap: boolean): number[] {
  const cell = rows.columns[x * 4]!;
  const j = rows.columns[x * 4 + 1]!;
  const o = (y * rows.cells + cell) * 12;
  const walk = (k: number) => rows.rows[o + k]! + j * rows.rows[o + k + 2]! + Math.floor((rows.rows[o + k + 1]! + j * rows.rows[o + k + 3]!) / 256);
  let x8 = walk(0);
  let y8 = walk(4);
  if (wrap) {
    const px = (subpixel ? w - 2 : w - 1) * 256;
    const py = (subpixel ? h - 2 : h - 1) * 256;
    x8 -= px * Math.floor(x8 / px);
    y8 -= py * Math.floor(y8 / py);
  }
  const sx = Math.floor(x8 / 256);
  const sy = Math.floor(y8 / 256);
  return [sx, sy, (x8 - sx * 256) + 256 * (y8 - sy * 256), Math.floor(walk(8) / 256)];
}
