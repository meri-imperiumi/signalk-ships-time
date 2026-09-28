const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
} = require("../lib/time-ext.js");

const loadModel = () => import("../public/time-ext-model.mjs");

describe("manifest", () => {
  test("declares a 1x1 iframe widget on Plotter Extensions API v1", () => {
    const manifest = buildManifest("/plotterext/x", "0.2.0");
    assert.strictEqual(manifest.apiVersion, "1");
    assert.ok(manifest.requires.includes("widgets"));
    assert.ok(manifest.requires.includes("signalk.stream"));
    const widget = manifest.widgets[0];
    assert.strictEqual(widget.size, "1x1");
    assert.strictEqual(widget.type, "iframe");
    assert.strictEqual(
      widget.url,
      "/plotterext/x/time-ext-widget.html?v=0.2.0",
    );
    assert.strictEqual(widget.lifecycle, "whileEnabled");
  });
});

describe("registerPlotterExtension", () => {
  function createMockApp() {
    return {
      providers: [],
      uses: [],
      registerResourceProvider(provider) {
        this.providers.push(provider);
      },
      use(prefix, middleware) {
        this.uses.push([prefix, middleware]);
      },
    };
  }

  test("registers a read-only provider that empties on teardown", async () => {
    const app = createMockApp();
    const teardown = registerPlotterExtension(app, {
      id: "signalk-ships-time",
    });
    assert.strictEqual(app.providers.length, 1);
    assert.strictEqual(app.providers[0].type, "plotterExtensions");
    assert.strictEqual(app.uses[0][0], "/plotterext/signalk-ships-time");

    const provider = app.providers[0].methods;
    const listed = await provider.listResources();
    assert.ok(listed["signalk-ships-time"].widgets.length === 1);
    const resource = await provider.getResource("signalk-ships-time");
    assert.strictEqual(resource.widgets[0].id, "ships-time-tile");
    await assert.rejects(() => provider.setResource({}));
    await assert.rejects(() => provider.deleteResource("signalk-ships-time"));

    teardown();
    assert.deepStrictEqual(await provider.listResources(), {});
    await assert.rejects(() => provider.getResource("signalk-ships-time"));
  });
});

describe("staticAssetHandler", () => {
  const PUBLIC_DIR = path.join(__dirname, "..", "public");

  function createRes() {
    return {
      statusCode: 0,
      headers: {},
      body: null,
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.body = body;
      },
    };
  }

  test("serves the widget html from public/", async () => {
    const handler = staticAssetHandler(PUBLIC_DIR, "/plotterext/x");
    const res = createRes();
    let fellThrough = false;
    handler({ path: "/plotterext/x/time-ext-widget.html" }, res, () => {
      fellThrough = true;
    });
    await new Promise((resolve) => {
      const original = res.end.bind(res);
      res.end = (body) => {
        original(body);
        resolve();
      };
    });
    assert.strictEqual(fellThrough, false);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assert.match(String(res.body), /time-ext-widget/);
  });

  test("traversal attempts fall through", () => {
    const handler = staticAssetHandler(PUBLIC_DIR, "/plotterext/x");
    const res = createRes();
    let fellThrough = false;
    handler({ path: "/plotterext/x/../../package.json" }, res, () => {
      fellThrough = true;
    });
    assert.strictEqual(fellThrough, true);
    assert.strictEqual(res.body, null);
  });
});

describe("tile model", () => {
  test("hhmmToMinutes decodes and validates", async () => {
    const { hhmmToMinutes } = await loadModel();
    assert.strictEqual(hhmmToMinutes(0), 0);
    assert.strictEqual(hhmmToMinutes(200), 120);
    assert.strictEqual(hhmmToMinutes(-930), -570); // Marquesas
    assert.strictEqual(hhmmToMinutes(130), 90);
    assert.strictEqual(hhmmToMinutes(1300), 780);
    assert.strictEqual(hhmmToMinutes(1400), null); // beyond schema range
    assert.strictEqual(hhmmToMinutes(179), null); // impossible minutes
    assert.strictEqual(hhmmToMinutes("abc"), null);
  });

  test("skew-corrects GNSS time and applies ship's offset", async () => {
    const { tileModel } = await loadModel();
    const gnssMs = Date.UTC(2024, 6, 15, 9, 0, 0);
    const model = tileModel({
      datetime: "2024-07-15T09:00:00Z",
      timezoneOffset: 200, // UTC+2
      timezoneRegion: "Europe/Helsinki",
      gnssAtMs: gnssMs,
      nowMs: gnssMs + 3_661_000, // 1h 1m 1s since the fix arrived
    });
    assert.strictEqual(model.utc, "10:01:01");
    assert.strictEqual(model.ship, "12:01:01");
    assert.strictEqual(model.zone, "Europe/Helsinki");
    assert.strictEqual(model.source, "gnss");
    assert.strictEqual(model.severity, "ok");
    assert.strictEqual(model.badge, false);
  });

  test("falls back to the device clock without GNSS time", async () => {
    const { tileModel } = await loadModel();
    const model = tileModel({
      datetime: null,
      timezoneOffset: -930, // Marquesas −9:30
      timezoneRegion: null,
      gnssAtMs: null,
      nowMs: Date.UTC(2024, 6, 15, 23, 30, 15),
    });
    assert.strictEqual(model.utc, "23:30:15");
    assert.strictEqual(model.ship, "14:00:15");
    assert.strictEqual(model.zone, "UTC-09:30"); // label when no region
    assert.strictEqual(model.source, "system");
    assert.strictEqual(model.severity, "muted");
    assert.strictEqual(model.badge, true);
  });

  test("shows placeholders when no offset is published", async () => {
    const { tileModel } = await loadModel();
    const model = tileModel({
      datetime: "2024-07-15T09:00:00Z",
      timezoneOffset: null,
      timezoneRegion: null,
      gnssAtMs: Date.UTC(2024, 6, 15, 9, 0, 0),
      nowMs: Date.UTC(2024, 6, 15, 9, 0, 5),
    });
    assert.strictEqual(model.utc, "09:00:05");
    assert.strictEqual(model.ship, "--:--:--");
    assert.strictEqual(model.zone, "UTC");
  });
});
