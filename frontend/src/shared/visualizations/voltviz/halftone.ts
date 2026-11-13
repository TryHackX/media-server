import { t } from "../../i18n";

/**
 * Halftone Pulse's choices, as voltviz's React overlay offers them (Style: Mode, Shape and
 * Colors; Upload Image is the overlay's alone, overlays.ts). Each choice is a preset of its
 * own, listed under Halftone Pulse, so favourites and Auto can deal it: the mode with the shapes
 * left to Auto, the shape with the modes left to Auto, or neon colours with both left to Auto.
 * Any mix of them is set in the overlay itself (overlays.ts): it becomes the listener's style,
 * the look plain Halftone Pulse opens in (halftoneStyle; Auto, Auto, source colours until then).
 *
 * The ids are those of impl/HalftonePulse.ts (MODES, SHAPES), in its order; the names are its
 * English ones (voltviz-icons.test.ts compares both lists with that file).
 */

/** What the overlay sets: setMode, setShape, setNeon. */
export interface HalftoneLook {
  mode: string;
  shape: string;
  neon: boolean;
}

export interface HalftoneVariant {
  id: string;
  /** voltviz's name for the choice, in English. */
  name: string;
  label: () => string;
  /** The heading it is listed under; "" for none. */
  group: () => string;
  look: HalftoneLook;
}

/** MODES of impl/HalftonePulse.ts: id, voltviz's name, the name in the interface. */
export const HALFTONE_MODES: readonly (readonly [string, string, () => string])[] = [
  ["flat", "Static (Flat)", () => t("Statyczny (płaski)")],
  ["stretch_v", "Stretch Vertical", () => t("Rozciągnięcie pionowe")],
  ["stretch_h", "Stretch Horizontal", () => t("Rozciągnięcie poziome")],
  ["checker", "Checkerboard (Alt)", () => t("Szachownica (na przemian)")],
  ["glitch", "Glitch (Luma > Offset)", () => t("Glitch (jasność > przesunięcie)")],
  ["melt", "Pixel Melt (Drip)", () => t("Topnienie pikseli (kapanie)")],
  ["crosshatch", "Crosshatch", () => t("Kreskowanie krzyżowe")],
  ["rotation", "Rotation (Luma > Angle)", () => t("Obrót (jasność > kąt)")],
  ["halftone", "Halftone (Luma > Size)", () => t("Półton (jasność > rozmiar)")],
  ["inv_halftone", "Inverse (Dark > Size)", () => t("Odwrócony (ciemność > rozmiar)")],
  ["random_size", "Random Size (Chaos)", () => t("Losowy rozmiar (chaos)")],
  ["random_rot", "Random Rotation", () => t("Losowy obrót")],
  ["opacity", "Opacity (Luma > Alpha)", () => t("Krycie (jasność > alfa)")],
  ["inv_opacity", "Inv. Opacity (Dark > Alpha)", () => t("Odwrócone krycie (ciemność > alfa)")],
  ["threshold", "Threshold (Hard Cut)", () => t("Próg (ostre cięcie)")],
  ["flow", "Flow Field (Direction)", () => t("Pole przepływu (kierunek)")],
  ["edges", "Edge Detect (Outline)", () => t("Wykrywanie krawędzi (kontur)")],
  ["jitter", "Mosaic Jitter (Scatter)", () => t("Drgająca mozaika (rozrzut)")],
  ["posterize", "Posterize (Levels)", () => t("Posteryzacja (poziomy)")],
  ["interference", "Interference (Moiré)", () => t("Interferencja (mora)")],
  ["crt_scan", "CRT TV (Scanline)", () => t("Telewizor CRT (linie)")],
  ["bio", "Bio-Organic (Cellular)", () => t("Bioorganiczny (komórki)")],
  ["eraser", "Eraser (Noise)", () => t("Gumka (szum)")]
];

/** SHAPES of impl/HalftonePulse.ts. */
export const HALFTONE_SHAPES: readonly (readonly [string, string, () => string])[] = [
  ["circle", "Circle", () => t("Koło")],
  ["rect", "Square", () => t("Kwadrat")],
  ["triangle", "Triangle", () => t("Trójkąt")],
  ["octagon", "Octagon", () => t("Ośmiokąt")],
  ["star", "Star", () => t("Gwiazda")],
  ["cross", "Cross", () => t("Krzyż")],
  ["rect_v", "Rect Vertical", () => t("Prostokąt pionowy")],
  ["rect_h", "Rect Horizontal", () => t("Prostokąt poziomy")],
  ["hex_v", "Hexagon Vertical", () => t("Sześciokąt pionowy")],
  ["line_diag_r", "Diagonal /", () => t("Ukośnik /")],
  ["line_diag_l", "Diagonal \\", () => t("Ukośnik \\")],
  ["chevron", "Chevron", () => t("Szewron")],
  ["trapezoid", "Trapezoid", () => t("Trapez")],
  ["semi_top", "Semi-Circle Top", () => t("Półkole górne")],
  ["semi_bottom", "Semi-Circle Bottom", () => t("Półkole dolne")],
  ["rect_hollow", "Square Hollow", () => t("Pusty kwadrat")],
  ["spiral", "Spiral", () => t("Spirala")],
  ["concentric", "Concentric Circles", () => t("Okręgi współśrodkowe")],
  ["gear", "Gear (Cog)", () => t("Koło zębate")],
  ["flower", "Flower (5 Petals)", () => t("Kwiat (5 płatków)")],
  ["shuriken", "Shuriken", () => t("Shuriken")],
  ["lightning", "Lightning", () => t("Błyskawica")],
  ["diamond_hollow", "Diamond Hollow", () => t("Pusty romb")],
  ["windmill", "Windmill", () => t("Wiatrak")],
  ["leaf", "Leaf", () => t("Liść")],
  ["ghost", "Pacman Ghost", () => t("Duszek z Pac-Mana")],
  ["ascii", "ASCII (Glyphs)", () => t("ASCII (znaki)")]
];

/** The presets beside Halftone Pulse, in the overlay's order: neon, every mode, every shape. */
export function halftoneVariants(): HalftoneVariant[] {
  const none = (): string => "";
  return [
    {
      id: "halftonepulse-neon", name: "Halftone Pulse: Colors: Neon",
      label: () => t("Halftone Pulse — neon"), group: none,
      look: { mode: "auto", shape: "auto", neon: true }
    },
    ...HALFTONE_MODES.map(([mode, name, label]): HalftoneVariant => ({
      id: `halftonepulse-mode-${mode}`, name: `Halftone Pulse: Mode: ${name}`,
      label: () => t("Halftone Pulse — tryb: {mode}", { mode: label() }), group: () => t("Halftone Pulse — tryby"),
      look: { mode, shape: "auto", neon: false }
    })),
    ...HALFTONE_SHAPES.map(([shape, name, label]): HalftoneVariant => ({
      id: `halftonepulse-shape-${shape}`, name: `Halftone Pulse: Shape: ${name}`,
      label: () => t("Halftone Pulse — kształt: {shape}", { shape: label() }), group: () => t("Halftone Pulse — kształty"),
      look: { mode: "auto", shape, neon: false }
    }))
  ];
}

/** Halftone Pulse in the listener's style: Auto, Auto and the source's colours until one is chosen. */
export function halftoneStyle(stored: string | null): HalftoneLook {
  const style: HalftoneLook = { mode: "auto", shape: "auto", neon: false };
  try {
    const value: unknown = JSON.parse(stored ?? "null");
    if (!value || typeof value !== "object") return style;
    const { mode, shape, neon } = value as Record<string, unknown>;
    if (typeof mode === "string" && HALFTONE_MODES.some(([id]) => id === mode)) style.mode = mode;
    if (typeof shape === "string" && HALFTONE_SHAPES.some(([id]) => id === shape)) style.shape = shape;
    style.neon = neon === true;
  } catch { /* zapis nieczytelny: styl domyślny */ }
  return style;
}
