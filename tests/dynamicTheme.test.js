const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const FILE = "content/features/dynamicTheme.js";

function api() {
  const { window } = loadFeature(FILE);
  return window.ScalerDynamicTheme;
}

// Helper: lightness (0–1) of a CSS color string, via the engine's own parser.
function lightnessOf(dt, cssColor) {
  const rgb = dt.parseColorToRgb(cssColor);
  return dt.rgbToHsl(rgb).l;
}
function hueOf(dt, cssColor) {
  return dt.rgbToHsl(dt.parseColorToRgb(cssColor)).h;
}

test("parseColorToRgb handles hex, rgb(a), named, transparent, and rejects junk", () => {
  const dt = api();
  // Field-by-field (the parsed object lives in the jsdom realm, so deepStrictEqual
  // against a node-realm literal would fail on prototype identity).
  const eqRgb = (got, r, g, b, a) => {
    assert.equal(got.r, r);
    assert.equal(got.g, g);
    assert.equal(got.b, b);
    assert.equal(got.a, a);
  };
  eqRgb(dt.parseColorToRgb("#fff"), 255, 255, 255, 1);
  eqRgb(dt.parseColorToRgb("#000000"), 0, 0, 0, 1);
  assert.equal(dt.parseColorToRgb("#ff000080").a, 128 / 255);
  eqRgb(dt.parseColorToRgb("rgb(10, 20, 30)"), 10, 20, 30, 1);
  assert.equal(dt.parseColorToRgb("rgba(0,0,0,0.5)").a, 0.5);
  assert.equal(dt.parseColorToRgb("transparent").a, 0);
  eqRgb(dt.parseColorToRgb("white"), 255, 255, 255, 1);
  assert.equal(dt.parseColorToRgb("var(--x)"), null);
  assert.equal(dt.parseColorToRgb("currentColor"), null);
  assert.equal(dt.parseColorToRgb(""), null);
});

test("rgb⇄hsl round-trips primary and grayscale colors", () => {
  const dt = api();
  for (const c of [
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 128, b: 64, a: 1 },
    { r: 37, g: 99, b: 235, a: 1 },
    { r: 128, g: 128, b: 128, a: 1 },
    { r: 0, g: 0, b: 0, a: 1 },
  ]) {
    const back = dt.hslToRgb(dt.rgbToHsl(c));
    assert.ok(Math.abs(back.r - c.r) <= 1, "r round-trips");
    assert.ok(Math.abs(back.g - c.g) <= 1, "g round-trips");
    assert.ok(Math.abs(back.b - c.b) <= 1, "b round-trips");
  }
});

test("modifyBackgroundColor: light surfaces become dark, dark stays dark", () => {
  const dt = api();
  // white → near-black band
  assert.ok(lightnessOf(dt, dt.modifyBackgroundColor({ r: 255, g: 255, b: 255, a: 1 })) < 0.16);
  // light gray → dark
  assert.ok(lightnessOf(dt, dt.modifyBackgroundColor({ r: 245, g: 245, b: 245, a: 1 })) < 0.18);
  // already dark (#1e1e1e) → stays dark (not bleached to a light panel)
  assert.ok(lightnessOf(dt, dt.modifyBackgroundColor({ r: 30, g: 30, b: 30, a: 1 })) < 0.2);
  // transparent → untouched (null = "leave as-is")
  assert.equal(dt.modifyBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }), null);
});

test("modifyBackgroundColor: a saturated button keeps its hue and stays recognizable", () => {
  const dt = api();
  const blue = { r: 37, g: 99, b: 235, a: 1 }; // #2563eb, mid-lightness blue
  const out = dt.modifyBackgroundColor(blue);
  const h = hueOf(dt, out);
  const l = lightnessOf(dt, out);
  assert.ok(Math.abs(h - hueOf(dt, "rgb(37,99,235)")) < 12, "hue preserved (still blue)");
  assert.ok(l < 0.5 && l > 0.18, "darkened but not crushed to near-black");
});

test("modifyForegroundColor: dark text becomes light, light text stays light, hue kept", () => {
  const dt = api();
  // black text → light
  assert.ok(lightnessOf(dt, dt.modifyForegroundColor({ r: 0, g: 0, b: 0, a: 1 })) > 0.85);
  // dark gray (#333) → light
  assert.ok(lightnessOf(dt, dt.modifyForegroundColor({ r: 51, g: 51, b: 51, a: 1 })) > 0.8);
  // already-light text stays light
  assert.ok(lightnessOf(dt, dt.modifyForegroundColor({ r: 240, g: 240, b: 240, a: 1 })) >= 0.6);
  // a dark-blue link → light blue, hue preserved
  const link = dt.modifyForegroundColor({ r: 26, g: 115, b: 232, a: 1 });
  assert.ok(lightnessOf(dt, link) > 0.55, "link lightened");
  assert.ok(Math.abs(hueOf(dt, link) - hueOf(dt, "rgb(26,115,232)")) < 12, "link hue kept");
});

test("modifyBorderColor: light border becomes a subtle dark border", () => {
  const dt = api();
  const out = dt.modifyBorderColor({ r: 221, g: 221, b: 221, a: 1 }); // #ddd
  const l = lightnessOf(dt, out);
  assert.ok(l > 0.12 && l < 0.42, "subtle mid-dark border");
});

test("modifyShadow: shadow colors are forced dark (no white glow), geometry + alpha kept", () => {
  const dt = api();
  const out = dt.modifyShadow("0 8px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255,255,255,0.5)");
  assert.match(out, /0 8px 40px/, "geometry preserved");
  // every color token must be black-ish (R,G,B = 0), alpha preserved
  const colors = out.match(/rgba?\([^)]*\)/g);
  for (const c of colors) {
    const rgb = dt.parseColorToRgb(c);
    assert.equal(rgb.r + rgb.g + rgb.b, 0, "shadow color forced to black");
  }
  assert.match(out, /0\.55/, "first alpha preserved");
  assert.match(out, /0\.5/, "second alpha preserved");
});

test("modifyGradient: stops recolored to dark, url() images untouched, transparent kept", () => {
  const dt = api();
  // The past-events scrim, expressed as a real gradient:
  const out = dt.modifyGradient(
    "linear-gradient(to bottom, rgba(0,0,0,0), rgba(3,39,74,0.52) 90%, #a6bdd5)",
  );
  assert.match(out, /linear-gradient\(to bottom/, "gradient kept");
  assert.match(out, /rgba\(0, ?0, ?0, ?0\)/, "fully-transparent stop preserved");
  // the light #a6bdd5 bottom stop must become dark (it was the inverted-white culprit)
  const stops = out.match(/rgba?\([^)]*\)/g).map((c) => dt.rgbToHsl(dt.parseColorToRgb(c)).l);
  assert.ok(Math.max(...stops) < 0.5, "no stop stays light (no white glow)");

  // url() backgrounds are NOT a gradient → returned null (left natural)
  assert.equal(dt.modifyGradient('url("photo.png")'), null);
  assert.equal(dt.modifyGradient("none"), null);
});
