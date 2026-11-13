import assert from "node:assert/strict";
import test from "node:test";
import { MENU_GAP, MENU_MARGIN, placeMenu } from "./action-menu-place.ts";

const screen = { width: 390, height: 844 };
const menu = { width: 220, height: 180 };

test("a menu opens under its control, flush with the control's right edge", () => {
  const place = placeMenu({ left: 300, top: 200, right: 344, bottom: 244 }, menu, screen);
  assert.deepEqual(place, { left: 344 - 220, top: 244 + MENU_GAP, above: false });
});

test("with no room under the control and more over it, the menu opens over it", () => {
  const place = placeMenu({ left: 300, top: 700, right: 344, bottom: 744 }, menu, screen);
  assert.equal(place.above, true);
  assert.equal(place.top, 700 - MENU_GAP - 180);
});

test("a menu that fits under its control stays under it, however much room there is above", () => {
  const place = placeMenu({ left: 300, top: 600, right: 344, bottom: 644 }, menu, screen);
  assert.equal(place.above, false);
});

test("a control near the left edge: the menu is pushed back inside the screen", () => {
  const place = placeMenu({ left: 10, top: 100, right: 54, bottom: 144 }, menu, screen);
  assert.equal(place.left, MENU_MARGIN);
});

test("a control past the right edge cannot take the menu with it", () => {
  const place = placeMenu({ left: 380, top: 100, right: 424, bottom: 144 }, menu, screen);
  assert.equal(place.left, 390 - MENU_MARGIN - 220);
});

test("a menu taller than the screen starts at the margin, so its first entries can be seen", () => {
  const place = placeMenu({ left: 300, top: 400, right: 344, bottom: 444 }, { width: 220, height: 900 }, screen);
  assert.equal(place.top, MENU_MARGIN);
});

test("neither side has room: the larger one is taken and the menu kept on screen", () => {
  const short = { width: 390, height: 300 };
  const place = placeMenu({ left: 300, top: 120, right: 344, bottom: 164 }, { width: 220, height: 200 }, short);
  // 300 - 164 - 14 = 122 under, 120 - 14 = 106 over: under it, pushed up to fit.
  assert.equal(place.above, false);
  assert.equal(place.top, 300 - MENU_MARGIN - 200);
});
