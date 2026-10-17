// Safe2Ride map-first interface: search card, filters, planning and the results panel. The page's entry point.
// The map and its drawing are in map.js, the route card's HTML in render.js.

import { PAST_HOURS, fetchWeather, fetchPlace } from "./logic.js";
import { SURFACE, SURFACE_FIT, routeCalls, searchPlaces, fetchRoute, makeCheckpoints, fetchElevation, fetchRouteWeather, forecastHoursFor,
  cycleProfile, fetchCycleRoute, surfaceStats, haversine, destPoint, bearing } from "./route.js";
import { cafesOnRoute, planLoop, loopAt, similarity, addCafeStop } from "./loop.js";
import { assessHere, assessRoute, describeRoute } from "./api.js";
import { routeNames, publicName, rideFacts } from "./describe.js";
import { BIKES, shareHash, parseShare } from "./share.js";
import { $, store, setStatus, esc, getPosition, countUp, hereHtml, renderHow } from "./app.js";
import { map, mapReady, ROUTE_LAYERS, isWide, popup, fitTo, clearMap, drawTrip, showPoint, placeKey, me, showMe, followMe, askCompass } from "./map.js";
import { BIKE_NAME, rideTitle, tripHtml, aiBox, pointHazard, cafePopup } from "./render.js";

const panel = $("panel"), body = $("panel-body"), planBtn = $("plan"), fromIn = $("from"), toIn = $("to");
let fromSel = null, toSel = null;     // fromSel null = "my location"
let trip = null, chosen = 0;
// Every route found for this ride, planned and checked: ‹ goes back through them, › shows the next or finds a new one.
let routes = [];
const MAX_ROUTES = 10;

// Tap the map: what's this stretch of route, switch to another route, or ride / start from here.
map.on("click", (e) => {
  const hit = map.queryRenderedFeatures(e.point, { layers: ROUTE_LAYERS.filter((id) => map.getLayer(id)) })[0];
  if (hit) {
    const s = SURFACE[hit.properties.cls], fit = trip && SURFACE_FIT[trip.bike]?.[hit.properties.cls];
    return popup(`<b>${s.name}</b><br>${["Fine on a", "Take care on a", "Not suitable for a"][fit ?? 0]} ${BIKE_NAME[trip?.bike] || "bike"}.`, e.lngLat, 6);
  }
  const alt = map.queryRenderedFeatures(e.point, { layers: ["alts"] })[0];
  if (alt) return chooseAlt(alt.properties.k);
  const at = { lat: e.lngLat.lat, lon: e.lngLat.lng, name: "Dropped pin", label: "Dropped pin" };
  const loop = prefs.ride === "loop";
  const pop = popup(`<b>${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}</b>
    ${loop ? `<button class="pop-btn" data-act="from">Start loop here</button>` : `<button class="pop-btn" data-act="to">Ride here</button><button class="pop-btn" data-act="from">Start from here</button>`}`, e.lngLat, 6);
  pop.getElement().querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
    pop.remove();
    if (b.dataset.act === "to") { toSel = at; toIn.value = at.label; } else { fromSel = at; fromIn.value = at.label; }
    const name = await fetchPlace(at.lat, at.lon);
    if (name) { at.name = at.label = name; (b.dataset.act === "to" ? toIn : fromIn).value = name; }
    if (loop || toSel) plan();
  }));
});

// --- Settings (remembered between visits) -----------------------------------------------

const prefs = { ride: "ab", bike: "road", offroad: false, cafe: true, miles: 25, ...store.get("prefs", {}) };
if (!BIKES.includes(prefs.bike)) prefs.bike = "road";
// Busy roads are always avoided and there's no "prefer flat" any more (both still written in share links, for older pages).
const fixedPrefs = () => Object.assign(prefs, { busy: true, flat: false });
fixedPrefs();
const savePrefs = () => store.set("prefs", prefs);
const lim = () => (prefs.bike === "motorbike" ? "motorbike" : "bicycle");

function showPrefs() {
  $("bike").value = prefs.bike;
  $("opt-offroad").checked = prefs.offroad; $("opt-cafe").checked = prefs.cafe;
  $("loop-len").value = prefs.miles;
}
showPrefs();

function syncControls() {
  const moto = prefs.bike === "motorbike", road = prefs.bike === "road";
  document.querySelectorAll("[data-cycle]").forEach((c) => (c.hidden = moto));
  $("opt-offroad").disabled = road;
  if (road) $("opt-offroad").checked = prefs.offroad = false;
  $("m-loop").disabled = moto;
  if (moto && prefs.ride === "loop") setRide("ab");
  $("m-loop").title = moto ? "Loops are for bicycles" : "";
  $("loop-out").textContent = `${prefs.miles} mi`;
}
function setRide(r) {
  prefs.ride = r; savePrefs();
  $("m-ab").setAttribute("aria-pressed", r === "ab"); $("m-loop").setAttribute("aria-pressed", r === "loop");
  $("to-field").hidden = r === "loop"; $("loop-field").hidden = r !== "loop";
  fromIn.placeholder = r === "loop" ? "Start: my location" : "From: my location";
}
$("m-ab").addEventListener("click", () => setRide("ab"));
$("m-loop").addEventListener("click", () => setRide("loop"));
$("bike").addEventListener("change", (e) => {
  prefs.bike = e.target.value;
  if (prefs.bike === "gravel" || prefs.bike === "mtb") $("opt-offroad").checked = prefs.offroad = true;
  savePrefs(); syncControls(); if (trip || busy) plan();
});
// A change re-plans the ride on show, or the one being planned right now.
[["opt-offroad", "offroad"], ["opt-cafe", "cafe"]].forEach(([id, k]) =>
  $(id).addEventListener("change", (e) => { prefs[k] = e.target.checked; savePrefs(); if (trip || busy) plan(); }));
$("loop-len").addEventListener("input", (e) => { prefs.miles = +e.target.value; $("loop-out").textContent = `${prefs.miles} mi`; });
$("loop-len").addEventListener("change", savePrefs);
setRide(prefs.ride); syncControls();

// --- Results sheet (phones) and search collapse ---------------------------------------

function setSheet(state) { panel.dataset.state = state; document.body.dataset.sheet = state; }
function setCollapsed(on, text) {
  if (text) $("search-mini-text").textContent = text;
  $("top").classList.toggle("collapsed", on && !isWide());
  placeKey();
}
$("search-mini").addEventListener("click", () => { setCollapsed(false); setSheet("peek"); });
$("grab").addEventListener("click", () => setSheet({ peek: "half", half: "full", full: "peek" }[panel.dataset.state]));
$("grab").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("grab").click(); } });
(function dragSheet() {
  let y0 = null, t0 = 0, moved = false;
  const y = () => new DOMMatrix(getComputedStyle(panel).transform).m42;
  $("grab").addEventListener("pointerdown", (e) => { y0 = e.clientY; t0 = y(); moved = false; panel.classList.add("dragging"); $("grab").setPointerCapture(e.pointerId); });
  $("grab").addEventListener("pointermove", (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true;
    panel.style.transform = `translateY(${Math.max(0, Math.min(panel.offsetHeight - 60, t0 + dy))}px)`;
  });
  $("grab").addEventListener("pointerup", (e) => {
    if (y0 === null) return;
    panel.classList.remove("dragging");
    const pos = y(), H = panel.offsetHeight;
    panel.style.transform = ""; y0 = null;
    if (!moved) return;
    e.preventDefault();
    const stops = { full: 0, half: 0.45 * H, peek: H - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) };
    setSheet(Object.entries(stops).reduce((a, [k, v]) => (Math.abs(v - pos) < Math.abs(stops[a] - pos) ? k : a), "half"));
  });
  $("grab").addEventListener("click", (e) => { if (moved) e.stopImmediatePropagation(); }, true);
})();
document.addEventListener("click", (e) => { if (e.target.closest('a[href="#how"]')) { e.preventDefault(); $("how").open = true; setSheet("full"); $("how").scrollIntoView({ behavior: "smooth" }); } });

// --- Saved and recent places, search suggestions -------------------------------------------

const places = () => store.get("places", { home: null, work: null, recent: [] });
const slim = (p) => ({ name: p.name, label: p.label, area: p.area || "", lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) });
function remember(p) {
  if (!p || p.name === "Your location" || p.name === "Dropped pin") return;
  const s = places();
  s.recent = [slim(p), ...s.recent.filter((r) => r.label !== p.label)].slice(0, 5);
  store.set("places", s);
}
function savedItems() {
  const s = places(), out = [];
  if (s.home) out.push({ ...s.home, cls: "saved", title: "Home", area: s.home.label });
  if (s.work) out.push({ ...s.work, cls: "saved", title: "Work", area: s.work.label });
  s.recent.forEach((r) => out.push({ ...r, cls: "recent" }));
  return out;
}
function here() { return fromSel ? [fromSel.lat, fromSel.lon] : me.pos || [map.getCenter().lat, map.getCenter().lng]; }

function autocomplete(input, list, onPick) {
  let timer = null, ctrl = null, items = [], active = -1;
  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
  const highlight = (i) => { active = i; [...list.children].forEach((li, k) => li.setAttribute("aria-selected", k === i)); };
  const pick = (i) => { const p = items[i]; if (!p) return; input.value = p.label; onPick(p); close(); };
  const show = (found) => {
    items = found;
    if (!items.length) return close();
    list.innerHTML = items.map((p, i) => `<li role="option" id="${list.id}-${i}" class="${p.cls || ""}"><span>${esc(p.title || p.name)}</span>${p.area ? `<small>${esc(p.area)}</small>` : ""}</li>`).join("");
    [...list.children].forEach((li, i) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); }));
    list.hidden = false; input.setAttribute("aria-expanded", "true"); highlight(-1);
  };
  input.addEventListener("input", () => {
    onPick(null);
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return show(q ? [] : savedItems());
    timer = setTimeout(async () => {
      ctrl?.abort(); ctrl = new AbortController();
      try {
        const found = await searchPlaces(q, here(), ctrl.signal);
        if (found.length) show(found);
        else { items = []; list.innerHTML = `<li aria-disabled="true"><small>No places found</small></li>`; list.hidden = false; }
      } catch (e) { if (e.name !== "AbortError") close(); }
    }, 250);
  });
  input.addEventListener("focus", () => { if (input.value.trim().length < 3) show(savedItems()); });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === "Enter" && items.length) { e.preventDefault(); pick(active < 0 ? 0 : active); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  return { show };
}
const fromAc = autocomplete(fromIn, $("from-sug"), (p) => { fromSel = p; if (p && prefs.ride === "loop") plan(); });
const toAc = autocomplete(toIn, $("to-sug"), (p) => { toSel = p; if (p) plan(); });
[fromIn, toIn].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.defaultPrevented) plan(); }));
$("use-loc").addEventListener("click", () => { fromSel = null; fromIn.value = ""; askCompass(); });
$("swap").addEventListener("click", () => {
  const mine = me.pos ? { lat: me.pos[0], lon: me.pos[1], name: "Your location", label: "Your location" } : null;
  const a = fromSel || mine, b = toSel;
  if (!a) return setStatus("Type a starting point (or plan once from your location) before swapping.");
  fromSel = b; toSel = a; fromIn.value = b ? b.label : ""; toIn.value = a.label;
  if (b) plan();
});

// Typed text without a picked suggestion: use it only if it's unambiguous, otherwise ask.
async function resolvePlace(input, sel, ac) {
  if (sel) return sel;
  const q = input.value.trim();
  if (!q) return null;
  const found = await searchPlaces(q, here());
  if (!found.length) throw new Error(`Couldn't find "${q}". Try a town or postcode.`);
  const exact = found.filter((p) => p.name.toLowerCase() === q.toLowerCase() || p.label.toLowerCase() === q.toLowerCase());
  if (found.length === 1 || exact.length === 1) { const p = exact[0] || found[0]; input.value = p.label; return p; }
  setCollapsed(false); input.focus(); ac.show(found);
  throw new Error(`Which "${q}" did you mean? Pick one from the list.`);
}

// --- One job at a time ---------------------------------------------------------------------
// Planning, switching route and "Safe to ride here?" take a while. Asking for another while one runs queues it
// (the latest ask replaces any earlier queued one) and the running job's result is dropped when it finishes:
// what you see is always what you asked for last.

let busy = false, queued = null, jobId = 0;
function startJob(again) {
  if (busy) { queued = again; return null; }
  busy = true;
  return ++jobId;
}
const stale = (id) => id !== jobId || queued !== null;
function endJob() {
  busy = false; setBusy(false);
  const next = queued; queued = null;
  next?.();
}

// The Plan / Update button spins while busy; what's happening is shown in the status line.
function setBusy(on, text) {
  planBtn.disabled = on;
  planBtn.classList.toggle("loading", on);
  planBtn.querySelector(".btn-text").textContent = trip ? "Update" : "Plan";
  if (on) setStatus(text);
}
const routeError = (e) => new Error(e.message === "noroute" ? "Couldn't find a route there. Try somewhere nearer, or a different spelling."
  : e.message === "noloop" ? "Couldn't make a loop from here. Try a different length or start point."
  : e.message === "busy" ? "The free cycle-route service is busy. Please try again in a minute."
  : e.message || "The route service isn't responding. Please try again in a moment.");

// --- Planning ---------------------------------------------------------------------------

async function plan() {
  if (prefs.ride === "ab" && !toIn.value.trim() && !toSel) { setCollapsed(false); toIn.focus(); return setStatus("Where are you heading? Type a destination or tap the map."); }
  const id = startJob(plan);
  if (id === null) return setStatus("Updating with your latest choices…");
  if (!fromSel) askCompass();
  setBusy(true, "Finding the way…");
  const bike = prefs.bike, opts = { avoidBusy: true, offroad: prefs.offroad, cafe: prefs.cafe, flat: false };
  try {
    const from = fromSel || (fromIn.value.trim() ? (fromSel = await resolvePlace(fromIn, null, fromAc)) : await getPosition());
    if (!fromSel) { me.pos = [from.lat, from.lon]; followMe(); }
    store.set("lastCentre", [+from.lat.toFixed(3), +from.lon.toFixed(3)]);
    let option, others = [], to = null, wind = null;
    if (prefs.ride === "ab") {
      to = toSel = await resolvePlace(toIn, toSel, toAc);
      const route = bike === "motorbike" ? await fetchRoute([from, to], "motorbike").catch((e) => { throw routeError(e); })
        : await fetchCycleRoute([from, to], cycleProfile(bike, opts.offroad, opts.avoidBusy)).catch((e) => { throw routeError(e); });
      option = { route, waypoints: [from, to] };
    } else {
      setBusy(true, "Checking the wind…");
      const h = (await fetchWeather(from.lat, from.lon)).hourly, i = PAST_HOURS;
      wind = { from: h.wind_direction_10m[i] ?? 270, speed: h.wind_speed_10m[i] ?? 0 };   // gap in the forecast: plan as if a light westerly
      const loop = await planLoop(from, prefs.miles, bike, opts, wind, (t) => setBusy(true, t)).catch((e) => { throw routeError(e); });
      option = loop.best; others = loop.others;
    }
    if (stale(id)) return;
    // Only this route is checked now; others are found when the rider taps › (see nextChoice). `gen` is shared by all of them.
    const ctx = { ride: prefs.ride, bike, opts, from, to, target: prefs.miles, wind, choices: [option], gen: { pool: others, step: 0, done: false } };
    const planned = await analyse(option, ctx, 0);
    if (stale(id)) return;
    routes = [planned]; trip = planned; chosen = 0;
    remember(fromSel); remember(to);
    history.replaceState(null, "", shareHash(trip.ride, trip.bike, prefs, trip.to, fromSel));
    setStatus("");
    renderTrip(true, true);
    console.info(`Safe2Ride: ${routeCalls} routing requests on this visit so far.`);
  } catch (e) {
    if (!stale(id)) setStatus(e.message && !/^(weather|route|search|elevation|cafes) ?\d*$/.test(e.message) ? e.message : "Something went wrong fetching the route or weather. Please try again.", true);
  } finally {
    endJob();
  }
}

// Weather along a route option (adding cafés first if wanted), ready to show.
async function analyse(option, ctx, k) {
  const now = Math.floor(Date.now() / 1000);
  if (ctx.opts.cafe && ctx.bike !== "motorbike" && !option.cafeSearched) {
    setBusy(true, "Finding cafés…");
    try { option = await addCafeStop(option, ctx.bike, ctx.opts, now); }
    catch { option = { ...option, cafe: null, cafeList: [], cafeSearched: true, cafeError: true }; }
    ctx.choices[k] = option;
  }
  const route = option.route;
  if (route.distance < 300) throw new Error("Your start and destination are too close together to plan a ride.");
  if (route.duration > 24 * 3600) throw new Error("That ride is over 24 hours long. Try planning it in stages.");
  setBusy(true, "Reading the sky…");
  const cps = makeCheckpoints(route);
  const [wx, elev] = await Promise.all([fetchRouteWeather(cps, forecastHoursFor(route)),
    route.ele ? Promise.resolve(elevFromRoute(route)) : fetchElevation(route).catch(() => null)]);
  const p = await assessRoute(cps, wx, ctx.bike === "motorbike" ? "motorbike" : "bicycle", now);
  if (!p.options.length) throw new Error("That ride is longer than the forecast covers. Try a shorter route.");
  const cafes = option.cafeList?.length ? cafesOnRoute(route, option.cafeList, now) : [];
  if (option.cafe && !cafes.some((c) => c.name === option.cafe.name)) cafes.push(...cafesOnRoute(route, [option.cafe], now, 400));
  return { ...ctx, ...p, now, descs: {}, descErr: {}, descBusy: {}, names: null, lastChosen: 0, option, route, cps, elev, alt: k, cafes: cafes.sort((a, b) => a.dist - b.dist),
    stats: route.cls ? surfaceStats(route, ctx.bike) : null };
}

function elevFromRoute(route) {
  const d = [], z = [], step = Math.max(1, Math.floor(route.coords.length / 150));
  for (let i = 0; i < route.coords.length; i += step) if (route.ele[i] != null) { d.push(route.cumD[i]); z.push(route.ele[i]); }
  return z.length > 1 ? { d, z } : null;
}

// Show route k: one found already comes straight back (with the departure you last had on it); the next new one is
// found and checked first. Ignored while something else runs.
async function chooseAlt(k) {
  if (busy || !trip || k === trip.alt || k < 0 || k >= MAX_ROUTES) return;
  if (routes[k]) { trip = routes[k]; chosen = trip.lastChosen; return renderTrip(false, true); }
  if (k !== routes.length || trip.gen.done) return;
  const id = startJob(null);
  try {
    setBusy(true, "Finding another route…");
    const option = await nextChoice(trip).catch((e) => { throw routeError(e); });
    if (stale(id)) return;
    if (!option) { trip.gen.done = true; setStatus("That's all the different routes we could find."); return renderTrip(false, false); }
    trip.choices[k] = option;
    const planned = await analyse(option, { ...trip }, k);
    if (stale(id)) return;
    routes[k] = planned; trip = planned; chosen = 0;
    setStatus("");
    renderTrip(false, true);
  } catch (e) { if (!stale(id)) setStatus(e.message || "Couldn't find another route.", true); }
  finally { endJob(); }
}

// A new route, clearly different from those found so far, or null when there are no more.
// Loops: the spare loops from the first search, then new directions. A → B: BRouter's own alternatives (bicycles),
// then detours through a point to one side or the other of the straight line, further out each time.
const LOOP_TURNS = [35, -35, 105, -105, 145, -145, 70, -70, 180, 0];
const SIDES = [0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6];
async function nextChoice(t) {
  const g = t.gen, profile = cycleProfile(t.bike, t.opts.offroad, true);
  const fresh = (route) => t.choices.every((c) => !c || similarity(route, c.route) < 0.85);
  if (t.ride === "loop") {
    while (g.pool.length) { const c = g.pool.shift(); if (fresh(c.route)) return c; }
    while (g.step < LOOP_TURNS.length) {
      const brg = (t.wind.from + LOOP_TURNS[g.step++] + 360) % 360;
      try { const c = await loopAt(t.from, t.target, t.bike, t.opts, t.wind, brg); if (fresh(c.route)) return c; }
      catch (e) { if (e.message === "busy") throw e; /* no loop that way: try the next direction */ }
    }
    return null;
  }
  const steps = [...(t.bike === "motorbike" ? [] : [1, 2, 3].map((alt) => ({ alt }))), ...SIDES.map((side) => ({ side }))];
  while (g.step < steps.length) {
    const st = steps[g.step++], wps = st.alt ? [t.from, t.to] : [t.from, detour(t.from, t.to, st.side), t.to];
    try {
      const route = t.bike === "motorbike" ? await fetchRoute(wps, "motorbike") : await fetchCycleRoute(wps, profile, st.alt || 0);
      if (route.distance <= 2 * t.choices[0].route.distance && fresh(route)) return { route, waypoints: wps };
    } catch (e) { if (e.message === "busy") throw e; /* no way through there: try the next */ }
  }
  return null;
}
// A point `side` × the distance from A to B, out to the left (negative) or right of the halfway point.
function detour(a, b, side) {
  const d = haversine([a.lat, a.lon], [b.lat, b.lon]);
  return destPoint((a.lat + b.lat) / 2, (a.lon + b.lon) / 2, (bearing(a, b) + (side > 0 ? 90 : 270)) % 360, Math.abs(side) * d);
}

planBtn.addEventListener("click", plan);

// --- Sharing: the ride lives in the link (your own location is never put in it) ---------

async function shareRide() {
  const url = location.href, title = trip.ride === "loop" ? `Safe2Ride: ${prefs.miles}-mile loop from ${trip.from.name}` : `Safe2Ride: ${trip.from.name} → ${trip.to.name}`;
  try {
    if (navigator.share) return await navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    setStatus("Link copied. Anyone who opens it sees this ride with the latest weather.");
  } catch (e) { if (e.name !== "AbortError") setStatus(`Copy this link to share the ride: ${url}`); }
}
function saveAs(which) {
  const s = places(); s[which] = slim(trip.to); store.set("places", s);
  setStatus(`Saved ${trip.to.name} as ${which === "home" ? "Home" : "Work"}. It appears when you tap a search box.`);
}
// Opening a shared link: only the parts that check out are used (see share.js).
(function openShared() {
  const st = parseShare(location.hash);
  if (!st) return;
  if (st.to) { toSel = st.to; toIn.value = toSel.label; }
  if (st.from) { fromSel = st.from; fromIn.value = fromSel.label; }
  if (st.bike) prefs.bike = st.bike;
  if (st.opts) Object.assign(prefs, st.opts);
  fixedPrefs();
  if (st.miles) prefs.miles = st.miles;
  showPrefs();
  setRide(st.ride); syncControls();
  if (st.ride === "loop" || st.to) mapReady.then(plan);
})();

// --- Showing a ride ------------------------------------------------------------------------

function renderTrip(first, fit) {
  body.innerHTML = tripHtml(trip, chosen, first, { n: routes.length, more: !trip.gen.done && routes.length < MAX_ROUTES });
  $("intro").hidden = true;
  $("prev").addEventListener("click", () => chooseAlt(trip.alt - 1));
  $("next").addEventListener("click", () => chooseAlt(trip.alt + 1));
  body.querySelectorAll(".dep").forEach((b) => b.addEventListener("click", () => { chosen = trip.lastChosen = +b.dataset.i; renderTrip(false, false); }));
  body.querySelectorAll(".risk").forEach((b) => b.addEventListener("click", () => showPoint(+b.dataset.pt)));
  $("share").addEventListener("click", shareRide);
  wireRetry(trip, chosen);
  body.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveAs(b.dataset.save)));
  countUp(body);
  if (first) { setCollapsed(true, rideTitle(trip)); setSheet("half"); }
  const o = trip.options[chosen];
  mapReady.then(() => drawTrip(trip, o, fit, (c) => cafePopup(trip, chosen, c), pointHazard));
  autoDescribe(first ? 0 : 700);
}

// --- The AI briefing: a paragraph on what to expect, written for whichever route and departure is on show ---------
// Asked for as soon as a ride is shown, and after a short pause when you switch route or departure (so flicking
// through doesn't ask for each one). Kept per departure on the route, so going back never asks again.
// If it can't be written, our own few sentences are shown instead, with a "Try again".

let describeTimer = null;
function autoDescribe(delay) {
  clearTimeout(describeTimer);
  const t = trip, k = chosen;
  if (!t || t.descs[k] || t.descErr[k]) return;
  describeTimer = setTimeout(() => describeTrip(t, k), delay);
}

async function describeTrip(t, k) {
  if (trip !== t || chosen !== k || t.descs[k] || t.descBusy[k]) return;
  const o = t.options[k];
  t.descBusy[k] = true;
  delete t.descErr[k];
  showAi(t, k);
  try {
    const names = t.names || (t.names = await routeNames(t.route));
    const [start, end] = await Promise.all([publicName(t.from), publicName(t.to)]);
    const wx = t.cps.map((_, i) => o.pts[i].h);
    t.descs[k] = await describeRoute(t.cps, wx, t.bike === "motorbike" ? "motorbike" : "bicycle", t.now, o.dep, rideFacts(t, o, names, start, end));
  } catch (e) {
    t.descErr[k] = `${e.message || "The AI briefing isn't available right now."} Here's our own summary instead.`;
  } finally {
    t.descBusy[k] = false;
    showAi(t, k);
  }
}

function showAi(t, k) {
  if (trip !== t || chosen !== k || !$("ai")) return;
  $("ai").outerHTML = aiBox(t, k);
  wireRetry(t, k);
}
function wireRetry(t, k) {
  $("ai-retry")?.addEventListener("click", () => { delete t.descErr[k]; describeTrip(t, k); });
}

// --- "Safe to ride here?" --------------------------------------------------------------

async function checkHere() {
  const b = $("here-btn");
  if (b.classList.contains("loading")) return;
  const id = startJob(checkHere);
  if (id === null) return;
  b.classList.add("loading"); b.querySelector("span").textContent = "Checking…";
  setStatus("Finding you…");
  try {
    askCompass();
    const pos = await getPosition();
    showMe(pos.lat, pos.lon); followMe();
    store.set("lastCentre", [+pos.lat.toFixed(3), +pos.lon.toFixed(3)]);
    setStatus("Reading the sky…");
    const [data, place] = await Promise.all([fetchWeather(pos.lat, pos.lon), fetchPlace(pos.lat, pos.lon)]);
    const a = await assessHere(data.hourly, lim());
    if (stale(id)) return;
    trip = null; routes = [];
    clearMap();
    me.note = place ? `<b>You're near ${esc(place)}</b>` : "";
    $("intro").hidden = true;
    body.innerHTML = hereHtml(data, place, lim(), a);
    countUp(body);
    setStatus("");
    setCollapsed(true, place ? `Riding near ${place}` : "Riding near you");
    setSheet("half");
    fitTo([[pos.lat - 0.02, pos.lon - 0.03], [pos.lat + 0.02, pos.lon + 0.03]], 14);
  } catch (e) {
    if (stale(id)) return;
    setStatus(e.message && !/^weather/.test(e.message) ? e.message : "Couldn't fetch the weather right now. Please try again in a moment.", true);
    setSheet("half");
  } finally {
    b.classList.remove("loading"); b.querySelector("span").textContent = "Safe to ride here?";
    endJob();
  }
}
$("here-btn").addEventListener("click", checkHere);

renderHow();
