// Run with: node tests/run.mjs        (add --live to also hit the real APIs)
import fs from "fs";
import assert from "assert/strict";

const src = ["logic.js", "route.js", "loop.js"].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
const S = new Function(src + "; return { findSpurs, isChain, cafesOnRoute, openAt, classifyWay, surfaceStats, loopWaypoints, overlapPct, insertStop, haversine, destPoint, fetchCycleRoute, cycleProfile, planLoop, addCafeStop, summarize, withPlace, climbStats, fetchElevation, pointAt, precipType, compass, assess, scores, bestWindow, soakScore, windScore, makeCheckpoints, evaluateDeparture, planDepartures, bearing, fetchRoute, fetchRouteWeather, forecastHoursFor, searchPlaces, PAST_HOURS, MILE };")();

// Browsers send a User-Agent automatically; Node doesn't, and some map services require one.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, { ...init, headers: { "User-Agent": "Safe2Ride-tests/1.0 (https://safe2ride.co.uk)", ...(init.headers || {}) } });

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

test("rain, sleet, snow and freezing rain are told apart", () => {
  const at = (o) => S.precipType(hours(o), 6);
  assert.equal(at({}), null);
  assert.equal(at({ precipitation: 1.2, weather_code: 61 }), "rain");
  assert.equal(at({ precipitation: 1.4, snowfall: 1, temperature_2m: -1, weather_code: 73 }), "snow");
  assert.equal(at({ precipitation: 3, snowfall: 0.3, temperature_2m: 1, weather_code: 68 }), "sleet");
  assert.equal(at({ precipitation: 0.5, snowfall: 0.2, temperature_2m: 2.5, weather_code: 71 }), "sleet");
  assert.equal(at({ precipitation: 0.4, weather_code: 66, temperature_2m: -1 }), "freezing");
});
test("compass points", () => assert.deepEqual([0, 90, 225, 350].map(S.compass), ["N", "E", "SW", "N"]));

test("summary: dry, then rain, with gusts", () => {
  const h = hours({ precipitation: (v, i) => (i >= 9 ? 1.5 : 0), wind_gusts_10m: (v, i) => (i === 8 ? 33 : 12) });
  assert.equal(S.summarize(h, "bicycle", 6, (i) => `h${i}`), "Dry until about h9, then rain, gusts to 33 mph around h8.");
});
test("summary: raining now, stops later", () => {
  const h = hours({ precipitation: (v, i) => (i <= 7 ? 2 : 0) });
  assert.equal(S.summarize(h, "bicycle", 6, (i) => `h${i}`), "Rain until about h8.");
});
test("hazard comes before the place", () => {
  assert.equal(S.withPlace("Rain forecast (up to 2.0 mm/h). Allow longer braking distances.", "at the end"), "Rain forecast (up to 2.0 mm/h) at the end. Allow longer braking distances.");
  assert.equal(S.withPlace("Gusts up to 40 mph: strong enough.", "around mile 5"), "Gusts up to 40 mph around mile 5: strong enough.");
});
test("climb stats", () => assert.deepEqual(S.climbStats([100, 120, 110, 150]), { up: 60, down: 10, min: 100, max: 150 }));

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
  assert.ok(rain && rain.text.includes("at the end"), rain?.text);
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

console.log("Opening hours");
const at = (d, hm) => new Date(`2026-10-${d}T${hm}:00`);   // 12 Oct 2026 is a Monday
test("simple daily hours", () => {
  assert.equal(S.openAt("Mo-Su 08:30-17:00", at(14, "10:00")), true);
  assert.equal(S.openAt("Mo-Su 08:30-17:00", at(14, "17:30")), false);
});
test("weekday and weekend rules, later rules win", () => {
  const oh = "Mo-Fr 07:00-16:00; Sa,Su 09:00-15:00; Tu off";
  assert.equal(S.openAt(oh, at(12, "08:00")), true);    // Monday
  assert.equal(S.openAt(oh, at(13, "08:00")), false);   // Tuesday off
  assert.equal(S.openAt(oh, at(17, "08:00")), false);   // Saturday before 9
  assert.equal(S.openAt(oh, at(18, "14:00")), true);    // Sunday
});
test("split hours, 24/7, unknown and unparseable", () => {
  assert.equal(S.openAt("Mo-Sa 08:00-12:00,13:00-17:00", at(12, "12:30")), false);
  assert.equal(S.openAt("24/7", at(12, "03:00")), true);
  assert.equal(S.openAt("", at(12, "10:00")), null);
  assert.equal(S.openAt("Apr-Oct Mo-Su 10:00-16:00", at(12, "10:00")), null);
});

console.log("Surfaces");
test("road and surface classes", () => {
  const c = S.classifyWay;
  assert.equal(c("highway=primary surface=asphalt"), "busy");
  assert.equal(c("highway=unclassified surface=asphalt"), "quiet");
  assert.equal(c("highway=residential"), "quiet");
  assert.equal(c("highway=cycleway"), "path");
  assert.equal(c("highway=track surface=compacted"), "g1");
  assert.equal(c("highway=track tracktype=grade3"), "g2");
  assert.equal(c("highway=bridleway surface=grass"), "g3");
  assert.equal(c("highway=path mtb:scale=2"), "g3");
  assert.equal(c("highway=track"), "unknown");
});
test("surface stats join nearby problem stretches", () => {
  const r = { distance: 1000, cumD: [0, 300, 400, 500, 1000], cls: ["quiet", "g2", "quiet", "g2"] };
  const st = S.surfaceStats(r, "road");
  assert.equal(Math.round(st.pct.g2), 60);
  assert.equal(st.issues.length, 1);
  assert.equal(st.issues[0].len, 600);
  assert.equal(S.surfaceStats(r, "mtb").issues.length, 0);
});
test("bike profiles", () => {
  assert.equal(S.cycleProfile("road", true, true), "fastbike-verylowtraffic");
  assert.equal(S.cycleProfile("gravel", true, true), "gravel");
  assert.equal(S.cycleProfile("mtb", false, true), "trekking");
});

console.log("Loops");
test("loop waypoints start and end at home, far point in the chosen direction", () => {
  const start = { lat: 51.78, lon: -1.48 }, w = S.loopWaypoints(start, 48000, 90);
  assert.equal(w.length, 5); assert.equal(w[0], start); assert.equal(w[4], start);
  const far = w[2], r = 48000 / (2 * Math.PI * 1.15);
  assert.ok(Math.abs(S.haversine([start.lat, start.lon], [far.lat, far.lon]) - 2 * r) < 50);
  assert.ok(far.lon > start.lon && Math.abs(far.lat - start.lat) < 0.01);
});
test("out-and-back route counts as overlap; a square loop doesn't", () => {
  const line = (pts) => { const coords = pts, cumD = [0]; for (let i = 1; i < pts.length; i++) cumD.push(cumD[i - 1] + S.haversine(pts[i - 1], pts[i])); return { coords, cumD, cumT: cumD.map((d) => d / 5), distance: cumD.at(-1) }; };
  const a = [51.7, -1.4], b = [51.72, -1.4], c = [51.72, -1.37], d = [51.7, -1.37];
  assert.ok(S.overlapPct(line([a, b, a])) > 40);
  assert.ok(S.overlapPct(line([a, b, c, d, a])) < 5);
});
test("a stop goes between the waypoints either side of it", () => {
  const route = { coords: [[0, 0], [0, 1], [0, 2], [0, 3]], cumD: [0, 1, 2, 3], distance: 3 };
  const wps = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 3 }];
  assert.deepEqual(S.insertStop(wps, route, { lat: 0.01, lon: 2 }).map((w) => w.lon), [0, 1, 2, 3]);
});

console.log("Dog legs and cafés");
const path = (pts) => { const cumD = [0]; for (let i = 1; i < pts.length; i++) cumD.push(cumD[i - 1] + S.haversine(pts[i - 1], pts[i])); return { coords: pts, cumD, cumT: cumD.map((d) => d / 5), distance: cumD.at(-1) }; };
test("a dog leg off a square loop is found; the loop itself isn't", () => {
  const A = [51.70, -1.40], B = [51.73, -1.40], C = [51.73, -1.35], D = [51.70, -1.35], tip = [51.745, -1.375], mid = [51.73, -1.375];
  assert.equal(S.findSpurs(path([A, B, C, D, A])).length, 0);
  const sp = S.findSpurs(path([A, B, mid, tip, mid, C, D, A]));
  assert.equal(sp.length, 1);
  assert.ok(Math.abs(sp[0].apex.lat - 51.745) < 0.002, JSON.stringify(sp[0].apex));
});
test("chains are recognised by brand or name", () => {
  assert.ok(S.isChain({ name: "Costa Coffee" })); assert.ok(S.isChain({ name: "Caffè Nero" }));
  assert.ok(S.isChain({ name: "The Bean", brand: "Some Brand" })); assert.ok(!S.isChain({ name: "Ue Coffee Roastery" }));
});
test("cafés near each other: the local coffee place wins; far-off cafés are left out", () => {
  const r = path([[51.70, -1.40], [51.70, -1.30]]);
  const cafes = [{ lat: 51.7003, lon: -1.35, name: "Costa Coffee", hours: "" }, { lat: 51.7004, lon: -1.3505, name: "Little Roastery", hours: "" },
    { lat: 51.71, lon: -1.33, name: "Too far", hours: "" }, { lat: 51.7002, lon: -1.32, name: "Village Café", hours: "" }];
  assert.deepEqual(S.cafesOnRoute(r, cafes, 1_800_000_000).map((c) => c.name), ["Little Roastery", "Village Café"]);
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
    const elev = await S.fetchElevation(r);
    console.log(`    climb: ${JSON.stringify(S.climbStats(elev.z))}`);
    const b = plan.options[plan.best];
    test(`${mode}: Witney → Burford planned`, () => {
      assert.equal(wx.length, c.length);
      assert.ok(plan.options.length >= 6);
    });
    console.log(`    ${(r.distance / S.MILE).toFixed(1)} mi, ${Math.round(r.duration / 60)} min, ${c.length} checkpoints; levels by departure: ${plan.options.map((o) => o.level).join("")}; best leaves ${new Date(b.dep * 1000).toTimeString().slice(0, 5)}`);
    console.log(`    summary: ${plan.options[0].summary}`);
    console.log(`    scores now: ice ${plan.options[0].scores.ice.score}, soak ${plan.options[0].scores.rain.score}, wind ${plan.options[0].scores.wind.score}; reasons: ${plan.options[0].reasons.map((x) => x.text).join(" | ") || "none"}`);
  }
}
if (process.argv.includes("--live")) {
  console.log("Live loop");
  const start = { lat: 51.7856, lon: -1.4857 };
  const t0 = Date.now();
  const plan = await S.planLoop(start, 15, "road", { avoidBusy: true, offroad: false }, { from: 240, speed: 12 });
  const b = plan.best;
  test("15-mile road loop from Witney is within 15% of target", () => assert.ok(Math.abs(b.route.distance / S.MILE - 15) < 2.25, (b.route.distance / S.MILE).toFixed(1)));
  console.log(`    ${(b.route.distance / S.MILE).toFixed(1)} mi, climb ${b.route.climb} m, score ${b.score.total.toFixed(1)} ${JSON.stringify(Object.fromEntries(Object.entries(b.score.parts).map(([k, v]) => [k, +v.toFixed(1)])))}; surfaces ${JSON.stringify(Object.fromEntries(Object.entries(b.score.stats.pct).filter(([, v]) => v > 0.5).map(([k, v]) => [k, Math.round(v)])))}; ${plan.others.length} alternatives; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const withCafe = await S.addCafeStop(b, "road", {}, Math.floor(Date.now() / 1000));
  console.log(`    café: ${withCafe.cafe ? `${withCafe.cafe.name} (open: ${withCafe.cafe.open}) at ${Math.round(withCafe.cafe.frac * 100)}%, loop now ${(withCafe.route.distance / S.MILE).toFixed(1)} mi` : "none found"}`);
}
console.log(`\n${passed} passed`);
