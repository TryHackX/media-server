/**
 * The lettering of SidMon 1's pattern editor (sidmon1.ts), drawn for this project by hand as
 * text after screenshots of the program, with the reader of its sheets and SidMon's spelling of
 * a note. Without runtime imports, so the tests read them as they are (trackers-amiga2.test.ts).
 *
 * - SM1_LABEL: the engraved labels of its plates, 7 rows, as wide as each letter: '#' the dark
 *   blue of the letter, '+' the lighter blue where its strokes round off.
 * - SM1_VALUE: the white figures and letters of its black fields, 7 rows on cells of 8; B, F
 *   and '#' (no screenshot shows them) drawn in the same manner as D, E and the rest.
 */

/** A block: a line of the characters, then the rows, the glyphs side by side, a space between. */
export const SM1_LABEL = `
A    B    C    D    E    G    I     K    L    N     O    P    R    S    T     Y    -
+##+ ###+ +##+ ###+ #### +##+ +###+ #..# #... +...# +##+ ###+ ###+ +##+ ##### #..# ...
#..# #..# #..# #..# #... #..# ..#.. #..# #... #+..# #..# #..# #..# #..# +.#.+ #..# ...
#..# #..# #... #..# #... #... ..#.. #.## #... ##+.# #..# #..# #..# #... ..#.. #..# ...
#### ###+ #... #..# ###. #... ..#.. ###. #... #+#+# #..# ###+ ###+ +##+ ..#.. +### ###
#..# #..# #... #..# #... #.## ..#.. #+## #... #.+## #..# #... #+#. ...# ..#.. ...# ...
#..# #..# #..# #..# #... #..# ..#.. #.+# ##.. #..+# #..# #... #.+# #..# ..#.. ...# ...
#..# ###+ +##+ ###+ #### +##+ +###+ #..# #### #...+ +##+ #... #..# +##+ ..#.. ###+ ...
`;

export const SM1_VALUE = `
0       1       2       3       4       5       6       7
.#####. ..##... ######. ######. ##..... ####### .###### #######
####### .###... ####### ####### ##..... ####### ####### #######
##..### ..##... ....### .....## ##..##. ##..... ##..... ....###
##.#.## ..##... ..####. .#####. ##..##. ######. ######. ...###.
###..## ..##... ####... .....## ####### ....### ##...## ..###..
####### ######. ####### ####### ####### ####### ####### ..###..
.#####. ######. ####### ######. ....##. ######. .#####. ..###..
8       9       A       B       C       D       E       F
.#####. .#####. ....##. ######. .#####. ######. .###### .######
####### ####### ..##### ####### ####### ####### ####### #######
##...## ##...## ..##.## .....## ##...## .....## ##..... ##.....
.#####. ####### .##..## ######. ##..... ##...## ####### ######.
##...## .....## .###### ##...## ##...## ##...## ##..... ##.....
####### ####### ##...## ####### ####### ####### ####### ##.....
.#####. .#####. ##...## ######. .#####. ######. .###### ##.....
G       -       #
.#####. ....... .##.##.
####### ....... #######
##..... ....... .##.##.
##..### ######. .##.##.
##...## ....... #######
####### ....... .##.##.
.#####. ....... .......
`;

/** A glyph of the sheets above: its rows as text. */
export interface Glyph {
  width: number;
  rows: string[];
}

/** Reads a sheet: blocks of a line of characters and seven rows, each glyph up to the next. */
export function readSheet(text: string): Map<string, Glyph> {
  const glyphs = new Map<string, Glyph>();
  const lines = text.split("\n").filter((line) => line.length > 0);
  for (let block = 0; block + 7 < lines.length; block += 8) {
    const header = lines[block]!;
    const rows = lines.slice(block + 1, block + 8);
    const starts: number[] = [];
    for (let i = 0; i < header.length; i += 1) if (header[i] !== " ") starts.push(i);
    const length = Math.max(...rows.map((row) => row.length));
    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1]! - 1 : length;
      glyphs.set(header[start]!, { width: end - start, rows: rows.map((row) => row.slice(start, end).padEnd(end - start, ".")) });
    });
  }
  return glyphs;
}

const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** A note as SidMon spells it: name and octave; "---" for none. */
export function sidmonNote(note: number): string {
  if (note < 0 || note > 119) return "---";
  return `${NAMES[note % 12]}${Math.floor(note / 12)}`;
}
