/**
 * DOM controls: layer toggle chips with legends, timeline scrubber with
 * play/pause, progress and status. No framework — small, explicit DOM.
 */
import type { LayerConfig } from "../config.ts";
import type { Colormap } from "../lib/colormap.ts";
import type { ReadoutState } from "../lib/readoutSampler.ts";
import {
  formatRange,
  formatTemperature,
  loadUnitSystem,
  saveUnitSystem,
  type UnitSystem,
} from "../lib/units.ts";

export interface UICallbacks {
  onScrub(t: number): void;
  onPlayToggle(): void;
  onLayerToggle(id: string, enabled: boolean): void;
  onLocate(): void;
}

const PLAY_ICON = "&#9654;";
const PAUSE_ICON = "&#10074;&#10074;";

/** Labels under the scrubber, evenly spaced from hour 0 to the last hour. */
const AXIS_TICKS = 5;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export function colormapGradient(cm: Colormap): string {
  const stops = cm.stops.map((s, i) => {
    const pct = (i / (cm.stops.length - 1)) * 100;
    const [r, g, b, a] = s.color;
    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${pct.toFixed(0)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export class AppUI {
  private readonly cb: UICallbacks;
  private readonly timeLabel: HTMLElement;
  private readonly relLabel: HTMLElement;
  private readonly initLabel: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly nowTick: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressWrap: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly titleBox: HTMLElement;
  private updateNotice: HTMLElement | null = null;
  /** What setStatus last asked for; a flash message shows over it for a while. */
  private status: { message: string; isError: boolean } | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private sliderText = "";
  private initDate: Date | null = null;
  private readonly readout: HTMLElement;
  private readonly readoutTemp: HTMLElement;
  private readonly readoutDew: HTMLElement;
  private readonly unitBtn: HTMLButtonElement;
  private readonly ranges = new Map<string, HTMLElement>();
  private readonly chips = new Map<string, HTMLButtonElement>();
  private readonly layers: { config: LayerConfig; colormap: Colormap }[];
  private readonly axisTicks: HTMLElement[] = [];
  private maxHours = 48;
  /** Play state the button currently shows. */
  private shownPlaying = false;
  private units: UnitSystem = loadUnitSystem();
  /** Last state, kept so a unit switch can re-render without new data. */
  private readoutState: ReadoutState = { kind: "hidden" };

  constructor(
    root: HTMLElement,
    layers: { config: LayerConfig; colormap: Colormap }[],
    cb: UICallbacks,
  ) {
    this.cb = cb;

    const top = el("div", "top-bar", root);
    const titleBox = el("div", "title-box", top);
    this.titleBox = titleBox;
    el("h1", "app-title", titleBox).textContent = "Smoke & Rain";
    this.initLabel = el("div", "init-label", titleBox);
    this.initLabel.textContent = "Loading forecast…";

    this.layers = layers;
    const chipRow = el("div", "chip-row", top);
    for (const { config, colormap } of layers) {
      const chip = el("button", "chip chip-on", chipRow);
      chip.type = "button";
      chip.dataset.layer = config.id;
      chip.setAttribute("aria-pressed", "true");
      const label = el("span", "chip-label", chip);
      label.textContent = config.label;
      const bar = el("span", "chip-gradient", chip);
      bar.style.background = colormapGradient(colormap);
      this.ranges.set(config.id, el("span", "chip-range", chip));
      chip.addEventListener("click", () => {
        const on = chip.classList.toggle("chip-on");
        chip.setAttribute("aria-pressed", String(on));
        this.cb.onLayerToggle(config.id, on);
      });
      this.chips.set(config.id, chip);
    }

    // Map controls stack upwards from just above the attribution button, so the
    // unit toggle sits directly above it and the locate button above that.
    const controls = el("div", "map-controls", root);
    const locate = el("button", "locate-btn", controls);
    locate.type = "button";
    locate.title = "Center on my location";
    locate.setAttribute("aria-label", "Center on my location");
    locate.innerHTML = "&#9678;";
    locate.addEventListener("click", () => this.cb.onLocate());

    this.unitBtn = el("button", "unit-btn", controls);
    this.unitBtn.type = "button";
    this.unitBtn.addEventListener("click", () => {
      this.setUnits(this.units === "metric" ? "imperial" : "metric");
      saveUnitSystem(this.units);
    });

    const bottom = el("div", "bottom-bar", root);
    const timeRow = el("div", "time-row", bottom);
    this.playBtn = el("button", "play-btn", timeRow);
    this.playBtn.type = "button";
    this.playBtn.setAttribute("aria-label", "Play animation");
    this.playBtn.innerHTML = PLAY_ICON;
    this.playBtn.addEventListener("click", () => this.cb.onPlayToggle());
    const labels = el("div", "time-labels", timeRow);
    this.timeLabel = el("div", "time-label", labels);
    this.timeLabel.textContent = "—";
    this.relLabel = el("div", "rel-label", labels);

    // Forecast at the located point, sharing the time row so it reads as part
    // of "what the map is showing right now". Hidden until there is both a fix
    // and a value.
    //
    // Deliberately NOT an aria-live region: the values track the timeline, so
    // during playback a live region would queue an announcement several times a
    // second and drown out everything else. role="group" gives it a name
    // assistive tech will actually use — ARIA forbids naming a plain div, whose
    // implicit role is `generic`.
    this.readout = el("div", "readout readout-hidden", timeRow);
    this.readout.setAttribute("role", "group");
    this.readout.setAttribute("aria-label", "Forecast at your location");
    this.readoutTemp = this.addMetric("temp", "Temp");
    this.readoutDew = this.addMetric("dew", "Dew");

    const sliderWrap = el("div", "slider-wrap", bottom);
    this.slider = el("input", "scrubber", sliderWrap);
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "48";
    this.slider.step = "0.1";
    this.slider.value = "0";
    this.slider.setAttribute("aria-label", "Forecast hour");
    this.slider.addEventListener("input", () => this.cb.onScrub(Number(this.slider.value)));
    this.nowTick = el("div", "now-tick", sliderWrap);
    this.nowTick.style.display = "none";

    // Evenly spaced ticks across the scrubber. The forecast does not always
    // reach +48 h — how far the spliced runs' inits are apart decides that — so
    // the labels are derived from the range rather than fixed, and setMaxHours
    // relabels them.
    const axis = el("div", "axis-row", bottom);
    for (let i = 0; i < AXIS_TICKS; i++) this.axisTicks.push(el("span", "axis-tick", axis));
    this.labelAxis();

    this.progressWrap = el("div", "progress-wrap", bottom);
    this.progressBar = el("div", "progress-bar", this.progressWrap);

    this.statusEl = el("div", "status", root);
    // Announced politely: loading, errors, and why locate did nothing.
    this.statusEl.setAttribute("role", "status");
    this.setStatus("Loading forecast…", false);

    this.trackBarHeight(bottom);

    // Paints the unit-dependent text (chip ranges, toggle label) for the
    // persisted preference.
    this.setUnits(this.units);
  }

  /**
   * Publish the bottom bar's height as --bar-h, which positions the map
   * controls and MapLibre's attribution. The bar is not a fixed height: it
   * grows if the readout wraps, and with safe-area insets.
   */
  private trackBarHeight(bar: HTMLElement): void {
    const apply = () => {
      const h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty("--bar-h", `${h}px`);
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(bar);
    else window.addEventListener("resize", apply);
    apply();
  }

  /** One labelled metric in the readout; returns the element holding its value. */
  private addMetric(key: string, label: string): HTMLElement {
    const metric = el("span", "readout-metric", this.readout);
    metric.dataset.metric = key;
    el("span", "readout-label", metric).textContent = label;
    return el("span", "readout-value", metric);
  }

  /**
   * Switch the displayed unit system. Only formatting changes — loaded frames,
   * colormap thresholds and the store all stay metric — so this just repaints
   * the legend ranges and the readout from values already in hand.
   */
  setUnits(system: UnitSystem): void {
    this.units = system;
    const imperial = system === "imperial";
    this.unitBtn.textContent = imperial ? "°F" : "°C";
    this.unitBtn.title = imperial ? "Switch to metric units" : "Switch to imperial units";
    this.unitBtn.setAttribute(
      "aria-label",
      imperial ? "Switch to metric units" : "Switch to imperial units",
    );
    // A toggle, not a mode indicator: report which of the two states is active.
    this.unitBtn.setAttribute("aria-pressed", String(imperial));
    this.unitBtn.dataset.units = system;
    for (const { config } of this.layers) {
      const target = this.ranges.get(config.id);
      if (target) {
        target.textContent = formatRange(
          config.range[0],
          config.range[1],
          config.quantity,
          system,
        );
      }
    }
    this.renderReadout();
  }

  setMaxHours(h: number): void {
    this.maxHours = h;
    this.slider.max = String(h);
    this.labelAxis();
    this.updateNowTick();
  }

  private labelAxis(): void {
    this.axisTicks.forEach((tick, i) => {
      const h = Math.round((this.maxHours * i) / (AXIS_TICKS - 1));
      tick.textContent = h === 0 ? "0h" : `+${h}h`;
    });
  }

  setInit(initDate: Date): void {
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      month: "short",
      day: "numeric",
    });
    this.initLabel.textContent = `HRRR forecast from ${fmt.format(initDate)}`;
    this.initDate = initDate;
    this.updateNowTick();
  }

  /**
   * Place the "now" tick on the timeline, or hide it once now has left the
   * forecast window. Called again as time passes, so a long-open tab's tick
   * keeps up with the clock.
   */
  updateNowTick(): void {
    if (!this.initDate) return;
    const nowHours = (Date.now() - this.initDate.getTime()) / 3_600_000;
    const inside = nowHours >= 0 && nowHours <= this.maxHours;
    this.nowTick.style.display = inside ? "block" : "none";
    if (inside) this.nowTick.style.left = `${(nowHours / this.maxHours) * 100}%`;
  }

  /**
   * Offer a newer forecast run, under the init label it supersedes. An offer,
   * not an automatic switch: loading one is tens of megabytes, and the user
   * may be mid-scrub.
   */
  showUpdateAvailable(onUpdate: () => void): void {
    if (this.updateNotice) return;
    const notice = el("div", "update-notice", this.titleBox);
    notice.setAttribute("role", "status");
    el("span", "update-text", notice).textContent = "Newer forecast available";
    const btn = el("button", "update-btn", notice);
    btn.type = "button";
    btn.textContent = "Update";
    btn.addEventListener("click", onUpdate);
    this.updateNotice = notice;
  }

  /**
   * Show timeline hour `t` of the forecast from `initDate`. The clock and the
   * "+Nh" label both name the nearest whole hour: truncating one and rounding
   * the other would have them disagree for half of every hour.
   */
  setTime(initDate: Date, t: number, playing: boolean): void {
    const hour = Math.round(t);
    const valid = new Date(initDate.getTime() + hour * 3_600_000);
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" });
    const clock = fmt.format(valid);
    this.timeLabel.textContent = clock;
    this.relLabel.textContent = `+${hour}h`;
    if (document.activeElement !== this.slider || playing) {
      this.slider.value = String(t);
    }
    // Screen readers would otherwise announce the raw value, e.g. "30.4".
    const text = `${clock}, ${hour} ${hour === 1 ? "hour" : "hours"} ahead`;
    if (text !== this.sliderText) {
      this.sliderText = text;
      this.slider.setAttribute("aria-valuetext", text);
    }
    // Only on a change: this runs every animation frame, and replacing the
    // button's contents between press and release swallows the click (WebKit
    // drops it when the pressed text node is gone), so pause could miss.
    if (playing !== this.shownPlaying) {
      this.shownPlaying = playing;
      this.playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      this.playBtn.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    }
  }

  /** Show, hide, or show a loading placeholder for the located-point readout. */
  setReadout(state: ReadoutState): void {
    this.readoutState = state;
    this.renderReadout();
  }

  /**
   * Paint the readout in the current unit system. Runs on every timeline change,
   * so the formatted strings are diffed and the DOM is only touched when a
   * displayed value actually changes.
   */
  private renderReadout(): void {
    const state = this.readoutState;
    this.readout.classList.toggle("readout-hidden", state.kind === "hidden");
    this.readout.classList.toggle("readout-loading", state.kind === "loading");
    if (state.kind === "loading") this.readout.setAttribute("aria-busy", "true");
    else this.readout.removeAttribute("aria-busy");
    // Empty values while loading so the placeholder boxes show through; they
    // keep the text's footprint, so nothing shifts when the numbers land.
    const temp = state.kind === "value" ? formatTemperature(state.temperatureC, this.units) : "";
    const dew = state.kind === "value" ? formatTemperature(state.dewpointC, this.units) : "";
    if (this.readoutTemp.textContent !== temp) this.readoutTemp.textContent = temp;
    if (this.readoutDew.textContent !== dew) this.readoutDew.textContent = dew;
  }

  setProgress(loaded: number, total: number): void {
    const done = total > 0 && loaded >= total;
    this.progressWrap.style.opacity = done ? "0" : "1";
    this.progressBar.style.width = total > 0 ? `${(loaded / total) * 100}%` : "0%";
  }

  setStatus(message: string | null, isError: boolean): void {
    this.status = message === null ? null : { message, isError };
    if (this.flashTimer === null) this.renderStatus(this.status);
  }

  /**
   * Show a passing message (e.g. why locate did nothing) for a few seconds,
   * then go back to whatever status was showing.
   */
  flashStatus(message: string, durationMs = 4000): void {
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.renderStatus({ message, isError: false });
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.renderStatus(this.status);
    }, durationMs);
  }

  private renderStatus(status: { message: string; isError: boolean } | null): void {
    if (status === null) {
      this.statusEl.classList.remove("status-visible", "status-error");
      return;
    }
    this.statusEl.textContent = status.message;
    this.statusEl.classList.add("status-visible");
    this.statusEl.classList.toggle("status-error", status.isError);
  }
}
