// Safe2Ride "Plan a route" tab. Uses helpers from app.js and route.js.

const routeEl = $("route-result"), planBtn = $("plan"), fromIn = $("from"), toIn = $("to");
const LEADS = {
  here: "We check the last few hours, right now and the next 12 for ice, rain, wind and fog, then give you a straight answer.",
  route: "Tell us where you're heading. We check the weather along the way, at the time you'll reach each part of the ride.",
};
const HAZARD_WORD = { storm: "Storms", snow: "Snow", ice: "Ice", wind: "Wind", crosswind: "Wind", headwind: "Headwind",
  rain: "Rain", soak: "Rain", wet: "Wet roads", fog: "Fog", heat: "Heat", dark: "Dark" };
let fromSel = null, toSel = null;          // chosen places; fromSel null = my location
let trip = null, chosen = 0;              // last plan and selected departure option
let routeMap = null, routeLayer = null, chipLayer = null, pickMap = null, pickMarker = null, myPos = null;

// --- Tabs -------------------------------------------------------------------

function showTab(name) {
  const route = name === "route";
  $("tab-here").setAttribute("aria-pressed", !route);
  $("tab-route").setAttribute("aria-pressed", route);
  $("lead").textContent = LEADS[name];
  btn.hidden = route;
  $("route-form").hidden = !route;
  resultEl.hidden = route || !lastData;
  routeEl.hidden = !route || !trip;
  $("intro").hidden = route ? !!trip : !!lastData;
  setCompact(route ? !!trip : !!lastData);
  setStatus("");
  if (route && routeMap) setTimeout(() => routeMap.invalidateSize(), 50);
}
$("tab-here").addEventListener("click", () => { showTab("here"); if (lastData) render(); });
$("tab-route").addEventListener("click", () => showTab("route"));

// Bike and car routes differ, so re-plan when the vehicle changes.
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
  if (trip && !routeEl.hidden) plan();
}));

// --- Saved and recent places --------------------------------------------------

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

// --- Place search with suggestions ----------------------------------------

function autocomplete(input, list, onPick) {
  let timer = null, ctrl = null, items = [], active = -1;
  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
  const highlight = (i) => { active = i; [...list.children].forEach((li, k) => li.setAttribute("aria-selected", k === i)); };
  const pick = (i) => { const p = items[i]; if (!p) return; input.value = p.label; onPick(p); close(); };
  const show = (list_) => {
    items = list_;
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
  // Saved and recent places as soon as the field is tapped.
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

const fromAc = autocomplete(fromIn, $("from-sug"), (p) => { fromSel = p; });
const toAc = autocomplete(toIn, $("to-sug"), (p) => { toSel = p; if (p) plan(); });
toIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.defaultPrevented) plan(); });
$("use-loc").addEventListener("click", () => { fromSel = null; fromIn.value = ""; fromIn.placeholder = "From: my location"; });
$("swap").addEventListener("click", () => {
  const me = myPos ? { lat: myPos[0], lon: myPos[1], name: "Your location", label: "Your location" } : null;
  const a = fromSel || me, b = toSel;
  if (!a) return setStatus("Type a starting point (or plan once from your location) before swapping.");
  fromSel = b; toSel = a;
  fromIn.value = b ? b.label : ""; toIn.value = a.label;
  if (b && a) plan();
});

function here() { return fromSel ? [fromSel.lat, fromSel.lon] : lastCoords || myPos || null; }

// --- Pick destination on the map -------------------------------------------

$("pick").addEventListener("click", () => {
  const wrap = $("pick-wrap");
  wrap.hidden = !wrap.hidden;
  if (wrap.hidden || !window.L) return;
  if (!pickMap) {
    pickMap = L.map("pick-map", { zoomControl: true, attributionControl: false }).setView(here() || UK_CENTRE, here() ? 11 : 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickMap);
    pickMap.on("click", async (e) => {
      const { lat, lng } = e.latlng;
      if (pickMarker) pickMarker.setLatLng(e.latlng);
      else pickMarker = L.marker(e.latlng, { icon: L.divIcon({ className: "", html: '<div class="pin-end"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(pickMap);
      toSel = { lat, lon: lng, name: "Dropped pin", label: "Dropped pin" };
      toIn.value = "Dropped pin";
      const name = await fetchPlace(lat, lng);
      if (name && toSel?.lat === lat) { toSel.name = toSel.label = name; toIn.value = name; }
    });
  } else setTimeout(() => pickMap.invalidateSize(), 50);
});

// --- Planning -----------------------------------------------------------------

planBtn.addEventListener("click", plan);

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject(new Error(`Location only works over a secure connection. Try https://${location.host}${location.pathname}`));
    if (!navigator.geolocation) return reject(new Error("Your browser can't share its location. Type a starting point instead."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, name: "Your location", label: "Your location" }),
      (err) => reject(new Error(err.code === 1 ? deniedHelp() + " Or type a starting point." : "Couldn't get your location. Type a starting point instead.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });
}

// Typed text without a picked suggestion: use it only if it's unambiguous, otherwise ask.
async function resolvePlace(input, sel, ac) {
  if (sel) return sel;
  const q = input.value.trim();
  if (!q) return null;
  const found = await searchPlaces(q, here());
  if (!found.length) throw new Error(`Couldn't find "${q}". Try a town or postcode.`);
  const exact = found.filter((p) => p.name.toLowerCase() === q.toLowerCase() || p.label.toLowerCase() === q.toLowerCase());
  if (found.length === 1 || exact.length === 1) { const p = exact[0] || found[0]; input.value = p.label; return p; }
  input.focus();
  ac.show(found);
  throw new Error(`Which "${q}" did you mean? Pick one from the list.`);
}

let planning = false;
async function plan() {
  if (planning) return;
  if (!toIn.value.trim() && !toSel) { toIn.focus(); return setStatus("Where are you heading? Type a destination or pick one on the map."); }
  planning = true;
  setBusy(planBtn, true, "Finding the way…");
  setStatus("");
  try {
    const mode = currentMode();
    const from = fromSel || (fromIn.value.trim() ? (fromSel = await resolvePlace(fromIn, null, fromAc)) : await getPosition());
    if (!fromSel) myPos = [from.lat, from.lon];
    const to = toSel = await resolvePlace(toIn, toSel, toAc);
    const route = await fetchRoute(from, to, mode).catch((e) => {
      throw new Error(e.message === "noroute" ? "Couldn't find a route between those places. Try somewhere nearer or a different spelling." : "The route service isn't responding. Please try again in a moment.");
    });
    if (route.distance < 300) throw new Error("Your start and destination are too close together to plan a ride.");
    if (route.duration > 24 * 3600) throw new Error("That route is over 24 hours long. Try planning it in stages.");
    setBusy(planBtn, true, "Reading the sky…");
    const cps = makeCheckpoints(route);
    const [wx, elev] = await Promise.all([fetchRouteWeather(cps, forecastHoursFor(route)), fetchElevation(route).catch(() => null)]);
    const p = planDepartures(cps, wx, mode, Math.floor(Date.now() / 1000));
    if (!p.options.length) throw new Error("That ride is longer than the forecast covers. Try a shorter route.");
    const first = !trip;
    trip = { ...p, route, cps, mode, from, to, elev };
    chosen = 0;
    remember(fromSel); remember(to);
    shareState(from, to, mode);
    $("intro").hidden = true;
    $("pick-wrap").hidden = true;
    renderRoute(first, true);
    setTimeout(() => routeEl.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  } catch (e) {
    setStatus(e.message && !/^(weather|route|search|elevation) \d/.test(e.message) ? e.message : "Something went wrong fetching the route or weather. Please try again.");
  } finally {
    planning = false;
    setBusy(planBtn, false, trip ? "Update route" : "Check my route");
  }
}

function setBusy(b, on, text) {
  b.disabled = on;
  b.classList.toggle("loading", on);
  b.querySelector(".btn-text").textContent = text;
}

// --- Sharing: the route lives in the link (your own location is never put in it) ---

function shareState(from, to, mode) {
  const pt = (p) => [+p.lat.toFixed(4), +p.lon.toFixed(4), p.name];
  const st = { t: pt(to), m: mode, ...(fromSel ? { f: pt(from) } : {}) };
  history.replaceState(null, "", "#r=" + encodeURIComponent(JSON.stringify(st)));
}

async function shareRoute() {
  const url = location.href, title = `Safe2Ride: ${trip.from.name} → ${trip.to.name}`;
  try {
    if (navigator.share) return await navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    setStatus("Link copied. Anyone who opens it sees this route with the latest weather.");
  } catch (e) {
    if (e.name !== "AbortError") setStatus(`Copy this link to share the route: ${url}`);
  }
}

function saveAs(which) {
  const s = places();
  s[which] = slim(trip.to);
  store.set("places", s);
  setStatus(`Saved ${trip.to.name} as ${which === "home" ? "Home" : "Work"}. It'll appear when you tap the From or To box.`);
}

// Open a shared link straight into the route.
(function openShared() {
  const m = /#r=(.+)$/.exec(location.hash);
  if (!m) return;
  try {
    const st = JSON.parse(decodeURIComponent(m[1]));
    const place = ([lat, lon, name]) => ({ lat, lon, name, label: name });
    toSel = place(st.t); toIn.value = toSel.label;
    if (st.f) { fromSel = place(st.f); fromIn.value = fromSel.label; }
    if (st.m === "motorbike") { $("m-moto").checked = true; seg.dataset.mode = "motorbike"; }
    showTab("route");
    plan();
  } catch { /* a broken link just opens the normal page */ }
})();

// --- Rendering ----------------------------------------------------------------

function renderRoute(first, fit) {
  const o = trip.options[chosen], best = trip.options[trip.best], now = trip.options[0];
  const who = trip.mode === "bicycle" ? "cycle" : "ride";
  const V = VERDICT[o.level];
  const when = chosen === 0 ? "now" : `at ${clock(o.dep)}`;
  const text = [`Conditions look fine to ${who} this route if you leave ${when}.`, `You can ${who} it if you leave ${when}, but parts need extra care.`,
    `We'd advise against riding this route if you leave ${when}.`][o.level];
  const anim = (i) => (first ? `reveal" style="--i:${i}` : "swap");
  const hazard = (d) => (d.level ? HAZARD_WORD[d.reasons.find((r) => r.level === d.level)?.kind] || VERDICT[d.level].title : "Clear");

  let bestLine;
  if (trip.best === 0) bestLine = `<b>Leaving now is your best option</b><small>${VERDICT[now.level].title} · arrive ${clock(now.arrive)}</small>`;
  else bestLine = `<b>Best time to leave: ${clock(best.dep)}</b><small>${VERDICT[best.level].title} · arrive ${clock(best.arrive)}${now.level > best.level ? ` · leaving now: ${VERDICT[now.level].title.toLowerCase()}` : ""}</small>`;

  $("rr-top").innerHTML = `
    <div class="card verdict ${V.cls} ${anim(0)}">${badge(o.level)}
      <div><h2>${V.title}</h2><p>${text}</p>
        <p class="summary">${esc(o.summary)}</p>
        <div class="trip"><span>${esc(trip.from.name)} → ${esc(trip.to.name)}</span><span>${miles(trip.route.distance)} mi</span><span>${duration(trip.route.duration)}</span><span>Leave ${clock(o.dep)} · arrive ${clock(o.arrive)}</span></div>
        <small class="disc">Guidance only: use your own judgement on the road.</small>
        <div class="links"><button type="button" class="linkbtn" id="share">Share route</button>
          <button type="button" class="linkbtn" data-save="home">Save ${esc(trip.to.name)} as Home</button><button type="button" class="linkbtn" data-save="work">Save as Work</button></div>
      </div></div>
    <div class="card ${anim(1)}"><h2 class="ch">When to leave</h2>
      <div class="best"><span class="ico">${svg("clock")}</span><span>${bestLine}</span></div>
      <div class="deps" role="group" aria-label="Departure times">${trip.options.map((d, i) => {
        const mid = d.pts[Math.floor(d.pts.length / 2)];
        return `<button class="dep" aria-pressed="${i === chosen}" data-i="${i}" title="${VERDICT[d.level].title}: leave ${clock(d.dep)}, arrive ${clock(d.arrive)}">
          ${i === trip.best ? '<span class="star">Best</span>' : ""}<span class="t">${i === 0 ? "Now" : clock(d.dep)}</span>
          ${svg(wxBits(mid.h, mid.at).icon)}${lvPill(d.level)}<span class="hz">${hazard(d)}</span></button>`;
      }).join("")}</div>
      ${legend()}
    </div>`;
  $("rr-top").querySelectorAll(".dep").forEach((b) => b.addEventListener("click", () => { chosen = +b.dataset.i; renderRoute(false, false); }));
  $("share").addEventListener("click", shareRoute);
  $("rr-top").querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveAs(b.dataset.save)));

  const rows = o.pts.map((p, k) => {
    const g = o.segs[Math.min(k, o.segs.length - 1)], h = p.h, i = p.at, b = wxBits(h, i);
    const wind = g.head >= 6 ? "headwind" : g.head <= -6 ? "tailwind" : h.wind_speed_10m[i] >= 8 ? "crosswind" : "light wind";
    const label = k === 0 ? `Start · ${esc(trip.from.name)}` : k === o.pts.length - 1 ? `Arrive · ${esc(trip.to.name)}` : `Mile ${miles(p.dist)}`;
    return `<li>${lvPill(p.level)}<span><b>${clock(p.eta)}</b><small>${k === 0 || k === o.pts.length - 1 ? miles(p.dist) + " mi" : ""}</small></span>
      ${svg(b.icon)}
      <span><b>${label}</b><span class="wx"><span>${b.temp}°</span><span>${b.fall}</span>
        <span>${b.arrow}<span class="w">&nbsp;gusts ${Math.round(h.wind_gusts_10m[i])}</span></span><span class="w">${wind}</span></span></span></li>`;
  }).join("");
  const list = `<ul class="cps">${rows}</ul>`;

  $("rr-bottom").innerHTML = `
    <div class="card ${anim(3)}"><h2 class="ch">Risk scores · along the route <a href="#how">How we score</a></h2>${scoreTiles(o.scores)}</div>
    <div class="card ${anim(4)}"><h2 class="ch">Why</h2>${reasonList(o.reasons, "No weather hazards found along the route.")}</div>
    <div class="card quiet ${anim(5)}"><h2 class="ch">Along the way</h2>${o.pts.length > 10
      ? `<details><summary class="linkbtn" style="display:inline-block">Show all ${o.pts.length} points</summary>${list}</details>` : list}</div>`;

  routeEl.hidden = false;
  setCompact(true);
  drawRoute(o, fit);
  drawProfile(o);
  countUp(routeEl);
}

// Weather tags on the map, thinned so they never overlap. Hazards and the ends win space first.
let chips = [];
function layoutChips() {
  if (!routeMap || !chipLayer) return;
  chipLayer.clearLayers();
  const placed = [];
  const order = chips.map((c, k) => ({ ...c, k })).sort((a, b) => b.level - a.level || b.end - a.end || a.k - b.k);
  for (const c of order) {
    const pt = routeMap.latLngToLayerPoint(c.ll);
    if (placed.some((q) => Math.abs(q.x - pt.x) < 104 && Math.abs(q.y - pt.y) < 34)) continue;
    placed.push(pt);
    c.marker.addTo(chipLayer);
  }
}

const LINE_DASH = [null, "10 8", "1 9"];   // take care = dashed, not advised = dotted

function drawRoute(o, fit) {
  if (!window.L) return;
  if (!routeMap) {
    routeMap = L.map("route-map", { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(routeMap);
    chipLayer = L.layerGroup().addTo(routeMap);
    routeMap.on("zoomend", layoutChips);
  }
  routeMap.invalidateSize();
  if (routeLayer) routeLayer.remove();
  routeLayer = L.layerGroup().addTo(routeMap);
  const colour = levelColours();
  const { coords } = trip.route;

  L.polyline(coords, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(routeLayer);
  o.segs.forEach((g) => {
    const line = [[g.from.lat, g.from.lon], ...coords.slice(g.from.gi + 1, g.to.gi + 1), [g.to.lat, g.to.lon]];
    L.polyline(line, { color: colour[g.level], weight: g.level === 2 ? 7 : 5, opacity: 0.95, lineCap: "round", dashArray: LINE_DASH[g.level] }).addTo(routeLayer);
  });
  const tip = (p, k) => {
    const h = p.h, i = p.at, b = wxBits(h, i);
    return `<b>${k === 0 ? "Start" : k === o.pts.length - 1 ? "Arrive" : "Mile " + miles(p.dist)} · ${clock(p.eta)} · ${VERDICT[p.level].title}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${b.temp}° · ${b.fall}<br>Wind from the ${compass(h.wind_direction_10m[i])}, ${Math.round(h.wind_speed_10m[i])} mph, gusts ${Math.round(h.wind_gusts_10m[i])}`;
  };
  const tappable = (m) => m.on("click", () => m.toggleTooltip());   // tooltips also open on tap, not just hover
  o.pts.slice(1, -1).forEach((p, k) => {
    tappable(L.circleMarker([p.lat, p.lon], { radius: 5, color: "#fff", weight: 2, fillColor: colour[p.level], fillOpacity: 1 })
      .bindTooltip(tip(p, k + 1))).addTo(routeLayer);
  });
  const pin = (cls, ll, title) => L.marker(ll, { title, icon: L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(routeLayer);
  pin("pin-start", coords[0], trip.from.name);
  pin("pin-end", coords[coords.length - 1], trip.to.name);
  if (fit) routeMap.fitBounds(L.latLngBounds(coords), { padding: [44, 24] });

  chips = o.pts.map((p, k) => {
    const b = wxBits(p.h, p.at);
    const marker = tappable(L.marker([p.lat, p.lon], { keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
      html: `<div class="wchip b${p.level}">${p.level ? `<b class="tg">${["", "!", "×"][p.level]}</b>` : ""}${svg(b.icon)}<span>${b.temp}°</span>${b.arrow}</div>` }) })
      .bindTooltip(tip(p, k), { direction: "top", offset: [0, -30] }));
    return { marker, ll: L.latLng(p.lat, p.lon), level: p.level, end: k === 0 || k === o.pts.length - 1 ? 1 : 0 };
  });
  layoutChips();
}

function levelColours() {
  const css = getComputedStyle(document.documentElement);
  return ["--go", "--care", "--stop"].map((v) => css.getPropertyValue(v).trim());
}

// Hills: height along the route, the line coloured (and dashed) like the map for the chosen departure.
function drawProfile(o) {
  const el = $("profile"), e = trip.elev;
  if (!e || !e.z?.length) { el.hidden = true; return; }
  const W = 600, H = 90, total = trip.route.distance;
  const lo = Math.min(...e.z), hi = Math.max(...e.z), span = Math.max(30, hi - lo);
  const x = (d) => (d / total * W).toFixed(1), y = (z) => (H - 6 - (z - lo) / span * (H - 14)).toFixed(1);
  const pts = e.d.map((d, i) => `${x(d)},${y(e.z[i])}`);
  const colour = levelColours();
  const lines = o.segs.map((g) => {
    const idx = e.d.map((d, i) => i).filter((i) => e.d[i] >= g.from.dist - 1 && e.d[i] <= g.to.dist + 1);
    if (idx.length < 2) return "";
    return `<polyline points="${idx.map((i) => `${x(e.d[i])},${y(e.z[i])}`).join(" ")}" fill="none" stroke="${colour[g.level]}" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"${LINE_DASH[g.level] ? ` stroke-dasharray="${LINE_DASH[g.level]}"` : ""}/>`;
  }).join("");
  const st = climbStats(e.z);
  const hilly = trip.mode === "bicycle" && st.up / (total / MILE) > 25;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hills along the route: ${st.up} metres of climbing, from ${st.min} to ${st.max} metres high.">
      <polygon class="area" points="0,${H} ${pts.join(" ")} ${W},${H}"/>${lines}</svg>
    <div class="stats-line"><span>↗ ${st.up} m climbing</span><span>↘ ${st.down} m descending</span><span>${st.min}–${st.max} m high</span>${hilly ? "<span>Hilly: allow extra time</span>" : ""}</div>`;
  el.hidden = false;
}
