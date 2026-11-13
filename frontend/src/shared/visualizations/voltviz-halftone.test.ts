import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// halftone.ts imports the interface language without an extension: resolved here (tests only).
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
      throw error;
    }
  }
});

const { HALFTONE_MODES, HALFTONE_SHAPES, halftoneVariants } = await import("./voltviz/halftone.ts");
const { provideDictionary, setLanguage } = await import("../i18n.ts");
provideDictionary("en", (await import("../i18n-en.ts")).english);

/** The entries of an object literal `const NAME = { id: 'Name', … } as const;` in the vendored file. */
function literal(source: string, name: string): [string, string][] {
  const body = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\} as const;`).exec(source)?.[1];
  assert.ok(body, `${name} in HalftonePulse.ts`);
  return [...body.matchAll(/^\s*(\w+): '((?:[^'\\]|\\.)*)',/gm)].map((match) => [match[1]!, match[2]!.replace(/\\\\/g, "\\")]);
}

const source = readFileSync(new URL("./voltviz/visualizers/impl/HalftonePulse.ts", import.meta.url), "utf8");

test("the choices are Halftone Pulse's own modes and shapes, with voltviz's names, in its order", () => {
  assert.deepEqual(HALFTONE_MODES.map(([id, name]) => [id, name]), literal(source, "MODES"));
  assert.deepEqual(HALFTONE_SHAPES.map(([id, name]) => [id, name]), literal(source, "SHAPES"));
  assert.equal(HALFTONE_MODES.length, 23);
  assert.equal(HALFTONE_SHAPES.length, 27);
});

test("every choice is a preset of its own: neon, each mode, each shape, the rest left to Auto", () => {
  const variants = halftoneVariants();
  assert.equal(variants.length, 1 + 23 + 27);
  assert.equal(new Set(variants.map((variant) => variant.id)).size, variants.length);
  assert.ok(variants.every((variant) => variant.id.startsWith("halftonepulse-")));
  assert.deepEqual(variants[0]!.look, { mode: "auto", shape: "auto", neon: true });
  for (const variant of variants.slice(1)) {
    assert.equal(variant.look.neon, false);
    assert.ok((variant.look.mode === "auto") !== (variant.look.shape === "auto"), `${variant.id}: one choice, the other Auto`);
  }
  // In English, voltviz's own words.
  setLanguage("en");
  try {
    assert.equal(variants[0]!.label(), "Halftone Pulse — Neon");
    assert.equal(variants.find((variant) => variant.id === "halftonepulse-mode-halftone")!.label(), "Halftone Pulse — Mode: Halftone (Luma > Size)");
    assert.equal(variants.find((variant) => variant.id === "halftonepulse-shape-line_diag_l")!.label(), "Halftone Pulse — Shape: Diagonal \\");
    for (const variant of variants.slice(1)) {
      const [, kind, name] = /^Halftone Pulse: (Mode|Shape): (.*)$/.exec(variant.name)!;
      assert.equal(variant.label(), `Halftone Pulse — ${kind}: ${name}`, variant.id);
    }
    assert.equal(variants[1]!.group(), "Halftone Pulse — modes");
    assert.equal(variants.at(-1)!.group(), "Halftone Pulse — shapes");
  } finally {
    setLanguage("pl");
  }
  assert.equal(variants.find((variant) => variant.id === "halftonepulse-shape-circle")!.label(), "Halftone Pulse — kształt: Koło");
});

const { halftoneStyle } = await import("./voltviz/halftone.ts");

test("Halftone Pulse's style (its overlay's mode, shape and colours) is read back as it was kept, or Auto", () => {
  assert.deepEqual(halftoneStyle(null), { mode: "auto", shape: "auto", neon: false });
  assert.deepEqual(halftoneStyle(JSON.stringify({ mode: "threshold", shape: "star", neon: true })), { mode: "threshold", shape: "star", neon: true });
  // What Halftone Pulse does not have (or no longer has) falls back to Auto, one choice at a time.
  assert.deepEqual(halftoneStyle(JSON.stringify({ mode: "nope", shape: "ascii", neon: "yes" })), { mode: "auto", shape: "ascii", neon: false });
  assert.deepEqual(halftoneStyle("{broken"), { mode: "auto", shape: "auto", neon: false });
  assert.deepEqual(halftoneStyle("[1,2]"), { mode: "auto", shape: "auto", neon: false });
});

test("Icons' overlay names every icon of voltviz's pool: in English as voltviz does, in Polish its own", async () => {
  const { ICON_POOL } = await import("./voltviz/visualizers/impl/Icons.ts");
  const { ICON_NAME_KEYS, iconName } = await import("./voltviz/overlays.ts");
  const names = ICON_POOL.map(([name]: [string, unknown]) => name);
  assert.deepEqual([...ICON_NAME_KEYS].sort(), [...names].sort());
  setLanguage("en");
  try {
    for (const name of names) assert.equal(iconName(name), name);
  } finally {
    setLanguage("pl");
  }
  const polish = names.map(iconName);
  assert.equal(new Set(polish).size, names.length);
  assert.equal(iconName("Heart"), "Serce");
  assert.equal(iconName("Unknown"), "Unknown");
});
