/**
 * Bookkeeping for the located-point readout: which grid cell is being read,
 * whether its series has arrived, and when a failed read may be retried.
 *
 * The read itself is one message to the data worker per location; this class
 * decides when to send it and turns replies into what the readout shows. It
 * holds no timers or worker of its own beyond what it is handed, so the whole
 * state machine is unit-testable.
 */
import { PointSeries } from "./pointSeries.ts";

/**
 * What the readout should show. `loading` keeps the labels and stands a
 * placeholder where each value will land, so the row doesn't jump when the
 * numbers arrive; `hidden` is for no location at all.
 */
export type ReadoutState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "value"; temperatureC: number; dewpointC: number };

export interface SampleCell {
  col: number;
  row: number;
}

export interface ReadoutSamplerOptions {
  /** Attempts per location before giving up on transient failures. */
  maxAttempts: number;
  /** Wait after a retryable failure before the next attempt. */
  retryDelayMs: number;
  /** Send a read; its reply must come back through `onSeries`/`onFailed`. */
  request(requestId: number, cell: SampleCell): void;
  /** What `readoutAt` returns may have changed without the timeline moving. */
  onChange(): void;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * - `idle`: nothing in flight; a read goes out as soon as one is allowed.
 * - `loading`: a read is in flight.
 * - `backoff`: the last read failed and a retry is scheduled. Nothing is sent
 *   until the timer fires — callers poke the sampler on every timeline tick,
 *   and retrying from there would spend the budget within a frame or two.
 * - `loaded`: the series is in hand.
 * - `gaveUp`: out of attempts, or the failure can't be retried.
 */
type State = "idle" | "loading" | "backoff" | "loaded" | "gaveUp";

export class ReadoutSampler {
  readonly series = new PointSeries();

  private readonly opts: ReadoutSamplerOptions;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private cell: SampleCell | null = null;
  /** Bumped per location so replies for a superseded one are dropped. */
  private requestId = 0;
  private state: State = "idle";
  private attempts = 0;
  private ready = false;
  private retryTimer: unknown = null;

  constructor(opts: ReadoutSamplerOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Allow reads to go out. The map's frames come first — the overlay is what
   * the user is looking at, and it shares the worker and the connection with
   * the point read — so the caller holds this back until the first frame pass
   * has landed.
   */
  setReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.maybeRequest();
  }

  /**
   * Point the readout at a grid cell, or at nothing. A repeat of the current
   * cell keeps the series already paid for, but is also the natural moment to
   * retry a read that failed: geolocation keeps returning the same cached
   * position, so nothing else would ever bring the readout back.
   */
  setCell(cell: SampleCell | null): void {
    const same = cell !== null && this.cell !== null && cell.col === this.cell.col && cell.row === this.cell.row;
    if (same) {
      if (this.state === "gaveUp" || this.state === "backoff") this.reset();
      this.maybeRequest();
      return;
    }
    this.cell = cell;
    // Bump the id even when clearing: a reply still in flight for the previous
    // cell must not land in the readout after it has moved on.
    this.requestId++;
    this.series.clear();
    this.reset();
    this.maybeRequest();
  }

  onSeries(requestId: number, leadHours: number[], temperatureC: Float32Array, dewpointC: Float32Array): void {
    if (requestId !== this.requestId) return;
    this.state = "loaded";
    this.series.setSeries(leadHours, temperatureC, dewpointC);
    this.opts.onChange();
  }

  onFailed(requestId: number, retryable: boolean): void {
    if (requestId !== this.requestId) return;
    if (!retryable || this.attempts >= this.opts.maxAttempts) {
      // Drop the placeholder rather than leave it spinning forever.
      this.state = "gaveUp";
    } else {
      this.state = "backoff";
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        if (this.state !== "backoff") return;
        this.state = "idle";
        this.maybeRequest();
        this.opts.onChange();
      }, this.opts.retryDelayMs);
    }
    this.opts.onChange();
  }

  /**
   * What to show at timeline hour `t`. The placeholder shows from the moment
   * there is a location — including while the read waits behind the first
   * frame pass — so the row reserves its space and the values are visibly on
   * their way.
   */
  readoutAt(t: number): ReadoutState {
    if (!this.cell) return { kind: "hidden" };
    const reading = this.series.reading(t);
    if (reading) return { kind: "value", ...reading };
    return this.state === "gaveUp" ? { kind: "hidden" } : { kind: "loading" };
  }

  private reset(): void {
    this.state = "idle";
    this.attempts = 0;
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private maybeRequest(): void {
    if (!this.ready || !this.cell || this.state !== "idle") return;
    this.state = "loading";
    this.attempts++;
    this.opts.request(this.requestId, this.cell);
  }
}
