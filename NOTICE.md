# Licence and attribution

This project is distributed under the **MIT** licence (see `LICENSE`; copyright holder: TryHackX).

## Origin of the transfer design

Single-range HTTP handling, memory-bounded reads and ZIP64 archives built with the STORE method
were designed after patterns from
[TryHackX-Files](https://github.com/TryHackX/TryHackX-Files), which is published under the
PolyForm Noncommercial 1.0.0 licence. The code in this repository is an independent Python
implementation of those patterns (`src/media_server/ranges.py`, `streaming.py`, `zipstream.py`).

Both projects belong to the same owner, so the MIT licence above applies to this repository in
full. If code is ever copied verbatim from the reference project, the corresponding PolyForm
Noncommercial notice must be added to `LICENSE` for those parts.

## Dependencies

Python and npm dependencies carry their own licences (MIT / BSD / Apache-2.0 / PSF); the complete
list follows from `requirements*.lock` and `frontend/package-lock.json`. Font Awesome Free is
bundled under CC BY 4.0 (icons), SIL OFL 1.1 (fonts) and MIT (code).

The MilkDrop and Geiss visualizers run on [butterchurn](https://github.com/jberg/butterchurn)
(MIT), a WebGL reimplementation of Ryan Geiss's MilkDrop, with the presets of
`butterchurn-presets` (MIT; its base, extra, md1 and image packs, each preset by its named author
from the MilkDrop community) and the stock MilkDrop textures that package carries. They
are fetched only when one of those visualizers is opened. Font Awesome Pro, when an owner installs
it, is used under that owner's commercial licence and is never part of this repository.

An owner may also add MilkDrop preset packs of their own — for example projectM's
[Cream of the Crop](https://github.com/projectM-visualizer/presets-cream-of-the-crop) (curated by
ISOSCELES), [MilkDrop original](https://github.com/projectM-visualizer/presets-milkdrop-original),
[projectM classic](https://github.com/projectM-visualizer/presets-projectm-classic) and the presets
of [En D](https://github.com/projectM-visualizer/presets-en-d)
— in `frontend/vendor/milkdrop-presets/` (git-ignored). The MilkDrop visualizer then offers them
beside butterchurn's presets. MilkDrop presets were almost always released without a licence and
are customarily treated as public domain (see the packs' own `LICENSE.md`); each remains the work
of its named author, and none of them is part of this repository. The build converts them with
[hlslparser-js](https://github.com/jberg/hlslparser-js) and
[milkdrop-preset-utils](https://github.com/jberg/milkdrop-preset-utils) (both MIT, Jordan Berg —
the parts of milkdrop-preset-converter), with this project's own corrections in
`frontend/scripts/milkdrop-hlsl.mjs` and `milkdrop-convert.mjs`; their equations are read by
`frontend/src/shared/visualizations/milkdrop-eel.ts`, a reimplementation of the parsing rules of
ns-eel2, MilkDrop's expression compiler (Cockos/Nullsoft, zlib licence), not of its code.
butterchurn itself is patched at build time (`frontend/scripts/butterchurn-patches.mjs`, as its
MIT licence allows). Those patches port code of MilkDrop 2 (BSD 3-Clause, Copyright 2005-2013
Nullsoft, Inc.) and of BeatDrop (BSD 3-Clause, Copyright (c) 2018 Maxim Volskiy and individual
contributors); their notices are in `frontend/scripts/LICENSE-milkdrop2-beatdrop.txt`. MilkDrop 3's
double-preset blend patterns follow the formulas described by
[MDropDX12](https://github.com/shanevbg/MDropDX12) (whose code is CC BY-NC 4.0); they are written
anew, not copied. They, and the way MilkDrop 3 draws a preset's sprite, were checked against
MilkDrop 3.37's own program by static analysis of its binary (never run); what is implemented
from that is written anew, and nothing of the program is copied.

The same holds for the presets of [BeatDrop](https://github.com/OfficialIncubo/BeatDrop-Music-Visualizer)
an owner may add there (its "Incubo_'s Presets" and "MilkDrop2077 Presets" folders, by Incubo_,
MilkDrop2077, Se7enSlasher and the authors their names credit). By BeatDrop's `PRESET LICENSE.md`,
most of its presets made from Shadertoy shaders are licensed CC BY-NC-SA 3.0 — non-commercial use
only, with credit to the shader authors — and the rest carry no licence. They are used only on
that owner's non-commercial site, under their authors' names, and never become part of this
repository. The same goes for MilkDrop 3's presets (its `.milk2` double presets and the `.milk`
presets no other pack has, by MilkDrop2077 and the authors their names credit), taken as data from
the official installer of [MilkDrop 3](https://github.com/milkdrop2077/MilkDrop3) — whose
LICENSE.txt allows personal use only, not commercial or professional use — for one of them, from
[Milkwave](https://github.com/IkeC/Milkwave), whose README says its presets are not covered by its
licences — and for the rest from [MDropDX12](https://github.com/shanevbg/MDropDX12)'s bundled
presets (a CC BY-NC 4.0 repository; the presets keep their authors' credits) and from
[XorPlayer](https://github.com/milkdrop2077/XorPlayer) (a BSD-3-Clause repository; its presets
are ports of XorDev's shaders, under XorDev's own terms).
The textures presets name — projectM's
[MilkDrop texture pack](https://github.com/projectM-visualizer/presets-milkdrop-texture-pack)
(MilkDrop's own textures and others that presets came to use), BeatDrop's textures and random
texture sets, four found in the SourceForge "mdpresetpack" archive, seven textures and the 39
sprite images its presets' sprite blocks draw from the MilkDrop 3 installer, and the ones a pack
brings in its own folder — were
released without a licence as well, and some are third-party artwork: they live only in
`frontend/vendor/milkdrop-textures/` (git-ignored) or in that pack's folder, and the build serves
them beside the presets.

The Geiss (Winamp) visualizer is a port of Ryan Geiss's Winamp plug-in Geiss 4.30 from its own
source code, [geissomatik/geiss](https://github.com/geissomatik/geiss) (3-Clause BSD, Copyright (c)
1998-2022 Ryan Geiss; licence in `frontend/src/shared/visualizations/geiss/LICENSE-geiss.txt`):
its 25 warp maps, the per-pixel warp with its dither (the x86 and MMX assembly of `proc_map.cpp`),
the waveforms, the special effects, the palettes and their blending, the 16/32-bit colour modes,
the beat detection, the map switching and the song-title popups, translated from C++ and assembly to
TypeScript in `frontend/src/shared/visualizations/geiss/`. The map names in its preset list are
this project's, taken from Ryan Geiss's comments in the source.

The AVS visualizer is a fork of [webvs](https://github.com/azeem/webvs) 3.0.0 (MIT, Azeem Arshad;
licence in `frontend/src/shared/visualizations/avs/webvs/LICENSE-webvs.txt`), with its expression
compiler replaced: scripts are parsed by [eel-wasm](https://github.com/captbaritone/eel-wasm) (MIT)
and compiled to closures, without `eval`. The effects AVS had and webvs lacked or drew
differently (Movement, Dynamic Movement, Water, Roto Blitter, Moving Particle, Triangle and others)
are ported from Nullsoft's vis_avs source and its continuation
[grandchild/vis_avs](https://github.com/grandchild/vis_avs) (BSD, Copyright 2005 Nullsoft, Inc.;
licence in `frontend/src/shared/visualizations/avs/webvs/LICENSE-vis_avs.txt`). Presets are
converted at build time by [@visbot/webvsc](https://github.com/visbot/webvsc) 2.3.0 (MIT), kept
with this project's fixes in `frontend/scripts/webvsc/` (licence `LICENSE-webvsc.txt` there); the
presets themselves are not part of this repository.

The AVS visualizer's modern effects, simulations and the "mscopes" preset pack are ported from
[mscopes](https://github.com/GarAlex/mscopes) (BSD 3-Clause, Copyright (c) 2026 Alexander Garmash;
licence in `frontend/src/shared/visualizations/avs/webvs/mscopes/LICENSE-mscopes.txt`): its GPU
post effects (Bloom, Kaleidoscope, RGB Split, Tone Map, Vignette, Shockwave, Glitch, Streaks,
Lens, Radial Blur, Neon Edges, Duotone, Shimmer, CRT), Trails, Particles, Vectorscope, the
flow-field, fluid and reaction-diffusion simulations, the pixel shader, the built-in effects its
presets use, its audio analysis (spectrum, beat and tempo, log bands, drum detection, behind the
extra script variables `kick`, `snare`, `hat`, `onset`, `level`, `bass_att`, `mid_att`,
`treb_att`) and its 17 built-in presets, translated from C++ and Metal to TypeScript and GLSL in
`frontend/src/shared/visualizations/avs/webvs/mscopes/`. mscopes ships no third-party presets.

The VoltViz visualizer plays the visualizations of [voltviz](https://github.com/sanderdw/voltviz)
0.35.1 (MIT, Copyright (c) 2026 VoltViz Contributors), vendored together with voltviz's audio
analysis in `frontend/src/shared/visualizations/voltviz/` (licence `LICENSE-voltviz.txt` there).
Within them, Halftone Pulse ports the shape library of "Dither / ASCII Effect Pro" by sabosugi
(MIT), Icons draws 40 icons of [Lucide](https://lucide.dev) from the `lucide` package (ISC,
Copyright (c) 2026 Lucide Icons and Contributors; eight of them derived from
[Feather](https://github.com/feathericons/feather), MIT, Copyright (c) 2013-present Cole Bemis),
and the Dutch Grid visualizers draw the generalized municipality boundaries of Statistics
Netherlands (CBS) and Kadaster (CC BY 4.0, © CBS, Kadaster); these notices are in
`NOTICE-voltviz.txt` there. voltviz's Moss Ball and Flame are not included: their shaders are
licensed CC BY-NC 4.0 (Moss Ball: [imoss](https://github.com/ledhieu/imoss) by ledhieu) and
CC BY-NC-SA 3.0 (Flame: [kuvkar's flame](https://www.shadertoy.com/view/4tXXRn) on Shadertoy).
An owner may place voltviz's own files for them in `frontend/vendor/voltviz-extra/`
(git-ignored); the build then offers them, credited, on that owner's site, under those licences
— for non-commercial use only — and they never become part of this repository. The WGSL shaders
of Pulsar, Oscilloscope, Daybreak and Blob Tracker are also translated to GLSL for browsers
without WebGPU (`visualizers/impl/gl/` there), under voltviz's MIT licence. Your Logo draws the
logos an owner places in `frontend/vendor/voltviz-logos/` (git-ignored): they are that owner's,
served only by their own build, and never part of this repository. The visualizations are drawn with
[three.js](https://github.com/mrdoob/three.js) (MIT, three.js authors) and
[d3-geo](https://github.com/d3/d3-geo) with d3-array and internmap (ISC, Mike Bostock; d3-geo
includes parts of GeographicLib, MIT, Charles Karney), and like the other WebGL visualizers they
are fetched only when VoltViz is opened. Names such as Disney, Defqon.1 or Razor 1911 in
visualization titles belong to their owners and are used descriptively.

The Shadery visualizer plays shader visualizations an owner may add in
`frontend/vendor/shader-visualizers/` (git-ignored): those of [Monkey Hi Hat](https://github.com/MV10/monkey-hi-hat)
by Jon McGuire, from its content repository [Volt's Laboratory](https://github.com/MV10/volts-laboratory)
— visualizers, post-processing effects and crossfades, most of them adaptations of
[Shadertoy](https://www.shadertoy.com) and [VertexShaderArt](https://www.vertexshaderart.com)
originals whose authors are credited in each `.conf` file and in `notes.txt` — and those of
[music_visualizer](https://github.com/bradleybauer/music_visualizer) by Bradley Bauer (GPL-3.0). Volt's
Laboratory carries no licence, and Shadertoy's default licence is CC BY-NC-SA 3.0. They are used
only on that owner's non-commercial site, with every shader's own credit lines kept and its
authors named in the preset list, and neither they nor anything converted from them ever becomes
part of this repository: the build converts them to GLSL ES 3.00 into the build output only
(`frontend/scripts/shader-visualizers.mjs`, `shader-glsl.mjs`, `shader-glsl-types.mjs`). They run
on this project's own WebGL 2 runner (`frontend/src/shared/visualizations/shaders/`), which feeds
them the audio data they were written for — the textures of [eyecandy](https://github.com/MV10/eyecandy)
(MIT, Jon McGuire) and music_visualizer's per-channel wave and spectrum — computed independently
from the player's analyser, and runs music_visualizer's geometry shaders as instanced vertex
shaders. The pictures and videos the shaders sample come from Volt's Laboratory's `textures/`
folder, also only in `frontend/vendor/shader-visualizers/`: Shadertoy's standard textures (no
licence stated), the cube maps of Emil Persson (Humus, http://www.humus.name), licensed
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), the "oc2k1 NASA Earth" cube map (source
not stated), and Volt's Laboratory's own starship pictures and costume videos (no licence, like
the rest of that repository). Without them Shadertoy's noise textures are generated, its
photographs replaced by generated stand-ins and the cube maps by a generated sky, and the two
effects that need the starship pictures and the videos are left out.

The Klasyka retro visualizer (`frontend/src/shared/visualizations/retro/`) recreates the looks of
early music visualizers. Its Atari Video Music presets are this project's own simulation of the
circuit described in US patent 4,081,829 (Robert J. Brown, Atari, 1978), drawn in its schematic
(CA010270) and set up as the C240's owner's manual describes; Atari and Video Music are
trademarks of their owners, who neither made nor endorse it. Its tracker screens (Ultimate
Soundtracker, D.O.C SoundTracker, NoiseTracker, Future Composer, SidMon, SidMon II, OctaMED, Oktalyzer,
ProTracker, AHX, Composer 669, Scream Tracker, Fasttracker II, Impulse Tracker, ModPlug Tracker,
SoundMonitor, JCH Editor, Soundtracker DMA, Arkos Tracker) are tributes drawn for this project —
layouts, bitmap fonts and colours made by hand after screenshots, with no code or data of the
programs or of their clones; the programs' names belong to their owners. Its Cthugha98,
Cthugha-4-Winamp and VSG+ presets are this project's own recreations, made after the programs'
descriptions, pages, recordings and screenshots, with nothing of their code or binaries:
Cthugha98 is Kevin "Zaph" Burfitt's, Cthugha-4-Winamp Krunoslav Pisačić's, VSG Neven Pintaric's,
and VSG+ is the name fomalhaut gave its version of it. Its Cthugha presets need ports of Cthugha
5.3 (DOS) and Cthugha-L 1.4 (with its OpenGL program, glcthugha, drawn with WebGL) that an owner
may keep in `frontend/vendor/cthugha/` (git-ignored), where ports of Cthugha98 0.6a (with its
3Dfx build) and Cthugha-4-Winamp 1.50, made from the owner's copies of the programs by static
analysis of their machine code, may also take the places of the recreations:
Cthugha — Audio Seeded Image Processing is © 1993–1998 Kevin "Zaph" Burfitt, Torps Productions,
and Cthugha-L © 1995–97 Harald Deischinger, and their source licence allows the code in other
programs only non-commercially and with credit to Cthugha, Torps Productions and Harald
Deischinger; Cthugha98 is postcardware, Cthugha-4-Winamp (Krunoslav Pisačić, beat detection by
Justin Frankel) free for personal use only (the folder keeps the terms as `COPYING-cthugha-53.txt`,
`COPYING-cthugha-L.txt`, `COPYING-cthugha98.txt` and `COPYING-cthugha4winamp.txt`). The ports and
what was converted from the programs' files — their palettes (among them Fractint's maps and Todd Hedenstrom's 'chromatic' map), their pictures
(among them "Images and Colors for Cthugha", © 1989, 1993–1994 Dmitry Altukhov) and their
translation tables (after mkgentable by Zaph and the generators of Ofer Faigon, and Cthugha-4-Winamp's
tab generators by Tom Willaert, Simon Werner and Kasuha) — are used only
on that owner's non-commercial site and never become part of this repository; without the
folder the visualizer offers its own presets only. The port's OpenGL text uses GLUT's Mono Roman
stroke font as freeglut keeps it (© 1999–2000 Pawel W. Olszta, MIT-style licence, its notice kept
with it).

