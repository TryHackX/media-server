/**
 * Cthugha for "Klasyka retro", for an owner who wants it on their own site.
 *
 * Cthugha-L's C source (Harald Deischinger, after Cthugha by Kevin "Zaph" Burfitt and Torps
 * Productions) may be used in other programs only non-commercially and with credit, so a port of
 * it cannot be part of this MIT repository. An owner may keep one in
 * `frontend/vendor/cthugha/` (git-ignored): `catalog.ts` exporting `CTHUGHA_PRESETS`
 * (`{ id, name, group? }[]`) and `index.ts` exporting `createCthughaScene(id)`, which returns a
 * scene of shared/visualizations/retro/types.ts. The build then lists those presets under the
 * heading "Cthugha", or under `group` (whose own presets then make way); the engine itself is a
 * chunk of its own, fetched when one of them is first shown.
 * Without the folder the module is `null` and the build is as it was: the other presets of
 * "Klasyka retro" are the repository's own.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const VIRTUAL_ID = "virtual:retro-cthugha";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const slashes = (path) => path.replace(/\\/g, "/");

/** `directory` is relative to the Vite root (frontend/) unless absolute. */
export function retroCthugha(options) {
  let catalog = "";
  let entry = "";
  let found = false;
  return {
    name: "tryhackx-retro-cthugha",
    configResolved(config) {
      const directory = isAbsolute(options.directory) ? options.directory : join(config.root, options.directory);
      catalog = join(directory, "catalog.ts");
      entry = join(directory, "index.ts");
      found = existsSync(catalog) && existsSync(entry);
      if (found) config.logger.info(`Klasyka retro: Cthugha from ${options.directory}`);
    },
    resolveId(source) {
      return source === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      if (!found) return "export default null;";
      return [
        `import { CTHUGHA_PRESETS } from ${JSON.stringify(slashes(catalog))};`,
        `export default { presets: CTHUGHA_PRESETS, load: () => import(${JSON.stringify(slashes(entry))}) };`
      ].join("\n");
    }
  };
}
