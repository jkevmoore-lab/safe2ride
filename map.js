// Safe2Ride map: vector tiles, the route drawn by path type, weather tags, markers and your location.
// MapLibre comes from its own <script> tag (the global maplibregl).

import { WMO, compass } from "./logic.js";
import { UK_CENTRE, SURFACE, destPoint, miles, clock } from "./route.js";
import { $, store, esc, num, VERDICT, svg, wxBits } from "./app.js";

const maplibregl = globalThis.maplibregl;
// Dash patterns for unpaved classes, in line widths (MapLibre's unit).
const DASH = { g1: [1.6, 1], g2: [0.8, 0.9], g3: [0.1, 1.5], unknown: [0.5, 0.8] };
const isWide = () => matchMedia("(min-width: 900px)").matches;
const EMPTY = { type: "FeatureCollection", features: [] };

// --- The map: vector tiles, so road and place names draw above our route ------------------------

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
  map.addSource("route", { type: "geojson", data: EMPTY });
  map.addSource("alts", { type: "geojson", data: EMPTY });
  map.addSource("me-acc", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "me-acc", type: "fill", source: "me-acc", paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 } }, firstLabel);
  map.addLayer({ id: "alts", type: "line", source: "alts", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#5f6f67", "line-width": 5, "line-opacity": 0.45, "line-dasharray": [0.6, 1.6] } }, firstLabel);
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": dark ? "#0f1a15" : "#ffffff", "line-width": 10, "line-opacity": 0.9 } }, firstLabel);
  map.addLayer({ id: "route-solid", type: "line", source: "route", filter: ["==", ["get", "dash"], "none"], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "colour"], "line-width": 6 } }, firstLabel);
  for (const [k, arr] of Object.entries(DASH)) map.addLayer({ id: `route-${k}`, type: "line", source: "route", filter: ["==", ["get", "dash"], k],
    layout: { "line-cap": k === "g3" ? "round" : "butt", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": 6, "line-dasharray": arr } }, firstLabel);
  // Direction of travel: white chevrons along the route.
  map.addSource("route-dir", { type: "geojson", data: EMPTY });
  map.addImage("chevron", chevron(), { pixelRatio: 2 });
  map.addLayer({ id: "route-dir", type: "symbol", source: "route-dir",
    layout: { "symbol-placement": "line", "symbol-spacing": 60, "icon-image": "chevron", "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-opacity": 0.95 } }, firstLabel);
  [...ROUTE_LAYERS, "alts"].forEach((id) => { map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer")); map.on("mouseleave", id, () => (map.getCanvas().style.cursor = "")); });
  resolve();
}));
map.on("zoomend", layoutChips);

// A chevron pointing along the line (east = forwards), drawn at 2× for sharp screens.
function chevron() {
  const s = 40, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d");
  g.lineCap = g.lineJoin = "round";
  g.beginPath(); g.moveTo(13, 9); g.lineTo(26, 20); g.lineTo(13, 31);
  g.strokeStyle = "rgba(15,26,21,.6)"; g.lineWidth = 10; g.stroke();
  g.strokeStyle = "#fff"; g.lineWidth = 5.5; g.stroke();
  return g.getImageData(0, 0, s, s);
}

const popup = (html, at, offset = 14) => new maplibregl.Popup({ closeButton: false, maxWidth: "270px", offset }).setLngLat(at).setHTML(html).addTo(map);
// One details popup at a time (markers, chips, your location).
let hoverPop = null;
function showPopup(html, at, offset) { hoverPop?.remove(); hoverPop = popup(html, at, offset); }

// Fit the map to [lat, lon] points, leaving room for the search card and the results sheet on phones.
function fitTo(points, maxZoom = 15) {
  const b = new maplibregl.LngLatBounds();
  points.forEach(([la, lo]) => b.extend([lo, la]));
  // Use where the sheet is heading, not where it is mid-slide.
  const panel = $("panel"), H = panel.offsetHeight, peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek"));
  const sheet = { peek, half: H * 0.55, full: H }[panel.dataset.state] ?? peek;
  const pad = isWide() ? { top: 40, bottom: 40, left: 40, right: 60 }
    : { top: $("top").getBoundingClientRect().bottom + 16, bottom: Math.min(sheet + 16, innerHeight * 0.6), left: 24, right: 24 };
  map.fitBounds(b, { padding: pad, maxZoom, duration: 600 });
}

// --- Markers -------------------------------------------------------------------------

let chips = [], markers = [];

// An HTML marker that shows its details on tap, and on hover with a mouse.
function addMarker(el, lat, lon, html, anchor = "center", offset = 16) {
  const m = new maplibregl.Marker({ element: el, anchor }).setLngLat([lon, lat]).addTo(map);
  if (html) {
    const show = () => showPopup(typeof html === "function" ? html() : html, [lon, lat], offset);
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
  const wipe = () => ["route", "route-dir", "alts"].forEach((id) => map.getSource(id)?.setData(EMPTY));
  if (map.getSource("route")) wipe(); else mapReady.then(wipe);
}

// --- Drawing a ride: coloured by path type, labels stay on top ---------------------
// `o` is the chosen departure option; `cafeHtml(c)` gives a café's popup.

function drawTrip(trip, o, fit, cafeHtml) {
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
  map.getSource("route-dir").setData({ type: "Feature", properties: {}, geometry: line(coords) });

  addMarker(div("pin-start"), coords[0][0], coords[0][1], `<b>Start</b><br>${esc(trip.from.name)}`);
  if (trip.ride === "ab") addMarker(div("pin-end"), coords.at(-1)[0], coords.at(-1)[1], `<b>Finish</b><br>${esc(trip.to.name)}`);
  trip.cafes.forEach((c) => addMarker(div(`pin-cafe${c.chain ? " chain" : ""}${trip.option.cafe?.name === c.name ? " stop" : ""}`, "☕"), c.lat, c.lon, () => cafeHtml(c), "center", 18));

  // Weather tags (thinned so they never overlap).
  chips = o.pts.map((p, k) => {
    const b = wxBits(p.h, p.at), h = p.h, i = p.at;
    const el = div(`wchip b${p.level}`, `${p.level ? `<b class="tg">${["", "!", "×"][p.level]}</b>` : ""}${svg(b.icon)}<span>${b.temp}°</span>${b.arrow}`);
    const tip = `<b>${k === 0 ? "Start" : k === o.pts.length - 1 ? "End" : "Mile " + miles(p.dist)} · ${clock(p.eta)} · ${VERDICT[p.level].title}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${b.temp}° · ${b.fall}<br>Wind from the ${compass(h.wind_direction_10m[i])}, ${num(h.wind_speed_10m[i])} mph, gusts ${num(h.wind_gusts_10m[i])}`;
    const marker = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -8] }).setLngLat([p.lon, p.lat]);
    el.addEventListener("click", (e) => { e.stopPropagation(); showPopup(tip, [p.lon, p.lat], 34); });
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

// --- Your location: blue dot, accuracy halo, and a cone showing which way the phone points ---------

// `me.pos` is your last known [lat, lon]; `me.note` is shown when you tap the dot.
const me = { pos: null, note: "" };
const meEl = div("me-dot", '<div class="me-cone"></div><div class="me-core"></div>');
const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: "map" });
let meShown = false;
meEl.addEventListener("click", (e) => {
  e.stopPropagation(); askCompass();
  if (me.pos) showPopup(me.note || "<b>You're here</b>", [me.pos[1], me.pos[0]], 14);
});

function showMe(lat, lon, acc) {
  me.pos = [lat, lon];
  meMarker.setLngLat([lon, lat]);
  if (!meShown) { meMarker.addTo(map); meShown = true; }
  const ring = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [Array.from({ length: 49 }, (_, i) => {
    const p = destPoint(lat, lon, (i % 48) * 7.5, Math.min(acc || 0, 2000)); return [p.lon, p.lat]; })] } };
  mapReady.then(() => map.getSource("me-acc").setData(acc > 15 ? ring : EMPTY));
}
function hideMe() {
  meMarker.remove(); meShown = false;
  mapReady.then(() => map.getSource("me-acc").setData(EMPTY));
}

// Following uses GPS, so it pauses while the page is hidden (another app, screen off) and resumes when you're back.
let meWatch = null, following = false;
function followMe() { following = true; startWatch(); }
function startWatch() {
  if (meWatch !== null || !navigator.geolocation || document.hidden) return;
  meWatch = navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    showMe(c.latitude, c.longitude, c.accuracy);
    // Moving and no compass: point the way you're travelling.
    if (meHeading === null && Number.isFinite(c.heading) && c.speed > 1) setHeading(c.heading, true);
  }, (err) => {
    // Location switched off for this site: stop following and take the dot away. Timeouts just wait for the next fix.
    if (err.code === 1) { following = false; stopWatch(); hideMe(); }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopWatch() {
  if (meWatch !== null) navigator.geolocation.clearWatch(meWatch);
  meWatch = null;
}
document.addEventListener("visibilitychange", () => (document.hidden ? stopWatch() : following && startWatch()));

// Compass, smoothed so the cone doesn't jitter, and drawn at most once a frame. Android gives it straight away; iPhones ask on a tap.
let meHeading = null, coneShown = null, pendingHeading = null;
function setHeading(deg, fromGps = false) {
  if (!fromGps) meHeading = deg;
  coneShown = coneShown === null ? deg : coneShown + ((((deg - coneShown) % 360) + 540) % 360 - 180) * 0.25;
  meEl.classList.add("has-heading");
  meMarker.setRotation((coneShown + 360) % 360);
}
function onCompass(e) {
  if (!meShown) return;
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
  const deg = e.webkitCompassHeading != null ? e.webkitCompassHeading + screenAngle : e.absolute && e.alpha != null ? 360 - e.alpha + screenAngle : null;
  if (deg === null) return;
  if (pendingHeading === null) requestAnimationFrame(() => { setHeading(pendingHeading); pendingHeading = null; });
  pendingHeading = deg;
}
// Listen from the start (Android sends readings without asking); iPhones only send them once allowed, which needs a tap.
addEventListener("deviceorientationabsolute", onCompass);
addEventListener("deviceorientation", onCompass);
let compassAsked = false;
function askCompass() {
  if (compassAsked || typeof DeviceOrientationEvent?.requestPermission !== "function") return;
  DeviceOrientationEvent.requestPermission().then((r) => { compassAsked = r === "granted"; }).catch(() => {});
}
// Already allowed on an earlier visit? Show the dot straight away.
navigator.permissions?.query({ name: "geolocation" }).then((s) => { if (s.state === "granted") followMe(); }).catch(() => {});

export { map, mapReady, ROUTE_LAYERS, isWide, popup, showPopup, fitTo, addMarker, div, clearMap, drawTrip, me, showMe, followMe, askCompass };
