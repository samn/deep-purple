import { describe, expect, it } from "vitest";
import { ReadoutSampler, type SampleCell } from "../../src/lib/readoutSampler.ts";

const HOURS = [0, 1, 2];
const series = () => Float32Array.from([10, 11, 12]);

function setup(maxAttempts = 2) {
  const requests: { requestId: number; cell: SampleCell }[] = [];
  const timers: { cb: () => void; ms: number; cleared: boolean }[] = [];
  let changes = 0;
  const sampler = new ReadoutSampler({
    maxAttempts,
    retryDelayMs: 2000,
    request: (requestId, cell) => requests.push({ requestId, cell }),
    onChange: () => changes++,
    setTimeout: (cb, ms) => {
      const t = { cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.cb();
  };
  return { sampler, requests, timers, fire, changes: () => changes };
}

const CELL = { col: 10, row: 20 };

describe("ReadoutSampler", () => {
  it("is hidden without a location and loading while the read is held back", () => {
    const { sampler, requests } = setup();
    expect(sampler.readoutAt(0)).toEqual({ kind: "hidden" });
    sampler.setCell(CELL);
    expect(sampler.readoutAt(0)).toEqual({ kind: "loading" });
    expect(requests).toHaveLength(0);
  });

  it("sends one read once ready, and shows its values", () => {
    const { sampler, requests } = setup();
    sampler.setCell(CELL);
    sampler.setReady();
    sampler.setReady();
    sampler.setCell({ ...CELL });
    expect(requests).toEqual([{ requestId: 1, cell: CELL }]);
    sampler.onSeries(1, HOURS, series(), series());
    expect(sampler.readoutAt(1)).toEqual({ kind: "value", temperatureC: 11, dewpointC: 11 });
  });

  it("drops replies for a location it has moved away from", () => {
    const { sampler, requests } = setup();
    sampler.setReady();
    sampler.setCell(CELL);
    sampler.setCell({ col: 11, row: 20 });
    expect(requests.map((r) => r.requestId)).toEqual([1, 2]);
    sampler.onSeries(1, HOURS, series(), series());
    expect(sampler.readoutAt(1)).toEqual({ kind: "loading" });
    sampler.onFailed(1, true);
    expect(requests).toHaveLength(2);
  });

  it("waits out the backoff before retrying, however often it is poked", () => {
    const { sampler, requests, timers, fire } = setup();
    sampler.setReady();
    sampler.setCell(CELL);
    sampler.onFailed(1, true);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(2000);
    // Timeline ticks during the backoff must not spend the retry.
    for (let i = 0; i < 10; i++) sampler.readoutAt(i / 10);
    sampler.setReady();
    expect(requests).toHaveLength(1);
    expect(sampler.readoutAt(0)).toEqual({ kind: "loading" });
    fire();
    expect(requests).toHaveLength(2);
  });

  it("gives up after the last attempt, and on failures a retry can't fix", () => {
    const a = setup(2);
    a.sampler.setReady();
    a.sampler.setCell(CELL);
    a.sampler.onFailed(1, true);
    a.fire();
    a.sampler.onFailed(1, true);
    expect(a.timers).toHaveLength(0);
    expect(a.sampler.readoutAt(0)).toEqual({ kind: "hidden" });

    const b = setup(5);
    b.sampler.setReady();
    b.sampler.setCell(CELL);
    b.sampler.onFailed(1, false);
    expect(b.timers).toHaveLength(0);
    expect(b.sampler.readoutAt(0)).toEqual({ kind: "hidden" });
  });

  it("retries at once when the same cell is located again", () => {
    const { sampler, requests, timers } = setup(1);
    sampler.setReady();
    sampler.setCell(CELL);
    sampler.onFailed(1, true);
    expect(sampler.readoutAt(0)).toEqual({ kind: "hidden" });
    sampler.setCell({ ...CELL });
    expect(requests).toHaveLength(2);
    expect(sampler.readoutAt(0)).toEqual({ kind: "loading" });

    // A pending backoff is cancelled rather than firing a second read.
    const s = setup(3);
    s.sampler.setReady();
    s.sampler.setCell(CELL);
    s.sampler.onFailed(1, true);
    s.sampler.setCell({ ...CELL });
    expect(s.requests).toHaveLength(2);
    s.fire();
    expect(s.requests).toHaveLength(2);
    expect(timers).toHaveLength(0);
  });

  it("hides and cancels when the location leaves the grid", () => {
    const { sampler, requests } = setup();
    sampler.setReady();
    sampler.setCell(CELL);
    sampler.setCell(null);
    expect(sampler.readoutAt(0)).toEqual({ kind: "hidden" });
    sampler.onSeries(1, HOURS, series(), series());
    expect(sampler.readoutAt(0)).toEqual({ kind: "hidden" });
    expect(requests).toHaveLength(1);
  });
});
