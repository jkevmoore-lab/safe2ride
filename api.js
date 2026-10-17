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
  if (res.status === 502 || res.status === 503) throw new Error(j.error || "The Safe2Ride service isn't available right now. Please try again later.");
  if (!res.ok) throw new Error("The Safe2Ride service had a problem. Please try again in a moment.");
  return j;
}

// Departure options along a route, shaped as the rest of the site expects: each point carries its
// checkpoint and weather (pts[k].h, .at), each stretch links the points either side (segs[k].from, .to).
// Replies are joined by their checkpoint index k, never by position in the list.
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const slimCps = (cps) => cps.map(({ lat, lon, t, dist }) => ({ lat, lon, t, dist }));

async function assessRoute(cps, wx, mode, now) {
  const { options, best } = await callApi("/assess/route", { mode, now, tz: localTz(), cps: slimCps(cps), wx });
  options.forEach((o) => {
    const pts = [];
    o.pts.forEach((p) => { pts[p.k] = { ...cps[p.k], h: wx[p.k], ...p }; });
    if (pts.length !== cps.length || [...pts].some((p) => !p)) throw new Error("The Safe2Ride service had a problem. Please try again in a moment.");
    o.pts = pts;
    o.segs = [...o.segs].sort((a, b) => a.k - b.k).map((g) => ({ ...g, from: pts[g.k], to: pts[g.k + 1] }));
  });
  return { options, best };
}

// The AI-written "what to expect" paragraph for departure `dep` of a ride already checked with assessRoute()
// (same checkpoints, weather and `now`). `route` is the facts from describe.js. It arrives as it's written:
// `onText(soFar)` is called with the text so far each time more comes in. Returns the whole text.
async function describeRoute(cps, wx, mode, now, dep, route, onText = () => {}) {
  let res;
  try {
    res = await fetch(API + "/describe/route", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: API_VERSION, mode, now, tz: localTz(), cps: slimCps(cps), wx, dep, route, stream: true }) });
  } catch {
    throw new Error("Couldn't reach the Safe2Ride service. Check your connection and try again.");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    if (res.status === 409 && j.code === "version") throw new Error("Safe2Ride has been updated. Please refresh the page.");
    throw new Error(j.error || "The Safe2Ride service had a problem. Please try again in a moment.");
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
    onText(text);
  }
  if (!text.trim()) throw new Error("The Safe2Ride service had a problem. Please try again in a moment.");
  return text;
}

export { API_VERSION, assessRoute, describeRoute };
