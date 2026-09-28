/**
 * `<time-ext-widget>` — the Ship's Time plotter tile. Runs inside a
 * chart plotter's sandboxed iframe (Plotter Extensions API v1 hosts):
 * connects over the vendored bus client and subscribes to GNSS time
 * (`navigation.datetime`) plus the plugin's published timezone
 * (`environment.time.timezoneOffset` / `timezoneRegion`) through the
 * host's multiplexed Signal K relay.
 *
 * UTC comes from `navigation.datetime`, skew-corrected against the
 * local clock so the display keeps ticking between GNSS deltas; a SYS
 * badge marks the fallback to the device clock when GNSS time is not
 * available. Ship's time is UTC plus the published offset. Pure
 * display logic lives in `time-ext-model.mjs` (Node-tested).
 *
 * Long-press → host config/remove dialog (pointer events inside the
 * iframe are invisible to the host, so the widget detects the gesture
 * itself). Night mode (optional capability) shifts the palette
 * amber/red.
 *
 * @file time-ext-widget.js
 */

import { parseDatetime, tileModel } from "./time-ext-model.mjs";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** Flat paths the tile consumes (scalars over the host relay). */
const STREAM_PATHS = [
  "navigation.datetime",
  "environment.time.timezoneOffset",
  "environment.time.timezoneRegion",
];

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 6px 8px;
      background: var(--bg-panel, #111414);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: ui-monospace, "Fira Code", monospace;
      color: var(--text-main, #ffffff);
      cursor: default;
      user-select: none;
      --tile-accent: var(--color-teal, #4f9ea8);
    }
    :host(.muted) { --tile-accent: var(--color-grey, #666677); }

    /* Night mode (host nightMode capability): amber/red palette. */
    :host(.night) {
      --color-teal: #c97b4f;
      --color-grey: #6a4a3f;
      --text-main: #e8c9a0;
      --text-muted: #a07d5c;
      --bg-panel: rgba(22, 11, 6, 0.88);
    }

    .tile {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100%;
      gap: 2px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .head .label {
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--tile-accent);
      white-space: nowrap;
    }
    .badge {
      display: none;
      padding: 1px 5px;
      border: 1px solid #fca847;
      color: #fca847;
      font-size: 0.55rem;
      font-weight: 700;
      letter-spacing: 0.1em;
    }
    .badge.on { display: inline-block; }
    .clocks {
      display: grid;
      align-content: center;
      gap: 4px;
      min-height: 0;
    }
    .row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    .row .sub {
      font-size: 0.55rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--text-muted, #9aa3ad);
      width: 2.6em;
      flex: none;
    }
    .row .time {
      font-size: clamp(0.75rem, 3.2vh, 1rem);
      font-weight: 700;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      white-space: nowrap;
      color: var(--text-muted, #9aa3ad);
    }
    .row.ship .time {
      color: var(--text-main, #ffffff);
      font-size: clamp(0.9rem, 4.2vh, 1.3rem);
    }
    .zone {
      font-size: 0.55rem;
      letter-spacing: 0.06em;
      color: var(--text-muted, #9aa3ad);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
  <div class="tile">
    <div class="head">
      <span class="label">Ship's time</span>
      <span class="badge" id="badge">SYS</span>
    </div>
    <div class="clocks">
      <div class="row">
        <span class="sub">UTC</span>
        <span class="time" id="utc">--:--:--</span>
      </div>
      <div class="row ship">
        <span class="sub">SHIP</span>
        <span class="time" id="ship">--:--:--</span>
      </div>
    </div>
    <div class="zone" id="zone">UTC</div>
  </div>
`;

class TimeExtWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));

    /** @type {Record<string, unknown>} latest per-path bus values */
    this.values = {};
    /** @type {number|null} local clock when the GNSS value arrived */
    this.gnssAtMs = null;
    this.connected = false;
    /** @type {number|null} one-second display ticker */
    this.tick = null;

    // Long-press → host config/remove dialog; short tap has no action
    // (there is no full webapp behind this tile).
    /** @type {number|null} */
    this.pressTimer = null;
    this.addEventListener("pointerdown", this.onPointerDown);
    this.addEventListener("pointerup", this.onPointerUp);
    this.addEventListener("pointercancel", this.onPointerUp);
    this.addEventListener("pointerleave", this.onPointerUp);
    this.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  onPointerDown(e) {
    if (!this.connected || e.button !== 0) return;
    this.pressTimer = setTimeout(() => {
      this.client?.call("ui.toggleConfigPanel").catch(() => {});
    }, 1200);
  }

  /**
   * @returns {void}
   */
  onPointerUp() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  /**
   * @returns {void}
   */
  async connectedCallback() {
    if (this.connected) return;
    let client;
    try {
      client = await connectExtension();
    } catch {
      // No host handshake (opened standalone while developing, or the
      // host vanished): render from the device clock and stop.
      this.render();
      return;
    }
    this.connected = true;
    this.client = client;

    // Seed current values via REST: deltas only travel on change, and
    // the timezone offset rarely changes, so without this the tile
    // could show placeholders for a long time.
    await Promise.all(
      STREAM_PATHS.map(async (path) => {
        try {
          const res = await fetch(`/signalk/v1/api/vessels/self/${path}`);
          if (!res.ok) return;
          const doc = await res.json();
          if (doc && "value" in doc) this.setPathValue(path, doc.value);
        } catch {
          /* the subscription still fills values in */
        }
      }),
    );

    try {
      await client.signalk.subscribe(STREAM_PATHS, (ev) => {
        // Event name is `sk.<path>`; the path is the dict key.
        const path = ev?.path;
        if (typeof path === "string") this.setPathValue(path, ev.value);
        this.render();
      });
    } catch {
      // Host without signalk.stream (or relay failure): seeded values.
    }

    if (client.hasCapability("nightMode")) {
      try {
        const { enabled } = await client.nightMode.get();
        this.classList.toggle("night", Boolean(enabled));
      } catch {
        /* best-effort seed */
      }
      await client
        .subscribe(["nightMode.changed"], (_name, params) => {
          this.classList.toggle("night", Boolean(params?.enabled));
        })
        .catch(() => {});
    }

    this.render();
    // Clocks tick once a second regardless of delta cadence; skew
    // correction keeps them honest between GNSS updates.
    this.tick = setInterval(() => this.render(), 1000);
  }

  /**
   * Stores one flat-path value, noting arrival time for GNSS time so
   * the display can skew-correct between deltas.
   *
   * @param {string} path
   * @param {unknown} value
   * @returns {void}
   */
  setPathValue(path, value) {
    this.values[path] = value;
    if (path === "navigation.datetime") {
      this.gnssAtMs = parseDatetime(value) != null ? Date.now() : null;
    }
  }

  /**
   * @returns {void}
   */
  disconnectedCallback() {
    this.onPointerUp();
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.client?.close();
    this.client = null;
    this.connected = false;
  }

  /**
   * Applies the latest bus values to the DOM.
   *
   * @returns {void}
   */
  render() {
    const model = tileModel({
      datetime: this.values["navigation.datetime"] ?? null,
      timezoneOffset: this.values["environment.time.timezoneOffset"] ?? null,
      timezoneRegion: this.values["environment.time.timezoneRegion"] ?? null,
      gnssAtMs: this.gnssAtMs,
      nowMs: Date.now(),
    });
    const root = this.shadowRoot;
    this.classList.remove("ok", "muted");
    this.classList.add(model.severity);
    root.querySelector("#utc").textContent = model.utc;
    root.querySelector("#ship").textContent = model.ship;
    root.querySelector("#zone").textContent = model.zone;
    root.querySelector("#badge").classList.toggle("on", model.badge);
  }
}

customElements.define("time-ext-widget", TimeExtWidget);
