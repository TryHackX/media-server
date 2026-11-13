/**
 * Render / Triangle's arithmetic, as grandchild/vis_avs's e_triangle.cpp does it (render/Triangle.ts
 * draws with it): corners to pixels, the colour, the depth and the rows of a filled triangle. Pure,
 * so the tests load it with plain Node.
 */

const INT_MIN = -2147483648;

/** C's (int) of a double as x86 converts it: toward zero; NaN and out of range give INT_MIN. */
export function cInt(value: number): number {
    return value > -2147483649 && value < 2147483648 ? Math.trunc(value) | 0 : INT_MIN;
}

/** world_to_screen(): (v + 1) · half, half = (size − 1)/2, as an int. */
export function triangleScreen(value: number, half: number): number {
    return cInt((Number(value) + 1.0) * half);
}

/**
 * col_to_int(): max(0, min(255, (int)(c · 255))) — vis_avs's platform.h has only int max/min, so the
 * product is cut to an int first: 0 below 0 and for NaN, 255 from 1 up, and 0 again past 2^31 / 255
 * (INT_MIN).
 */
export function triangleChannel(value: number): number {
    const c = cInt(Number(value) * 255.0);
    return c < 0 ? 0 : c > 255 ? 255 : c;
}

/** z_to_depthbuffer(): the depth as a whole number, 0…4·10^9 (z1 · 100000, 40000 at most). */
export function triangleDepth(z: number): number {
    if (z > 40000) {
        return 40000 * 100000;
    }
    return z > 0 ? Math.trunc(z * 100000) : 0;
}

const imul = Math.imul;
/** C's int division: toward zero (exact for int32 operands, the quotient is never near a whole one). */
const idiv = (a: number, b: number) => Math.trunc(a / b) | 0;

/**
 * draw_triangle() and draw_line() of e_triangle.cpp on a width × height frame: the corners as ints
 * (y down), sorted top to bottom as sort_vertices() sorts them; the rows from the top corner's
 * (left out when the corner lies on it) down to the bottom one's (left out), clamped to the frame;
 * in each row x from the edge v1→v2 (then v2→v3) to the edge v1→v3, in 32-bit integer arithmetic,
 * the right end left out and column width − 1 never reached. `span(y, x, count)` gets every row's
 * run of pixels x … x + count − 1 (count ≥ 1), top row first.
 */
export function triangleSpans(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
                              width: number, height: number, span: (y: number, x: number, count: number) => void) {
    // sort_vertices(): p = (v0.y <= v1.y) + 2 (v0.y <= v2.y) + 4 (v1.y <= v2.y).
    let ax = x1, ay = y1, bx = x2, by = y2, cx = x3, cy = y3;
    const p = (ay <= by ? 1 : 0) + (ay <= cy ? 2 : 0) + (by <= cy ? 4 : 0);
    let tx, ty;
    switch (p) {
        case 0: // 321
            tx = cx; ty = cy; cx = ax; cy = ay; ax = tx; ay = ty;
            break;
        case 1: // 312
            tx = cx; ty = cy; cx = bx; cy = by; bx = ax; by = ay; ax = tx; ay = ty;
            break;
        case 3: // 132
            tx = cx; ty = cy; cx = bx; cy = by; bx = tx; by = ty;
            break;
        case 4: // 231
            tx = cx; ty = cy; cx = ax; cy = ay; ax = bx; ay = by; bx = tx; by = ty;
            break;
        case 6: // 213
            tx = bx; ty = by; bx = ax; by = ay; ax = tx; ay = ty;
            break;
        default: // 7: 123; 2 and 5 cannot happen
            break;
    }
    let y = Math.max(0, Math.min(height, ay));
    if (y === ay) {
        y++;
    }
    const midy = Math.max(-1, Math.min(height - 1, by));
    const endy = Math.max(-1, Math.min(height, cy));
    const line = (startx: number, endx: number) => {
        if (startx > endx) {
            const t = startx;
            startx = endx;
            endx = t;
        }
        if (endx < 0 || startx >= width) {
            return;
        }
        startx = Math.max(startx, 0);
        endx = Math.min(endx, width - 1);
        if (endx > startx) {
            span(y, startx, endx - startx);
        }
    };
    for (; y <= midy; y++) {
        line((idiv(imul((bx - ax) | 0, (y - ay) | 0), (by - ay) | 0) + ax) | 0,
            (idiv(imul((cx - ax) | 0, (y - ay) | 0), (cy - ay) | 0) + ax) | 0);
    }
    for (; y < endy; y++) {
        line((idiv(imul((cx - bx) | 0, (y - by) | 0), (cy - by) | 0) + bx) | 0,
            (idiv(imul((cx - ax) | 0, (y - ay) | 0), (cy - ay) | 0) + ax) | 0);
    }
}
