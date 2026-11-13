import type { RetroScene } from "../types";

/**
 * The tracker screens' presets: each program's main screen playing along, its code a chunk of
 * its own. The names are the programs' own, so the list keeps them as they are. The list goes
 * by platform, each roughly in the order the programs came out.
 */
function tracker(id: string, name: string, create: () => Promise<RetroScene>): { id: string; name: string; translate: boolean; create(): Promise<RetroScene> } {
  return { id, name, translate: false, create };
}

export const TRACKER_PRESETS: readonly { id: string; name: string; translate: boolean; create(): Promise<RetroScene> }[] = [
  // Amiga
  tracker("tracker-ust", "Ultimate Soundtracker 1.21", async () => (await import("./ultimatesoundtracker")).createUltimateSoundtracker()),
  tracker("tracker-doc-soundtracker", "D.O.C SoundTracker 2.0", async () => (await import("./docsoundtracker")).createDocSoundTracker()),
  tracker("tracker-noisetracker", "NoiseTracker 2.0", async () => (await import("./noisetracker")).createNoiseTracker()),
  tracker("tracker-futurecomposer", "Future Composer 1.4", async () => (await import("./futurecomposer")).createFutureComposer()),
  tracker("tracker-sidmon1", "SidMon 1.0", async () => (await import("./sidmon1")).createSidMon1()),
  tracker("tracker-sidmon", "SidMon II", async () => (await import("./sidmon")).createSidMon()),
  tracker("tracker-octamed", "OctaMED Professional 4.0", async () => (await import("./octamed")).createOctaMED()),
  tracker("tracker-oktalyzer", "Oktalyzer 1.57", async () => (await import("./oktalyzer")).createOktalyzer()),
  tracker("tracker-protracker", "ProTracker 2.3", async () => (await import("./protracker")).createProTracker("scope")),
  tracker("tracker-protracker-spectrum", "ProTracker 2.3 · Spectrum", async () => (await import("./protracker")).createProTracker("spectrum")),
  tracker("tracker-ahx", "AHX 2.3d", async () => (await import("./ahx")).createAHX()),
  // DOS and Windows
  tracker("tracker-composer669", "Composer 669 1.3", async () => (await import("./composer669")).createComposer669()),
  tracker("tracker-screamtracker", "Scream Tracker 3.21", async () => (await import("./screamtracker")).createScreamTracker()),
  tracker("tracker-fasttracker", "Fasttracker II", async () => (await import("./fasttracker")).createFastTracker()),
  tracker("tracker-impulsetracker", "Impulse Tracker 2.14", async () => (await import("./impulsetracker")).createImpulseTracker()),
  tracker("tracker-modplug", "ModPlug Tracker 1.16", async () => (await import("./modplug")).createModPlug()),
  // Commodore 64 and Amstrad CPC
  tracker("tracker-soundmonitor", "SoundMonitor 1.1", async () => (await import("./soundmonitor")).createSoundMonitor()),
  tracker("tracker-jch", "JCH Editor 3.04", async () => (await import("./jch")).createJch()),
  tracker("tracker-cpc-soundtracker", "Soundtracker DMA 2.0", async () => (await import("./soundtrackerdma")).createSoundtrackerDma()),
  tracker("tracker-arkos", "Arkos Tracker 3", async () => (await import("./arkostracker")).createArkosTracker())
];
