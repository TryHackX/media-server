import assert from "node:assert/strict";
import test from "node:test";

import { safeLanding } from "./landing.ts";

const ORIGIN = "https://media.example";
const land = (next: string | null, base = "/"): string => safeLanding(next, ORIGIN, base, `${base}login/`, base);

test("a page of the application is kept, with its query and hash", () => {
  assert.equal(land("/music/?collection=1#x"), "/music/?collection=1#x");
  assert.equal(land("/movies/"), "/movies/");
  assert.equal(land("/app/account/", "/app/"), "/app/account/");
});

test("anything that leaves the origin goes home (the audit's open redirect and its relatives)", () => {
  for (const next of ["/\\127.0.0.1:9/audit", "//evil.example/x", "\\\\evil.example", "https://evil.example/", "/\\/evil.example",
    "javascript:alert(1)", "data:text/html,x", " //evil.example", "/%5C127.0.0.1:9/audit".replace("%5C", "\\")]) {
    assert.equal(land(next), "/", next);
  }
});

test("outside the base, the sign-in page itself, nothing or garbage: home", () => {
  assert.equal(land("/other/", "/app/"), "/app/");
  assert.equal(land("/login/"), "/");
  assert.equal(land("/login/?next=/music/"), "/");
  assert.equal(land(null), "/");
  assert.equal(land(""), "/");
  assert.equal(land("http://[::1"), "/");
});
