/**
 * Pure render model for the Ship's Time plotter tile. Split from the
 * DOM adapter so Node tests cover the display logic;
 * `time-ext-widget.js` is the bus/DOM adapter only.
 *
 * Time source: `navigation.datetime` (GNSS, RFC 3339 UTC), skew-
 * corrected against the local clock so the display keeps ticking
 * between GNSS deltas. Ship's time is UTC plus the plugin's published
 * `environment.time.timezoneOffset` in the schema's `(-)hhmm`
 * encoding. When GNSS time is unavailable the tile falls back to the
 * device clock and flags it.
 *
 * @file time-ext-model.mjs
 */

/**
 * Decodes the `(-)hhmm` timezone encoding into minutes east of UTC:
 * `-930` → -570. Returns null for anything non-finite, outside the
 * environment.json ±1300 range, or with impossible minute digits.
 *
 * @param {unknown} hhmm
 * @returns {number|null}
 */
export function hhmmToMinutes(hhmm) {
  if (hhmm == null || hhmm === "") {
    return null;
  }
  const n = Number(hhmm);
  if (!Number.isFinite(n) || Math.abs(n) > 1300) {
    return null;
  }
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const minutes = abs % 100;
  if (minutes > 59) {
    return null;
  }
  return sign * (Math.floor(abs / 100) * 60 + minutes);
}

/**
 * Parses an RFC 3339 datetime (or Date) into epoch ms, null if invalid.
 *
 * @param {string|Date|null} value
 * @returns {number|null}
 */
export function parseDatetime(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * UTC clock face `HH:MM:SS` for an epoch-ms instant.
 *
 * @param {number} ms
 * @returns {string}
 */
export function clockFace(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Formats minutes east of UTC as a `UTC±HH:MM` label.
 *
 * @param {number} minutes
 * @returns {string}
 */
export function offsetLabel(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(minutes));
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Tile render model.
 *
 * UTC is `navigation.datetime` skew-corrected: the GNSS value arrived
 * at local time `gnssAtMs`, so the effective instant now is
 * `gnssMs + (nowMs - gnssAtMs)`. Without a GNSS fix the device clock
 * stands in (`source: "system"`, badge on). Ship's time applies the
 * published offset when one is known.
 *
 * @param {object} params
 * @param {string|null} params.datetime - `navigation.datetime` value
 * @param {number|null} params.timezoneOffset - `(-)hhmm` from `environment.time.timezoneOffset`
 * @param {string|null} params.timezoneRegion - `environment.time.timezoneRegion`
 * @param {number|null} params.gnssAtMs - local clock when datetime arrived
 * @param {number} params.nowMs - local clock now
 * @returns {{utc: string, ship: string, zone: string, source: "gnss"|"system", severity: "ok"|"muted", badge: boolean}}
 */
export function tileModel({
  datetime,
  timezoneOffset,
  timezoneRegion,
  gnssAtMs,
  nowMs,
}) {
  const gnssMs = parseDatetime(datetime);
  const source =
    gnssMs != null && Number.isFinite(gnssAtMs) ? "gnss" : "system";
  const utcMs = source === "gnss" ? gnssMs + (nowMs - gnssAtMs) : nowMs;
  const offsetMin = hhmmToMinutes(timezoneOffset);
  const shipMs = offsetMin != null ? utcMs + offsetMin * 60000 : null;
  const zone =
    timezoneRegion || (offsetMin != null ? offsetLabel(offsetMin) : null);
  return {
    utc: clockFace(utcMs),
    ship: shipMs != null ? clockFace(shipMs) : "--:--:--",
    zone: zone || "UTC",
    source,
    severity: source === "gnss" ? "ok" : "muted",
    badge: source === "system",
  };
}
