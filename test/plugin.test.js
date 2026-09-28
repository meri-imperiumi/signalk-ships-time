const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const pluginFactory = require("../index.js");

/**
 * Minimal mock app capturing deltas, statuses and subscriptions so the
 * plugin can run without a Signal K server.
 */
function createMockApp() {
  const messages = [];
  const statuses = [];
  const errors = [];
  const providers = [];
  const uses = [];
  const deltaHandlers = [];
  const state = { unsubscribed: 0 };
  return {
    messages,
    statuses,
    errors,
    providers,
    uses,
    state,
    setPluginStatus: (s) => statuses.push(s),
    handleMessage: (_source, msg) => messages.push(msg),
    error: (e) => errors.push(e),
    registerResourceProvider: (provider) => providers.push(provider),
    use: (prefix, middleware) => uses.push([prefix, middleware]),
    subscriptionmanager: {
      subscribe: (_subscription, unsubscribes, _onError, onDelta) => {
        deltaHandlers.push(onDelta);
        unsubscribes.push(() => {
          state.unsubscribed += 1;
        });
      },
    },
    sendPositionDelta(latitude, longitude) {
      for (const handler of deltaHandlers) {
        handler({
          updates: [
            {
              values: [
                {
                  path: "navigation.position",
                  value: { latitude, longitude },
                },
              ],
            },
          ],
        });
      }
    },
  };
}

/** Deltas carrying real values (as opposed to the meta message). */
const deltasOf = (app) => app.messages.filter((m) => m.updates?.[0]?.values);

describe("plugin identity", () => {
  test("exposes Signal K plugin identity and schema", () => {
    const plugin = pluginFactory(createMockApp());
    assert.strictEqual(plugin.id, "signalk-ships-time");
    assert.strictEqual(plugin.name, "Ship's Time");
    assert.strictEqual(typeof plugin.start, "function");
    assert.strictEqual(typeof plugin.stop, "function");
    assert.deepStrictEqual(plugin.schema.properties.mode.enum, [
      "manual",
      "auto",
    ]);
  });
});

describe("manual mode", () => {
  test("publishes configured offset once on start", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ mode: "manual", utcOffset: 2.5 });
    const deltas = deltasOf(app);
    assert.strictEqual(deltas.length, 1);
    assert.deepStrictEqual(deltas[0].updates[0].values, [
      { path: "environment.time.timezoneOffset", value: 230 }, // 2:30
    ]);
    plugin.stop();
  });

  test("supports negative and fractional offsets", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ mode: "manual", utcOffset: -5.5 });
    assert.deepStrictEqual(deltasOf(app)[0].updates[0].values, [
      { path: "environment.time.timezoneOffset", value: -530 },
    ]);
    plugin.stop();
  });

  test("publishes region alongside offset when configured", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({
      mode: "manual",
      utcOffset: 2,
      timezoneRegion: "Europe/Helsinki",
    });
    assert.deepStrictEqual(deltasOf(app)[0].updates[0].values, [
      { path: "environment.time.timezoneOffset", value: 200 },
      { path: "environment.time.timezoneRegion", value: "Europe/Helsinki" },
    ]);
    plugin.stop();
  });

  test("never publishes time values — offset source only", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ mode: "manual", utcOffset: 2 });
    for (const delta of deltasOf(app)) {
      for (const update of delta.updates) {
        for (const v of update.values) {
          assert.match(v.path, /^environment\.time\./);
        }
      }
    }
    plugin.stop();
  });
});

describe("plotter extension", () => {
  test("registers on start and empties on stop", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({ mode: "manual", utcOffset: 2 });
    assert.strictEqual(app.providers.length, 1);
    assert.strictEqual(app.providers[0].type, "plotterExtensions");
    assert.strictEqual(app.uses[0][0], "/plotterext/signalk-ships-time");
    plugin.stop();
    assert.deepStrictEqual(await app.providers[0].methods.listResources(), {});
  });
});

describe("offset helpers", () => {
  test("offsetMinutesToHhmm encodes and clamps", () => {
    const { offsetMinutesToHhmm } = pluginFactory;
    assert.strictEqual(offsetMinutesToHhmm(0), 0);
    assert.strictEqual(offsetMinutesToHhmm(150), 230); // 2:30
    assert.strictEqual(offsetMinutesToHhmm(-330), -530); // -5:30
    assert.strictEqual(offsetMinutesToHhmm(60), 100);
    assert.strictEqual(offsetMinutesToHhmm(-60), -100);
    assert.strictEqual(offsetMinutesToHhmm(780), 1300);
    assert.strictEqual(offsetMinutesToHhmm(840), 1300); // clamped
    assert.strictEqual(offsetMinutesToHhmm(-840), -1300); // clamped
  });

  test("timezoneOffsetMinutes resolves DST correctly", () => {
    const { timezoneOffsetMinutes } = pluginFactory;
    const summer = new Date("2024-07-15T12:00:00Z");
    const winter = new Date("2024-01-15T12:00:00Z");
    assert.strictEqual(timezoneOffsetMinutes(summer, "Europe/Helsinki"), 180);
    assert.strictEqual(timezoneOffsetMinutes(summer, "America/New_York"), -240);
    assert.strictEqual(timezoneOffsetMinutes(winter, "America/New_York"), -300);
    assert.strictEqual(timezoneOffsetMinutes(summer, "UTC"), 0);
  });
});

describe("auto mode", () => {
  test("waits for position before publishing an offset", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({
      mode: "auto",
      lookup: () => "Europe/Helsinki",
      now: "2024-07-15T12:00:00Z",
      recheckInterval: 3600,
    });
    assert.strictEqual(deltasOf(app).length, 0);
    assert.ok(app.statuses.some((s) => s.includes("waiting for vessel")));
    plugin.stop();
  });

  test("derives region and offset from position", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    plugin.start({
      mode: "auto",
      lookup: () => "Europe/Helsinki",
      now: "2024-07-15T12:00:00Z",
      recheckInterval: 3600,
    });
    app.sendPositionDelta(60.17, 24.94);
    const deltas = deltasOf(app);
    assert.strictEqual(deltas.length, 1);
    assert.deepStrictEqual(deltas[0].updates[0].values, [
      { path: "environment.time.timezoneOffset", value: 300 }, // EEST
      { path: "environment.time.timezoneRegion", value: "Europe/Helsinki" },
    ]);
    plugin.stop();
  });

  test("republishes only when the timezone actually changes", () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    let call = 0;
    const zones = ["Europe/Helsinki", "America/New_York"];
    plugin.start({
      mode: "auto",
      lookup: () => zones[Math.min(call, zones.length - 1)],
      now: "2024-01-15T12:00:00Z", // EST -5, EET +2
      recheckInterval: 3600,
    });
    app.sendPositionDelta(60.17, 24.94);
    assert.strictEqual(deltasOf(app).length, 1);
    // Same zone again via recompute → deduplicated, no new delta.
    app.sendPositionDelta(60.18, 24.95);
    assert.strictEqual(deltasOf(app).length, 1);
    // Zone change → new delta.
    call = 1;
    app.sendPositionDelta(40.71, -74.0);
    const deltas = deltasOf(app);
    assert.strictEqual(deltas.length, 2);
    assert.deepStrictEqual(deltas[1].updates[0].values, [
      { path: "environment.time.timezoneOffset", value: -500 },
      { path: "environment.time.timezoneRegion", value: "America/New_York" },
    ]);
    plugin.stop();
  });

  test("stop unsubscribes and halts the recheck loop", async () => {
    const app = createMockApp();
    const plugin = pluginFactory(app);
    let zone = "Europe/Helsinki";
    plugin.start({
      mode: "auto",
      lookup: () => zone,
      now: "2024-07-15T12:00:00Z",
      recheckInterval: 0.001, // 1ms, for observable ticking
    });
    app.sendPositionDelta(60.17, 24.94);
    assert.strictEqual(deltasOf(app).length, 1);
    // While running, the recheck loop picks up zone changes on its own.
    zone = "America/New_York";
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(deltasOf(app).length > 1);
    plugin.stop();
    assert.strictEqual(app.state.unsubscribed, 1);
    // After stop the loop is halted: further zone changes go unpublished.
    zone = "Asia/Kolkata";
    const countAfterStop = deltasOf(app).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(deltasOf(app).length, countAfterStop);
  });
});
