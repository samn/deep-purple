/**
 * Splicing several HRRR forecast runs into one timeline.
 *
 * HRRR publishes two forecast products: an 18-hour run every hour, and a
 * 48-hour run every six hours. Neither alone is what we want to show — the
 * hourly run is fresher (and so more skilful) but stops at +18 h, while the
 * six-hourly run reaches +48 h but can be up to five hours stale at its nose.
 * Splicing gives both: the freshest run available for every forecast hour it
 * covers, older runs extending the tail.
 *
 * Runs are joined on **valid time**, not on lead index — the runs have
 * different init times, so lead 6 of one is not lead 6 of another. Hour 0 of
 * the spliced timeline is the newest init present, and each subsequent hour is
 * served by whichever run has the newest init that still reaches that valid
 * time.
 */

const HOUR_MS = 3_600_000;

export interface ForecastRun {
  /** Init time, epoch ms. */
  initTimeMs: number;
  /** Lead offsets from the init, in hours, ascending. */
  leadHours: number[];
}

/** Where one hour of the spliced timeline is read from. */
export interface FrameSource {
  /** Index into the runs array passed to `spliceRuns`. */
  runIndex: number;
  /** Lead index within that run. */
  leadIndex: number;
}

export interface SplicedTimeline {
  /** Timeline hour 0: the newest init among the runs, epoch ms. */
  initTimeMs: number;
  /** Hours from `initTimeMs`, one per frame — contiguous, hourly, from 0. */
  leadHours: number[];
  /** Parallel to `leadHours`. */
  sources: FrameSource[];
}

/**
 * Build the spliced timeline over `runs`. The result runs from the newest init
 * forward for as long as some run still covers the next hour, so its length
 * depends on how far apart the runs' inits are: with the 48-hour run five hours
 * behind the 18-hour one, the timeline ends at +43 h rather than +48 h.
 *
 * Ties (two runs with the same init covering the same hour) go to the earlier
 * entry in `runs`.
 */
export function spliceRuns(runs: ForecastRun[]): SplicedTimeline {
  if (runs.length === 0) throw new Error("No forecast runs to splice");
  const initTimeMs = Math.max(...runs.map((r) => r.initTimeMs));

  // For each run, which lead index serves each hour of the spliced timeline.
  // Leads landing before hour 0 (a run older than the newest) are already in
  // the past and simply drop out.
  const leadForHour = runs.map((run) => {
    const shift = (run.initTimeMs - initTimeMs) / HOUR_MS;
    const byHour = new Map<number, number>();
    run.leadHours.forEach((lead, leadIndex) => {
      const hour = lead + shift;
      if (Number.isInteger(hour) && hour >= 0 && !byHour.has(hour)) byHour.set(hour, leadIndex);
    });
    return byHour;
  });

  // Freshest run first, so every hour is served by the best forecast that
  // reaches it; ties keep the caller's order.
  const preference = runs
    .map((run, runIndex) => ({ run, runIndex }))
    .sort((a, b) => b.run.initTimeMs - a.run.initTimeMs || a.runIndex - b.runIndex);

  const leadHours: number[] = [];
  const sources: FrameSource[] = [];
  for (let hour = 0; ; hour++) {
    let source: FrameSource | null = null;
    for (const { runIndex } of preference) {
      const leadIndex = leadForHour[runIndex]!.get(hour);
      if (leadIndex !== undefined) {
        source = { runIndex, leadIndex };
        break;
      }
    }
    if (!source) break;
    leadHours.push(hour);
    sources.push(source);
  }
  if (sources.length === 0) throw new Error("Forecast runs cover no common hour");

  return { initTimeMs, leadHours, sources };
}
