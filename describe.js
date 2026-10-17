// Safe2Ride route descriptions: the facts the API's AI writer gets about a planned ride (contract/v2.json,
// "POST /describe/route" route). Runs only when the rider taps Description. No DOM access here.
// The rider's own position is never sent by name: "Your location" becomes the nearest town.

import { fetchPlace } from "./logic.js";
import { pointAt, climbStats, miles } from "./route.js";
import { openAt } from "./loop.js";

const SAMPLES = 10;

const AT_A_TIME = 2;                       // Photon is a free service: don't hit it with all the lookups at once
const MINOR = new Set(["service", "track", "footway", "path", "steps"]);   // driveways, farm tracks: not worth naming

// Towns and roads along the route, in order: the nearest street to evenly spaced points (Photon, OpenStreetMap data).
// A road counts only if the point is inside its outline (plus ~30 m), so an unnamed path doesn't pick up one nearby.
// A failed lookup is just a gap.
// Returns { places, roads } with repeats removed. (Photon's "district" is the town or village; "city" is often the council.)
async function routeNames(route, signal) {
  const pts = Array.from({ length: SAMPLES }, (_, k) => pointAt(route, route.distance * (k + 0.5) / SAMPLES));
  const lookup = async (p) => {
    try {
      const res = await fetch(`https://photon.komoot.io/reverse?lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}&lang=en&limit=1&layer=street`, { signal });
      if (!res.ok) return null;
      const f = (await res.json()).features?.[0]?.properties;
      if (!f) return null;
      const [w, n, e, s] = f.extent || [], pad = 0.0004;
      const on = f.extent && p.lon >= w - pad && p.lon <= e + pad && p.lat >= s - pad && p.lat <= n + pad;
      return { road: on && f.osm_key === "highway" && !MINOR.has(f.osm_value) ? f.name : null, place: f.district || f.locality || f.city };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return null;
    }
  };
  const found = [];
  for (let i = 0; i < pts.length; i += AT_A_TIME) found.push(...await Promise.all(pts.slice(i, i + AT_A_TIME).map(lookup)));
  const uniq = (xs) => xs.filter((x, i) => x && xs.indexOf(x) === i);
  return { places: uniq(found.map((f) => f?.place)), roads: uniq(found.map((f) => f?.road)) };
}

// A place's name as the API may see it: the rider's own location becomes the nearest town (or nothing).
async function publicName(p) {
  if (!p) return "";
  if (p.name !== "Your location") return p.name;
  return (await fetchPlace(p.lat, p.lon)) || "";
}

// The route facts for departure option `o` of a planned trip (see analyse() in ui.js).
function rideFacts(trip, o, names, start, end) {
  const st = trip.stats, hills = trip.elev ? climbStats(trip.elev.z) : null;
  return {
    kind: trip.ride, bike: trip.bike,
    distanceM: Math.round(trip.route.distance), durationS: Math.round(trip.route.duration),
    climbM: Number.isFinite(trip.route.climb) ? trip.route.climb : hills ? hills.up : null,
    start, end: trip.ride === "loop" ? "" : end,
    places: names.places, roads: names.roads,
    surfaces: st ? Object.fromEntries(Object.entries(st.pct).map(([k, v]) => [k, Math.round(v * 10) / 10])) : {},
    issues: st ? st.issues.slice(0, 5).map((x) => ({ kind: x.cls, level: x.level, mile: +miles(x.start), lengthMiles: +miles(x.len) })) : [],
    hills,
    cafes: trip.cafes.slice(0, 6).map((c) => ({ name: c.name, mile: +miles(c.dist), open: openAt(c.hours, new Date((o.dep + c.t) * 1000)), chain: !!c.chain })),
  };
}

export { routeNames, publicName, rideFacts };
