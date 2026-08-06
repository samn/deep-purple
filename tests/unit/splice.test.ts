import { describe, expect, it } from "vitest";
import { spliceRuns, type ForecastRun } from "../../src/lib/splice.ts";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso).getTime();

/** HRRR's hourly product: 0..18 h from `iso`. */
const run18 = (iso: string): ForecastRun => ({
  initTimeMs: at(iso),
  leadHours: Array.from({ length: 19 }, (_, i) => i),
});

/** HRRR's six-hourly product: 0..48 h from `iso`. */
const run48 = (iso: string): ForecastRun => ({
  initTimeMs: at(iso),
  leadHours: Array.from({ length: 49 }, (_, i) => i),
});

describe("spliceRuns", () => {
  it("starts at the newest init and runs to the last hour anything covers", () => {
    // The 18-hour run is 5 h fresher, so the 48-hour run's +48 h is only +43 h
    // from the start of the timeline — that is where the forecast ends.
    const t = spliceRuns([run18("2026-08-06T17:00Z"), run48("2026-08-06T12:00Z")]);
    expect(t.initTimeMs).toBe(at("2026-08-06T17:00Z"));
    expect(t.leadHours.at(-1)).toBe(43);
    expect(t.leadHours).toHaveLength(44);
    expect(t.leadHours).toEqual(t.leadHours.map((_, i) => i));
  });

  it("serves each hour from the freshest run that reaches it", () => {
    const t = spliceRuns([run18("2026-08-06T17:00Z"), run48("2026-08-06T12:00Z")]);
    // 0..18 from the hourly run, at its own lead numbers.
    for (let h = 0; h <= 18; h++) {
      expect(t.sources[h]).toEqual({ runIndex: 0, leadIndex: h });
    }
    // Past its reach, the six-hourly run takes over — at leads shifted by the
    // 5 h gap between the two inits, so the valid times still line up.
    expect(t.sources[19]).toEqual({ runIndex: 1, leadIndex: 24 });
    expect(t.sources[43]).toEqual({ runIndex: 1, leadIndex: 48 });
    expect(t.sources).toHaveLength(44);
  });

  it("keeps every frame's valid time equal to its timeline hour", () => {
    const runs = [run18("2026-08-06T17:00Z"), run48("2026-08-06T12:00Z")];
    const t = spliceRuns(runs);
    for (const [hour, source] of t.sources.entries()) {
      const run = runs[source.runIndex]!;
      const validMs = run.initTimeMs + run.leadHours[source.leadIndex]! * HOUR;
      expect(validMs).toBe(t.initTimeMs + hour * HOUR);
    }
  });

  it("uses the whole 48 hours when both runs share an init", () => {
    const t = spliceRuns([run18("2026-08-06T12:00Z"), run48("2026-08-06T12:00Z")]);
    expect(t.leadHours.at(-1)).toBe(48);
    // Same init, same data: the tie goes to the caller's order.
    expect(t.sources[0]).toEqual({ runIndex: 0, leadIndex: 0 });
    expect(t.sources[19]).toEqual({ runIndex: 1, leadIndex: 19 });
  });

  it("prefers the newer run even when it is listed second", () => {
    // The hourly store can lag behind the six-hourly one; freshness decides,
    // not the order the stores are configured in.
    const t = spliceRuns([run18("2026-08-06T11:00Z"), run48("2026-08-06T12:00Z")]);
    expect(t.initTimeMs).toBe(at("2026-08-06T12:00Z"));
    expect(t.sources[0]).toEqual({ runIndex: 1, leadIndex: 0 });
    expect(t.leadHours.at(-1)).toBe(48);
  });

  it("falls back to a single run", () => {
    const t = spliceRuns([run18("2026-08-06T17:00Z")]);
    expect(t.initTimeMs).toBe(at("2026-08-06T17:00Z"));
    expect(t.leadHours.at(-1)).toBe(18);
    expect(t.sources.every((s) => s.runIndex === 0)).toBe(true);
  });

  it("stops at the first uncovered hour rather than leaving a gap", () => {
    // A stale 48-hour run whose reach ends inside the hourly run's span: the
    // timeline must not resume on the far side of the hole.
    const t = spliceRuns([run18("2026-08-06T17:00Z"), run48("2026-08-04T12:00Z")]);
    expect(t.leadHours.at(-1)).toBe(18);
    expect(t.sources.every((s) => s.runIndex === 0)).toBe(true);
  });

  it("ignores runs offset by a fractional hour", () => {
    // Guards the integer-hour assumption the frame grid rests on: a run whose
    // init sits between hours has no lead landing on one of ours.
    const t = spliceRuns([run18("2026-08-06T17:30Z"), run48("2026-08-06T12:00Z")]);
    expect(t.initTimeMs).toBe(at("2026-08-06T17:30Z"));
    expect(t.sources.every((s) => s.runIndex === 0)).toBe(true);
    expect(t.leadHours.at(-1)).toBe(18);
  });

  it("rejects an empty or uncoverable set of runs", () => {
    expect(() => spliceRuns([])).toThrow(/No forecast runs/);
    expect(() => spliceRuns([{ initTimeMs: at("2026-08-06T12:00Z"), leadHours: [] }])).toThrow(
      /cover no common hour/,
    );
  });
});
