import assert from "node:assert/strict";
import test from "node:test";

import { countdownFraction, exitDuration, flipInvert, flipTransform, sheetOffset, sheetShouldClose, staggerDelay } from "./motion-math.ts";

test("an exit is about two thirds of the arrival, never nothing for something that arrived", () => {
  assert.equal(exitDuration(220), 150);
  assert.equal(exitDuration(340), 240);
  assert.equal(exitDuration(420), 290);
  assert.equal(exitDuration(40), 60);
  assert.equal(exitDuration(0), 0);
  assert.equal(exitDuration(Number.NaN), 0);
});

test("only the first dozen children of a list are staggered", () => {
  assert.equal(staggerDelay(0), 0);
  assert.equal(staggerDelay(1), 24);
  assert.equal(staggerDelay(11), 264);
  // The thirteenth and the two-hundredth arrive with the twelfth.
  assert.equal(staggerDelay(12), 264);
  assert.equal(staggerDelay(200), 264);
  assert.equal(staggerDelay(3, 40, 6), 120);
  assert.equal(staggerDelay(9, 40, 6), 200);
  assert.equal(staggerDelay(-1), 0);
  assert.equal(staggerDelay(Number.NaN), 0);
});

test("FLIP inverts a move", () => {
  const delta = flipInvert({ left: 10, top: 200, width: 64, height: 64 }, { left: 110, top: 20, width: 64, height: 64 });
  assert.deepEqual(delta, { x: -100, y: 180, scaleX: 1, scaleY: 1 });
  assert.equal(flipTransform(delta!), "translate(-100px, 180px)");
});

test("FLIP inverts a change of size from the top left corner", () => {
  // A 56 px cover in the mini-player that became a 280 px cover in the open player.
  const delta = flipInvert({ left: 12, top: 780, width: 56, height: 56 }, { left: 55, top: 120, width: 280, height: 280 });
  assert.deepEqual(delta, { x: -43, y: 660, scaleX: 0.2, scaleY: 0.2 });
  assert.equal(flipTransform(delta!), "translate(-43px, 660px) scale(0.2, 0.2)");
});

test("FLIP has nothing to do for an element that stayed put, or that is not on screen", () => {
  const box = { left: 10, top: 10, width: 100, height: 40 };
  assert.equal(flipInvert(box, { ...box }), null);
  assert.equal(flipInvert(box, { ...box, left: 10.3 }), null);
  assert.equal(flipInvert(box, { ...box, width: 0 }), null);
  assert.equal(flipInvert({ ...box, height: 0 }, box), null);
});

test("a dragged sheet follows the finger down and resists it up", () => {
  assert.equal(sheetOffset(0), 0);
  assert.equal(sheetOffset(180), 180);
  assert.equal(sheetOffset(-50), -10);
  assert.equal(sheetOffset(-500), -24);
  assert.equal(sheetOffset(Number.NaN), 0);
});

test("a sheet closes when dragged a third of the way, or flicked down", () => {
  assert.equal(sheetShouldClose(250, 600, 0), true);
  assert.equal(sheetShouldClose(150, 600, 0), false);
  assert.equal(sheetShouldClose(60, 600, 0.9), true);
  // A tap that moved a few pixels quickly is not a flick.
  assert.equal(sheetShouldClose(10, 600, 2), false);
  // Upwards never closes it.
  assert.equal(sheetShouldClose(-200, 600, 2), false);
  assert.equal(sheetShouldClose(100, 0, 1), false);
});

test("the countdown ring is full at the start and empty at the end, whatever the timer does", () => {
  assert.equal(countdownFraction(0, 12000), 1);
  assert.equal(countdownFraction(3000, 12000), 0.75);
  assert.equal(countdownFraction(12000, 12000), 0);
  assert.equal(countdownFraction(15000, 12000), 0);
  assert.equal(countdownFraction(-500, 12000), 1);
  assert.equal(countdownFraction(100, 0), 0);
});
