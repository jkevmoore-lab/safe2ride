// Safe2Ride route planning: place search, routing, and weather along the route at
// the time you'd reach each point. No DOM access here so it can be tested on its own.

const ROUTE_PROFILE = { bicycle: "routed-bike", motorbike: "routed-car" };
const MILE = 1609.344;
const UK_CENTRE = [52.5, -1.5];

async function searchPlaces(q, near, signal) {
  const [lat, lon] = near || UK_CENTRE;
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("search " + res.status);
  const j = await res.json();
  const seen = new Set();
  return j.features.map((f) => {
    const p = f.properties, [lo, la] = f.geometry.coordinates;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || "Unnamed place";
    const area = [...new Set([p.city, p.county, p.country === "United Kingdom" ? null : p.country])]
      .filter((x) => x && x !== name).join(", ");
    return { name, area, label: area ? `${name}, ${area}` : name, lat: la, lon: lo };
  }).filter((r) => !seen.has(r.label) && seen.add(r.label));
}

async function fetchRoute(from, to, mode) {
  const url = `https://routing.openstreetmap.de/${ROUTE_PROFILE[mode]}/route/v1/driving/`
    + `${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&annotations=duration,distance&alternatives=false&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("route " + res.status);
  const j = await res.json();
  if (j.code !== "Ok" || !j.routes?.length) throw new Error("noroute");
  const r = j.routes[0], a = r.legs[0].annotation;
  const cumD = [0], cumT = [0];
  a.distance.forEach((d, i) => { cumD.push(cumD[i] + d); cumT.push(cumT[i] + a.duration[i]); });
  return { coords: r.geometry.coordinates.map(([lo, la]) => [la, lo]), cumD, cumT, distance: r.distance, duration: r.duration };
}

// Evenly spaced points along the route (every ~2.5 miles, 4–21 points), each with
// its distance and travel time from the start.
function makeCheckpoints(route) {
  const segs = Math.max(3, Math.min(20, Math.round(route.distance / MILE / 2.5)));
  return range(0, segs + 1).map((k) => pointAt(route, route.distance * k / segs));
}

// The point `d` metres along the route, with travel time to it and the index of the route line before it.
function pointAt(route, d) {
  const last = route.coords.length - 1;
  let j = 0, lo = 0, hi = last - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (route.cumD[m] <= d) { j = m; lo = m + 1; } else hi = m - 1; }
  j = Math.min(j, Math.max(0, last - 1));
  const span = route.cumD[j + 1] - route.cumD[j] || 1, f = Math.max(0, Math.min(1, (d - route.cumD[j]) / span));
  const [a1, o1] = route.coords[j], [a2, o2] = route.coords[Math.min(j + 1, last)];
  return { lat: a1 + (a2 - a1) * f, lon: o1 + (o2 - o1) * f, dist: d, t: route.cumT[j] + (route.cumT[j + 1] - route.cumT[j]) * f, gi: j };
}

// Height (m) at evenly spaced points along the route, for the hills profile.
async function fetchElevation(route, n = 80) {
  const pts = range(0, n).map((k) => pointAt(route, route.distance * k / (n - 1)));
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${pts.map((p) => p.lat.toFixed(4)).join(",")}&longitude=${pts.map((p) => p.lon.toFixed(4)).join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("elevation " + res.status);
  const j = await res.json();
  return { d: pts.map((p) => p.dist), z: j.elevation };
}

function climbStats(z) {
  let up = 0, down = 0;
  for (let i = 1; i < z.length; i++) { const dz = z[i] - z[i - 1]; if (dz > 0) up += dz; else down -= dz; }
  return { up: Math.round(up), down: Math.round(down), min: Math.round(Math.min(...z)), max: Math.round(Math.max(...z)) };
}

// Hourly weather for every checkpoint in one request. Times are unix seconds.
async function fetchRouteWeather(cps, forecastHours) {
  const lat = cps.map((c) => c.lat.toFixed(3)).join(","), lon = cps.map((c) => c.lon.toFixed(3)).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${WEATHER_VARS}`
    + `&past_hours=${PAST_HOURS}&forecast_hours=${forecastHours}&wind_speed_unit=mph&timeformat=unixtime`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather " + res.status);
  const j = await res.json();
  return (Array.isArray(j) ? j : [j]).map((x) => x.hourly);
}

function forecastHoursFor(route) { return Math.min(96, 14 + Math.ceil(route.duration / 3600)); }

// --- Cycle routing (BRouter) with road type and surface for every stretch ---------

// Which BRouter profile suits each bike and the rider's filters.
function cycleProfile(bike, offroad, avoidBusy) {
  if (bike === "road") return avoidBusy ? "fastbike-verylowtraffic" : "fastbike-lowtraffic";
  if (bike === "gravel") return offroad ? "gravel" : "trekking";
  return offroad ? "mtb" : "trekking";
}

// Route through waypoints [{lat, lon}, …]. `alt` 0–3 asks for an alternative route.
let routeCalls = 0;   // diagnostics: how many routing requests a plan made
async function fetchCycleRoute(waypoints, profile, alt = 0) {
  routeCalls++;
  const lonlats = waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join("|");
  const res = await fetch(`https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=${alt}&format=geojson`);
  if (res.status === 403 || res.status === 429) throw new Error("busy");     // the free server's rate limit
  if (!res.ok) throw new Error(res.status >= 500 || res.status === 400 ? "noroute" : "route " + res.status);
  const text = await res.text();
  if (!text.startsWith("{")) throw new Error("noroute");    // BRouter answers errors as plain text
  return parseBRouter(JSON.parse(text), profile);
}

function parseBRouter(j, profile) {
  const f = j.features[0], p = f.properties, g = f.geometry.coordinates;
  const coords = g.map(([lo, la]) => [la, lo]), ele = g.map((c) => c[2] ?? null);
  const cumD = [0];
  for (let i = 1; i < coords.length; i++) cumD.push(cumD[i - 1] + haversine(coords[i - 1], coords[i]));
  // Each message row describes the stretch ending at its point; give every line segment its row's class.
  const hdr = p.messages[0], rows = p.messages.slice(1), lonI = hdr.indexOf("Longitude"), latI = hdr.indexOf("Latitude"), tagI = hdr.indexOf("WayTags");
  const cls = [];
  let r = 0;
  for (let i = 1; i < g.length; i++) {
    const row = rows[Math.min(r, rows.length - 1)];
    cls.push(classifyWay(row[tagI]));
    if (r < rows.length && Math.round(g[i][0] * 1e6) === +row[lonI] && Math.round(g[i][1] * 1e6) === +row[latI]) r++;
  }
  return { coords, ele, cumD, cumT: p.times.map(Number), distance: cumD[cumD.length - 1], duration: +p["total-time"],
    climb: +p["filtered ascend"], cls, profile };
}

// Road and surface classes, from OpenStreetMap tags. Order matters for display.
const SURFACES = [
  { id: "quiet", name: "Quiet road", colour: "#2d6a4f" },
  { id: "path", name: "Cycle path", colour: "#2f7fb8" },
  { id: "busy", name: "Busy road", colour: "#c4442f" },
  { id: "g1", name: "Grade 1 · smooth track", colour: "#c08a1e", dash: "8 5" },
  { id: "g2", name: "Grade 2 · rough track", colour: "#8b5a2b", dash: "4 5" },
  { id: "g3", name: "Grade 3 · MTB only", colour: "#4a2f17", dash: "1 6" },
  { id: "unknown", name: "Unknown surface", colour: "#7d8a84", dash: "2 4" },
];
const SURFACE = Object.fromEntries(SURFACES.map((s) => [s.id, s]));

function classifyWay(tagStr) {
  const t = Object.fromEntries((tagStr || "").split(" ").filter((kv) => kv.includes("=")).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  const hw = t.highway || "", sf = t.surface || "", tt = t.tracktype || "", sm = t.smoothness || "", mtb = parseFloat(t["mtb:scale"]);
  const paved = /^(asphalt|paved|concrete|concrete:plates|concrete:lanes|paving_stones|chipseal|metal|wood)$/.test(sf);
  if (mtb >= 1 || /^(grass|mud|sand|earth|rock|roots|woodchips|grass_paver|stepping_stones)$/.test(sf)
    || /^grade[45]$/.test(tt) || /^(very_bad|horrible|very_horrible|impassable)$/.test(sm)) return "g3";
  if (/^(gravel|dirt|ground|unpaved|pebblestone|unhewn_cobblestone)$/.test(sf) || tt === "grade3" || sm === "bad") return "g2";
  if (/^(compacted|fine_gravel|sett|cobblestone)$/.test(sf) || (/^grade[12]$/.test(tt) && !paved)) return "g1";
  if (/^(trunk|trunk_link|primary|primary_link|secondary|secondary_link)$/.test(hw)) return "busy";
  if (/^(cycleway|path|footway|bridleway|pedestrian|track|steps)$/.test(hw)) return paved || (hw === "cycleway" && !sf) ? "path" : "unknown";
  return "quiet";
}

// How suitable each class is for a bike: 0 fine, 1 take care, 2 not suitable.
const SURFACE_FIT = {
  road: { quiet: 0, path: 0, busy: 1, g1: 1, g2: 2, g3: 2, unknown: 1 },
  gravel: { quiet: 0, path: 0, busy: 1, g1: 0, g2: 0, g3: 2, unknown: 1 },
  mtb: { quiet: 0, path: 0, busy: 1, g1: 0, g2: 0, g3: 0, unknown: 0 },
};

// Distance per class, plus stretches that don't suit the bike (joined when < 150 m apart).
function surfaceStats(route, bike) {
  const metres = Object.fromEntries(SURFACES.map((s) => [s.id, 0]));
  const fit = SURFACE_FIT[bike] || SURFACE_FIT.mtb, issues = [];
  route.cls.forEach((c, i) => {
    const len = route.cumD[i + 1] - route.cumD[i];
    metres[c] += len;
    const lvl = fit[c];
    if (!lvl) return;
    const last = issues[issues.length - 1];
    if (last && last.cls === c && route.cumD[i] - last.end < 150) { last.end = route.cumD[i + 1]; last.len += len; }
    else issues.push({ cls: c, level: lvl, start: route.cumD[i], end: route.cumD[i + 1], len });
  });
  const total = route.distance || 1;
  return { metres, pct: Object.fromEntries(Object.entries(metres).map(([k, v]) => [k, 100 * v / total])),
    issues: issues.filter((x) => x.len >= 100).sort((a, b) => b.level - a.level || b.len - a.len) };
}

function haversine([la1, lo1], [la2, lo2]) {
  const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}

// The point `dist` metres from (lat, lon) on a compass bearing.
function destPoint(lat, lon, brg, dist) {
  const r = Math.PI / 180, d = dist / 6371000, b = brg * r, la = lat * r, lo = lon * r;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / r, lon: lo2 / r };
}

function bearing(p, q) {
  const r = Math.PI / 180, dl = (q.lon - p.lon) * r;
  const y = Math.sin(dl) * Math.cos(q.lat * r);
  const x = Math.cos(p.lat * r) * Math.sin(q.lat * r) - Math.sin(p.lat * r) * Math.cos(q.lat * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function miles(m) { const v = m / MILE; return v < 10 ? v.toFixed(1) : Math.round(v); }
function clock(ts) { return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
function duration(s) { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; }
