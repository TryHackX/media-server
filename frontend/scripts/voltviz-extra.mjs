/**
 * VoltViz visualizations that are not MIT, for an owner who wants them on their own site.
 *
 * voltviz's Moss Ball (its shaders are ledhieu's imoss, CC BY-NC 4.0) and Flame (its shader is
 * kuvkar's on Shadertoy, CC BY-NC-SA 3.0) cannot be part of this repository. An owner may put
 * voltviz's own files for them — `src/visualizers/impl/MossBall.ts` and `Flame.ts` of voltviz
 * 0.35.1, unchanged — in `frontend/vendor/voltviz-extra/` (git-ignored). The build then lists
 * them in VoltViz beside the vendored ones, every visitor of that site gets them, and their
 * imports (`../lib/three`, `../runtime/types`) resolve into the vendored voltviz as if the files
 * sat in its `visualizers/impl/`. Without the folder the build is as it was.
 *
 * Only these two names are taken; anything else in the folder is ignored. Their names in the
 * panel carry their authors, as their licences ask.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const VIRTUAL_ID = "virtual:voltviz-extra";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** voltviz's registry entries for them (src/visualizers/registry.ts), with the credit. */
export const EXTRA_VISUALIZATIONS = {
  MossBall: { id: "mossball", name: "Moss Ball (ledhieu)" },
  Flame: { id: "flame", name: "Flame (kuvkar)" }
};

const same = (left, right) => resolve(left).replace(/\\/g, "/").toLowerCase() === resolve(right).replace(/\\/g, "/").toLowerCase();
const slashes = (path) => path.replace(/\\/g, "/");

/** `directory` and `impl` are relative to the Vite root (frontend/) unless absolute. */
export function voltvizExtra(options) {
  let directory = "";
  let impl = "";
  let found = [];
  return {
    name: "tryhackx-voltviz-extra",
    configResolved(config) {
      directory = isAbsolute(options.directory) ? options.directory : join(config.root, options.directory);
      impl = isAbsolute(options.impl) ? options.impl : join(config.root, options.impl);
      found = Object.entries(EXTRA_VISUALIZATIONS).filter(([file]) => existsSync(join(directory, `${file}.ts`)));
      if (found.length) config.logger.info(`VoltViz: ${found.map(([file]) => file).join(", ")} from ${options.directory}`);
    },
    async resolveId(source, importer) {
      if (source === VIRTUAL_ID) return RESOLVED_ID;
      // The vendored files' relative imports, as if they sat in the vendored voltviz's impl/.
      if (importer && source.startsWith(".") && same(dirname(importer.split("?")[0]), directory)) {
        return this.resolve(source, join(impl, "__voltviz_extra__.ts"), { skipSelf: true });
      }
      return null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const entries = found.map(([file, entry]) =>
        `{ id: ${JSON.stringify(entry.id)}, name: ${JSON.stringify(entry.name)}, ` +
        `load: () => import(${JSON.stringify(slashes(join(directory, `${file}.ts`)))}) }`);
      return `export default [${entries.join(", ")}];`;
    }
  };
}
