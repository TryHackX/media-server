/**
 * Who made what "Klasyka retro" recreates or ports, as the project's notes record it (NOTICE.md,
 * vendor/cthugha/SOURCE.md, the trackers' own screens and headers). The credits are facts, so the
 * Cthugha lines stay in builds without the ports in vendor/. Names are never translated; a line
 * marked `translate` is Polish source text for t(). Without imports, so the tests read it as it
 * is (retro.test.ts).
 */

export interface CreditEntry {
  /** The program, as it called itself. */
  program: string;
  /** Its authors and years, a line each. */
  lines: readonly string[];
  /** Lines of Polish text for t(), after the names. */
  notes?: readonly string[];
  /** The presets of the plugin it stands behind (trackers: their ids). */
  presets?: readonly string[];
}

export interface CreditSection {
  /** A heading of Polish text for t(), or none (each program is then its own heading). */
  heading?: string;
  entries: readonly CreditEntry[];
}

export const CREDITS: readonly CreditSection[] = [
  {
    entries: [
      {
        program: "Cthugha",
        lines: ['Kevin "Zaph" Burfitt', "Torps Productions · 1993–1995", "Daniel Sachs · Jochen Quante", "Ofer Faigon · Volker Muehle", "Todd Hedenstrom · Dmitry Altukhov"]
      },
      { program: "Cthugha-L", lines: ["Harald Deischinger · 1995–1999", "Pete · Aaron · Russ · Rus Maxham", "Stanislav V. Voronyi"] },
      { program: "Cthugha98", lines: ['Kevin "Zaph" Burfitt · 1997–1998'] },
      { program: "Cthugha-4-Winamp", lines: ["Krunoslav Pisačić · 1998"] },
      { program: "Atari Video Music (1977)", lines: ["Atari, Inc.", "Robert J. Brown"], notes: ["patent USA nr 4 081 829"] }
    ]
  },
  {
    heading: "Trackery",
    entries: [
      { program: "Ultimate Soundtracker", lines: ["Karsten Obarski · 1987"], presets: ["tracker-ust"] },
      { program: "D.O.C SoundTracker", lines: ["Unknown of D.O.C · 1988"], presets: ["tracker-doc-soundtracker"] },
      { program: "NoiseTracker", lines: ["Mahoney & Kaktus · 1990"], presets: ["tracker-noisetracker"] },
      { program: "Future Composer", lines: ["SuperSero of The Superions · 1990"], presets: ["tracker-futurecomposer"] },
      { program: "SidMon", lines: ["Reinier van Vliet · Turtle Byte · 1989"], presets: ["tracker-sidmon1"] },
      { program: "SidMon II", lines: ["Michael Kleps · Turtle Byte · 1990"], presets: ["tracker-sidmon"] },
      { program: "OctaMED", lines: ["Teijo Kinnunen · 1992"], presets: ["tracker-octamed"] },
      { program: "Oktalyzer", lines: ["Armin Sander · 1989–1993"], presets: ["tracker-oktalyzer"] },
      { program: "ProTracker", lines: ["Amiga Freelancers"], presets: ["tracker-protracker", "tracker-protracker-spectrum"] },
      { program: "AHX", lines: ["Dexter & Pink of Abyss · 1998"], presets: ["tracker-ahx"] },
      { program: "Composer 669", lines: ["Tran of Renaissance · 1992"], presets: ["tracker-composer669"] },
      { program: "Scream Tracker", lines: ["Sami Tammilehto · 1993–1994"], presets: ["tracker-screamtracker"] },
      { program: "Fasttracker II", lines: ["Triton · 1994–1996"], presets: ["tracker-fasttracker"] },
      { program: "Impulse Tracker", lines: ["Jeffrey Lim · 1995–1998"], presets: ["tracker-impulsetracker"] },
      { program: "ModPlug Tracker", lines: ["Olivier Lapicque · 2004"], presets: ["tracker-modplug"] },
      { program: "SoundMonitor", lines: ["Chris Hülsbeck · 1986"], presets: ["tracker-soundmonitor"] },
      { program: "JCH Editor", lines: ["Jens-Christian Huus · 1991"], presets: ["tracker-jch"] },
      { program: "Soundtracker DMA", lines: ["Zik / Futurs' · 2021"], presets: ["tracker-cpc-soundtracker"] },
      { program: "Arkos Tracker", lines: ["Julien Névo · 2024–2026"], presets: ["tracker-arkos"] }
    ]
  },
  {
    entries: [
      { program: "VSG", lines: ["Neven Pintaric · 2000"] },
      { program: "Geiss", lines: ["Ryan Geiss"] }
    ]
  }
];
