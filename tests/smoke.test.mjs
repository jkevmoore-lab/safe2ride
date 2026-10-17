// Browser smoke tests: the real page in a real browser, with every outside service faked.
// Run with: npm run test:smoke   (uses Playwright's Chromium, or your installed Chrome if that isn't downloaded)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".brf": "text/plain", ".css": "text/css" };
const HOME = { latitude: 51.7856, longitude: -1.4857 };   // Witney
const MILE = 1609.344;

let server, browser, base;
before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const index = path.join(file, "index.html");
      if (fs.existsSync(index)) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(index)); }
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});
after(async () => { await browser?.close(); server?.close(); });

// --- Fake outside services ------------------------------------------------------------

// Open-Meteo hourly data, mild/dry/calm. `times`: unix seconds, or local strings for the "here" check.
function hourly(times) {
  const f = (v) => times.map(() => v);
  return { time: times, temperature_2m: f(12), apparent_temperature: f(11), dew_point_2m: f(6), precipitation: f(0), precipitation_probability: f(5),
    snowfall: f(0), weather_code: f(1), visibility: f(20000), wind_speed_10m: f(8), wind_gusts_10m: f(14), wind_direction_10m: f(240),
    soil_temperature_0cm: f(11), is_day: f(1) };
}
function forecast(url) {
  const u = new URL(url), past = +u.searchParams.get("past_hours"), ahead = +u.searchParams.get("forecast_hours");
  const t0 = Math.floor(Date.now() / 3600000) * 3600 - past * 3600, n = past + ahead;
  if (u.searchParams.get("timeformat") === "unixtime") {
    const each = u.searchParams.get("latitude").split(",").map(() => ({ hourly: hourly(Array.from({ length: n }, (_, i) => t0 + i * 3600)) }));
    return each.length === 1 ? each[0] : each;
  }
  return { timezone: "Europe/London", hourly: hourly(Array.from({ length: n }, (_, i) => new Date((t0 + i * 3600) * 1000).toISOString().slice(0, 16))) };
}
// A ride along a quiet road through the given [lon, lat] points, as BRouter would answer. Alternative `alt` bows out
// to the north by alt × 0.01°, so each alternative is a different route.
function brouterRoute(pts, alt = 0) {
  if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.232, pts[0][1]]];
  const n = 41, legs = pts.length - 1;
  const coords = Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1) * legs, j = Math.min(legs - 1, Math.floor(f)), u = f - j, [a, b] = [pts[j], pts[j + 1]];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + alt * 0.01 * Math.sin(Math.PI * i / (n - 1)), 90 + i];
  });
  return { features: [{ properties: { messages: [["Longitude", "Latitude", "WayTags"], ...coords.slice(1).map(([lo, la]) => [String(Math.round(lo * 1e6)), String(Math.round(la * 1e6)), "highway=unclassified surface=asphalt"])],
    times: coords.map((_, i) => i * 60), "total-time": String(40 * 60), "filtered ascend": "40" }, geometry: { coordinates: coords } }] };
}
// What the Safe2Ride API answers (see contract/v2.json): one departure option, everything clear.
function assessRoute(body) {
  const cps = body.cps;
  const pts = cps.map((c, k) => ({ k, at: 6, eta: body.now + c.t, level: 0, kinds: [] }));
  const segs = cps.slice(1).map((c, k) => ({ k, dist: c.dist - cps[k].dist, hours: (c.t - cps[k].t) / 3600, level: 0, head: -3, crossGust: 4, rain: 0 }));
  const score = (label, detail) => ({ score: 0, label, detail });
  return { v: 2, best: 0, options: [{ dep: body.now, arrive: body.now + cps.at(-1).t, level: 0, cost: 0, reasons: [], summary: "Dry all the way.",
    scores: { ice: score("Very low", "Surface down to 11°C, dry roads"), rain: score("Staying dry", "5% chance"), wind: score("Calm", "Gusts up to 14 mph") },
    headD: 0, tailD: 0, pts, segs }] };
}
function assessHere(body) {
  const score = (label) => ({ score: 0, label, detail: "" });
  return { v: 2, time: body.hourly.time[6], level: 0, verdict: "Good to go", summary: "Dry for the next 12 hours.", reasons: [],
    scores: { ice: score("Very low"), rain: score("Staying dry"), wind: score("Calm") }, levels: body.hourly.time.map(() => 0) };
}

// A page with the fakes in place. `opts.api` can replace the API's answers; `opts.routeDelay` holds BRouter's first answer back.
async function openPage(hash = "", opts = {}) {
  const ctx = await browser.newContext({ geolocation: HOME, permissions: ["geolocation"], viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [], calls = { route: 0, api: [] };
  page.on("pageerror", (e) => errors.push(e.message));
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  await page.route(/tiles\.openfreemap\.org/, (r) => json(r, { version: 8, sources: {}, layers: [] }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
  await page.route(/photon\.komoot\.io/, (r) => json(r, { features: [{ properties: { name: "Burford", county: "Oxfordshire", country: "United Kingdom" }, geometry: { coordinates: [-1.6363, 51.8076] } }] }));
  await page.route(/brouter\.de\/brouter\/profile/, (r) => json(r, { profileid: "custom_1" }));
  await page.route(/brouter\.de\/brouter\?/, async (r) => {
    const first = ++calls.route === 1;
    if (first && opts.routeDelay) await new Promise((res) => setTimeout(res, opts.routeDelay));
    const q = new URL(r.request().url()).searchParams, pts = q.get("lonlats").split("|").map((x) => x.split(",").map(Number));
    return json(r, brouterRoute(pts, +q.get("alternativeidx") || 0));
  });
  await page.route(/api\.open-meteo\.com\/v1\/forecast/, (r) => json(r, forecast(r.request().url())));
  await page.route(/api\.open-meteo\.com\/v1\/elevation/, (r) => json(r, { elevation: Array(80).fill(100) }));
  await page.route(/nominatim\.openstreetmap\.org/, (r) => json(r, []));
  await page.route(/api\.bigdatacloud\.net/, (r) => json(r, { locality: "Witney" }));
  await page.route(/safe2ride-api\.safe2ride\.workers\.dev/, (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" } });
    const body = JSON.parse(r.request().postData()), p = new URL(r.request().url()).pathname;
    calls.api.push({ path: p, body });
    if (opts.api) { const [status, reply] = opts.api(p, body); return json(r, reply, status); }
    if (p === "/describe/route") { calls.describe = (calls.describe || 0) + 1; return json(r, { v: 2, text: `A gentle ride from ${body.route.start} to ${body.route.end}.` }); }
    return json(r, p === "/assess/here" ? assessHere(body) : assessRoute(body));
  });
  await page.goto(base + "index.html" + hash);
  return { page, ctx, errors, calls };
}

// --- Tests ------------------------------------------------------------------------------

test("Safe to ride here? shows the verdict for where you are", async () => {
  const { page, ctx, errors, calls } = await openPage();
  await page.click("#here-btn");
  await page.waitForSelector(".verdict h2");
  assert.equal(await page.textContent(".verdict h2"), "Good to go");
  assert.match(await page.textContent(".verdict .place"), /Witney/);
  assert.equal(calls.api[0].body.v, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("A → B: pick a destination and get a route with departure times", async () => {
  const { page, ctx, errors, calls } = await openPage();
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector(".rdlg .rsum");
  assert.match(await page.textContent(".rdlg .rsum"), /Good to go/);
  assert.match(await page.textContent(".rdlg .rsum"), /\d+\.\d mi · 40 min · leave now, arrive \d\d:\d\d/);
  assert.equal(await page.textContent("#plan"), "Update");
  assert.ok(await page.locator(".dep").count() >= 1);
  const route = calls.api.find((c) => c.path === "/assess/route").body;
  assert.equal(route.v, 2);
  assert.match(page.url(), /#r=/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the AI briefing is written straight away, once per departure, and never names home", async () => {
  const { page, ctx, errors, calls } = await openPage();
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector(".ai:not(.writing) p");
  assert.equal(await page.textContent(".ai p"), "A gentle ride from Witney to Burford.");
  assert.match(await page.textContent(".ai small"), /Written by AI/);
  const sent = calls.api.find((c) => c.path === "/describe/route").body;
  assert.equal(sent.v, 2);
  assert.equal(sent.dep, calls.api.find((c) => c.path === "/assess/route").body.now);
  assert.doesNotMatch(JSON.stringify(sent.route), /Your location|51\.785|-1\.485/, "the route facts never name or pinpoint home");
  // Away to another departure time and straight back: the same text, no second call.
  if (await page.locator(".dep").count() > 1) { await page.locator(".dep").nth(1).click(); await page.locator(".dep").nth(0).click(); }
  await page.waitForTimeout(900);
  assert.equal(await page.textContent(".ai p"), "A gentle ride from Witney to Burford.");
  assert.equal(calls.describe, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("if the AI briefing fails, our own summary shows with a Try again", async () => {
  let fail = true;
  const { page, ctx, errors, calls } = await openPage("", { api: (p, body) => p === "/describe/route"
    ? (fail ? [503, { error: "Route descriptions aren't available right now. Please try again later." }] : [200, { v: 2, text: "Second time lucky." }])
    : [200, assessRoute(body)] });
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector("#ai-retry");
  assert.match(await page.textContent(".ai p"), /Dry all the way/);
  assert.match(await page.textContent(".ai small"), /aren't available.*our own summary/);
  fail = false;
  await page.click("#ai-retry");
  await page.waitForSelector(".ai:not(.writing) p:text('Second time lucky.')");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("› finds a new route only when tapped; ‹ brings earlier ones back without asking again", async () => {
  const { page, ctx, errors, calls } = await openPage();
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector(".rdlg .rsum");
  const after1 = calls.route;
  assert.equal(after1, 1, "only the first route is fetched");
  assert.equal(await page.textContent(".rt b"), "Route 1");
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector(".rt b")?.textContent === "Route 2");
  assert.equal(calls.route, 2);
  const routeChecks = calls.api.filter((c) => c.path === "/assess/route").length;
  await page.click("#prev");
  await page.waitForFunction(() => document.querySelector(".rt b")?.textContent === "Route 1");
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector(".rt b")?.textContent === "Route 2");
  assert.equal(calls.route, 2, "going back and forward again fetches nothing new");
  assert.equal(calls.api.filter((c) => c.path === "/assess/route").length, routeChecks);
  // Keep going: never more than 10 routes.
  for (let k = 3; k <= 10; k++) {
    await page.click("#next");
    await page.waitForFunction((n) => document.querySelector(".rt b")?.textContent.startsWith(`Route ${n}`), k);
  }
  assert.ok(await page.locator("#next").isDisabled(), "no 11th route");
  assert.equal(await page.textContent(".rt b"), "Route 10 of 10");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("risk points: a pill on the card and a hazard tag on the map; the map has a route colour key", async () => {
  const { page, ctx, errors } = await openPage("", { api: (p, body) => {
    if (p !== "/assess/route") return [200, { v: 2, text: "Windy in the middle." }];
    const r = assessRoute(body), o = r.options[0];
    o.level = 1; o.pts[2] = { ...o.pts[2], level: 1, kinds: ["wind", "rain"] };
    return [200, r];
  } });
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector(".risk");
  assert.equal(await page.locator(".risk").count(), 1);
  assert.match(await page.textContent(".risk"), /^!\d\d:\d\d mi \d+(\.\d)? Wind$/);
  await page.waitForSelector(".wchip.b1");
  assert.match(await page.textContent(".wchip.b1"), /Wind/);
  await page.click(".risk");
  await page.waitForSelector(".maplibregl-popup");
  assert.match(await page.textContent(".maplibregl-popup"), /Wind/);
  assert.ok(await page.locator("#rkey").isVisible());
  assert.match(await page.textContent("#rkey"), /Quiet road 100%/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a share link with bad values opens safely with sensible defaults", async () => {
  const bad = { r: "loop", b: "unicycle", o: "1x01", L: 1000, f: ["51", -1, "x"] };
  const { page, ctx, errors } = await openPage("#r=" + encodeURIComponent(JSON.stringify(bad)));
  await page.waitForFunction(() => document.querySelector("#loop-field") && !document.querySelector("#loop-field").hidden);
  assert.equal(await page.inputValue("#bike"), "road");
  assert.equal(await page.inputValue("#loop-len"), "100");
  assert.equal(await page.inputValue("#from"), "");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("changing a setting while a ride is planning re-plans with the new setting", async () => {
  const { page, ctx, errors, calls } = await openPage("", { routeDelay: 1500 });
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForFunction(() => document.querySelector("#plan").disabled);
  await page.click("label:has(#opt-cafe)");          // café stop off, mid-plan
  await page.waitForSelector(".rdlg .rsum");
  await page.waitForFunction(() => !document.querySelector("#plan").disabled);
  assert.equal(calls.route, 2, "planned twice: once dropped, once with the new setting");
  assert.match(decodeURIComponent(page.url()), /"o":"1000"/, "the ride on show has the café stop off");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("an out-of-date page is asked to refresh", async () => {
  const { page, ctx, errors } = await openPage("", { api: () => [409, { error: "Safe2Ride has been updated. Please refresh the page.", code: "version" }] });
  await page.click("#here-btn");
  await page.waitForSelector("#status.error");
  assert.match(await page.textContent("#status"), /refresh the page/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
