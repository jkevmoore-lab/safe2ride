// Run with: node tests/run.mjs        (add --live to also hit the real APIs)
import fs from "fs";
import assert from "assert/strict";

const src = ["logic.js", "route.js"].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
const S = new Function(src + "; return { assess, scores, bestWindow, soakScore, windScore, makeCheckpoints, evaluateDeparture, planDepartures, bearing, fetchRoute, fetchRouteWeather, forecastHoursFor, searchPlaces, PAST_HOURS, MILE };")();

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

// Fake hourly data: 30 hours from a fixed start, mild/dry/calm unless overridden.
function hours(over = {}, n = 30, t0 = 1_800_000_000) {
  const f = (v) => Array(n).fill(v);
  const h = { time: Array.from({ length: n }, (_, i) => t0 + i * 3600), temperature_2m: f(10), apparent_temperature: f(9), dew_point_2m: f(5),
    precipitation: f(0), precipitation_probability: f(0), snowfall: f(0), weather_code: f(1), visibility: f(20000),
    wind_speed_10m: f(5), wind_gusts_10m: f(10), wind_direction_10m: f(270), soil_temperature_0cm: f(10), is_day: f(1) };
  for (const k in over) h[k] = typeof over[k] === "function" ? h[k].map(over[k]) : f(over[k]);
  return h;
}

console.log("Scores");
test("calm mild dry is all zero", () => {
  const s = S.scores(hours(), "bicycle", 6);
  assert.deepEqual([s.ice.score, s.rain.score, s.wind.score], [0, 0, 0]);
});
test("frosty night scores high ice and stops", () => {
  const h = hours({ temperature_2m: -1, soil_temperature_0cm: -2, dew_point_2m: -1.5 });
  assert.ok(S.scores(h, "bicycle", 6).ice.score >= 7);
  assert.equal(S.assess(h, "bicycle", 6).level, 2);
});
test("drizzle at 90% is not a soaking", () => assert.ok(S.soakScore(0.3, 90, 0.1) <= 2));
test("5 mm/h downpour is drenched", () => assert.ok(S.soakScore(15, 95, 5) >= 9));
test("wind limits differ by vehicle", () => assert.ok(S.windScore(30, "bicycle") > S.windScore(30, "motorbike")));

console.log("Route maths");
test("bearing north/east", () => {
  assert.ok(Math.abs(S.bearing({ lat: 51, lon: 0 }, { lat: 52, lon: 0 }) - 0) < 1);
  assert.ok(Math.abs(S.bearing({ lat: 51, lon: 0 }, { lat: 51, lon: 1 }) - 90) < 1);
});

// A straight 10-mile route heading due east, taking 40 minutes.
const t0 = 1_800_000_000;
const n = 41, route = { coords: [], cumD: [], cumT: [], distance: 10 * S.MILE, duration: 2400 };
for (let i = 0; i < n; i++) { route.coords.push([51.5, -1 + i * 0.0058]); route.cumD.push(i / (n - 1) * route.distance); route.cumT.push(i / (n - 1) * 2400); }
const cps = S.makeCheckpoints(route);
test("checkpoints span the route", () => {
  assert.equal(cps.length, 5);
  assert.equal(cps[0].dist, 0);
  assert.ok(Math.abs(cps[cps.length - 1].dist - route.distance) < 1);
  assert.ok(Math.abs(cps[cps.length - 1].t - 2400) < 1);
});
test("easterly wind riding east is a headwind", () => {
  const wx = cps.map(() => hours({ wind_speed_10m: 16, wind_gusts_10m: 22, wind_direction_10m: 90 }));
  const e = S.evaluateDeparture(cps, wx, "bicycle", t0 + 6 * 3600);
  assert.ok(e.segs.every((g) => g.head > 15));
  assert.ok(e.reasons.some((r) => r.kind === "headwind" && r.level === 1));
});
test("westerly wind riding east is a tailwind", () => {
  const wx = cps.map(() => hours({ wind_speed_10m: 12, wind_direction_10m: 270 }));
  const e = S.evaluateDeparture(cps, wx, "bicycle", t0 + 6 * 3600);
  assert.ok(e.reasons.some((r) => r.kind === "tailwind"));
});
test("rain only at the far end is located and timed", () => {
  const wx = cps.map((_, k) => hours(k === cps.length - 1 ? { precipitation: 3, precipitation_probability: 90, weather_code: 63 } : {}));
  const e = S.evaluateDeparture(cps, wx, "bicycle", t0 + 6 * 3600);
  const rain = e.reasons.find((r) => r.kind === "rain");
  assert.ok(rain && rain.text.startsWith("At the end"), rain?.text);
});
test("best departure avoids a shower", () => {
  // Rain everywhere for hours 6–8, dry afterwards.
  const wx = cps.map(() => hours({ precipitation: (v, i) => (i >= 6 && i <= 8 ? 4 : 0), precipitation_probability: (v, i) => (i >= 6 && i <= 8 ? 90 : 0) }));
  const plan = S.planDepartures(cps, wx, "bicycle", t0 + 6 * 3600);
  const best = plan.options[plan.best];
  assert.ok(best.dep >= t0 + 9 * 3600, `best leaves at hour ${(best.dep - t0) / 3600}`);
  assert.equal(best.level, 0);
  assert.ok(plan.options[0].level >= 1);
});

if (process.argv.includes("--live")) {
  console.log("Live APIs");
  const places = await S.searchPlaces("Burford", [51.8, -1.5]);
  test("search finds Burford, Oxfordshire first", () => assert.match(places[0].label, /Burford, .*Oxfordshire/));
  for (const mode of ["bicycle", "motorbike"]) {
    const r = await S.fetchRoute({ lat: 51.7856, lon: -1.4857 }, places[0], mode);
    const c = S.makeCheckpoints(r);
    const wx = await S.fetchRouteWeather(c, S.forecastHoursFor(r));
    const plan = S.planDepartures(c, wx, mode, Math.floor(Date.now() / 1000));
    const b = plan.options[plan.best];
    test(`${mode}: Witney → Burford planned`, () => {
      assert.equal(wx.length, c.length);
      assert.ok(plan.options.length >= 6);
    });
    console.log(`    ${(r.distance / S.MILE).toFixed(1)} mi, ${Math.round(r.duration / 60)} min, ${c.length} checkpoints; levels by departure: ${plan.options.map((o) => o.level).join("")}; best leaves ${new Date(b.dep * 1000).toTimeString().slice(0, 5)}`);
    console.log(`    scores now: ice ${plan.options[0].scores.ice.score}, soak ${plan.options[0].scores.rain.score}, wind ${plan.options[0].scores.wind.score}; reasons: ${plan.options[0].reasons.map((x) => x.text).join(" | ") || "none"}`);
  }
}
console.log(`\n${passed} passed`);
