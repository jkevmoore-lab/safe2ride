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
  const last = route.coords.length - 1, cps = [];
  let j = 0;
  for (let k = 0; k <= segs; k++) {
    const d = route.distance * k / segs;
    while (j < last - 1 && route.cumD[j + 1] < d) j++;
    const span = route.cumD[j + 1] - route.cumD[j] || 1, f = Math.max(0, Math.min(1, (d - route.cumD[j]) / span));
    const [a1, o1] = route.coords[j], [a2, o2] = route.coords[Math.min(j + 1, last)];
    cps.push({ lat: a1 + (a2 - a1) * f, lon: o1 + (o2 - o1) * f, dist: d, t: route.cumT[j] + (route.cumT[j + 1] - route.cumT[j]) * f, gi: j });
  }
  return cps;
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

// Conditions along the route if you leave at `dep` (unix seconds).
function evaluateDeparture(cps, wx, mode, dep) {
  const pts = cps.map((cp, k) => {
    const h = wx[k], eta = dep + cp.t;
    const at = Math.max(0, Math.min(h.time.length - 1, Math.floor((eta - h.time[0]) / 3600)));
    const a = assess(h, mode, at, 1);
    return { ...cp, h, at, eta, level: a.level, reasons: a.reasons, s: scores(h, mode, at, 1) };
  });
  const lastPt = pts[pts.length - 1];
  const where = (p) => p === pts[0] ? "At the start" : p === lastPt ? "At the end" : `Around mile ${miles(p.dist)} (${clock(p.eta)})`;
  const near = (p) => p === pts[0] ? "near the start" : p === lastPt ? "near the end" : `around mile ${miles(p.dist)}`;

  // Each stretch between checkpoints: wind relative to direction of travel, rain while on it.
  const segs = pts.slice(0, -1).map((p, k) => {
    const q = pts[k + 1], h = p.h, i = p.at;
    const rel = (bearing(p, q) - h.wind_direction_10m[i]) * Math.PI / 180;
    return {
      from: p, to: q, dist: q.dist - p.dist, hours: (q.t - p.t) / 3600, level: Math.max(p.level, q.level),
      head: h.wind_speed_10m[i] * Math.cos(rel), crossGust: h.wind_gusts_10m[i] * Math.abs(Math.sin(rel)),
      rain: h.precipitation[i],
    };
  });

  // Worst instance of each hazard, labelled with where it happens.
  const byKind = {};
  pts.forEach((p) => p.reasons.forEach((r) => {
    if (!byKind[r.kind] || r.level > byKind[r.kind].level) byKind[r.kind] = { ...r, text: `${where(p)}: ${lowerFirst(r.text)}` };
  }));
  const reasons = Object.values(byKind);

  const total = Math.max(1, lastPt.dist);
  const mm = segs.reduce((s, g) => s + g.rain * g.hours, 0);
  const chance = Math.max(0, ...pts.map((p) => p.h.precipitation_probability?.[p.at] ?? (p.h.precipitation[p.at] > 0 ? 100 : 0)));
  const peak = Math.max(0, ...pts.map((p) => p.h.precipitation[p.at]));
  const soak = soakScore(mm, chance, peak);
  if (soak >= 7) reasons.push({ level: 1, kind: "soak", text: `You're likely to get soaked: about ${mm.toFixed(1)} mm of rain over the ride.` });

  const headD = segs.filter((g) => g.head >= 6).reduce((s, g) => s + g.dist, 0);
  const tailD = segs.filter((g) => g.head <= -6).reduce((s, g) => s + g.dist, 0);
  const avgHead = segs.reduce((s, g) => s + g.head * g.dist, 0) / total;
  const strongest = segs.reduce((a, g) => (g.head > a.head ? g : a), segs[0]);
  const gustiest = segs.reduce((a, g) => (g.crossGust > a.crossGust ? g : a), segs[0]);
  if (mode === "bicycle" && avgHead >= 10) {
    reasons.push({ level: 1, kind: "headwind", text: `Into a headwind for most of the ride (averaging ${Math.round(avgHead)} mph). Expect it to be hard going and slower than the estimate.` });
  } else if (headD / total >= 0.4 && strongest.head >= 8) {
    reasons.push({ level: 0, kind: "headwind", text: `Headwind for about ${Math.round(100 * headD / total)}% of the ride, strongest ${near(strongest.from)} (${Math.round(strongest.head)} mph).` });
  } else if (tailD / total >= 0.5) {
    reasons.push({ level: 0, kind: "tailwind", text: `Tailwind for about ${Math.round(100 * tailD / total)}% of the ride.` });
  }
  if (mode === "motorbike" && gustiest.crossGust >= 30) {
    reasons.push({ level: 1, kind: "crosswind", text: `Crosswind gusts of about ${Math.round(gustiest.crossGust)} mph ${near(gustiest.from)}. Take care on exposed stretches and bridges.` });
  }
  reasons.sort((a, b) => b.level - a.level);

  const worst = (key) => pts.reduce((a, p) => (p.s[key].score > a.s[key].score ? p : a), pts[0]);
  const iceP = worst("ice"), windP = worst("wind");
  const sc = {
    ice: { score: iceP.s.ice.score, label: band(iceP.s.ice.score, ICE_LABELS), detail: `${iceP.s.ice.detail} (${lowerFirst(where(iceP))})` },
    rain: { score: soak, label: band(soak, SOAK_LABELS), detail: mm < 0.1 ? `${Math.round(chance)}% chance · no rain expected on the ride` : `${Math.round(chance)}% chance · ~${mm.toFixed(1)} mm over the ride` },
    wind: { score: windP.s.wind.score, label: band(windP.s.wind.score, WIND_LABELS), detail: `${windP.s.wind.detail} (${lowerFirst(where(windP))})` },
  };
  const level = Math.max(0, ...pts.map((p) => p.level), ...reasons.map((r) => r.level));
  // Prefer daylight when choosing a departure time.
  const dark = pts.filter((p) => p.h.is_day[p.at] === 0).length / pts.length;
  const cost = level * 100 + sc.ice.score + sc.rain.score + sc.wind.score + 3 * dark;
  return { dep, arrive: dep + lastPt.t, level, cost, pts, segs, reasons, scores: sc, headD, tailD };
}

// Leave now, then on each hour for the next 12 hours (as far as the forecast reaches).
function planDepartures(cps, wx, mode, now) {
  const end = wx[0].time[wx[0].time.length - 1] + 3600, ride = cps[cps.length - 1].t;
  const first = Math.ceil(now / 3600) * 3600;
  const deps = [now, ...range(0, 12).map((i) => first + i * 3600).filter((t) => t - now >= 15 * 60)]
    .filter((t) => t + ride <= end);
  const options = deps.map((d) => evaluateDeparture(cps, wx, mode, d));
  // Earliest option that's about as good as the very best (same verdict, scores within 2).
  const min = Math.min(...options.map((o) => o.cost));
  const best = Math.max(0, options.findIndex((o) => o.cost <= min + 2));
  return { options, best };
}

function bearing(p, q) {
  const r = Math.PI / 180, dl = (q.lon - p.lon) * r;
  const y = Math.sin(dl) * Math.cos(q.lat * r);
  const x = Math.cos(p.lat * r) * Math.sin(q.lat * r) - Math.sin(p.lat * r) * Math.cos(q.lat * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function compass(deg) { return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16]; }
function miles(m) { const v = m / MILE; return v < 10 ? v.toFixed(1) : Math.round(v); }
function clock(ts) { return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
function duration(s) { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; }
function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
