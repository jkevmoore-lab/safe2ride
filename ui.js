// Safe2Ride map-first interface: map, search card, filters, results panel. Uses app.js, route.js and loop.js.

const BIKE_NAME = { road: "road bike", gravel: "gravel bike", mtb: "mountain bike", motorbike: "motorbike" };
const HAZARD_WORD = { storm: "Storms", snow: "Snow", ice: "Ice", wind: "Wind", crosswind: "Wind", headwind: "Headwind",
  rain: "Rain", soak: "Rain", wet: "Wet roads", fog: "Fog", heat: "Heat", dark: "Dark" };
const ISSUE_NAME = { busy: "busy road", g1: "smooth track (Grade 1)", g2: "rough track (Grade 2)", g3: "MTB-only track (Grade 3)", unknown: "path with unknown surface" };
// Dash patterns for unpaved classes, in line widths (MapLibre's unit).
const DASH = { g1: [1.6, 1], g2: [0.8, 0.9], g3: [0.1, 1.5], unknown: [0.5, 0.8] };
const isWide = () => matchMedia("(min-width: 900px)").matches;

const panel = $("panel"), body = $("panel-body"), planBtn = $("plan"), fromIn = $("from"), toIn = $("to");
let fromSel = null, toSel = null, myPos = null;     // fromSel null = "my location"
let trip = null, chosen = 0, chips = [], markers = [];

// --- Map: vector tiles, so road and place names draw above our route ------------------------

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const last = store.get("lastCentre", null);
const map = new maplibregl.Map({
  container: "map", style: `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
  center: last ? [last[1], last[0]] : [UK_CENTRE[1], UK_CENTRE[0]], zoom: last ? 11 : 5, attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }), isWide() ? "bottom-left" : "top-left");
if (isWide()) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
const ROUTE_LAYERS = ["route-solid", ...Object.keys(DASH).map((k) => `route-${k}`)];
const mapReady = new Promise((resolve) => map.on("load", () => {
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;   // route goes under every label
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("route", { type: "geojson", data: empty });
  map.addSource("alts", { type: "geojson", data: empty });
  map.addLayer({ id: "alts", type: "line", source: "alts", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#5f6f67", "line-width": 5, "line-opacity": 0.45, "line-dasharray": [0.6, 1.6] } }, firstLabel);
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": dark ? "#0f1a15" : "#ffffff", "line-width": 10, "line-opacity": 0.9 } }, firstLabel);
  map.addLayer({ id: "route-solid", type: "line", source: "route", filter: ["==", ["get", "dash"], "none"], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "colour"], "line-width": 6 } }, firstLabel);
  for (const [k, arr] of Object.entries(DASH)) map.addLayer({ id: `route-${k}`, type: "line", source: "route", filter: ["==", ["get", "dash"], k],
    layout: { "line-cap": k === "g3" ? "round" : "butt", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": 6, "line-dasharray": arr } }, firstLabel);
  [...ROUTE_LAYERS, "alts"].forEach((id) => { map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer")); map.on("mouseleave", id, () => (map.getCanvas().style.cursor = "")); });
  resolve();
}));
map.on("zoomend", layoutChips);

const popup = (html, at, offset = 14) => new maplibregl.Popup({ closeButton: false, maxWidth: "270px", offset }).setLngLat(at).setHTML(html).addTo(map);
let hoverPop = null;

// Fit the map to [lat, lon] points, leaving room for the search card and the results sheet on phones.
function fitTo(points, maxZoom = 15) {
  const b = new maplibregl.LngLatBounds();
  points.forEach(([la, lo]) => b.extend([lo, la]));
  // Use where the sheet is heading, not where it is mid-slide.
  const H = panel.offsetHeight, peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek"));
  const sheet = { peek, half: H * 0.55, full: H }[panel.dataset.state] ?? peek;
  const pad = isWide() ? { top: 40, bottom: 40, left: 40, right: 60 }
    : { top: $("top").getBoundingClientRect().bottom + 16, bottom: Math.min(sheet + 16, innerHeight * 0.6), left: 24, right: 24 };
  map.fitBounds(b, { padding: pad, maxZoom, duration: 600 });
}

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

// An HTML marker that shows its details on tap, and on hover with a mouse.
function addMarker(el, lat, lon, html, anchor = "center", offset = 16) {
  const m = new maplibregl.Marker({ element: el, anchor }).setLngLat([lon, lat]).addTo(map);
  if (html) {
    const show = () => { hoverPop?.remove(); hoverPop = popup(typeof html === "function" ? html() : html, [lon, lat], offset); };
    el.addEventListener("click", (e) => { e.stopPropagation(); show(); });
    el.addEventListener("mouseenter", () => { if (matchMedia("(hover: hover)").matches) show(); });
  }
  markers.push(m);
  return m;
}
function div(cls, html = "") { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; return d; }
function clearMap() {
  markers.forEach((m) => m.remove()); markers = [];
  chips.forEach((c) => c.marker.remove()); chips = [];
  hoverPop?.remove();
  // Clear now if the map is ready (drawTrip always is), so a new route drawn straight after isn't wiped.
  const wipe = () => ["route", "alts"].forEach((id) => map.getSource(id)?.setData({ type: "FeatureCollection", features: [] }));
  if (map.getSource("route")) wipe(); else mapReady.then(wipe);
}

// --- Settings (remembered between visits) -----------------------------------------------

const prefs = { ride: "ab", bike: "road", busy: true, offroad: false, cafe: true, flat: false, miles: 25, ...store.get("prefs", {}) };
const savePrefs = () => store.set("prefs", prefs);
const lim = () => (prefs.bike === "motorbike" ? "motorbike" : "bicycle");

$("bike").value = prefs.bike;
$("opt-busy").checked = prefs.busy; $("opt-offroad").checked = prefs.offroad; $("opt-cafe").checked = prefs.cafe; $("opt-flat").checked = prefs.flat;
$("loop-len").value = prefs.miles;

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
  savePrefs(); syncControls(); if (trip) plan();
});
[["opt-busy", "busy"], ["opt-offroad", "offroad"], ["opt-cafe", "cafe"], ["opt-flat", "flat"]].forEach(([id, k]) =>
  $(id).addEventListener("change", (e) => { prefs[k] = e.target.checked; savePrefs(); if (trip) plan(); }));
$("loop-len").addEventListener("input", (e) => { prefs.miles = +e.target.value; $("loop-out").textContent = `${prefs.miles} mi`; });
$("loop-len").addEventListener("change", savePrefs);
setRide(prefs.ride); syncControls();

// --- Results sheet (phones) and search collapse ---------------------------------------

function setSheet(state) { panel.dataset.state = state; document.body.dataset.sheet = state; }
function setCollapsed(on, text) {
  if (text) $("search-mini-text").textContent = text;
  $("top").classList.toggle("collapsed", on && !isWide());
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
function here() { return fromSel ? [fromSel.lat, fromSel.lon] : myPos || [map.getCenter().lat, map.getCenter().lng]; }

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
$("use-loc").addEventListener("click", () => { fromSel = null; fromIn.value = ""; });
$("swap").addEventListener("click", () => {
  const me = myPos ? { lat: myPos[0], lon: myPos[1], name: "Your location", label: "Your location" } : null;
  const a = fromSel || me, b = toSel;
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

// --- Planning ---------------------------------------------------------------------------

let planning = false;
function setBusy(on, text) {
  planBtn.disabled = on;
  planBtn.classList.toggle("loading", on);
  planBtn.querySelector(".btn-text").textContent = on ? text : trip ? "Update ride" : "Plan my ride";
  if (on) setStatus(text);
}
const routeError = (e) => new Error(e.message === "noroute" ? "Couldn't find a route there. Try somewhere nearer, or a different spelling."
  : e.message === "noloop" ? "Couldn't make a loop from here. Try a different length or start point."
  : e.message === "busy" ? "The free cycle-route service is busy. Please try again in a minute."
  : e.message || "The route service isn't responding. Please try again in a moment.");

async function plan() {
  if (planning) return;
  if (prefs.ride === "ab" && !toIn.value.trim() && !toSel) { setCollapsed(false); toIn.focus(); return setStatus("Where are you heading? Type a destination or tap the map."); }
  planning = true;
  setBusy(true, "Finding the way…");
  const bike = prefs.bike, opts = { avoidBusy: prefs.busy, offroad: prefs.offroad, cafe: prefs.cafe, flat: prefs.flat };
  try {
    const from = fromSel || (fromIn.value.trim() ? (fromSel = await resolvePlace(fromIn, null, fromAc)) : await getPosition());
    if (!fromSel) myPos = [from.lat, from.lon];
    store.set("lastCentre", [+from.lat.toFixed(3), +from.lon.toFixed(3)]);
    let option, others = [], to = null;
    if (prefs.ride === "ab") {
      to = toSel = await resolvePlace(toIn, toSel, toAc);
      const route = bike === "motorbike" ? await fetchRoute(from, to, "motorbike").catch((e) => { throw routeError(e); })
        : await fetchCycleRoute([from, to], cycleProfile(bike, opts.offroad, opts.avoidBusy)).catch((e) => { throw routeError(e); });
      option = { route, waypoints: [from, to] };
    } else {
      setBusy(true, "Checking the wind…");
      const h = (await fetchWeather(from.lat, from.lon)).hourly, i = PAST_HOURS;
      const loop = await planLoop(from, prefs.miles, bike, opts, { from: h.wind_direction_10m[i], speed: h.wind_speed_10m[i] }, (t) => setBusy(true, t)).catch((e) => { throw routeError(e); });
      option = loop.best; others = loop.others;
    }
    // A → B bike routes fetch alternatives on demand (BRouter gives up to 3 more).
    const ctx = { ride: prefs.ride, bike, opts, from, to, target: prefs.miles, choices: [option, ...others],
      moreAlts: prefs.ride === "ab" && bike !== "motorbike" };
    trip = await analyse(option, ctx, 0);
    remember(fromSel); remember(to);
    shareState();
    setStatus("");
    renderTrip(true, true);
  } catch (e) {
    setStatus(e.message && !/^(weather|route|search|elevation|cafes) ?\d*$/.test(e.message) ? e.message : "Something went wrong fetching the route or weather. Please try again.", true);
  } finally {
    planning = false;
    setBusy(false);
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
  chosen = 0;
  const cafes = option.cafeList?.length ? cafesOnRoute(route, option.cafeList, now) : [];
  if (option.cafe && !cafes.some((c) => c.name === option.cafe.name)) cafes.push(...cafesOnRoute(route, [option.cafe], now, 400));
  return { ...ctx, ...p, option, route, cps, elev, alt: k, cafes: cafes.sort((a, b) => a.dist - b.dist),
    stats: route.cls ? surfaceStats(route, ctx.bike) : null };
}

function elevFromRoute(route) {
  const d = [], z = [], step = Math.max(1, Math.floor(route.coords.length / 150));
  for (let i = 0; i < route.coords.length; i += step) if (route.ele[i] != null) { d.push(route.cumD[i]); z.push(route.ele[i]); }
  return z.length > 1 ? { d, z } : null;
}

// Switch to route k (loops: already planned; A → B: fetched from BRouter the first time).
async function chooseAlt(k) {
  if (planning || !trip || k === trip.alt || k < 0) return;
  planning = true;
  try {
    const ctx = { ...trip };
    if (!ctx.choices[k]) {
      if (!ctx.moreAlts) return;
      setStatus("Finding another route…");
      const profile = cycleProfile(ctx.bike, ctx.opts.offroad, ctx.opts.avoidBusy);
      const route = await fetchCycleRoute([ctx.from, ctx.to], profile, k).catch((e) => { throw routeError(e); });
      const same = ctx.choices.some((c) => Math.abs(c.route.distance - route.distance) < 50 && Math.abs(c.route.duration - route.duration) < 30);
      if (same || k >= 3) trip.moreAlts = false;
      if (same) { setStatus("That's the only sensible route we found."); renderTrip(false, false); return; }
      ctx.choices[k] = { route, waypoints: [ctx.from, ctx.to] };
      ctx.moreAlts = trip.moreAlts;
    }
    trip = await analyse(ctx.choices[k], ctx, k);
    setStatus("");
    renderTrip(false, true);
  } catch (e) { setStatus(e.message || "Couldn't load that route.", true); }
  finally { planning = false; setBusy(false); }
}

planBtn.addEventListener("click", plan);

// --- Sharing: the ride lives in the link (your own location is never put in it) ---------

function shareState() {
  const pt = (p) => [+p.lat.toFixed(4), +p.lon.toFixed(4), p.name];
  const st = { r: trip.ride, b: trip.bike, o: [prefs.busy, prefs.offroad, prefs.cafe, prefs.flat].map(Number).join(""), L: prefs.miles,
    ...(trip.to ? { t: pt(trip.to) } : {}), ...(fromSel ? { f: pt(fromSel) } : {}) };
  history.replaceState(null, "", "#r=" + encodeURIComponent(JSON.stringify(st)));
}
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
(function openShared() {
  const m = /#r=(.+)$/.exec(location.hash);
  if (!m) return;
  try {
    const st = JSON.parse(decodeURIComponent(m[1]));
    const place = ([lat, lon, name]) => ({ lat, lon, name, label: name });
    if (st.t) { toSel = place(st.t); toIn.value = toSel.label; }
    if (st.f) { fromSel = place(st.f); fromIn.value = fromSel.label; }
    if (st.b) { prefs.bike = st.b; $("bike").value = st.b; }
    if (st.o) [prefs.busy, prefs.offroad, prefs.cafe, prefs.flat] = st.o.split("").map((c) => c === "1");
    ["busy", "offroad", "cafe", "flat"].forEach((k) => ($(`opt-${k}`).checked = prefs[k]));
    if (st.L) { prefs.miles = st.L; $("loop-len").value = st.L; }
    setRide(st.r === "loop" ? "loop" : "ab"); syncControls();
    mapReady.then(plan);
  } catch { /* a broken link just opens the normal page */ }
})();

// --- Rendering a ride: one compact route card -------------------------------------------

function renderTrip(first, fit) {
  const o = trip.options[chosen], best = trip.options[trip.best], cycle = trip.bike !== "motorbike";
  const backWord = trip.ride === "loop" ? "back" : "arrive";
  const fromName = trip.from.name === "Your location" ? "your location" : trip.from.name;
  const title = trip.ride === "loop" ? `${miles(trip.route.distance)}-mile loop from ${fromName}` : `${trip.from.name} → ${trip.to.name}`;
  const n = trip.choices.filter(Boolean).length, known = !trip.moreAlts;
  const hazard = (d) => (d.level ? HAZARD_WORD[d.reasons.find((r) => r.level === d.level)?.kind] || VERDICT[d.level].title : "Clear");
  const anim = (i) => (first ? `reveal" style="--i:${i}` : "swap");
  const sub = trip.alt === 0 ? (n > 1 || trip.moreAlts ? "Best match" : "") : trip.ride === "loop" ? `Heads ${compass(trip.option.heading ?? 0)} first` : "Alternative route";

  body.innerHTML = `
    <div class="card rdlg ${anim(0)}">
      <div class="rhead">
        <button type="button" class="arr" id="prev" aria-label="Previous route" ${trip.alt === 0 ? "disabled" : ""}>‹</button>
        <div class="rt"><b>${n > 1 || trip.moreAlts ? `Route ${trip.alt + 1}${known ? ` of ${n}` : ""}` : "Your route"}</b><small>${esc(sub)}</small></div>
        <button type="button" class="arr" id="next" aria-label="Next route" ${trip.alt + 1 < n || trip.moreAlts ? "" : "disabled"}>›</button>
      </div>
      <p class="desc">${describe(o, title, backWord)}</p>
      ${trip.stats ? surfaceBar(trip.stats) : ""}
      <div class="links"><button type="button" class="linkbtn" id="share">Share</button>
        ${trip.to ? `<button type="button" class="linkbtn" data-save="home">Save as Home</button><button type="button" class="linkbtn" data-save="work">Save as Work</button>` : ""}</div>
    </div>
    <div class="card ${anim(1)}"><h2 class="ch">When to leave${trip.best !== chosen ? ` · best ${trip.best === 0 ? "now" : clock(best.dep)}` : ""}</h2>
      <div class="deps" role="group" aria-label="Departure times">${trip.options.map((d, i) => {
        const mid = d.pts[Math.floor(d.pts.length / 2)];
        return `<button class="dep" aria-pressed="${i === chosen}" data-i="${i}" title="${VERDICT[d.level].title}: leave ${clock(d.dep)}">
          ${i === trip.best ? '<span class="star">Best</span>' : ""}<span class="t">${i === 0 ? "Now" : clock(d.dep)}</span>
          ${svg(wxBits(mid.h, mid.at).icon)}${lvPill(d.level)}<span class="hz">${hazard(d)}</span></button>`;
      }).join("")}</div></div>
    <details class="card more ${anim(2)}"><summary>More details</summary>
      ${trip.stats?.issues.length ? `<h3>Surfaces to watch</h3>${issuesHtml(trip.stats)}` : ""}
      ${trip.elev ? `<h3>Hills</h3>${profileHtml(o)}` : ""}
      <h3>Weather risk <a href="#how">How we score</a></h3>${scoreTiles(o.scores)}
      <h3>Why</h3>${reasonList(o.reasons, "No weather hazards found along the route.")}
      <h3>Along the way</h3>${pointsHtml(o)}
      ${cycle && trip.opts.cafe && cafeNote() ? `<p class="note">${cafeNote()}</p>` : ""}
    </details>`;

  $("intro").hidden = true;
  $("prev").addEventListener("click", () => chooseAlt(trip.alt - 1));
  $("next").addEventListener("click", () => chooseAlt(trip.alt + 1));
  body.querySelectorAll(".dep").forEach((b) => b.addEventListener("click", () => { chosen = +b.dataset.i; renderTrip(false, false); }));
  $("share").addEventListener("click", shareRide);
  body.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveAs(b.dataset.save)));
  countUp(body);
  if (first) { setCollapsed(true, title); setSheet("half"); }
  mapReady.then(() => drawTrip(o, fit));
}

// The route in one paragraph: verdict, distance and time, weather, roads, hills, cafés.
function describe(o, title, backWord) {
  const st = trip.stats, when = chosen === 0 ? "now" : `at ${clock(o.dep)}`;
  const parts = [`<span class="vpill l${o.level}">${["✓", "!", "×"][o.level]} ${VERDICT[o.level].title}</span>`,
    `${esc(title)}: ${miles(trip.route.distance)} mi, about ${duration(trip.route.duration)}, ${backWord} ${clock(o.arrive)} if you leave ${when}.`,
    esc(o.summary)];
  if (st) {
    const main = ["quiet", "path"].filter((k) => st.pct[k] >= 5).map((k) => `${{ quiet: "quiet roads", path: "cycle paths" }[k]} (${Math.round(st.pct[k])}%)`);
    const extra = [];
    if (st.metres.busy >= 100) extra.push(`${miles(st.metres.busy)} mi on busy roads`);
    const rough = st.metres.g1 + st.metres.g2 + st.metres.g3;
    if (rough >= 100) extra.push(`${miles(rough)} mi of unpaved track`);
    const bad = st.issues.filter((x) => x.level === 2).reduce((s, x) => s + x.len, 0);
    parts.push(`${main.length ? `Mostly ${main.join(" and ")}` : "Mixed roads"}${extra.length ? `, with ${extra.join(" and ")}` : ""}.${bad ? ` <b>${miles(bad)} mi isn't suitable for a ${BIKE_NAME[trip.bike]}.</b>` : ""}`);
    const p0 = o.pts[0], rain6 = p0.h.precipitation.slice(Math.max(0, p0.at - PAST_HOURS), p0.at + 1).reduce((a, b) => a + b, 0);
    if (rough + st.metres.unknown > 800 && rain6 >= 1) parts.push("Unpaved stretches will be muddy after the recent rain.");
  }
  if (trip.route.climb) parts.push(`${Math.round(trip.route.climb)} m of climbing.`);
  if (trip.bike !== "motorbike" && trip.opts.cafe) {
    const c = trip.cafes.length;
    parts.push(c ? `${c} café${c > 1 ? "s" : ""} on the way: tap ☕ on the map.` : trip.option.cafeError ? "Café search isn't responding right now." : "No cafés right on the route.");
  }
  if (trip.option.detours?.length) parts.push(`Includes a short detour to ${esc(trip.option.detours.map((d) => d.why).join(", "))}.`);
  return parts.join(" ");
}

function surfaceBar(st) {
  const shown = SURFACES.filter((x) => st.metres[x.id] >= 50);
  return `<div class="sbar" role="img" aria-label="${shown.map((x) => `${x.name} ${Math.round(st.pct[x.id])}%`).join(", ")}">${shown.map((x) => `<i style="width:${st.pct[x.id]}%;background:${x.colour}"></i>`).join("")}</div>
    <div class="skey">${shown.map((x) => `<span><i class="sw" style="background:${x.colour}"></i>${x.name} ${st.pct[x.id] < 1 ? "<1" : Math.round(st.pct[x.id])}%</span>`).join("")}</div>`;
}

function issuesHtml(st) {
  const where = (d) => (d < 400 ? "near the start" : trip.route.distance - d < 400 ? "near the end" : `around mile ${miles(d)}`);
  const verb = ["", "take care on a", "not suitable for a"];
  return `<ul class="issues">${st.issues.slice(0, 5).map((x) => `<li>${lvPill(x.level)}<span>${miles(x.len)} mi of ${ISSUE_NAME[x.cls]} ${where(x.start)}: ${verb[x.level]} ${BIKE_NAME[trip.bike]}.</span></li>`).join("")}</ul>`;
}

function cafeNote() {
  if (trip.option.cafeRejected) return `The nearest café to halfway, ${esc(trip.option.cafeRejected)}, is only reachable on surfaces that don't suit a ${BIKE_NAME[trip.bike]}, so we've left it out.`;
  return trip.cafes.length ? "Cafés come from OpenStreetMap. Where several are close together we show the best local one." : "";
}

// Café details, shown when you tap or hover over its ☕ on the map.
function cafePopup(c) {
  const o = trip.options[chosen], eta = o.dep + c.t, open = openAt(c.hours, new Date(eta * 1000));
  return `<b>${esc(c.name)}</b><br>${c.chain ? "Chain" : "Independent"}${trip.option.cafe?.name === c.name ? " · your café stop" : ""}<br>
    Mile ${miles(c.dist)} · about ${clock(eta)}<br>
    ${open === true ? '<span class="open-yes">Open when you get there</span>' : open === false ? '<span class="closed">Closed when you get there</span>' : '<span class="open-unknown">Opening hours not listed</span>'}${c.hours ? `<br><small>${esc(c.hours)}</small>` : ""}`;
}

function pointsHtml(o) {
  return `<ul class="cps">${o.pts.map((p, k) => {
    const g = o.segs[Math.min(k, o.segs.length - 1)], h = p.h, i = p.at, b = wxBits(h, i);
    const wind = g.head >= 6 ? "headwind" : g.head <= -6 ? "tailwind" : h.wind_speed_10m[i] >= 8 ? "crosswind" : "light wind";
    const label = k === 0 ? "Start" : k === o.pts.length - 1 ? (trip.ride === "loop" ? "Back home" : "Arrive") : `Mile ${miles(p.dist)}`;
    return `<li>${lvPill(p.level)}<span><b>${clock(p.eta)}</b></span>${svg(b.icon)}
      <span><b>${label}</b><span class="wx"><span>${b.temp}°</span><span>${b.fall}</span><span>${b.arrow}<span class="w">&nbsp;gusts ${Math.round(h.wind_gusts_10m[i])}</span></span><span class="w">${wind}</span></span></span></li>`;
  }).join("")}</ul>`;
}

// Hills: height along the route.
function profileHtml(o) {
  const e = trip.elev;
  if (!e || e.z.length < 2) return "";
  const W = 600, H = 80, total = trip.route.distance;
  const lo = Math.min(...e.z), hi = Math.max(...e.z), span = Math.max(30, hi - lo);
  const x = (d) => (d / total * W).toFixed(1), y = (z) => (H - 6 - (z - lo) / span * (H - 14)).toFixed(1);
  const pts = e.d.map((d, i) => `${x(d)},${y(e.z[i])}`);
  const st = climbStats(e.z);
  return `<div class="profile"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hills: ${st.up} metres of climbing, ${st.min} to ${st.max} metres high.">
      <polygon class="area" points="0,${H} ${pts.join(" ")} ${W},${H}"/><polyline points="${pts.join(" ")}" fill="none" stroke="var(--moss)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="stats-line"><span>↗ ${st.up} m climbing</span><span>↘ ${st.down} m descending</span><span>${st.min}–${st.max} m high</span>${trip.bike !== "motorbike" && st.up / (total / MILE) > 25 ? "<span>Hilly: allow extra time</span>" : ""}</div></div>`;
}

// --- Drawing a ride on the map: coloured by path type, labels stay on top ---------------------

function drawTrip(o, fit) {
  clearMap();
  const { coords } = trip.route;
  const line = (pts) => ({ type: "LineString", coordinates: pts.map(([la, lo]) => [lo, la]) });

  // Other routes: faint dashed lines you can tap to switch.
  map.getSource("alts").setData({ type: "FeatureCollection", features: trip.choices.map((c, k) => (k === trip.alt || !c ? null
    : { type: "Feature", properties: { k }, geometry: line(c.route.coords) })).filter(Boolean) });

  // The route, one feature per run of the same path type (motorbike routes have no grading: one colour).
  const feats = [];
  if (trip.route.cls) {
    let start = 0;
    for (let i = 1; i <= trip.route.cls.length; i++) {
      if (i < trip.route.cls.length && trip.route.cls[i] === trip.route.cls[start]) continue;
      const c = trip.route.cls[start];
      feats.push({ type: "Feature", properties: { cls: c, colour: SURFACE[c].colour, dash: DASH[c] ? c : "none" }, geometry: line(coords.slice(start, i + 1)) });
      start = i;
    }
  } else feats.push({ type: "Feature", properties: { cls: "quiet", colour: "#2d6a4f", dash: "none" }, geometry: line(coords) });
  map.getSource("route").setData({ type: "FeatureCollection", features: feats });

  addMarker(div("pin-start"), coords[0][0], coords[0][1], `<b>Start</b><br>${esc(trip.from.name)}`);
  if (trip.ride === "ab") addMarker(div("pin-end"), coords.at(-1)[0], coords.at(-1)[1], `<b>Finish</b><br>${esc(trip.to.name)}`);
  trip.cafes.forEach((c) => addMarker(div(`pin-cafe${c.chain ? " chain" : ""}${trip.option.cafe?.name === c.name ? " stop" : ""}`, "☕"), c.lat, c.lon, () => cafePopup(c), "center", 18));

  // Weather tags (thinned so they never overlap).
  chips = o.pts.map((p, k) => {
    const b = wxBits(p.h, p.at), h = p.h, i = p.at;
    const el = div(`wchip b${p.level}`, `${p.level ? `<b class="tg">${["", "!", "×"][p.level]}</b>` : ""}${svg(b.icon)}<span>${b.temp}°</span>${b.arrow}`);
    const tip = `<b>${k === 0 ? "Start" : k === o.pts.length - 1 ? "End" : "Mile " + miles(p.dist)} · ${clock(p.eta)} · ${VERDICT[p.level].title}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${b.temp}° · ${b.fall}<br>Wind from the ${compass(h.wind_direction_10m[i])}, ${Math.round(h.wind_speed_10m[i])} mph, gusts ${Math.round(h.wind_gusts_10m[i])}`;
    const marker = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -8] }).setLngLat([p.lon, p.lat]);
    el.addEventListener("click", (e) => { e.stopPropagation(); hoverPop?.remove(); hoverPop = popup(tip, [p.lon, p.lat], 34); });
    return { marker, lngLat: [p.lon, p.lat], level: p.level, end: k === 0 || k === o.pts.length - 1 ? 1 : 0 };
  });
  if (fit) { fitTo(coords); map.once("moveend", layoutChips); } else layoutChips();
}

// Weather tags, thinned so they never overlap. Hazards and the ends win space first.
function layoutChips() {
  const placed = [];
  const order = chips.map((c, k) => ({ c, k })).sort((a, b) => b.c.level - a.c.level || b.c.end - a.c.end || a.k - b.k);
  for (const { c } of order) {
    const pt = map.project(c.lngLat);
    const clash = placed.some((q) => Math.abs(q.x - pt.x) < 104 && Math.abs(q.y - pt.y) < 34);
    if (clash) c.marker.remove(); else { placed.push(pt); c.marker.addTo(map); }
  }
}

// --- "Safe to ride here?" --------------------------------------------------------------

$("here-btn").addEventListener("click", async () => {
  const b = $("here-btn");
  if (b.classList.contains("loading")) return;
  b.classList.add("loading"); b.querySelector("span").textContent = "Checking…";
  setStatus("Finding you…");
  try {
    const pos = await getPosition();
    myPos = [pos.lat, pos.lon];
    store.set("lastCentre", [+pos.lat.toFixed(3), +pos.lon.toFixed(3)]);
    setStatus("Reading the sky…");
    const [data, place] = await Promise.all([fetchWeather(pos.lat, pos.lon), fetchPlace(pos.lat, pos.lon)]);
    const a = await assessHere(data.hourly, lim());
    trip = null;
    clearMap();
    addMarker(div("me"), pos.lat, pos.lon, place ? `<b>You're near ${esc(place)}</b>` : "");
    $("intro").hidden = true;
    body.innerHTML = hereHtml(data, place, lim(), a);
    countUp(body);
    setStatus("");
    setCollapsed(true, place ? `Riding near ${place}` : "Riding near you");
    setSheet("half");
    fitTo([[pos.lat - 0.02, pos.lon - 0.03], [pos.lat + 0.02, pos.lon + 0.03]], 14);
  } catch (e) {
    setStatus(e.message && !/^weather/.test(e.message) ? e.message : "Couldn't fetch the weather right now. Please try again in a moment.", true);
    setSheet("half");
  } finally {
    b.classList.remove("loading"); b.querySelector("span").textContent = "Safe to ride here?";
  }
});

renderHow();
