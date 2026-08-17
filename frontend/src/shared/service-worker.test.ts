import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

/*
 * The offline shell is anchored to one value — where the application lives —
 * and every rule in the worker is expressed in terms of it. When it was written
 * by hand it survived the move from `/media-next/` to the root without a single
 * error: the worker installed, activated, and then ignored every request there
 * was. Nothing tells you that has happened, which is exactly why it is worth a
 * test.
 *
 * `sw.js` is a public asset, so it cannot be imported: it runs in a worker
 * scope, not a module scope. It is loaded here into a fake one, which also lets
 * the handlers it registers be called directly.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

type Scope = {
  BASE: string;
  SHELL: string[];
  handlers: Map<string, (event: unknown) => void>;
};

function load(workerUrl: string): Scope {
  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    location: new URL(workerUrl),
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() }
  };
  // Enough of the two APIs the worker reaches for that its handlers can run;
  // what they return is beside the point here, only which requests reach them.
  const cache = {
    add: () => Promise.resolve(),
    put: () => Promise.resolve(),
    match: () => Promise.resolve(undefined)
  };
  const caches = {
    open: () => Promise.resolve(cache),
    match: () => Promise.resolve(undefined),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true)
  };
  const context = vm.createContext({
    self,
    URL,
    Response,
    caches,
    fetch: () => Promise.resolve(new Response("", { status: 200 }))
  });
  // The completion value of the script: `const` declarations live in the
  // script's own lexical scope, so they are read by evaluating them there.
  const { BASE, SHELL } = vm.runInContext(`${SOURCE}\n;({ BASE, SHELL })`, context) as {
    BASE: string;
    SHELL: string[];
  };
  return { BASE, SHELL, handlers };
}

test("the base is where the worker itself was served, not a path written by hand", () => {
  assert.equal(load("https://example.test/sw.js").BASE, "/");
  assert.equal(load("https://example.test/media-next/sw.js").BASE, "/media-next/");
});

test("the precached shell is anchored to that base", () => {
  const root = load("https://example.test/sw.js");
  assert.ok(root.SHELL.includes("/"));
  assert.ok(root.SHELL.includes("/music/"));

  const nested = load("https://example.test/media-next/sw.js");
  assert.ok(nested.SHELL.every((url) => url.startsWith("/media-next/")));
  assert.ok(nested.SHELL.includes("/media-next/music/"));
});

test("a request outside the application is left alone", () => {
  const { handlers } = load("https://example.test/media-next/sw.js");
  const fetchHandler = handlers.get("fetch");
  assert.ok(fetchHandler);

  let answered = false;
  const event = {
    request: new Request("https://example.test/other-app/index.html", { method: "GET" }),
    respondWith: () => {
      answered = true;
    }
  };
  fetchHandler(event);
  assert.equal(answered, false, "the worker must not answer for anything outside its own base");
});

test("a page inside the application is answered", () => {
  const { handlers } = load("https://example.test/media-next/sw.js");
  const fetchHandler = handlers.get("fetch");
  assert.ok(fetchHandler);

  let answered = false;
  const request = new Request("https://example.test/media-next/music/", { method: "GET" });
  Object.defineProperty(request, "mode", { value: "navigate" });
  fetchHandler({
    request,
    respondWith: () => {
      answered = true;
    }
  });
  assert.equal(answered, true);
});
