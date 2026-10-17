// Safe2Ride API (a Cloudflare Worker). The decision rules live there, not on this site:
// we send the weather fetched here and get back verdicts, reasons, scores and summaries.
// Request and reply shapes: contract/v2.json (kept identical in the API's repo).

const API = "https://safe2ride-api.safe2ride.workers.dev";
const API_VERSION = 2;

async function callApi(path, body) {
  let res;
  try {
    res = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: API_VERSION, ...body }) });
  } catch {
    throw new Error("Couldn't reach the Safe2Ride service. Check your connection and try again.");
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 409 && j.code === "version") throw new Error("Safe2Ride has been updated. Please refresh the page.");
  if (res.status === 429) throw new Error(j.error || "Too many checks at once. Please wait a minute and try again.");
  if (!res.ok) throw new Error("The Safe2Ride service had a problem. Please try again in a moment.");
  return j;
}

// "Safe to ride here?" for Open-Meteo hourly data from fetchWeather():
// { level, verdict, reasons, scores, summary, levels (1-hour verdict for every hour) }.
function assessHere(hourly, mode) {
  return callApi("/assess/here", { mode, hourly });
}

// Departure options along a route, shaped as the rest of the site expects: each point carries its
// checkpoint and weather (pts[k].h, .at), each stretch links the points either side (segs[k].from, .to).
// Replies are joined by their checkpoint index k, never by position in the list.
async function assessRoute(cps, wx, mode, now) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const slim = cps.map(({ lat, lon, t, dist }) => ({ lat, lon, t, dist }));
  const { options, best } = await callApi("/assess/route", { mode, now, tz, cps: slim, wx });
  options.forEach((o) => {
    const pts = [];
    o.pts.forEach((p) => { pts[p.k] = { ...cps[p.k], h: wx[p.k], ...p }; });
    if (pts.length !== cps.length || [...pts].some((p) => !p)) throw new Error("The Safe2Ride service had a problem. Please try again in a moment.");
    o.pts = pts;
    o.segs = [...o.segs].sort((a, b) => a.k - b.k).map((g) => ({ ...g, from: pts[g.k], to: pts[g.k + 1] }));
  });
  return { options, best };
}

export { API_VERSION, assessHere, assessRoute };
