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
// A straight 10-mile ride east along a quiet road, as BRouter would answer.
function brouterRoute(from) {
  const n = 41, coords = Array.from({ length: n }, (_, i) => [from.lon + i * 0.0058, from.lat, 90 + i]);
  return { features: [{ properties: { messages: [["Longitude", "Latitude", "WayTags"], ...coords.slice(1).map(([lo, la]) => [String(Math.round(lo * 1e6)), String(Math.round(la * 1e6)), "highway=unclassified surface=asphalt"])],
    times: coords.map((_, i) => i * 60), "total-time": String(40 * 60), "filtered ascend": "40" }, geometry: { coordinates: coords } }] };
}
// What the Safe2Ride API answers (see contract/v2.json): one departure option, everything clear.
function assessRoute(body) {
  const cps = body.cps;
  const pts = cps.map((c, k) => ({ k, at: 6, eta: body.now + c.t, level: 0 }));
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
    const [lon, lat] = new URL(r.request().url()).searchParams.get("lonlats").split("|")[0].split(",").map(Number);
    return json(r, brouterRoute({ lat, lon }));
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
    if (p === "/describe/route") return json(r, { v: 2, text: `A gentle ride from ${body.route.start} to ${body.route.end}.` });
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
  await page.waitForSelector(".rdlg .desc");
  assert.match(await page.textContent(".rdlg .desc"), /Good to go/);
  assert.match(await page.textContent(".rdlg .desc"), /9\.9 mi, about 40 min/);
  assert.ok(await page.locator(".dep").count() >= 1);
  const route = calls.api.find((c) => c.path === "/assess/route").body;
  assert.equal(route.v, 2);
  assert.match(page.url(), /#r=/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Description: asked for only on a tap, written once per departure, home kept private", async () => {
  const { page, ctx, errors, calls } = await openPage();
  await page.fill("#to", "Burford");
  await page.click("#to-sug li");
  await page.waitForSelector(".rdlg .desc");
  assert.equal(calls.api.filter((c) => c.path === "/describe/route").length, 0, "nothing is written until asked");
  await page.click("#describe");
  await page.waitForSelector(".ai p");
  assert.equal(await page.textContent(".ai p"), "A gentle ride from Witney to Burford.");
  assert.match(await page.textContent(".ai small"), /Written by AI/);
  assert.ok(await page.locator("#describe").isHidden());
  const sent = calls.api.find((c) => c.path === "/describe/route").body;
  assert.equal(sent.v, 2);
  assert.equal(sent.dep, calls.api.find((c) => c.path === "/assess/route").body.now);
  assert.doesNotMatch(JSON.stringify(sent.route), /Your location|51\.785|-1\.485/, "the route facts never name or pinpoint home");
  // Away to another departure time (if there is one) and back: the same text, no second call.
  const deps = await page.locator(".dep").count();
  if (deps > 1) { await page.locator(".dep").nth(1).click(); await page.locator(".dep").nth(0).click(); }
  assert.equal(await page.textContent(".ai p"), "A gentle ride from Witney to Burford.");
  assert.equal(calls.api.filter((c) => c.path === "/describe/route").length, 1);
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
  await page.waitForSelector(".rdlg .desc");
  await page.waitForFunction(() => !document.querySelector("#plan").disabled);
  assert.equal(calls.route, 2, "planned twice: once dropped, once with the new setting");
  assert.doesNotMatch(await page.textContent(".rdlg .desc"), /café/i);
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
