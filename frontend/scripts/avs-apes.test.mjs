import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { avsApes, findApePorts } from "./avs-apes.mjs";

test("the ports of a vendor folder: modules that are not tests, and data files by lower-case name", () => {
  const root = mkdtempSync(join(tmpdir(), "avs-apes-"));
  try {
    mkdirSync(join(root, "files"));
    writeFileSync(join(root, "tv.ts"), "export const ape = { id: 'Nullsoft TV v1', create() { return { render() { return 0; } }; } };");
    writeFileSync(join(root, "tv.test.ts"), "");
    writeFileSync(join(root, "SOURCE.txt"), "");
    writeFileSync(join(root, "files", "Sphere.ASC"), "mesh");
    const found = findApePorts(root);
    assert.deepEqual(found.ports.map((path) => path.slice(root.length + 1)), ["tv.ts"]);
    assert.deepEqual(found.files.map((file) => file.name), ["sphere.asc"]);
    const plugin = avsApes({ directory: root });
    plugin.configResolved({ root: "/", logger: { info() {} } });
    assert.match(plugin.load("\0virtual:avs-apes"), /import\("virtual:avs-apes-entry"\)/);
    const entry = plugin.load("\0virtual:avs-apes-entry");
    assert.match(entry, /export const apes = /);
    assert.match(entry, /"sphere\.asc": file0/);
    assert.equal(findApePorts(join(root, "missing")).ports.length, 0);
    const none = avsApes({ directory: join(root, "missing") });
    none.configResolved({ root: "/", logger: { info() {} } });
    assert.equal(none.load("\0virtual:avs-apes"), "export default null;");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
