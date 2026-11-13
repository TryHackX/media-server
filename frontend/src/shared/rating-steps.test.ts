import assert from "node:assert/strict";
import test from "node:test";

import { ratingAt, ratingStep } from "./rating-steps.ts";

test("the half star under the pointer is the rating: ten equal steps across the row", () => {
  // A row 100 px wide: every 10 px is half a star.
  assert.equal(ratingAt(0, 100), 0.5);
  assert.equal(ratingAt(1, 100), 0.5);
  assert.equal(ratingAt(10, 100), 0.5);
  assert.equal(ratingAt(10.5, 100), 1);
  assert.equal(ratingAt(49, 100), 2.5);
  assert.equal(ratingAt(51, 100), 3);
  assert.equal(ratingAt(99, 100), 5);
  assert.equal(ratingAt(100, 100), 5);
});

test("a press beside the row (a finger on the enlarged target) is its nearest end", () => {
  assert.equal(ratingAt(-12, 100), 0.5);
  assert.equal(ratingAt(140, 100), 5);
});

test("a row that has no width yet gives the lowest rating rather than NaN", () => {
  assert.equal(ratingAt(30, 0), 0.5);
  assert.equal(ratingAt(Number.NaN, 100), 0.5);
});

test("arrows move by half a star, pages by a whole one, within half a star and five", () => {
  assert.equal(ratingStep(3, "ArrowRight"), 3.5);
  assert.equal(ratingStep(3, "ArrowUp"), 3.5);
  assert.equal(ratingStep(3, "ArrowLeft"), 2.5);
  assert.equal(ratingStep(3, "ArrowDown"), 2.5);
  assert.equal(ratingStep(3, "PageUp"), 4);
  assert.equal(ratingStep(3, "PageDown"), 2);
  assert.equal(ratingStep(5, "ArrowRight"), 5);
  assert.equal(ratingStep(4.5, "PageUp"), 5);
  assert.equal(ratingStep(0.5, "ArrowLeft"), 0.5);
  assert.equal(ratingStep(1, "PageDown"), 0.5);
});

test("an unrated track starts from nothing: the first step up is half a star", () => {
  assert.equal(ratingStep(0, "ArrowRight"), 0.5);
  assert.equal(ratingStep(0, "ArrowLeft"), 0.5);
  assert.equal(ratingStep(Number.NaN, "ArrowRight"), 0.5);
});

test("Home, End and the digits jump", () => {
  assert.equal(ratingStep(3, "Home"), 0.5);
  assert.equal(ratingStep(3, "End"), 5);
  for (const digit of [1, 2, 3, 4, 5]) assert.equal(ratingStep(2.5, String(digit)), digit);
});

test("any other key is not about the rating", () => {
  for (const key of ["Tab", "Enter", " ", "Escape", "a", "0", "6", "F5"]) assert.equal(ratingStep(3, key), null, key);
});
