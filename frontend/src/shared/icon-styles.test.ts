import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ICON_STYLE_IDS, iconStyleFont, resolveIconStyle, splitIconStyle } from "./icon-styles.ts";

test("Free unless Pro is chosen and built", () => {
  const built = ["classic-solid", "classic-light", "duotone-thin"];
  assert.equal(resolveIconStyle({ icon_pack: "free", icon_style: "classic-light" }, built), null);
  assert.equal(resolveIconStyle({ icon_pack: "pro", icon_style: "classic-light" }, null), null);
  assert.equal(resolveIconStyle({ icon_pack: "pro", icon_style: "classic-light" }, []), null);
  assert.equal(resolveIconStyle({ icon_pack: "pro", icon_style: "classic-light" }, built), "classic-light");
  assert.equal(resolveIconStyle({ icon_pack: "pro" }, built), "classic-solid");
  // A style this build lost falls back to Pro solid, then to Free.
  assert.equal(resolveIconStyle({ icon_pack: "pro", icon_style: "sharp-thin" }, built), "classic-solid");
  assert.equal(resolveIconStyle({ icon_pack: "pro", icon_style: "sharp-thin" }, ["duotone-thin"]), null);
});

test("every style id names a family and a weight", () => {
  assert.equal(ICON_STYLE_IDS.length, 16);
  for (const id of ICON_STYLE_IDS) assert.ok(splitIconStyle(id), id);
  assert.deepEqual(splitIconStyle("sharp-duotone-light"), { family: "sharp-duotone", weight: "light" });
  assert.equal(splitIconStyle("duotone"), null);
  assert.equal(splitIconStyle("jelly-regular"), null);
  assert.deepEqual(iconStyleFont("duotone-thin"), { font: "Font Awesome 7 Duotone", weight: 100 });
});

test("the server accepts exactly the styles the panel offers", () => {
  const php = readFileSync(new URL("../../../integrations/php/CatalogActions.php", import.meta.url), "utf8");
  const declared = php.match(/ICON_STYLES = \[([^\]]*)\]/);
  assert.ok(declared, "CatalogActions::ICON_STYLES is missing");
  const ids = [...declared[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...ids].sort(), [...ICON_STYLE_IDS].sort());
});
