/**
 * Ports of AVS plug-ins without published source, for an owner who has them.
 *
 * Plug-ins (APE DLLs and the Sonique plug-ins AVS ran through its SVP Loader) whose authors never
 * published source cannot be part of this MIT repository. An owner may keep ports of them in
 * `frontend/vendor/avs-apes/` (git-ignored): every `*.ts` there that is not a test and exports
 * `ape` (`{ id, create(config, files) }`) or `svp` (`{ file, create() }`) in the shape of
 * src/shared/visualizations/avs/webvs/ape/apeHost.ts, plus data files a port reads at run time in
 * `files/` (e.g. 3D meshes, by lower-case name). The build lists them in `virtual:avs-apes`, whose
 * value is a loader for a chunk of their own (fetched when AVS starts), or null without the folder.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const VIRTUAL_ID = "virtual:avs-apes";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const ENTRY_ID = "virtual:avs-apes-entry";
const RESOLVED_ENTRY = `\0${ENTRY_ID}`;

const slashes = (path) => path.replace(/\\/g, "/");

/** The port modules and data files of a vendor folder. */
export function findApePorts(directory) {
  if (!existsSync(directory)) return { ports: [], files: [] };
  const ports = readdirSync(directory)
    .filter((name) => /\.ts$/i.test(name) && !/\.test\.ts$/i.test(name) && !/\.d\.ts$/i.test(name))
    .sort()
    .map((name) => join(directory, name));
  const filesDir = join(directory, "files");
  const files = existsSync(filesDir) && statSync(filesDir).isDirectory()
    ? readdirSync(filesDir).filter((name) => statSync(join(filesDir, name)).isFile()).sort().map((name) => ({ name: name.toLowerCase(), path: join(filesDir, name) }))
    : [];
  return { ports, files };
}

/** `directory` is relative to the Vite root (frontend/) unless absolute. */
export function avsApes(options) {
  let found = { ports: [], files: [] };
  return {
    name: "tryhackx-avs-apes",
    configResolved(config) {
      const directory = isAbsolute(options.directory) ? options.directory : join(config.root, options.directory);
      found = findApePorts(directory);
      if (found.ports.length) {
        config.logger.info(`AVS: ${found.ports.length} plug-in ports from ${options.directory}`);
      }
    },
    resolveId(source) {
      if (source === VIRTUAL_ID) return RESOLVED_ID;
      if (source === ENTRY_ID) return RESOLVED_ENTRY;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) {
        return found.ports.length ? `export default () => import(${JSON.stringify(ENTRY_ID)});` : "export default null;";
      }
      if (id === RESOLVED_ENTRY) {
        const lines = [];
        found.ports.forEach((path, k) => lines.push(`import * as port${k} from ${JSON.stringify(slashes(path))};`));
        found.files.forEach((file, k) => lines.push(`import file${k} from ${JSON.stringify(`${slashes(file.path)}?raw`)};`));
        const modules = found.ports.map((_, k) => `port${k}`).join(", ");
        lines.push(`const modules = [${modules}];`);
        lines.push("export const apes = modules.map((m) => m.ape).filter(Boolean);");
        lines.push("export const svps = modules.map((m) => m.svp).filter(Boolean);");
        lines.push(`export const files = {${found.files.map((file, k) => `${JSON.stringify(file.name)}: file${k}`).join(", ")}};`);
        return lines.join("\n");
      }
      return null;
    }
  };
}
