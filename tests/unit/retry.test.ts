import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientLoadError, TimeoutError, withRetry } from "../../src/lib/retry.ts";

const OPTS = { attempts: 3, timeoutMs: 1000, backoffMs: 100 };

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the first success", async () => {
    const fn = vi.fn(async () => 42);
    await expect(withRetry(fn, OPTS)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries failures with doubling backoff, then succeeds", async () => {
    const calls: number[] = [];
    const fn = vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length < 3) throw new Error("flaky");
      return "ok";
    });
    const p = withRetry(fn, OPTS);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls[1]! - calls[0]!).toBe(100);
    expect(calls[2]! - calls[1]!).toBe(200);
  });

  it("aborts and retries an attempt that hangs", async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      // First attempt never settles, even when aborted; the second answers.
      return signals.length === 1 ? new Promise<string>(() => {}) : Promise.resolve("late");
    });
    const p = withRetry(fn, OPTS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[0]!.reason).toBeInstanceOf(TimeoutError);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("late");
  });

  it("rethrows the last error once attempts run out", async () => {
    let n = 0;
    const p = withRetry(async () => {
      throw new Error(`fail ${++n}`);
    }, OPTS);
    const assertion = expect(p).rejects.toThrow("fail 3");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("stops at once on an error the caller marks unretryable", async () => {
    const fn = vi.fn(async () => {
      throw new RangeError("corrupt");
    });
    await expect(withRetry(fn, { ...OPTS, retryable: (e) => !(e instanceof RangeError) })).rejects.toThrow("corrupt");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientLoadError", () => {
  const err = (message: string, name = "Error") => Object.assign(new Error(message), { name });

  it("retries timeouts, network drops, throttling and server errors", () => {
    expect(isTransientLoadError(new TimeoutError("timed out"))).toBe(true);
    expect(isTransientLoadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientLoadError(err("Failed to fetch virtual chunk from https://x/y.grib2: 503 Service Unavailable"))).toBe(true);
    expect(isTransientLoadError(err("HTTP 500 Internal Server Error for https://x/y"))).toBe(true);
    expect(isTransientLoadError(err("Failed to fetch virtual chunk from https://x: 429 Too Many Requests"))).toBe(true);
  });

  it("gives up on missing objects, refusals and corrupt data", () => {
    expect(isTransientLoadError(err("Failed to fetch virtual chunk from https://x/y.grib2: 404 Not Found"))).toBe(false);
    expect(isTransientLoadError(err("HTTP 403 Forbidden for https://x/y"))).toBe(false);
    expect(isTransientLoadError(err("Packed data ends early", "GribDecodeError"))).toBe(false);
    expect(isTransientLoadError(err("Object not found: manifests/ABC", "NotFoundError"))).toBe(false);
  });
});
