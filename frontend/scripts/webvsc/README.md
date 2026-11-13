# webvsc (vendored, patched)

Copy of [`@visbot/webvsc`](https://github.com/grandchild/AVS-File-Decoder) 2.3.0
(MIT, see `LICENSE-webvsc.txt`), the converter from Winamp AVS presets (`.avs`)
to webvs JSON, used by `../avs-presets.mjs` at build time. Kept here because
of fixes the published package does not have; each is marked `Fork (TryHackX)`:

- `lib/util.js` `getBufferNum`: called with the preset's bytes, it took the
  byte array for the buffer number. The value came out as the first byte of the
  surrounding effect list (254, 21, 36, 40…) and every field after it shifted:
  Dynamic Movement's source buffer and "alpha only", Bump's depth buffer, and
  Buffer Save's buffer, blend mode and adjustable value.
- `lib/tables.js`: AVS's last effect list blend mode, "Minimum" (input 13,
  output 12), was missing; such lists came without the option.
- `lib/log.js`: plain console output instead of chalk, so the copy has no
  dependencies.
- `browser.js` `decode_movement`: Movement's fields were read a byte early (the
  new-version marker was not skipped), so 39 of 101 rectangular movements came
  out polar; a leading `!rect ` is taken off the code, "source mapped" and its
  on-beat toggle are read as AVS's two bits, and the effect id comes from where
  AVS keeps it. Each setting after the code is read only while the block still
  has four bytes for it, as `r_trans.cpp`'s `load_config` does; a short block
  (older AVS versions) keeps AVS's defaults — no blend, not source mapped,
  polar, no bilinear, no wrap. webvsc read on into the next component, so in
  the presets at hand 110 movements came out wrapping and 52 bilinear that AVS
  ran without either (66 presets, mostly AVSociety vol. 1–2). A `!rect `
  prefix is skipped the way AVS skips it (the old fixed code block is then
  250 bytes long), and with no rectangular field it makes the movement
  rectangular.
- `lib/util.js` `getCodeEIF`: an effect list's code was read from the "use code"
  flag itself, so every list's code came out empty or a character short.
- `lib/util.js` `getRadioButton`: it looped over `map.length` of an object map —
  never — and moved on by NaN bytes, so every field after it was read from
  nowhere. Its only user, Custom BPM, came out "arbitrary, 21, 21, 21" whatever
  the preset held (in the presets at hand: "skip every n-th beat", none skipped
  at the start).
- `lib/components.js`, fields checked against each `r_*.cpp`'s `load_config`:
  Oscilloscope Star's `size` and `rotation` and Interferences' distances, alphas
  and turns are signed ints (a star turning at −16 came out as 4294967280);
  Interferences' starting rotation and the saved rotation of Dot Plane and Dot
  Fountain (×32) were skipped as padding (`null0`) and are `initialRotation` and
  `rotation` now; Interferences with both blend flags set is 50/50, as in AVS,
  where the map had no key and threw (losing the whole preset).
- `lib/tables.js`: Set Render Mode's tenth mode, "Minimum Blend", was missing.
- `lib/util.js` `getCodeFBI` (Bump only): `r_bump.cpp` stores the per-frame code
  first and the beat code second; webvsc read them the other way round. All 106
  Bumps of the presets at hand (101 presets) have per-frame code — most the
  default `x=0.5+cos(t)*0.3; …; t=t+0.1` — so their light moved only on beats,
  and the beat code of 18 ran every frame.
- `browser.js` `decode_effectList`: an effect list's code block ("AVS 2.8+ Effect
  List Config") was recognised only under the effect number 16384. AVS
  (`r_list.cpp` `load_config`) knows it by its name alone, under any number from
  DLLRENDERBASE up, in a list with the extended settings; four presets of the
  VISBOT archive (2026-11) store it under another number (20374860, 45415716…)
  and lost their lists' code to an "unknown effect".
- `lib/components.js`: Text's `shiftX` and `shiftY` are signed ints (`r_text.cpp`,
  a percentage of the window); read unsigned, a shift of −8 came out as
  4294967288 and the text was drawn off screen — 1,236 Text effects of the
  presets at hand (2026-11) have a negative shift.

Not changed here but worth knowing: what webvsc calls the Convolution Filter's
`edgeMode` (`EXTEND`/`WRAP`) is AVS's "wrap" flag — a negative result wraps
round to white — not an edge mode; AVS always extends the picture's edges. The
engine reads it that way (`webvs/trans/Extras.ts`, `Convolution.ts`).
