import assert from "node:assert/strict";
import test from "node:test";

// The module reads and writes storage only when asked, so a plain map stands in
// for the browser's (Node's own `localStorage` wants a backing file).
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
});

const { agentLabel, normaliseDeviceLabel, onDeviceLabelChange, ownDeviceLabel, setDeviceLabel } =
  await import("./device-label.ts");

test("the name read from the user agent tells the phone from the desktop", () => {
  assert.equal(agentLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36", "?"), "Windows · Chrome");
  assert.equal(agentLabel("Mozilla/5.0 (Linux; Android 14) Firefox/131.0", "?"), "Android · Firefox");
  assert.equal(agentLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Edg/130.0", "?"), "Windows · Edge");
  assert.equal(agentLabel("curl/8.0", "Nieznane urządzenie"), "Nieznane urządzenie");
});

test("a name given by hand is kept tidy, and an empty one removes it", () => {
  store.clear();
  assert.equal(ownDeviceLabel(), "");
  assert.equal(setDeviceLabel("  Salon  ·  Firefox  "), "Salon · Firefox");
  assert.equal(ownDeviceLabel(), "Salon · Firefox");
  assert.equal(setDeviceLabel("   "), "");
  assert.equal(store.size, 0);
});

test("a name is cut to the 64 bytes the bridge keeps, between characters", () => {
  // 40 Polish letters are 80 bytes; the bridge measures with strlen and would
  // refuse every queue save that carried them.
  const fitted = normaliseDeviceLabel("ż".repeat(40));
  assert.equal(fitted, "ż".repeat(32));
  assert.equal(new TextEncoder().encode(fitted).length, 64);
  assert.equal(normaliseDeviceLabel("a".repeat(63) + "ż"), "a".repeat(63));
  // One line, no control characters: the bridge refuses those too.
  assert.equal(normaliseDeviceLabel("Pokój\n\tdzieci\u0007"), "Pokój dzieci");
});

test("whoever listens hears about a rename at once", () => {
  store.clear();
  let heard = 0;
  const stop = onDeviceLabelChange(() => { heard += 1; });
  setDeviceLabel("Laptop w kuchni");
  assert.equal(heard, 1);
  stop();
  setDeviceLabel("");
  assert.equal(heard, 1);
});
