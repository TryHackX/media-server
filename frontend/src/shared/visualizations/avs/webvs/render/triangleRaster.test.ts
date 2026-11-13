import assert from "node:assert/strict";
import test from "node:test";

import { cInt, triangleChannel, triangleDepth, triangleScreen, triangleSpans } from "./triangleRaster.ts";

const spans = (corners: number[], width: number, height: number): number[][] => {
    const out: number[][] = [];
    triangleSpans(corners[0]!, corners[1]!, corners[2]!, corners[3]!, corners[4]!, corners[5]!, width, height,
        (y, x, count) => out.push([y, x, count]));
    return out;
};

test("corners: (v + 1)·(size − 1)/2 cut toward zero, NaN and overflow as x86's INT_MIN", () => {
    assert.equal(triangleScreen(-1, 319.5), 0);
    assert.equal(triangleScreen(1, 319.5), 639);
    assert.equal(triangleScreen(-0.5, 319.5), 159); // 159.75
    assert.equal(triangleScreen(-1.001, 319.5), 0); // -0.3195: toward zero, not down
    assert.equal(triangleScreen(-1.01, 319.5), -3); // -3.195
    assert.equal(triangleScreen(Number.NaN, 319.5), -2147483648);
    assert.equal(triangleScreen(1e300, 319.5), -2147483648);
    assert.equal(cInt(-2147483648.5), -2147483648);
    assert.equal(cInt(2147483647.9), 2147483647);
});

test("colour: (int)(c · 255) through platform.h's int max/min", () => {
    assert.equal(triangleChannel(1), 255);
    assert.equal(triangleChannel(0.5), 127);
    assert.equal(triangleChannel(2), 255);
    assert.equal(triangleChannel(-0.1), 0);
    assert.equal(triangleChannel(Number.NaN), 0);
    // past 2^31 / 255 the int cut gives INT_MIN, so black, not white
    assert.equal(triangleChannel(1e8), 0);
});

test("depth: z1 · 100000, at most 40000 · 100000, nothing below 0", () => {
    assert.equal(triangleDepth(1.5), 150000);
    assert.equal(triangleDepth(50000), 4e9);
    assert.equal(triangleDepth(-3), 0);
    assert.equal(triangleDepth(Number.NaN), 0);
});

test("rows: the top corner's row and the bottom one's are left out, and each row's right end", () => {
    // (0,0) (4,0) (0,4): rows 1…3, from x = 0 to 4 − y (exclusive).
    assert.deepEqual(spans([0, 0, 4, 0, 0, 4], 10, 10), [[1, 0, 3], [2, 0, 2], [3, 0, 1]]);
    // the same corners in any order
    assert.deepEqual(spans([0, 4, 0, 0, 4, 0], 10, 10), [[1, 0, 3], [2, 0, 2], [3, 0, 1]]);
    assert.deepEqual(spans([4, 0, 0, 4, 0, 0], 10, 10), [[1, 0, 3], [2, 0, 2], [3, 0, 1]]);
    // a top corner above the frame: row 0 is drawn
    assert.deepEqual(spans([0, -1, 6, -1, 0, 5], 10, 10).slice(0, 2), [[0, 0, 5], [1, 0, 4]]);
});

test("rows past the frame are clamped, and the last column is never reached", () => {
    // wider than the frame: x 0…6 of 8 columns (column 7 is left out, as draw_line clamps to w − 1
    // and leaves the end out)
    for (const [y, x, count] of spans([-10, 2, 100, 2, -10, 6], 8, 10)) {
        assert.ok(y >= 3 && y <= 5, `row ${y}`);
        assert.equal(x, 0);
        assert.ok(x + count <= 7, `row ${y} reaches column ${x + count - 1}`);
    }
    // below the frame: rows end at height − 1
    const rows = spans([0, 0, 10, 20, -10, 20], 10, 10).map(([y]) => y);
    assert.deepEqual(rows, [2, 3, 4, 5, 6, 7, 8, 9]);
    // wholly outside: nothing
    assert.deepEqual(spans([0, -9, 5, -9, 2, -3], 10, 10), []);
    assert.deepEqual(spans([20, 2, 30, 2, 25, 6], 10, 10), []);
    // flat (all on one row): nothing
    assert.deepEqual(spans([0, 3, 9, 3, 5, 3], 10, 10), []);
});

test("integer arithmetic as C does it: products wrap at 32 bits, divisions go toward zero", () => {
    // the edge from (10, 0) to (3, 3): row 1 starts at (3 − 10)·1/3 + 10 = -2 + 10 (toward zero), not 7
    assert.deepEqual(spans([10, 0, 3, 3, 15, 3], 20, 20)[0], [1, 8, 3]);
    // corners at INT_MIN (NaN in the code) wrap instead of throwing or hanging
    const out = spans([-2147483648, 0, 5, 5, -2147483648, 9], 16, 16);
    assert.ok(out.every(([y, x, count]) => y >= 0 && y < 16 && x >= 0 && count >= 1 && x + count <= 15));
});
