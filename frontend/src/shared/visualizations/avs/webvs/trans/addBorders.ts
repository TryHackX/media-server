/**
 * Add Borders ("Virtual Effect: Addborders" APE) as grandchild/vis_avs e_addborders.cpp reads its
 * binary: the top and bottom borders are `size` % of the height, the sides `size` % of the width,
 * integer division, each at least one pixel; `size` is 1…50. Pure: the tests run it with Node.
 */
export function addBorderPixels(w: number, h: number, size: unknown): { rows: number; columns: number } {
    const percent = Math.max(1, Math.min(50, Math.trunc(Number(size) || 0)));
    return {
        rows: Math.max(1, Math.trunc((h * percent) / 100)),
        columns: Math.max(1, Math.trunc((w * percent) / 100)),
    };
}
