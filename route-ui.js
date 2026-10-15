// Safe2Ride "Plan a route" tab. Uses helpers from the main page script and route.js.

const routeEl = $("route-result"), planBtn = $("plan"), fromIn = $("from"), toIn = $("to");
const LEADS = {
  here: "We check the last few hours, right now and the next 12 for ice, rain, wind and fog, then give you a straight answer.",
  route: "Tell us where you're heading. We check the weather along the way, at the time you'll reach each part of the ride.",
};
let fromSel = null, toSel = null;          // chosen places; fromSel null = my location
let trip = null, chosen = 0;              // last plan and selected departure option
let routeMap = null, routeLayer = null, pickMap = null, pickMarker = null;

// --- Tabs -------------------------------------------------------------------

function showTab(name) {
  const route = name === "route";
  $("tab-here").setAttribute("aria-selected", !route);
  $("tab-route").setAttribute("aria-selected", route);
  $("lead").textContent = LEADS[name];
  btn.hidden = route;
  $("route-form").hidden = !route;
  resultEl.hidden = route || !lastData;
  routeEl.hidden = !route || !trip;
  $("intro").hidden = route ? !!trip : !!lastData;
  setStatus("");
  if (route && routeMap) setTimeout(() => routeMap.invalidateSize(), 50);
}
$("tab-here").addEventListener("click", () => { showTab("here"); if (lastData) render(); });
$("tab-route").addEventListener("click", () => showTab("route"));

// Bike and car routes differ, so re-plan when the vehicle changes.
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
  if (trip && !routeEl.hidden) plan();
}));

// --- Place search with suggestions ----------------------------------------

function autocomplete(input, list, onPick) {
  let timer = null, ctrl = null, items = [], active = -1;
  const close = () => { list.hidden = true; active = -1; input.setAttribute("aria-expanded", "false"); };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute("aria-selected", k === i));
  };
  const pick = (i) => { const p = items[i]; if (!p) return; input.value = p.label; onPick(p); close(); };

  input.addEventListener("input", () => {
    onPick(null);
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      ctrl?.abort(); ctrl = new AbortController();
      try {
        items = await searchPlaces(q, here(), ctrl.signal);
        list.innerHTML = items.map((p, i) => `<li role="option" id="${list.id}-${i}"><span>${esc(p.name)}</span>${p.area ? `<small>${esc(p.area)}</small>` : ""}</li>`).join("")
          || `<li aria-disabled="true"><small>No places found</small></li>`;
        [...list.children].forEach((li, i) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); }));
        list.hidden = false; input.setAttribute("aria-expanded", "true"); highlight(-1);
      } catch (e) { if (e.name !== "AbortError") close(); }
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active < 0 ? 0 : active); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

autocomplete(fromIn, $("from-sug"), (p) => { fromSel = p; });
autocomplete(toIn, $("to-sug"), (p) => { toSel = p; if (p) plan(); });
toIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.defaultPrevented) plan(); });
$("use-loc").addEventListener("click", () => { fromSel = null; fromIn.value = ""; fromIn.placeholder = "From: my location"; });

function here() { return fromSel ? [fromSel.lat, fromSel.lon] : lastCoords || myPos || null; }
let myPos = null;

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

// Use the typed text even if no suggestion was picked.
async function resolvePlace(input, sel) {
  if (sel) return sel;
  const q = input.value.trim();
  if (!q) return null;
  const [top] = await searchPlaces(q, here());
  if (!top) throw new Error(`Couldn't find "${q}". Try a town or postcode.`);
  input.value = top.label;
  return top;
}

let planning = false;
async function plan() {
  if (planning) return;
  if (!toIn.value.trim() && !toSel) { toIn.focus(); return setStatus("Where are you heading? Type a destination or pick one on the map."); }
  planning = true;
  setBusy(planBtn, true, "Finding the way…");
  setStatus("");
  try {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const from = fromSel || (fromIn.value.trim() ? (fromSel = await resolvePlace(fromIn, null)) : await getPosition());
    if (!fromSel) myPos = [from.lat, from.lon];
    const to = toSel = await resolvePlace(toIn, toSel);
    const route = await fetchRoute(from, to, mode).catch((e) => {
      throw new Error(e.message === "noroute" ? "Couldn't find a route between those places. Try somewhere nearer or a different spelling." : "The route service isn't responding. Please try again in a moment.");
    });
    if (route.distance < 300) throw new Error("Your start and destination are too close together to plan a ride.");
    if (route.duration > 24 * 3600) throw new Error("That route is over 24 hours long. Try planning it in stages.");
    setBusy(planBtn, true, "Reading the sky…");
    const cps = makeCheckpoints(route);
    const wx = await fetchRouteWeather(cps, forecastHoursFor(route));
    const p = planDepartures(cps, wx, mode, Math.floor(Date.now() / 1000));
    if (!p.options.length) throw new Error("That ride is longer than the forecast covers. Try a shorter route.");
    const first = !trip;
    trip = { ...p, route, cps, mode, from, to };
    chosen = 0;
    $("intro").hidden = true;
    $("pick-wrap").hidden = true;
    renderRoute(first, true);
    setTimeout(() => routeEl.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  } catch (e) {
    setStatus(e.message && !/^(weather|route|search) \d/.test(e.message) ? e.message : "Something went wrong fetching the route or weather. Please try again.");
  } finally {
    planning = false;
    setBusy(planBtn, false, "Check again");
  }
}

function setBusy(b, on, text) {
  b.disabled = on;
  b.classList.toggle("loading", on);
  b.querySelector(".btn-text").textContent = text;
}

// --- Rendering ----------------------------------------------------------------

function renderRoute(first, fit) {
  const o = trip.options[chosen], best = trip.options[trip.best], now = trip.options[0];
  const who = trip.mode === "bicycle" ? "cycle" : "ride";
  const V = VERDICT[o.level];
  const when = chosen === 0 ? "now" : `at ${clock(o.dep)}`;
  const text = [`Conditions look fine to ${who} this route if you leave ${when}.`, `You can ${who} it if you leave ${when}, but parts need extra care.`,
    `We'd advise against riding this route if you leave ${when}.`][o.level];
  const anim = (i) => (first ? `reveal" style="--i:${i}` : "swap");

  let bestLine;
  if (trip.best === 0) bestLine = `<b>Leaving now is your best option</b><small>${VERDICT[now.level].title} · arrive ${clock(now.arrive)}</small>`;
  else bestLine = `<b>Best time to leave: ${clock(best.dep)}</b><small>${VERDICT[best.level].title} · arrive ${clock(best.arrive)}${now.level > best.level ? ` · leaving now: ${VERDICT[now.level].title.toLowerCase()}` : ""}</small>`;

  $("rr-top").innerHTML = `
    <div class="card verdict ${V.cls} ${anim(0)}">${badge(o.level)}
      <div><h2>${V.title}</h2><p>${text}</p>
        <div class="trip"><span>${esc(trip.from.name)} → ${esc(trip.to.name)}</span><span>${miles(trip.route.distance)} mi</span><span>${duration(trip.route.duration)}</span><span>Leave ${clock(o.dep)} · arrive ${clock(o.arrive)}</span></div>
      </div></div>
    <div class="card ${anim(1)}"><h3>When to leave</h3>
      <div class="best"><span class="ico">${svg("clock")}</span><span>${bestLine}</span></div>
      <div class="deps" role="group" aria-label="Departure times">${trip.options.map((d, i) => {
        const mid = d.pts[Math.floor(d.pts.length / 2)];
        return `<button class="dep" aria-pressed="${i === chosen}" data-i="${i}" title="${VERDICT[d.level].title}: leave ${clock(d.dep)}, arrive ${clock(d.arrive)}">
          ${i === trip.best ? '<span class="star">Best</span>' : ""}<span class="t">${i === 0 ? "Now" : clock(d.dep)}</span>
          ${svg(weatherIcon(mid.h.weather_code[mid.at], mid.h.is_day[mid.at]))}<span class="bar lv${d.level}"></span></button>`;
      }).join("")}</div>
      <div class="legend"><span style="--c:var(--go)">Good</span><span style="--c:var(--care)">Take care</span><span style="--c:var(--stop)">Not advised</span></div>
    </div>`;
  $("rr-top").querySelectorAll(".dep").forEach((b) => b.addEventListener("click", () => { chosen = +b.dataset.i; renderRoute(false, false); }));

  $("rr-bottom").innerHTML = `
    <div class="card ${anim(3)}"><h3>Risk scores · along the route</h3>${scoreTiles(o.scores)}</div>
    <div class="card ${anim(4)}"><h3>Why</h3>${reasonList(o.reasons, "No weather hazards found along the route.")}</div>
    <div class="card ${anim(5)}"><h3>Along the way</h3><ul class="cps">${o.pts.map((p, k) => {
      const g = o.segs[Math.min(k, o.segs.length - 1)], h = p.h, i = p.at, b = wxBits(h, i);
      const wind = g.head >= 6 ? "headwind" : g.head <= -6 ? "tailwind" : h.wind_speed_10m[i] >= 8 ? "crosswind" : "light wind";
      const label = k === 0 ? `Start · ${esc(trip.from.name)}` : k === o.pts.length - 1 ? `Arrive · ${esc(trip.to.name)}` : `Mile ${miles(p.dist)}`;
      return `<li><span class="d lv${p.level}"></span><span><b>${clock(p.eta)}</b><small>${k === 0 || k === o.pts.length - 1 ? miles(p.dist) + " mi" : ""}</small></span>
        ${svg(b.icon)}
        <span><b>${label}</b><span class="wx"><span>${b.temp}°</span><span>${b.fall}</span>
          <span>${b.arrow}<span class="w">&nbsp;gusts ${Math.round(h.wind_gusts_10m[i])}</span></span><span class="w">${wind}</span></span></span></li>`;
    }).join("")}</ul></div>`;

  routeEl.hidden = false;
  drawRoute(o, fit);
  countUp(routeEl);
}

// Compact weather for one point: icon (rain/sleet/snow aware), temperature, wind arrow.
function wxBits(h, i) {
  const kind = precipType(h, i), code = h.weather_code[i];
  const icon = kind === "freezing" ? "sleet" : kind || (code >= 51 && code < 95 ? "cloud" : weatherIcon(code, h.is_day[i]));
  const mm = h.precipitation[i];
  const fall = { rain: `${mm.toFixed(1)} mm rain`, sleet: `sleet ${mm.toFixed(1)} mm`, snow: `snow ${h.snowfall[i].toFixed(1)} cm`, freezing: "freezing rain" }[kind] || "dry";
  const ws = h.wind_speed_10m[i], dir = h.wind_direction_10m[i];
  const arrow = `<span class="wa w${ws < 10 ? 0 : ws < 20 ? 1 : ws < 30 ? 2 : 3}" style="--r:${(dir + 180) % 360}deg" title="Wind from the ${compass(dir)}, ${Math.round(ws)} mph">${svg("arrow")}<i>${Math.round(ws)}</i></span>`;
  return { icon, fall, arrow, temp: Math.round(h.temperature_2m[i]) };
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
    if (placed.some((q) => Math.abs(q.x - pt.x) < 96 && Math.abs(q.y - pt.y) < 32)) continue;
    placed.push(pt);
    c.marker.addTo(chipLayer);
  }
}
let chipLayer = null;

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
  const css = getComputedStyle(document.documentElement);
  const colour = ["--go", "--care", "--stop"].map((v) => css.getPropertyValue(v).trim());
  const { coords } = trip.route;

  L.polyline(coords, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(routeLayer);
  o.segs.forEach((g) => {
    const line = [[g.from.lat, g.from.lon], ...coords.slice(g.from.gi + 1, g.to.gi + 1), [g.to.lat, g.to.lon]];
    L.polyline(line, { color: colour[g.level], weight: 5, opacity: 0.95, lineCap: "round" }).addTo(routeLayer);
  });
  o.pts.slice(1, -1).forEach((p) => {
    const h = p.h, i = p.at;
    L.circleMarker([p.lat, p.lon], { radius: 5, color: "#fff", weight: 2, fillColor: colour[p.level], fillOpacity: 1 })
      .bindTooltip(`<b>Mile ${miles(p.dist)} · ${clock(p.eta)}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${Math.round(h.temperature_2m[i])}°<br>Rain ${h.precipitation[i].toFixed(1)} mm · gusts ${Math.round(h.wind_gusts_10m[i])} mph`)
      .addTo(routeLayer);
  });
  const pin = (cls, ll, title) => L.marker(ll, { title, icon: L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(routeLayer);
  pin("pin-start", coords[0], trip.from.name);
  pin("pin-end", coords[coords.length - 1], trip.to.name);
  if (fit) routeMap.fitBounds(L.latLngBounds(coords), { padding: [40, 24] });

  chips = o.pts.map((p, k) => {
    const h = p.h, i = p.at, b = wxBits(h, i);
    const marker = L.marker([p.lat, p.lon], { keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
      html: `<div class="wchip b${p.level}">${svg(b.icon)}<span>${b.temp}°</span>${b.arrow}</div>` }) })
      .bindTooltip(`<b>${k === 0 ? "Start" : k === o.pts.length - 1 ? "Arrive" : "Mile " + miles(p.dist)} · ${clock(p.eta)}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${b.temp}° · ${b.fall}<br>Wind from the ${compass(h.wind_direction_10m[i])}, ${Math.round(h.wind_speed_10m[i])} mph, gusts ${Math.round(h.wind_gusts_10m[i])}`, { direction: "top", offset: [0, -30] });
    return { marker, ll: L.latLng(p.lat, p.lon), level: p.level, end: k === 0 || k === o.pts.length - 1 ? 1 : 0 };
  });
  layoutChips();
}
