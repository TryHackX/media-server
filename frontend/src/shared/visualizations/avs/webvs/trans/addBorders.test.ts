import assert from "node:assert/strict";
import test from "node:test";

import { addBorderPixels } from "./addBorders.ts";

test("Add Borders: size is a percentage of the height (top, bottom) and the width (sides)", () => {
    // DarK MatteR — Transform at 640×360: 3 rows and 6 columns, as the reference draws them.
    assert.deepEqual(addBorderPixels(640, 360, 1), { rows: 3, columns: 6 });
    assert.deepEqual(addBorderPixels(1280, 720, 10), { rows: 72, columns: 128 });
    assert.deepEqual(addBorderPixels(100, 100, 50), { rows: 50, columns: 50 });
});

test("Add Borders: at least a pixel, size held to 1…50", () => {
    assert.deepEqual(addBorderPixels(64, 36, 1), { rows: 1, columns: 1 });
    assert.deepEqual(addBorderPixels(640, 360, 0), { rows: 3, columns: 6 });
    assert.deepEqual(addBorderPixels(640, 360, 99), { rows: 180, columns: 320 });
    assert.deepEqual(addBorderPixels(640, 360, undefined), { rows: 3, columns: 6 });
});
