import assert from "node:assert/strict";
import test from "node:test";

import { adoptIsoTimes, formatServerTime, isPast, minutesSince, parseServerTime } from "./datetime.ts";

test("a value with an offset is the instant it names, whatever zone the reader is in", () => {
  const instant = Date.UTC(2026, 10, 11, 19, 14, 3);
  assert.equal(parseServerTime("2026-11-11T19:14:03+00:00"), instant);
  assert.equal(parseServerTime("2026-11-11T19:14:03Z"), instant);
  assert.equal(parseServerTime("2026-11-11T20:14:03+01:00"), instant);
  assert.equal(parseServerTime("2026-11-11T20:14:03+0100"), instant);
  assert.equal(parseServerTime("2026-11-11T14:14:03-05:00"), instant);
  assert.equal(parseServerTime("2026-11-12T00:44:03+05:30"), instant);
  assert.equal(parseServerTime("2026-11-11 19:14:03.250+00:00"), instant + 250);
});

test("a value without a zone is the database's wall clock, read as local time", () => {
  assert.equal(parseServerTime("2026-11-11 20:14:03"), new Date(2026, 10, 11, 20, 14, 3).getTime());
  assert.equal(parseServerTime("2026-11-11T20:14"), new Date(2026, 10, 11, 20, 14, 0).getTime());
  assert.equal(parseServerTime("2026-11-11"), new Date(2026, 10, 11).getTime());
});

test("anything else is not a time", () => {
  for (const value of ["", "now", "11.11.2026", "2026-13-01 10:00:00", "2026-11-11 25:00:00", null, undefined]) {
    assert.ok(Number.isNaN(parseServerTime(value as string | null | undefined)), String(value));
  }
});

test("written out for a person, in the interface language", () => {
  const polish = formatServerTime("2026-11-11 20:14:03", "pl-PL");
  assert.match(polish, /11/);
  assert.match(polish, /2026/);
  assert.match(polish, /20:14/);
  assert.doesNotMatch(polish, /:03/);
  const english = formatServerTime("2026-11-11 20:14:03", "en-GB");
  assert.match(english, /Nov/);
  assert.match(english, /20:14/);
  assert.doesNotMatch(formatServerTime("2026-11-11 20:14:03", "pl-PL", false), /20:14/);
  // An audit trail is read to the second.
  assert.match(formatServerTime("2026-11-11 20:14:03", "pl-PL", "seconds"), /20:14:03/);
});

test("a value that is not a time is shown as it came, cut to the minute, never as Invalid Date", () => {
  assert.equal(formatServerTime("soon", "pl-PL"), "soon");
  assert.equal(formatServerTime("2026-99-99T10:11:12", "pl-PL"), "2026-99-99 10:11");
  assert.equal(formatServerTime("2026-99-99T10:11:12", "pl-PL", "seconds"), "2026-99-99 10:11:12");
  assert.equal(formatServerTime(null, "pl-PL"), "");
});

test("minutes since, and whether a moment has passed", () => {
  const now = Date.UTC(2026, 10, 11, 20, 0, 0);
  assert.equal(minutesSince("2026-11-11T19:48:30+00:00", now), 11);
  assert.equal(minutesSince("2026-11-11T20:10:00+00:00", now), -10);
  assert.ok(Number.isNaN(minutesSince("?", now)));
  assert.equal(isPast("2026-11-11T19:59:59+00:00", now), true);
  assert.equal(isPast("2026-11-11T20:00:01+00:00", now), false);
  // A link whose expiry cannot be read is not declared expired.
  assert.equal(isPast("?", now), false);
  // The case that used to go wrong: 20:30 in Warsaw is 19:30 UTC, half an hour ago — not in half an hour.
  assert.equal(isPast("2026-11-11T20:30:00+01:00", now), true);
});

test("an answer's times become the instants the bridge named beside them", () => {
  const answer = {
    sessions: [
      { id: 1, created_at: "2026-11-11 20:19:17", created_at_iso: "2026-11-11T19:19:17+00:00", last_seen_at: null, last_seen_at_iso: null },
      { id: 2, created_at: "2026-11-11 21:00:00" }
    ],
    digest: { covered_until: "2026-11-10 00:00:00", covered_until_iso: "2026-11-09T23:00:00+00:00" },
    total: 2
  };
  const same = adoptIsoTimes(answer);
  assert.equal(same, answer);
  assert.equal(answer.sessions[0]!.created_at, "2026-11-11T19:19:17+00:00");
  assert.equal(answer.sessions[0]!.last_seen_at, null);
  // An older bridge sends no sibling: the value stays as it came, and is read as local time as before.
  assert.equal(answer.sessions[1]!.created_at, "2026-11-11 21:00:00");
  assert.equal(answer.digest.covered_until, "2026-11-09T23:00:00+00:00");
  assert.equal(parseServerTime(answer.sessions[0]!.created_at), Date.UTC(2026, 10, 11, 19, 19, 17));
});

test("nothing is invented: a lone _iso field, a non-string one and plain values are left alone", () => {
  const answer: Record<string, unknown> = { generated_iso: "2026-11-11T19:19:17+00:00", played_at: "x", played_at_iso: 5, list: [1, "a", null] };
  adoptIsoTimes(answer);
  assert.deepEqual(answer, { generated_iso: "2026-11-11T19:19:17+00:00", played_at: "x", played_at_iso: 5, list: [1, "a", null] });
  assert.equal(adoptIsoTimes(null), null);
  assert.equal(adoptIsoTimes("text"), "text");
});
