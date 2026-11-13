import assert from "node:assert/strict";
import test from "node:test";

import { fromBase64Config, msvcRand, svpFileName } from "./config.ts";

test("config bytes from base64; anything else is no bytes", () => {
    assert.deepEqual([...fromBase64Config("AQAAAAgAAAA=")], [1, 0, 0, 0, 8, 0, 0, 0]);
    assert.deepEqual([...fromBase64Config(undefined)], []);
    assert.deepEqual([...fromBase64Config("not base64!")], []);
});

test("MSVC rand(): 41, 18467, 6334 from the CRT's start; srand reseeds", () => {
    const rand = msvcRand();
    assert.deepEqual([rand(), rand(), rand()], [41, 18467, 6334]);
    const seeded = msvcRand(42);
    assert.equal(seeded(), 175);
});

test("an SVP library is found by its file name, case aside", () => {
    assert.equal(svpFileName("C:\\Program Files\\Winamp\\Plugins\\AVS\\Voronoi.SVP"), "voronoi.svp");
    assert.equal(svpFileName("ball.svp"), "ball.svp");
    assert.equal(svpFileName(null), "");
});
