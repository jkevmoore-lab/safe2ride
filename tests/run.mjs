// Unit tests for the parts of the site with no page to draw on. Run with: npm run test:unit   (npm run test:live also hits the real APIs)
import fs from "fs";
import assert from "assert/strict";
import * as logicJs from "../logic.js";
import * as routeJs from "../route.js";
import * as loopJs from "../loop.js";
import * as apiJs from "../api.js";
import * as shareJs from "../share.js";
import * as appJs from "../app.js";
import * as describeJs from "../describe.js";

const S = { ...logicJs, ...routeJs, ...loopJs, ...apiJs, ...shareJs, ...appJs, ...describeJs };

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

console.log("Weather helpers");
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

// The API call for a route (api.js), with the Worker faked: what's sent, and how the reply is joined back up.
{
  // Points and stretches come back shuffled: they must be joined by k, not by position.
  const fake = { v: 2, best: 0, options: [{ dep: t0, arrive: t0 + 2400, level: 1, reasons: [], scores: {}, summary: "",
    pts: cps.map((c, k) => ({ k, at: 6, eta: t0 + c.t, level: k === 2 ? 2 : 1 })).reverse(),
    segs: cps.slice(1).map((_, k) => ({ k, head: k })).reverse() }] };
  const saved = globalThis.fetch;
  let sent;
  const reply = (status, body) => async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return new Response(JSON.stringify(body), { status }); };
  globalThis.fetch = reply(200, fake);
  const wx = cps.map((_, k) => ({ time: [k] }));
  const plan = await S.assessRoute(cps, wx, "bicycle", t0);
  globalThis.fetch = reply(409, { error: "x", code: "version" });
  const old = await S.assessRoute(cps, wx, "bicycle", t0).catch((e) => e.message);
  globalThis.fetch = reply(200, { ...fake, options: [{ ...fake.options[0], pts: fake.options[0].pts.slice(1) }] });
  const short = await S.assessRoute(cps, wx, "bicycle", t0).catch((e) => e.message);
  globalThis.fetch = saved;
  test("route check sends the version, weather and checkpoints, and joins the reply back up by index", () => {
    assert.match(sent.url, /\/assess\/route$/);
    assert.equal(sent.v, S.API_VERSION);
    assert.deepEqual(Object.keys(sent.cps[0]), ["lat", "lon", "t", "dist"]);
    assert.equal(typeof sent.tz, "string");
    const o = plan.options[0];
    assert.equal(o.pts[2].h, wx[2]);
    assert.equal(o.pts[2].lat, cps[2].lat);
    assert.equal(o.pts[2].level, 2);
    assert.deepEqual(o.segs.map((g) => g.head), [0, 1, 2, 3]);
    assert.equal(o.segs[1].from, o.pts[1]);
    assert.equal(o.segs[1].to, o.pts[2]);
  });
  test("an out-of-date page is asked to refresh; a reply missing a point is an error", () => {
    assert.match(old, /refresh the page/);
    assert.match(short, /had a problem/);
  });
}

// Route descriptions (describe.js and api.js): what's looked up and sent, with every service faked.
{
  const contract = JSON.parse(fs.readFileSync(new URL("../contract/v2.json", import.meta.url), "utf8")).endpoints["POST /describe/route"];
  const route = { coords: [[51.78, -1.49], [51.78, -1.40], [51.80, -1.30]], cumD: [0, 6000, 14000], cumT: [0, 900, 2100], distance: 14000, duration: 2100, climb: 85 };
  const trip = { ride: "ab", bike: "road", route, elev: { d: [0, 7000, 14000], z: [90, 140, 100] },
    stats: { pct: { quiet: 70.04, busy: 29.96 }, issues: [{ cls: "busy", level: 1, start: 4000, len: 4200 }] },
    cafes: [{ name: "Huffkins", dist: 13000, t: 1950, hours: "Mo-Su 08:00-17:00", chain: false }] };
  const saved = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (/photon.*reverse/.test(url)) {
      const n = asked.filter((u) => /reverse/.test(u)).length;
      if (n === 3) return new Response("", { status: 500 });                   // a failed lookup is just a gap
      const everywhere = [-2, 52, -1, 51];                                       // extent: west, north, east, south
      if (n === 4) return Response.json({ features: [{ properties: { osm_key: "highway", osm_value: "service", name: "Windrush Motors", district: "Witney", extent: everywhere } }] });
      if (n === 6) return Response.json({ features: [{ properties: { osm_key: "highway", osm_value: "primary", name: "Far Away Road", city: "Burford", extent: [0, 1, 0.1, 0.9] } }] });
      return Response.json({ features: [{ properties: n <= 5 ? { osm_key: "highway", osm_value: "unclassified", name: "Burford Road", district: "Witney", city: "West Oxfordshire", extent: everywhere }
        : { osm_key: "highway", osm_value: "tertiary", name: "B4047", city: "Burford", extent: everywhere } }] });
    }
    if (/bigdatacloud/.test(url)) return Response.json({ locality: "Witney" });
    return Response.json({ v: 2, text: "A gentle ride." });
  };
  const names = await S.routeNames(route);
  const mine = await S.publicName({ name: "Your location", lat: 51.7856, lon: -1.4857 });
  const named = await S.publicName({ name: "Burford", lat: 51.8, lon: -1.6 });
  const dep = Date.UTC(2026, 9, 17, 9, 0) / 1000;
  const facts = S.rideFacts(trip, { dep }, names, mine, named);
  asked.length = 0;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return Response.json({ v: 2, text: "A gentle ride." }); };
  const text = await S.describeRoute([{ lat: 1, lon: 2, t: 0, dist: 0, h: {}, gi: 4 }], [{ time: [1] }], "bicycle", dep - 60, dep, facts);
  globalThis.fetch = async () => Response.json({ error: "Route descriptions aren't available right now. Please try again later." }, { status: 503 });
  const off = await S.describeRoute([], [], "bicycle", 0, 0, facts).catch((e) => e.message);
  globalThis.fetch = saved;
  test("towns and roads along the route come out in order, without repeats, gaps, councils or driveways", () => {
    assert.deepEqual(names, { places: ["Witney", "Burford"], roads: ["Burford Road", "B4047"] });
  });
  test("your own location is sent only as the nearest town", () => {
    assert.equal(mine, "Witney");
    assert.equal(named, "Burford");
  });
  test("the route facts are the ones the contract lists, rounded for reading", () => {
    assert.deepEqual(Object.keys(facts), contract.route);
    assert.deepEqual(Object.keys(facts.issues[0]), contract.issue);
    assert.deepEqual(Object.keys(facts.cafes[0]), contract.cafe);
    assert.deepEqual(Object.keys(facts.hills), contract.hills);
    assert.deepEqual(facts.surfaces, { quiet: 70, busy: 30 });
    assert.deepEqual(facts.issues[0], { kind: "busy", level: 1, mile: 2.5, lengthMiles: 2.6 });
    assert.equal(facts.climbM, 85);
    assert.equal(facts.cafes[0].mile, 8.1);
  });
  test("a description request carries the ride, the departure and the facts, and slim checkpoints", () => {
    assert.match(sent.url, /\/describe\/route$/);
    assert.deepEqual(Object.keys(sent).filter((k) => k !== "url"), contract.request);
    assert.deepEqual(Object.keys(sent.cps[0]), ["lat", "lon", "t", "dist"]);
    assert.equal(text, "A gentle ride.");
  });
  test("when descriptions are switched off the rider is told so", () => assert.match(off, /aren't available/));
}

console.log("Finding more routes");
{
  const line = (pts) => { const coords = pts, cumD = [0]; for (let i = 1; i < coords.length; i++) cumD.push(cumD[i - 1] + S.haversine(coords[i - 1], coords[i])); return { coords, cumD, cumT: cumD, distance: cumD.at(-1), duration: cumD.at(-1) }; };
  const east = line([[51.78, -1.50], [51.78, -1.45], [51.78, -1.40]]);
  const bowed = line([[51.78, -1.50], [51.80, -1.45], [51.78, -1.40]]);
  test("a route is the same as another when it runs along it, different when it goes its own way", () => {
    assert.ok(S.similarity(east, east) > 0.99);
    assert.ok(S.similarity(bowed, east) < 0.3);
  });
  const saved = globalThis.fetch;
  let asked;
  globalThis.fetch = async (url) => {
    asked = String(url);
    return Response.json({ code: "Ok", routes: [{ distance: 2000, duration: 120, geometry: { coordinates: [[-1.5, 51.78], [-1.49, 51.78], [-1.48, 51.79], [-1.47, 51.79]] },
      legs: [{ annotation: { distance: [700, 300], duration: [40, 20] } }, { annotation: { distance: [1000], duration: [60] } }] }] });
  };
  const moto = await S.fetchRoute([{ lat: 51.78, lon: -1.5 }, { lat: 51.79, lon: -1.48 }, { lat: 51.79, lon: -1.47 }], "motorbike");
  globalThis.fetch = saved;
  test("a motorbike route through a via point joins its legs up end to end", () => {
    assert.match(asked, /-1\.5,51\.78;-1\.48,51\.79;-1\.47,51\.79\?/);
    assert.deepEqual(moto.cumD, [0, 700, 1000, 2000]);
    assert.deepEqual(moto.cumT, [0, 40, 60, 120]);
    assert.equal(moto.coords.length, 4);
  });
}

console.log("Shared contract with the API");
{
  const contract = JSON.parse(fs.readFileSync(new URL("../contract/v2.json", import.meta.url), "utf8"));
  test("the site sends the version, weather and hours the contract says", () => {
    assert.equal(S.API_VERSION, contract.v);
    assert.deepEqual(S.WEATHER_VARS.split(","), contract.weather.vars);
    assert.equal(S.PAST_HOURS, contract.weather.pastHours);
    assert.equal(S.FORECAST_HOURS, contract.weather.forecastHours);
  });
  // Only when the API repo is checked out next to this one (not in CI): the two copies must be identical.
  const theirs = new URL("../../safe2ride-api/contract/v2.json", import.meta.url);
  if (fs.existsSync(theirs)) test("contract/v2.json is identical in both repos", () => assert.equal(fs.readFileSync(theirs, "utf8"), fs.readFileSync(new URL("../contract/v2.json", import.meta.url), "utf8")));
}

console.log("Share links");
test("a good link round-trips", () => {
  const prefs = { busy: true, offroad: false, cafe: true, flat: false, miles: 30 };
  const hash = S.shareHash("ab", "gravel", prefs, { lat: 51.81234, lon: -1.63, name: "Burford" }, null);
  assert.deepEqual(S.parseShare(hash), { ride: "ab", bike: "gravel", opts: { busy: true, offroad: false, cafe: true, flat: false }, miles: 30,
    to: { lat: 51.8123, lon: -1.63, name: "Burford", label: "Burford" } });
});
test("bad parts of a link are dropped, not trusted", () => {
  const link = (st) => S.parseShare("#r=" + encodeURIComponent(JSON.stringify(st)));
  assert.deepEqual(link({ r: "loop", b: "unicycle", o: "1x01", L: 1000, t: ["51", -1, "x"], f: [95, 0, "Nowhere"] }), { ride: "loop", miles: 100 });
  assert.equal(link({ L: 2 }).miles, 5);
  assert.equal(link({ L: 23 }).miles, 25);
  assert.equal(link({ t: [51, -1, "<b>" + "x".repeat(200)] }).to.name.length, 80);
  assert.equal(link({ t: [51, -1] }).to.name, "Shared place");
  assert.equal(S.parseShare("#r=%7Bnot json"), null);
  assert.equal(S.parseShare("#how"), null);
});

console.log("Gaps in the forecast");
test("missing values show as a dash, never as 0", () => {
  assert.equal(S.num(null), "–"); assert.equal(S.num(3.46, 1), "3.5"); assert.equal(S.num(0), "0");
  const h = { weather_code: [null], precipitation: [null], snowfall: [null], wind_speed_10m: [null], wind_direction_10m: [null], temperature_2m: [null], is_day: [1] };
  const b = S.wxBits(h, 0);
  assert.equal(b.temp, "–"); assert.equal(b.fall, "rain unknown"); assert.match(b.arrow, /Wind from the \?, – mph/);
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
  assert.equal(S.cycleProfile("road", true, true), "road");
  assert.equal(S.cycleProfile("road", false, false), "road-lowtraffic");
  assert.equal(S.cycleProfile("gravel", true, true), "gravel");
  assert.equal(S.cycleProfile("mtb", false, true), "trekking");
});

// Road bikes: our profile is uploaded once, re-uploaded when BRouter has dropped it, and BRouter's own is the fallback.
{
  const saved = globalThis.fetch, asked = [];
  const geo = JSON.stringify({ features: [{ properties: { messages: [["Longitude", "Latitude", "WayTags"], ["-1390000", "51700000", "highway=residential"]], times: [0, 60], "total-time": "60", "filtered ascend": "0" },
    geometry: { coordinates: [[-1.4, 51.7, 0], [-1.39, 51.7, 0]] } }] });
  let uploads = 0, expired = false, island = false;
  globalThis.location = { href: "https://safe2ride.co.uk/" };
  globalThis.fetch = async (url) => {
    url = String(url); asked.push(url);
    if (url.endsWith("profiles/road.brf")) return new Response("# profile");
    if (url.endsWith("/brouter/profile")) return new Response(JSON.stringify({ profileid: `custom_${++uploads}` }));
    const custom = /profile=custom_/.test(url);
    if (custom && expired) { expired = false; return new Response("", { status: 500 }); }
    if (custom && island) return new Response("target island detected for section 1", { status: 500 });
    return new Response(geo);
  };
  const wps = [{ lat: 51.7, lon: -1.4 }, { lat: 51.7, lon: -1.39 }];
  const last = () => asked.at(-1).match(/profile=([^&]+)(&profile:consider_traffic=[\d.]+)?/).slice(1).join("");
  await S.fetchCycleRoute(wps, "road"); const first = last();
  await S.fetchCycleRoute(wps, "road-lowtraffic"); const second = last();
  expired = true; await S.fetchCycleRoute(wps, "road"); const afterExpiry = last();
  island = true; const r = await S.fetchCycleRoute(wps, "road"); const fallback = last();
  await S.fetchCycleRoute(wps, "trekking"); const other = last();
  globalThis.fetch = saved; delete globalThis.location;
  test("road bikes use our own profile, re-uploaded when it expires, with BRouter's as a fallback", () => {
    assert.equal(first, "custom_1&profile:consider_traffic=1");
    assert.equal(second, "custom_1&profile:consider_traffic=0.5");
    assert.equal(afterExpiry, "custom_2&profile:consider_traffic=1");
    assert.equal(uploads, 2);
    assert.equal(fallback, "fastbike-verylowtraffic");
    assert.equal(r.profile, "road");
    assert.equal(other, "trekking");
  });
}

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

console.log("Out-and-back stretches and cafés");
const path = (pts) => { const cumD = [0]; for (let i = 1; i < pts.length; i++) cumD.push(cumD[i - 1] + S.haversine(pts[i - 1], pts[i])); return { coords: pts, cumD, cumT: cumD.map((d) => d / 5), distance: cumD.at(-1) }; };
test("an out-and-back off a square loop is found; the loop itself isn't", () => {
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
    const r = await S.fetchRoute([{ lat: 51.7856, lon: -1.4857 }, places[0]], mode);
    const c = S.makeCheckpoints(r);
    const wx = await S.fetchRouteWeather(c, S.forecastHoursFor(r));
    const plan = await S.assessRoute(c, wx, mode, Math.floor(Date.now() / 1000));
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
