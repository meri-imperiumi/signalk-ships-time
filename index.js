/**
 * Signal K Ship's Time plugin.
 *
 * Publishes the vessel's onboard timezone as `environment.time` so every
 * clock and display aboard renders ship's local time. This plugin is the
 * offset source only: `navigation.datetime` stays the UTC time reference
 * (typically GPS), and no time values are ever published — just which
 * timezone the vessel keeps.
 *
 * Two modes:
 * - manual: the crew configures a UTC offset (and optionally an IANA
 *   region) and updates it when crossing timezones.
 * - auto: the IANA timezone is derived from the vessel's position via
 *   tz-lookup, and the offset (DST included) is computed from it. The
 *   offset is republished only when it changes; a low-frequency recheck
 *   catches DST transitions while the vessel is stationary.
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const tzLookup = require("tz-lookup");

const { registerPlotterExtension } = require("./lib/time-ext.js");

const PLUGIN_ID = "signalk-ships-time";
const OFFSET_PATH = "environment.time.timezoneOffset";
const REGION_PATH = "environment.time.timezoneRegion";
const POSITION_PATH = "navigation.position";

/**
 * The environment.json schema caps timezoneOffset at ±1300 (±13:00).
 * Real-world timezones reach ±14h (e.g. Pacific/Kiritimati); those get
 * clamped to stay schema-valid, at the cost of a wrong offset in waters
 * no Signal K vessel is likely to sail.
 */
const OFFSET_LIMIT_MINUTES = 780;

/**
 * How often auto mode recomputes the offset, in seconds. Timezone
 * changes are rare, so 10 minutes is plenty. The same period both
 * drives the recheck timer and throttles the position subscription —
 * the plugin asks the server for navigation.position at most once per
 * interval. Positions that do arrive still recompute immediately.
 */
const DEFAULT_RECHECK_SECONDS = 600;

/**
 * Converts minutes east of UTC into the `(-)hhmm` encoding the
 * environment.json schema uses for timezoneOffset: 150 → 150,
 * -330 → -330. Minutes are clamped to the schema's ±13:00 range.
 *
 * @param {number} minutes - Minutes east of UTC
 * @returns {number}
 */
function offsetMinutesToHhmm(minutes) {
  const sign = minutes < 0 ? -1 : 1;
  const total = Math.min(Math.abs(Math.round(minutes)), OFFSET_LIMIT_MINUTES);
  return sign * (Math.floor(total / 60) * 100 + (total % 60));
}

/**
 * UTC offset of an IANA timezone at a given instant, in minutes east of
 * UTC, DST included. Uses Intl so no tzdata package is needed.
 *
 * @param {Date} date - Instant to evaluate the offset at
 * @param {string} timeZone - IANA timezone name, e.g. "Europe/Helsinki"
 * @returns {number}
 */
function timezoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Formats a (-)hhmm offset for status text: 200 → "UTC+02:00".
 *
 * @param {number} hhmm
 * @returns {string}
 */
function formatHhmm(hhmm) {
  const sign = hhmm < 0 ? "-" : "+";
  const abs = Math.abs(hhmm);
  return `UTC${sign}${String(Math.floor(abs / 100)).padStart(2, "0")}:${String(abs % 100).padStart(2, "0")}`;
}

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin}
 */
module.exports = (app) => {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);
  let mode = "manual";
  // Injectable for tests; real usage uses tz-lookup.
  let lookup = tzLookup;
  let now = () => new Date();
  let manualMinutes = 0;
  let manualRegion = null;
  let position = null;
  let recheck = null;
  let lastPublished = null;
  let teardownPlotterExt = null;
  const unsubscribes = [];

  /**
   * Publishes the timezone offset (and region when known) as an
   * environment.time delta. Deduplicated: nothing is sent when neither
   * value changed since the last publish.
   *
   * @param {number} hhmm - Offset in the schema's (-)hhmm encoding
   * @param {string|null} region - IANA region, when known
   */
  function publish(hhmm, region) {
    const key = `${hhmm}/${region || ""}`;
    if (key === lastPublished) return;
    lastPublished = key;
    const values = [{ path: OFFSET_PATH, value: hhmm }];
    if (region) values.push({ path: REGION_PATH, value: region });
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          source: { label: PLUGIN_ID, src: "timezone" },
          timestamp: now().toISOString(),
          values,
        },
      ],
    });
    setStatus(
      `Ship's time: ${formatHhmm(hhmm)}${region ? ` (${region})` : ""}`,
    );
  }

  /**
   * Recomputes the timezone from the latest position (auto mode only).
   */
  function recomputeAuto() {
    if (!position) {
      setStatus("Ship's time: waiting for vessel position");
      return;
    }
    let zone;
    try {
      zone = lookup(position.latitude, position.longitude);
    } catch (err) {
      app.error(`Timezone lookup failed: ${err.message}`);
      return;
    }
    if (!zone) {
      app.error("Timezone lookup returned no zone");
      return;
    }
    publish(offsetMinutesToHhmm(timezoneOffsetMinutes(now(), zone)), zone);
  }

  /**
   * Feeds a Signal K delta into auto mode, reacting to self position
   * updates.
   *
   * @param {object} delta - Signal K delta
   */
  function feedPosition(delta) {
    for (const update of delta?.updates || []) {
      for (const v of update.values || []) {
        if (
          v.path === POSITION_PATH &&
          v.value &&
          Number.isFinite(v.value.latitude) &&
          Number.isFinite(v.value.longitude)
        ) {
          position = {
            latitude: v.value.latitude,
            longitude: v.value.longitude,
          };
          recomputeAuto();
        }
      }
    }
  }

  const plugin = {
    id: PLUGIN_ID,
    name: "Ship's Time",
    description:
      "Publishes the vessel's timezone offset so clocks aboard show ship's local time",

    schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          title: "Timezone mode",
          description:
            "Manual offset set by the crew, or automatic from the vessel's position",
          enum: ["manual", "auto"],
          default: "manual",
        },
        utcOffset: {
          type: "number",
          title: "Manual UTC offset (hours)",
          description:
            "Decimal hours east of UTC, e.g. 2 for EET, -5.5, or 5.75 (Nepal). Only used in manual mode.",
          default: 0,
          minimum: -13,
          maximum: 13,
        },
        timezoneRegion: {
          type: "string",
          title: "Manual IANA region (optional)",
          description:
            "Optional IANA zone like Europe/Helsinki. UIs display it in preference to the plain offset. Only used in manual mode.",
        },
        recheckInterval: {
          type: "integer",
          title: "Recheck interval (seconds)",
          description:
            "How often auto mode recomputes the timezone from the vessel position; also throttles how often position updates are requested from the server.",
          default: 600,
          minimum: 10,
        },
      },
    },

    start: (options) => {
      const raw = options || {};
      mode = raw.mode === "auto" ? "auto" : "manual";
      lookup = typeof raw.lookup === "function" ? raw.lookup : tzLookup;
      now = raw.now != null ? () => new Date(raw.now) : () => new Date();

      // Send meta so consumers know the meaning of our paths.
      app.handleMessage(PLUGIN_ID, {
        context: "vessels.self",
        updates: [
          {
            meta: [
              {
                path: OFFSET_PATH,
                value: {
                  displayName: "Ship's timezone offset",
                  description:
                    "Onboard timezone offset from UTC in (-)hhmm. All clocks aboard displaying local time should use this.",
                },
              },
              {
                path: REGION_PATH,
                value: {
                  displayName: "Ship's timezone region",
                  description:
                    "IANA timezone region the vessel is keeping; UIs should display it in preference to the plain offset.",
                },
              },
            ],
          },
        ],
      });

      // Serve the 1x1 plotter tile in every mode: it reads GNSS time
      // and the published timezone straight off the Signal K bus.
      teardownPlotterExt = registerPlotterExtension(app, { id: PLUGIN_ID });

      if (mode === "manual") {
        manualMinutes = Math.round((raw.utcOffset ?? 0) * 60);
        manualRegion =
          typeof raw.timezoneRegion === "string" && raw.timezoneRegion.trim()
            ? raw.timezoneRegion.trim()
            : null;
        publish(offsetMinutesToHhmm(manualMinutes), manualRegion);
        return;
      }

      // Auto mode: track self position so the zone follows the vessel.
      // minPeriod keeps the update flow at recheck cadence — the clock
      // has no use for position deltas more often than that.
      const recheckSeconds = Math.max(
        0.001,
        raw.recheckInterval ?? DEFAULT_RECHECK_SECONDS,
      );
      if (typeof app.subscriptionmanager?.subscribe === "function") {
        app.subscriptionmanager.subscribe(
          {
            context: "vessels.self",
            subscribe: [
              {
                path: POSITION_PATH,
                policy: "instant",
                minPeriod: recheckSeconds * 1000,
              },
            ],
          },
          unsubscribes,
          (err) => app.error(`Subscription error: ${err}`),
          (delta) => feedPosition(delta),
        );
      } else {
        app.error(
          "Server has no subscriptionmanager; auto mode cannot track position",
        );
      }
      recheck = setInterval(recomputeAuto, recheckSeconds * 1000);
      recomputeAuto();
    },

    stop: () => {
      if (recheck) {
        clearInterval(recheck);
        recheck = null;
      }
      if (teardownPlotterExt) {
        teardownPlotterExt();
        teardownPlotterExt = null;
      }
      for (const f of unsubscribes) f();
      unsubscribes.length = 0;
      position = null;
      lastPublished = null;
      setStatus("Ship's time stopped");
    },
  };

  return plugin;
};

module.exports.offsetMinutesToHhmm = offsetMinutesToHhmm;
module.exports.timezoneOffsetMinutes = timezoneOffsetMinutes;
