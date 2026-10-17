// Safe2Ride share links: the ride lives in the link (your own location is never put in it).
// No DOM access here so it can be tested on its own. Links come from anyone, so everything read is checked.

const BIKES = ["road", "gravel", "mtb", "motorbike"];
const LOOP_MILES = { min: 5, max: 100, step: 5 };   // the same as the loop slider

// #r=… for a planned ride. `from` is left out when it's your location.
function shareHash(ride, bike, prefs, to, from) {
  const pt = (p) => [+p.lat.toFixed(4), +p.lon.toFixed(4), p.name];
  const st = { r: ride, b: bike, o: [prefs.busy, prefs.offroad, prefs.cafe, prefs.flat].map(Number).join(""), L: prefs.miles,
    ...(to ? { t: pt(to) } : {}), ...(from ? { f: pt(from) } : {}) };
  return "#r=" + encodeURIComponent(JSON.stringify(st));
}

// The ride in a link, or null if there isn't a usable one. Bad parts are dropped, not trusted.
// Returns { ride, bike?, opts?, miles?, to?, from? }.
function parseShare(hash) {
  const m = /#r=(.+)$/.exec(hash || "");
  if (!m) return null;
  let st;
  try { st = JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
  if (!st || typeof st !== "object") return null;
  const out = { ride: st.r === "loop" ? "loop" : "ab" };
  if (BIKES.includes(st.b)) out.bike = st.b;
  if (typeof st.o === "string" && /^[01]{4}$/.test(st.o)) {
    const [busy, offroad, cafe, flat] = st.o.split("").map((c) => c === "1");
    out.opts = { busy, offroad, cafe, flat };
  }
  if (Number.isFinite(st.L)) {
    const { min, max, step } = LOOP_MILES;
    out.miles = Math.min(max, Math.max(min, Math.round(st.L / step) * step));
  }
  const to = place(st.t), from = place(st.f);
  if (to) out.to = to;
  if (from) out.from = from;
  return out;
}

function place(p) {
  if (!Array.isArray(p)) return null;
  const [lat, lon, name] = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "Shared place";
  return { lat, lon, name: label, label };
}

export { BIKES, LOOP_MILES, shareHash, parseShare };
