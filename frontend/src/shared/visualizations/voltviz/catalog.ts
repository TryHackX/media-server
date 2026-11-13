import type { HalftoneLook } from "./halftone";
import type { VisualizerModule } from "./visualizers/runtime/types";

/** One of voltviz's own visualizations: a preset of the VoltViz visualizer. */
export interface VoltVizEntry {
  /** voltviz's id; also what the panel, the remembered choice and the favourites store. */
  id: string;
  /** voltviz's name for it, as its picker shows it. */
  name: string;
  /** Its module: a chunk of its own, fetched the first time it is shown. */
  load: () => Promise<VisualizerModule>;
  /**
   * Raw WebGPU, with a WebGL 2 translation (visualizers/lib/webgl2.ts) for browsers without
   * WebGPU; the name says which one draws: "Pulsar (WebGPU)" or "Pulsar (WebGL)".
   */
  webgpu?: boolean;
  /** The name in the panel, in the interface's language, where it is not voltviz's own. */
  label?: () => string;
  /** Several presets of one visualization (Your Logo's logos): Auto deals them as one card. */
  family?: string;
  /**
   * One of the choices that another visualization's upstream overlay offers (Halftone Pulse's
   * mode, shape, neon colours), as a preset: listed right after that visualization, under the
   * heading `group` gives. Auto deals it only from the favourites, and › steps into the
   * choices only from one of them.
   */
  variantOf?: string;
  group?: () => string;
  /**
   * The overlay voltviz shows over it (overlays.ts): Icons' name and Shuffle, Halftone Pulse's
   * Style (mode, shape, colours).
   */
  overlay?: "icons" | "halftone";
  /** Halftone Pulse's look, set before the first frame (setMode, setShape, setNeon). */
  look?: () => HalftoneLook;
}

/**
 * voltviz 0.35.1's registry (src/visualizers/registry.ts, newest first), less five:
 *
 * - MilkDrop and MilkDrop Warp: the player has MilkDrop itself (butterchurn, with its presets);
 * - Moss Ball and Flame: their shaders are third-party work under CC BY-NC 4.0 and
 *   CC BY-NC-SA 3.0 (voltviz's THIRD_PARTY_NOTICES.md), not MIT, so they are not vendored;
 * - Your Logo: draws nothing until somebody uploads an SVG, and the panel has no upload; the
 *   adapter (index.ts) offers it instead once per logo the owner put in vendor/voltviz-logos.
 *
 * Icons draws lucide's icons without React: their data from the `lucide` package, their
 * outlines measured by outline.ts as Chrome measures them (impl/Icons.ts); its overlay (the icon's
 * name, Shuffle) is overlays.ts. Halftone Pulse is listed with variants, the choices of its
 * upstream overlay (halftone.ts, index.ts), and has that overlay too, for any mix of them.
 *
 * Every import below is a chunk of its own; three.js, shared by most of them, is one more and
 * is fetched with the first that needs it.
 */
export const voltvizCatalog: readonly VoltVizEntry[] = [
  { id: "pulsar", name: "Pulsar", load: () => import("./visualizers/impl/Pulsar"), webgpu: true },
  { id: "oscilloscope", name: "Oscilloscope", load: () => import("./visualizers/impl/Oscilloscope"), webgpu: true },
  { id: "daybreak", name: "Daybreak", load: () => import("./visualizers/impl/Daybreak"), webgpu: true },
  { id: "blobtracker", name: "Blob Tracker", load: () => import("./visualizers/impl/BlobTracker"), webgpu: true },
  { id: "kaleidoscope", name: "Kaleidoscope", load: () => import("./visualizers/impl/Kaleidoscope") },
  { id: "lasershow", name: "Laser Show", load: () => import("./visualizers/impl/LaserShow") },
  { id: "halftonepulse", name: "Halftone Pulse", load: () => import("./visualizers/impl/HalftonePulse") },
  { id: "sungalizer", name: "Sungalizer", load: () => import("./visualizers/impl/Sungalizer") },
  { id: "insidequantum", name: "Inside Quantum", load: () => import("./visualizers/impl/InsideQuantum") },
  { id: "holoblinds", name: "Holo Blinds", load: () => import("./visualizers/impl/HoloBlinds") },
  { id: "shambhala", name: "Shambhala", load: () => import("./visualizers/impl/Shambhala") },
  { id: "trailsstream", name: "Trails Stream", load: () => import("./visualizers/impl/TrailsStream") },
  { id: "anunakisphere", name: "Anunaki Sphere", load: () => import("./visualizers/impl/AnunakiSphere") },
  { id: "aurumleaf", name: "Aurum Leaf", load: () => import("./visualizers/impl/AurumLeaf") },
  { id: "rawaudio", name: "Raw Audio", load: () => import("./visualizers/impl/RawAudio") },
  { id: "cybercity", name: "Cyber City", load: () => import("./visualizers/impl/CyberCity") },
  { id: "razor1911", name: "Razor 1911", load: () => import("./visualizers/impl/Razor1911") },
  { id: "fractalorb", name: "Fractal Orb", load: () => import("./visualizers/impl/FractalOrb") },
  { id: "msdefrag", name: "MS Defrag", load: () => import("./visualizers/impl/MsDefrag") },
  { id: "aurorawaves", name: "Aurora Waves", load: () => import("./visualizers/impl/AuroraWaves") },
  { id: "hexglobe", name: "Hex Globe", load: () => import("./visualizers/impl/HexGlobe") },
  { id: "vumeter", name: "VU Meter", load: () => import("./visualizers/impl/VUMeter") },
  { id: "blurimage", name: "Blur Image", load: () => import("./visualizers/impl/BlurImage") },
  { id: "backgroundimagesendspin", name: "Background Image", load: () => import("./visualizers/impl/BackgroundImageSendspin") },
  { id: "vinylsendspin", name: "Vinyl", load: () => import("./visualizers/impl/VinylSendspin") },
  { id: "datadashboard", name: "Data Dashboard", load: () => import("./visualizers/impl/DataDashboard") },
  { id: "fireworksshow", name: "Fireworks Show", load: () => import("./visualizers/impl/FireworksShow") },
  { id: "disneydroneshow", name: "Disney Drone Show", load: () => import("./visualizers/impl/DisneyDroneShow") },
  { id: "defqonmainstage", name: "Defqon Mainstage", load: () => import("./visualizers/impl/DefqonMainstage") },
  { id: "3dequalizer", name: "3D Equalizer", load: () => import("./visualizers/impl/ThreeDEqualizer") },
  { id: "fluidsmoke", name: "Fluid Smoke", load: () => import("./visualizers/impl/FluidSmoke") },
  { id: "psychedelicskull", name: "Psychedelic Skull", load: () => import("./visualizers/impl/PsychedelicSkull") },
  { id: "polysphere", name: "Poly Sphere", load: () => import("./visualizers/impl/PolySphere") },
  { id: "bars", name: "Bars", load: () => import("./visualizers/impl/Bars") },
  { id: "cybergridcanvas", name: "Cyber Grid Canvas", load: () => import("./visualizers/impl/CyberGridCanvas") },
  { id: "cybermatrix", name: "Cyber Matrix", load: () => import("./visualizers/impl/CyberMatrix") },
  { id: "circular", name: "Circular", load: () => import("./visualizers/impl/Circular") },
  { id: "particlesstream", name: "Particles Stream", load: () => import("./visualizers/impl/ParticlesStream") },
  { id: "tunnel", name: "Tunnel", load: () => import("./visualizers/impl/Tunnel") },
  { id: "sheetmusic", name: "Sheet Music", load: () => import("./visualizers/impl/SheetMusic") },
  { id: "neonwave", name: "Neon Wave", load: () => import("./visualizers/impl/NeonWave") },
  { id: "cosmicparticles", name: "Cosmic Particles", load: () => import("./visualizers/impl/CosmicParticles") },
  { id: "crtterminal", name: "CRT Terminal", load: () => import("./visualizers/impl/CRTTerminal") },
  { id: "glowsphere", name: "Glow Sphere", load: () => import("./visualizers/impl/GlowSphere") },
  { id: "icons", name: "Icons", load: () => import("./visualizers/impl/Icons"), overlay: "icons" },
  { id: "glitchdatabend", name: "Glitch Databend", load: () => import("./visualizers/impl/GlitchDatabend") },
  { id: "glitchbackgroundsendspin", name: "Glitch Background", load: () => import("./visualizers/impl/GlitchBackgroundSendspin") },
  { id: "dutchgridwebgl", name: "Dutch Grid (WebGL)", load: () => import("./visualizers/impl/DutchGridWebGL") },
  { id: "dutchgrid", name: "Dutch Grid", load: () => import("./visualizers/impl/DutchGrid") }
];
