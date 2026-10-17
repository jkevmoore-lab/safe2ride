// Safe2Ride loops and café stops. No DOM access here so it can be tested on its own.

import { MILE, SURFACES, SURFACE_FIT, bearing, cycleProfile, destPoint, fetchCycleRoute, haversine, pointAt, surfaceStats } from "./route.js";

// --- Opening hours ---------------------------------------------------------------

// Is a place open at `date`, from an OpenStreetMap opening_hours value? true / false / null (can't tell).
// Handles the common forms: "24/7", "Mo-Fr 08:00-17:00; Sa,Su 09:00-16:00", "Tu off", several time ranges.
// Anything fancier (months, holidays, week numbers) answers null rather than guessing.
function openAt(oh, date) {
  if (!oh) return null;
  oh = oh.trim();
  if (oh === "24/7") return true;
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const day = (date.getDay() + 6) % 7, mins = date.getHours() * 60 + date.getMinutes();
  let result = null, matched = false;
  for (let rule of oh.split(";").map((r) => r.trim()).filter(Boolean)) {
    if (/^PH\b/.test(rule)) continue;                        // public-holiday rules: ignore
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/.exec(rule);
    if (!m) return null;
    const [, dayPart, timePart] = m;
    let days = dayPart ? new Set() : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (dayPart) for (const part of dayPart.split(",").filter(Boolean)) {
      const [a, b] = part.split("-").map((d) => DAYS.indexOf(d));
      for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (b === undefined || d === b) break; }
    }
    const tp = timePart.replace(/,?\s*PH\s+off/i, "").trim();
    if (!days.has(day)) continue;
    if (/^(off|closed)$/i.test(tp)) { result = false; matched = true; continue; }
    const ranges = tp.split(",").map((r) => /^(\d\d):(\d\d)-(\d\d):(\d\d)\+?$/.exec(r.trim()));
    if (!tp || ranges.some((r) => !r)) return null;
    result = ranges.some((r) => { const a = +r[1] * 60 + +r[2], b = +r[3] * 60 + +r[4]; return b > a ? mins >= a && mins < b : mins >= a || mins < b; });
    matched = true;
  }
  return matched ? result : false;
}

// --- Cafés from OpenStreetMap ----------------------------------------------------------

const OVERPASS = ["https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"];

// Nominatim first (reliable, includes opening hours, max 40 results), then the Overpass mirrors.
async function searchCafes(south, west, north, east) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=cafe&viewbox=${west},${north},${east},${south}&bounded=1&format=jsonv2&limit=40&extratags=1`,
      { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const j = await res.json();
      const cafes = j.filter((e) => e.category === "amenity" && e.type === "cafe").map((e) => ({ lat: +e.lat, lon: +e.lon, ...cafeFrom(e.name, e.extratags || {}) }));
      return cafes;                       // an empty list is a real answer: no cafés there
    }
  } catch { /* fall through to Overpass */ }
  const q = `[out:json][timeout:20];(node["amenity"="cafe"](${south},${west},${north},${east});way["amenity"="cafe"](${south},${west},${north},${east}););out center 200;`;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(`${url}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const j = await res.json();
      return j.elements.map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, ...cafeFrom(e.tags?.name, e.tags || {}) }))
        .filter((c) => c.lat != null);
    } catch { /* try the next mirror */ }
  }
  throw new Error("cafes");
}

function cafeFrom(name, t) {
  return { name: name || "Café", hours: t.opening_hours || "", brand: t.brand || (t["brand:wikidata"] ? "chain" : ""), cuisine: t.cuisine || "",
    bikeFriendly: t.bicycle === "yes" || /cycl/i.test(name || "") };
}

// Chains lose out to local, coffee-focused places when several are close together.
const CHAINS = /\b(costa|starbucks|caff[eè] nero|nero|pret|greggs|mcdonald'?s|coffee ?#1|esquires|black sheep coffee|gail'?s|patisserie valerie|harris \+ hoole|tim hortons|subway|wetherspoon|bb'?s coffee|puccino'?s|leon)\b/i;
function isChain(c) { return !!c.brand || CHAINS.test(c.name); }
function cafeQuality(c) {
  let q = isChain(c) ? 0 : 3;
  if (/coffee/.test(c.cuisine) || /coffee|roast|espresso|brew|barista/i.test(c.name)) q += 2;
  if (c.bikeFriendly) q += 2;
  return q;
}

// Cafés within `within` metres of the route, best one per 400 m cluster, in riding order.
// Each gets `t` (seconds from the start to reach it) and `dist` (metres along the route).
function cafesOnRoute(route, cafes, dep, within = 150) {
  const samples = [];
  for (let d = 0; d <= route.distance; d += 50) samples.push(pointAt(route, d));
  const on = [];
  for (const c of cafes) {
    let near = null, nd = Infinity;
    for (const s of samples) { const d = haversine([s.lat, s.lon], [c.lat, c.lon]); if (d < nd) { nd = d; near = s; } }
    if (nd > within) continue;
    const open = openAt(c.hours, new Date((dep + near.t) * 1000));
    on.push({ ...c, off: Math.round(nd), dist: near.dist, t: near.t, chain: isChain(c), quality: cafeQuality(c) + (open === true ? 1 : open === false ? -4 : 0) });
  }
  const kept = [];
  for (const c of on.sort((a, b) => b.quality - a.quality)) if (!kept.some((k) => haversine([k.lat, k.lon], [c.lat, c.lon]) < 400)) kept.push(c);
  return kept.sort((a, b) => a.dist - b.dist);
}

// Best café near the middle of the route (35–65% of the way), open when you'd arrive if we can tell.
// `dep` = departure time (unix seconds). Returns { cafe, dist, frac, eta, open } or null.
function pickCafe(route, cafes, dep) {
  const samples = [];
  for (let d = route.distance * 0.3; d <= route.distance * 0.7; d += 100) samples.push(pointAt(route, d));
  let best = null;
  for (const c of cafes) {
    let near = null, nd = Infinity;
    for (const s of samples) { const d = haversine([s.lat, s.lon], [c.lat, c.lon]); if (d < nd) { nd = d; near = s; } }
    if (nd > 400) continue;
    const frac = near.dist / route.distance, eta = dep + near.t, open = openAt(c.hours, new Date(eta * 1000));
    const score = Math.abs(frac - 0.5) * 20 + nd / 100 + (open === false ? 100 : open === null ? 3 : 0) - cafeQuality(c);
    if (!best || score < best.score) best = { cafe: c, dist: nd, frac, eta, open, score };
  }
  return best && best.open !== false ? best : null;
}

function routeBounds(route, from = 0, to = 1, pad = 0.01) {
  let s = 90, w = 180, n = -90, e = -180;
  route.coords.forEach(([la, lo], i) => {
    const f = route.cumD[i] / route.distance;
    if (f < from || f > to) return;
    s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo);
  });
  return [s - pad, w - pad, n + pad, e + pad].map((v) => +v.toFixed(4));
}

// Insert a stop into a waypoint list, between the waypoints either side of it along the route.
function insertStop(waypoints, route, stop) {
  const at = (w) => {
    let best = 0, bd = Infinity;
    route.coords.forEach((c, i) => { const d = haversine(c, [w.lat, w.lon]); if (d < bd) { bd = d; best = i; } });
    return route.cumD[best];
  };
  const sd = at(stop), out = [waypoints[0]];
  let placed = false;
  waypoints.slice(1).forEach((w, k) => {
    const wd = k === waypoints.length - 2 ? route.distance : at(w);
    if (!placed && sd < wd) { out.push(stop); placed = true; }
    out.push(w);
  });
  if (!placed) out.splice(out.length - 1, 0, stop);
  return out;
}

// --- Loops --------------------------------------------------------------------------

// Waypoints for a round loop of about `length` metres, its far point on bearing `brg` from the start.
// Roads wind, so the circle is drawn ~15% smaller than the target length.
function loopWaypoints(start, length, brg) {
  const r = length / (2 * Math.PI * 1.15);
  const c = destPoint(start.lat, start.lon, brg, r);
  const back = (brg + 180) % 360;
  return [start, ...[back + 90, back + 180, back + 270].map((b) => destPoint(c.lat, c.lon, b % 360, r)), start];
}

// Out-and-back stretches: where the route rides back over road it covered shortly before.
// Returns [{ start, end, apex }] in metres along the route (the loop's own start/finish road is ignored).
function findSpurs(route) {
  const cells = new Map(), hits = [], maxGap = Math.min(8000, route.distance * 0.4);
  for (let d = 0; d <= route.distance; d += 25) {
    const p = pointAt(route, d), key = `${Math.round(p.lat / 0.0003)},${Math.round(p.lon / 0.00045)}`;
    const seen = cells.get(key);
    if (seen === undefined) cells.set(key, d);
    else if (d - seen > 150 && d - seen < maxGap) hits.push([seen, d]);
  }
  // Going out and coming back pair up as nested intervals; a spur spans the outermost pair.
  const spurs = [];
  for (const [a, b] of hits.sort((x, y) => x[0] - y[0])) {
    const sp = spurs.find((x) => a <= x.end && b >= x.start);
    if (sp) { sp.start = Math.min(sp.start, a); sp.end = Math.max(sp.end, b); } else spurs.push({ start: a, end: b });
  }
  return spurs.filter((x) => x.end - x.start >= 300).map((x) => ({ ...x, apex: pointAt(route, (x.start + x.end) / 2) }));
}

// Move the waypoint that causes each out-and-back stretch to where the stretch leaves the loop (or drop it), and re-route.
// One fix at a time, re-checking the new route each time (positions shift after every re-route).
async function removeSpurs(cand, target, bike, opts, wind, profile) {
  for (let round = 0; round < 3; round++) {
    const spurs = findSpurs(cand.route).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    if (!spurs.length) return;
    let improved = false;
    for (const spur of spurs.slice(0, 2)) {
      const near = cand.waypoints.map((w, i) => ({ i, d: haversine([w.lat, w.lon], [spur.apex.lat, spur.apex.lon]) }))
        .slice(1, -1).sort((a, b) => a.d - b.d)[0];
      if (!near || near.d > (spur.end - spur.start) / 2 + 300) continue;
      const base = pointAt(cand.route, spur.start);
      const variants = [cand.waypoints.map((p, i) => (i === near.i ? { lat: base.lat, lon: base.lon } : p))];
      if (cand.waypoints.length > 4) variants.push(cand.waypoints.filter((p, i) => i !== near.i));
      for (const wps of variants) {
        try {
          const route = await fetchCycleRoute(wps, profile), score = scoreLoop(route, target, bike, opts, wind);
          if (score.total < cand.score.total) { Object.assign(cand, { route, waypoints: wps, score }); improved = true; break; }
        } catch (e) { if (e.message === "busy") return; }
      }
      if (improved) break;
    }
    if (!improved) return;
  }
}

// After fixes the loop can drift from the chosen length: stretch or shrink it around the start once.
async function rescaleLoop(cand, target, bike, opts, wind, profile) {
  const f = target / cand.route.distance;
  if (Math.abs(1 - f) < 0.08) return;
  const s = cand.waypoints[0], last = cand.waypoints.length - 1;
  const scale = (w, k) => ({ lat: s.lat + (w.lat - s.lat) * k, lon: s.lon + (w.lon - s.lon) * k });
  // Two ways to stretch: the whole loop, or just its far point (keeps the roads near home).
  const far = Math.floor(last / 2);
  const variants = [cand.waypoints.map((w, i) => (i === 0 || i === last ? w : scale(w, f))),
    cand.waypoints.map((w, i) => (i === far ? scale(w, 1 + (f - 1) * 2) : w))];
  for (const wps of variants) {
    try {
      const route = await fetchCycleRoute(wps, profile), score = scoreLoop(route, target, bike, opts, wind);
      if (score.total < cand.score.total) Object.assign(cand, { route, waypoints: wps, score });
    } catch (e) { if (e.message === "busy") return; }
  }
}

// Share of the route that rides over road already covered earlier (out-and-back sections).
function overlapPct(route) {
  const cells = new Map(); let repeat = 0, n = 0;
  for (let d = 0; d <= route.distance; d += 25) {
    const p = pointAt(route, d), key = `${Math.round(p.lat / 0.0003)},${Math.round(p.lon / 0.00045)}`;
    const seen = cells.get(key);
    if (seen !== undefined && d - seen > 400) repeat++;
    if (seen === undefined) cells.set(key, d);
    n++;
  }
  return 100 * repeat / Math.max(1, n);
}

// Average wind along each half (mph, + = headwind) for a steady wind from `windFrom`.
function halfWinds(route, windFrom, windSpeed) {
  const half = [0, 0], dist = [0, 0];
  for (let d = 0; d + 200 <= route.distance; d += 200) {
    const p = pointAt(route, d), q = pointAt(route, d + 200), k = d < route.distance / 2 ? 0 : 1;
    half[k] += windSpeed * Math.cos((bearing(p, q) - windFrom) * Math.PI / 180) * 200; dist[k] += 200;
  }
  return half.map((h, k) => h / Math.max(1, dist[k]));
}

// Lower is better. Weights are in "points"; comments say what costs what.
function scoreLoop(route, target, bike, opts, wind) {
  const st = surfaceStats(route, bike), fit = SURFACE_FIT[bike];
  const care = SURFACES.reduce((s, x) => s + (fit[x.id] === 1 && x.id !== "busy" ? st.pct[x.id] : 0), 0);   // busy roads scored below
  const bad = SURFACES.reduce((s, x) => s + (fit[x.id] === 2 ? st.pct[x.id] : 0), 0);
  const [out, home] = halfWinds(route, wind.from, wind.speed);
  const climbPerMile = route.climb / (route.distance / MILE);
  const parts = {
    length: 80 * Math.abs(route.distance - target) / target,     // 10% off = 8
    busy: (opts.avoidBusy ? 0.6 : 0.2) * st.pct.busy,           // 10% busy = 6 (when avoiding)
    surface: 0.5 * care + 8 * bad,                              // unsuitable surfaces weigh heavily: 1% = 8
    overlap: 0.3 * overlapPct(route),
    spurs: 600 * findSpurs(route).reduce((s, x) => s + x.end - x.start, 0) / route.distance,   // out-and-back: 5% of the ride = 30
    wind: Math.max(0, home) * 0.6 - Math.max(0, out) * 0.2,     // headwind home costs; headwind out is welcome
    hills: (opts.flat ? 0.4 : 0.05) * climbPerMile,
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, stats: st, winds: [out, home] };
}

// Plan a loop: try up to four directions (into the wind first), rescale once, score, pick the best.
// `progress(text)` reports what's happening. Returns { best, others } of { route, waypoints, score, heading }.
async function planLoop(start, miles, bike, opts, wind, progress = () => {}) {
  const target = miles * MILE, profile = cycleProfile(bike, opts.offroad, opts.avoidBusy);
  const headings = [0, -70, 70, 180].map((d) => (wind.from + d + 360) % 360);
  const tried = [];
  for (let k = 0; k < headings.length; k++) {
    const brg = headings[k];
    progress(k < 4 ? `Planning loop ${k + 1} of 4…` : "Looking for quieter roads…");
    try {
      let wps = loopWaypoints(start, target, brg), route = await fetchCycleRoute(wps, profile);
      if (Math.abs(route.distance - target) / target > 0.1) {
        wps = loopWaypoints(start, target * target / route.distance, brg);
        route = await fetchCycleRoute(wps, profile);
      }
      tried.push({ route, waypoints: wps, heading: brg, score: scoreLoop(route, target, bike, opts, wind) });
    } catch (e) {
      if (e.message === "busy") { if (tried.length) break; throw e; }   // rate-limited: stop asking, use what we have
      /* otherwise that direction had no route (sea, private land): skip it */
    }
    // Good enough already? Stop early to go easy on the free route server.
    const good = tried.find((t) => t.score.total < 16 && !t.score.stats.issues.some((x) => x.level === 2) && !findSpurs(t.route).length);
    if (good && k >= 1) break;
    // Still too much busy road after four tries? Try two more directions.
    if (k === 3 && opts.avoidBusy && tried.length && Math.min(...tried.map((t) => t.score.stats.pct.busy)) > 10) {
      headings.push((wind.from + 140) % 360, (wind.from + 220) % 360);
    }
  }
  if (!tried.length) throw new Error("noloop");
  tried.sort((a, b) => a.score.total - b.score.total);
  // Unsuitable stretches usually come from a waypoint landing on a path or track: nudge it and re-route.
  // Worth repairing: loops that would beat the current best if their unsuitable stretch went away (at most two).
  const lead = tried[0].score.total;
  const fixable = tried.filter((c) => c.score.stats.issues.some((x) => x.level === 2) && c.score.total - c.score.parts.surface < lead).slice(0, 1);
  for (const cand of fixable) {
    progress("Steering round a rough track…");
    const fixed = await repairLoop(cand, target, bike, opts, wind, profile);
    if (fixed) Object.assign(cand, fixed);
  }
  tried.sort((a, b) => a.score.total - b.score.total);
  // Out-and-back stretches: the point of a loop is not to ride the same road twice.
  for (const cand of tried.slice(0, 2)) {
    if (!findSpurs(cand.route).length) continue;
    progress("Avoiding riding the same road twice…");
    await removeSpurs(cand, target, bike, opts, wind, profile);
  }
  tried.sort((a, b) => a.score.total - b.score.total);
  progress("Fine-tuning the distance…");
  await rescaleLoop(tried[0], target, bike, opts, wind, profile);
  if (findSpurs(tried[0].route).length) await removeSpurs(tried[0], target, bike, opts, wind, profile);
  tried.sort((a, b) => a.score.total - b.score.total);
  // The rest aren't shown yet: they're the first ones offered when the rider asks for another route.
  return { best: tried[0], others: tried.slice(1) };
}

// One more loop, heading out on compass bearing `brg`: routed, its length corrected and out-and-back stretches removed.
async function loopAt(start, miles, bike, opts, wind, brg) {
  const target = miles * MILE, profile = cycleProfile(bike, opts.offroad, opts.avoidBusy);
  let wps = loopWaypoints(start, target, brg), route = await fetchCycleRoute(wps, profile);
  if (Math.abs(route.distance - target) / target > 0.1) {
    wps = loopWaypoints(start, target * target / route.distance, brg);
    route = await fetchCycleRoute(wps, profile);
  }
  const cand = { route, waypoints: wps, heading: brg, score: scoreLoop(route, target, bike, opts, wind) };
  await rescaleLoop(cand, target, bike, opts, wind, profile);
  if (findSpurs(cand.route).length) await removeSpurs(cand, target, bike, opts, wind, profile);
  return cand;
}

// How much of route a runs along route b (0–1): the share of points every 50 m that are within ~40 m of b.
function similarity(a, b) {
  const cell = (p) => [Math.round(p.lat / 0.0004), Math.round(p.lon / 0.0006)];
  const cells = new Set();
  for (let d = 0; d <= b.distance; d += 25) { const [y, x] = cell(pointAt(b, d)); cells.add(`${y},${x}`); }
  let n = 0, on = 0;
  for (let d = 0; d <= a.distance; d += 50) {
    const [y, x] = cell(pointAt(a, d));
    n++;
    if ([-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => cells.has(`${y + dy},${x + dx}`)))) on++;
  }
  return n ? on / n : 1;
}

// Move the waypoint nearest the worst unsuitable stretch (towards the loop's middle, or round the circle)
// and keep the change if the loop scores better.
async function repairLoop(cand, target, bike, opts, wind, profile) {
  const issue = cand.score.stats.issues.find((x) => x.level === 2);
  const at = (w) => { let bi = 0, bd = Infinity; cand.route.coords.forEach((c, i) => { const d = haversine(c, [w.lat, w.lon]); if (d < bd) { bd = d; bi = i; } }); return cand.route.cumD[bi]; };
  const inner = cand.waypoints.slice(1, -1);
  const k = 1 + inner.map(at).reduce((b, d, i, a) => (Math.abs(d - issue.start) < Math.abs(a[b] - issue.start) ? i : b), 0);
  const w = cand.waypoints[k], mid = { lat: inner.reduce((s, p) => s + p.lat, 0) / inner.length, lon: inner.reduce((s, p) => s + p.lon, 0) / inner.length };
  const prev = cand.waypoints[k - 1], next = cand.waypoints[k + 1];
  const variants = [
    { lat: w.lat + (mid.lat - w.lat) * 0.35, lon: w.lon + (mid.lon - w.lon) * 0.35 },          // pull towards the middle
    { lat: w.lat + (prev.lat - w.lat) * 0.3, lon: w.lon + (prev.lon - w.lon) * 0.3 },          // slide back along the loop
    { lat: w.lat + (next.lat - w.lat) * 0.3, lon: w.lon + (next.lon - w.lon) * 0.3 },          // slide forward
  ];
  let best = null;
  for (const v of variants) {
    try {
      const wps = cand.waypoints.map((p, i) => (i === k ? v : p));
      const route = await fetchCycleRoute(wps, profile), score = scoreLoop(route, target, bike, opts, wind);
      if (score.total < (best || cand).score.total) best = { route, waypoints: wps, score };
      if (best && !best.score.stats.issues.some((x) => x.level === 2)) break;
    } catch (e) { if (e.message === "busy") break; /* otherwise try the next nudge */ }
  }
  return best;
}

// Re-route an option through the best café near halfway. Returns the updated option, or the original if none.
async function addCafeStop(option, bike, opts, dep) {
  const cafes = await searchCafes(...routeBounds(option.route, 0, 1, 0.004));
  const base = { ...option, cafeList: cafes, cafeSearched: true };
  const midway = cafesOnRoute(option.route, cafes, dep).filter((c) => c.dist > 0.3 * option.route.distance && c.dist < 0.7 * option.route.distance);
  if (midway.length) return { ...base, cafe: null };          // already passes a café near halfway: no detour needed
  const pick = pickCafe(option.route, cafes, dep);
  if (!pick) return { ...base, cafe: null };
  const wps = insertStop(option.waypoints, option.route, pick.cafe);
  const route = await fetchCycleRoute(wps, option.route.profile);
  // Don't take a detour that puts the bike on surfaces it can't ride.
  const unsuitable = (r) => surfaceStats(r, bike).issues.filter((x) => x.level === 2).reduce((s, x) => s + x.len, 0);
  if (unsuitable(route) > unsuitable(option.route) + 100) return { ...base, cafe: null, cafeRejected: pick.cafe.name };
  return { ...base, route, waypoints: wps, cafe: { ...pick.cafe, open: pick.open, frac: pick.frac } };
}

export { loopAt, similarity, openAt, searchCafes, isChain, cafesOnRoute, routeBounds, insertStop, loopWaypoints, findSpurs, overlapPct, scoreLoop, planLoop, addCafeStop };
