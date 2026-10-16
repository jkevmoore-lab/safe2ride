// Safe2Ride map-first interface: map, search card, filters, results panel. Uses app.js, route.js and loop.js.

const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const BIKE_NAME = { road: "road bike", gravel: "gravel bike", mtb: "mountain bike", motorbike: "motorbike" };
const HAZARD_WORD = { storm: "Storms", snow: "Snow", ice: "Ice", wind: "Wind", crosswind: "Wind", headwind: "Headwind",
  rain: "Rain", soak: "Rain", wet: "Wet roads", fog: "Fog", heat: "Heat", dark: "Dark" };
const ISSUE_NAME = { busy: "busy road", g1: "smooth track (Grade 1)", g2: "rough track (Grade 2)", g3: "MTB-only track (Grade 3)", unknown: "path with unknown surface" };
const isWide = () => matchMedia("(min-width: 900px)").matches;

const panel = $("panel"), body = $("panel-body"), planBtn = $("plan"), fromIn = $("from"), toIn = $("to");
let fromSel = null, toSel = null, myPos = null;     // fromSel null = "my location"
let trip = null, chosen = 0, chips = [];

// --- Map ---------------------------------------------------------------------------

const last = store.get("lastCentre", null);
const map = L.map("map", { zoomControl: false, attributionControl: false }).setView(last || UK_CENTRE, last ? 11 : 6);
L.tileLayer(OSM, { maxZoom: 19 }).addTo(map);
if (isWide()) L.control.zoom({ position: "topright" }).addTo(map);
const layers = Object.fromEntries(["alts", "route", "marks", "tags"].map((k) => [k, L.layerGroup().addTo(map)]));
map.on("zoomend", layoutChips);

// Fit the map to `bounds`, leaving room for the search card and the results sheet on phones.
function fitTo(bounds) {
  if (isWide()) return map.fitBounds(bounds, { padding: [40, 40] });
  const top = $("top").getBoundingClientRect().bottom, sheet = innerHeight - panel.getBoundingClientRect().top;
  map.fitBounds(bounds, { paddingTopLeft: [24, top + 16], paddingBottomRight: [24, sheet + 16] });
}

// Tap the map: ride there, start from there, or start a loop there.
map.on("click", (e) => {
  const at = { lat: e.latlng.lat, lon: e.latlng.lng, name: "Dropped pin", label: "Dropped pin" };
  const loop = prefs.ride === "loop";
  const html = `<b>${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}</b>
    ${loop ? `<button class="pop-btn" data-act="from">Start loop here</button>` : `<button class="pop-btn" data-act="to">Ride here</button><button class="pop-btn" data-act="from">Start from here</button>`}`;
  const pop = L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(html).openOn(map);
  pop.getElement().querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
    map.closePopup();
    if (b.dataset.act === "to") { toSel = at; toIn.value = at.label; } else { fromSel = at; fromIn.value = at.label; }
    const name = await fetchPlace(at.lat, at.lon);
    if (name) { at.name = at.label = name; (b.dataset.act === "to" ? toIn : fromIn).value = name; }
    if (loop || toSel) plan();
  }));
});

// --- Settings (remembered between visits) -----------------------------------------------

const prefs = { ride: "ab", bike: "road", busy: true, offroad: false, cafe: true, flat: false, miles: 25, colour: "surface", ...store.get("prefs", {}) };
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
  if (prefs.bike === "motorbike") prefs.colour = "weather";
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
    const fail = (e) => { throw new Error(e.message === "noroute" ? "Couldn't find a route there. Try somewhere nearer, or a different spelling." : e.message === "noloop" ? "Couldn't make a loop from here. Try a different length or start point." : e.message === "busy" ? "The free cycle-route service is busy. Please try again in a minute." : "The route service isn't responding. Please try again in a moment."); };
    if (prefs.ride === "ab") {
      to = toSel = await resolvePlace(toIn, toSel, toAc);
      const route = bike === "motorbike" ? await fetchRoute(from, to, "motorbike").catch(fail)
        : await fetchCycleRoute([from, to], cycleProfile(bike, opts.offroad, opts.avoidBusy)).catch(fail);
      option = { route, waypoints: [from, to] };
    } else {
      setBusy(true, "Checking the wind…");
      const h = (await fetchWeather(from.lat, from.lon)).hourly, i = PAST_HOURS;
      const loop = await planLoop(from, prefs.miles, bike, opts, { from: h.wind_direction_10m[i], speed: h.wind_speed_10m[i] }, (t) => setBusy(true, t)).catch(fail);
      option = loop.best; others = loop.others;
    }
    const ctx = { ride: prefs.ride, bike, opts, from, to, target: prefs.miles, choices: [option, ...others] };
    trip = await analyse(option, ctx, 0);
    remember(fromSel); remember(to);
    shareState();
    setStatus("");
    renderTrip(true, true);
  } catch (e) {
    setStatus(e.message && !/^(weather|route|search|elevation|cafes) ?\d*/.test(e.message) ? e.message : "Something went wrong fetching the route or weather. Please try again.", true);
  } finally {
    planning = false;
    setBusy(false);
  }
}

// Weather along a route option (adding a café first if wanted), ready to show.
async function analyse(option, ctx, k) {
  if (ctx.opts.cafe && ctx.bike !== "motorbike" && !option.cafeSearched) {
    setBusy(true, "Finding a café…");
    try { option = await addCafeStop(option, ctx.bike, ctx.opts, Math.floor(Date.now() / 1000)); }
    catch { option = { ...option, cafe: null, cafeSearched: true, cafeError: true }; }
    ctx.choices[k] = option;
  }
  const route = option.route;
  if (route.distance < 300) throw new Error("Your start and destination are too close together to plan a ride.");
  if (route.duration > 24 * 3600) throw new Error("That ride is over 24 hours long. Try planning it in stages.");
  setBusy(true, "Reading the sky…");
  const cps = makeCheckpoints(route);
  const [wx, elev] = await Promise.all([fetchRouteWeather(cps, forecastHoursFor(route)),
    route.ele ? Promise.resolve(elevFromRoute(route)) : fetchElevation(route).catch(() => null)]);
  const p = planDepartures(cps, wx, ctx.bike === "motorbike" ? "motorbike" : "bicycle", Math.floor(Date.now() / 1000));
  if (!p.options.length) throw new Error("That ride is longer than the forecast covers. Try a shorter route.");
  chosen = 0;
  return { ...ctx, ...p, option, route, cps, elev, alt: k, stats: route.cls ? surfaceStats(route, ctx.bike) : null };
}

function elevFromRoute(route) {
  const d = [], z = [], step = Math.max(1, Math.floor(route.coords.length / 150));
  for (let i = 0; i < route.coords.length; i += step) if (route.ele[i] != null) { d.push(route.cumD[i]); z.push(route.ele[i]); }
  return z.length > 1 ? { d, z } : null;
}

async function chooseAlt(k) {
  if (planning || !trip || k === trip.alt) return;
  planning = true;
  try {
    const ctx = { ...trip }, next = await analyse(ctx.choices[k], ctx, k);
    trip = next;
    setStatus("");
    renderTrip(false, true);
  } catch (e) { setStatus(e.message || "Couldn't load that loop.", true); }
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
    plan();
  } catch { /* a broken link just opens the normal page */ }
})();

// --- Rendering a ride ---------------------------------------------------------------------

function renderTrip(first, fit) {
  const o = trip.options[chosen], best = trip.options[trip.best], now = trip.options[0], cycle = trip.bike !== "motorbike";
  const who = cycle ? "cycle" : "ride";
  const when = chosen === 0 ? "now" : `at ${clock(o.dep)}`;
  const text = [`Weather looks fine to ${who} this ride if you leave ${when}.`, `You can ${who} it if you leave ${when}, but parts need extra care.`,
    `We'd advise against this ride if you leave ${when}.`][o.level];
  const anim = (i) => (first ? `reveal" style="--i:${i}` : "swap");
  const hazard = (d) => (d.level ? HAZARD_WORD[d.reasons.find((r) => r.level === d.level)?.kind] || VERDICT[d.level].title : "Clear");
  const fromName = trip.from.name === "Your location" ? "your location" : trip.from.name;
  const title = trip.ride === "loop" ? `${miles(trip.route.distance)}-mile loop from ${fromName}` : `${trip.from.name} → ${trip.to.name}`;
  let k = 0;

  let bestLine;
  const backWord = trip.ride === "loop" ? "back" : "arrive";
  if (trip.best === 0) bestLine = `<b>Leaving now is your best option</b><small>${VERDICT[now.level].title} · ${backWord} ${clock(now.arrive)}</small>`;
  else bestLine = `<b>Best time to leave: ${clock(best.dep)}</b><small>${VERDICT[best.level].title} · ${trip.ride === "loop" ? "back" : "arrive"} ${clock(best.arrive)}${now.level > best.level ? ` · leaving now: ${VERDICT[now.level].title.toLowerCase()}` : ""}</small>`;

  let html = `
    <div class="card verdict ${VERDICT[o.level].cls} ${anim(k++)}">${badge(o.level)}
      <div><h2>${VERDICT[o.level].title}</h2><p>${text}</p><p class="summary">${esc(o.summary)}</p>
        <div class="trip"><span>${esc(title)}</span><span>${miles(trip.route.distance)} mi</span><span>${duration(trip.route.duration)}</span><span>Leave ${clock(o.dep)} · ${trip.ride === "loop" ? "back" : "arrive"} ${clock(o.arrive)}</span></div>
        <small class="disc">Guidance only: use your own judgement on the road.</small>
        <div class="links"><button type="button" class="linkbtn" id="share">Share ride</button>
          ${trip.to ? `<button type="button" class="linkbtn" data-save="home">Save ${esc(trip.to.name)} as Home</button><button type="button" class="linkbtn" data-save="work">Save as Work</button>` : ""}</div>
      </div></div>`;

  if (trip.stats) html += `<div class="card ${anim(k++)}">${surfaceHtml(trip.stats, o)}</div>`;
  else if (trip.elev) html += `<div class="card ${anim(k++)}"><h2 class="ch">Hills</h2>${profileHtml(o)}</div>`;

  if (cycle && trip.opts.cafe) html += `<div class="card ${anim(k++)}"><h2 class="ch">Café stop</h2>${cafeHtml(o)}</div>`;

  html += `<div class="card ${anim(k++)}"><h2 class="ch">When to leave</h2>
      <div class="best"><span class="ico">${svg("clock")}</span><span>${bestLine}</span></div>
      <div class="deps" role="group" aria-label="Departure times">${trip.options.map((d, i) => {
        const mid = d.pts[Math.floor(d.pts.length / 2)];
        return `<button class="dep" aria-pressed="${i === chosen}" data-i="${i}" title="${VERDICT[d.level].title}: leave ${clock(d.dep)}">
          ${i === trip.best ? '<span class="star">Best</span>' : ""}<span class="t">${i === 0 ? "Now" : clock(d.dep)}</span>
          ${svg(wxBits(mid.h, mid.at).icon)}${lvPill(d.level)}<span class="hz">${hazard(d)}</span></button>`;
      }).join("")}</div>${legend()}</div>`;

  if (trip.choices.length > 1) html += `<div class="card ${anim(k++)}"><h2 class="ch">Other loops</h2><ul class="alts">${trip.choices.map((c, i) => {
      const st = c.route.cls ? surfaceStats(c.route, trip.bike) : null, off = st ? Math.round(st.pct.g1 + st.pct.g2 + st.pct.g3 + st.pct.unknown) : 0;
      return `<li><button type="button" data-alt="${i}" aria-pressed="${i === trip.alt}"><b>${i === 0 ? "Best match" : `Option ${i + 1}`} · ${miles(c.route.distance)} mi</b><span>${compass(c.heading)} first</span>
        <small>${st ? `${Math.round(st.pct.busy)}% busy roads · ${off}% unpaved · ` : ""}↗ ${Math.round(c.route.climb || 0)} m climbing${i === trip.alt ? " · showing" : ""}</small></button></li>`;
    }).join("")}</ul></div>`;

  html += `<div class="card ${anim(k++)}"><h2 class="ch">Weather risk · along the route <a href="#how">How we score</a></h2>${scoreTiles(o.scores)}</div>
    <div class="card ${anim(k++)}"><h2 class="ch">Why</h2>${reasonList(o.reasons, "No weather hazards found along the route.")}</div>
    <div class="card quiet ${anim(k++)}"><h2 class="ch">Along the way</h2><details><summary class="linkbtn" style="display:inline-block">Show all ${o.pts.length} points</summary>${pointsHtml(o)}</details></div>`;

  $("intro").hidden = true;
  body.innerHTML = html;
  body.querySelectorAll(".dep").forEach((b) => b.addEventListener("click", () => { chosen = +b.dataset.i; renderTrip(false, false); }));
  body.querySelectorAll("[data-alt]").forEach((b) => b.addEventListener("click", () => chooseAlt(+b.dataset.alt)));
  body.querySelectorAll("[data-colour]").forEach((b) => b.addEventListener("click", () => { prefs.colour = b.dataset.colour; savePrefs(); renderTrip(false, false); }));
  $("share").addEventListener("click", shareRide);
  body.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveAs(b.dataset.save)));
  countUp(body);
  if (first) { setCollapsed(true, title); setSheet("half"); }
  drawTrip(o, fit);
}

function surfaceHtml(st, o) {
  const shown = SURFACES.filter((x) => st.metres[x.id] >= 50);
  const where = (d) => (d < 400 ? "near the start" : trip.route.distance - d < 400 ? "near the end" : `around mile ${miles(d)}`);
  const verb = ["", "take care on a", "not suitable for a"];
  const issues = st.issues.slice(0, 4).map((x) => `<li>${lvPill(x.level)}<span>${miles(x.len)} mi of ${ISSUE_NAME[x.cls]} ${where(x.start)}: ${verb[x.level]} ${BIKE_NAME[trip.bike]}.</span></li>`).join("");
  const unpaved = st.metres.g1 + st.metres.g2 + st.metres.g3 + st.metres.unknown;
  const p0 = o.pts[0], rain6 = p0.h.precipitation.slice(Math.max(0, p0.at - PAST_HOURS), p0.at + 1).reduce((a, b) => a + b, 0);
  const colourBy = prefs.colour === "weather" ? "weather" : "surface";
  return `<h2 class="ch">Roads and surfaces</h2>
    <div class="maptog">Colour the map by
      <span class="toggle"><button type="button" data-colour="surface" aria-pressed="${colourBy === "surface"}">Surface</button><button type="button" data-colour="weather" aria-pressed="${colourBy === "weather"}">Weather</button></span></div>
    <div class="sbar" role="img" aria-label="${shown.map((x) => `${x.name} ${Math.round(st.pct[x.id])}%`).join(", ")}">${shown.map((x) => `<i style="width:${st.pct[x.id]}%;background:${x.colour}"></i>`).join("")}</div>
    <ul class="slist">${shown.map((x) => `<li><span class="sw" style="background:${x.colour}${x.dash ? `;background-image:repeating-linear-gradient(90deg,transparent 0 6px,rgba(255,255,255,.55) 6px 9px)` : ""}"></span><span>${x.name}</span><small>${st.pct[x.id] < 1 ? "<1" : Math.round(st.pct[x.id])}% · ${miles(st.metres[x.id])} mi</small></li>`).join("")}</ul>
    ${issues ? `<ul class="issues">${issues}</ul>` : `<p class="note">${lvPill(0)} Every surface on this route suits a ${BIKE_NAME[trip.bike]}.</p>`}
    ${unpaved > 800 && rain6 >= 1 ? `<p class="note">Unpaved stretches are likely to be muddy after ${rain6.toFixed(1)} mm of rain in the last ${PAST_HOURS} hours.</p>` : ""}
    ${profileHtml(o)}`;
}

function cafeHtml(o) {
  const c = trip.option.cafe;
  if (trip.option.cafeError) return `<p class="empty">The café search isn't responding right now. Try again in a minute.</p>`;
  if (!c && trip.option.cafeRejected) return `<p class="empty">The nearest café to halfway, ${esc(trip.option.cafeRejected)}, can only be reached on surfaces that don't suit a ${BIKE_NAME[trip.bike]}, so we've left it out.</p>`;
  if (!c) return `<p class="empty">No café found within 400 m of the route near halfway${trip.ride === "loop" ? "; try a different loop length" : ""}.</p>`;
  let best = 0, bd = Infinity;
  trip.route.coords.forEach((p, i) => { const d = haversine(p, [c.lat, c.lon]); if (d < bd) { bd = d; best = i; } });
  const eta = o.dep + trip.route.cumT[best], open = openAt(c.hours, new Date(eta * 1000));
  return `<div class="cafe"><span class="ico" aria-hidden="true">☕</span><div><b>${esc(c.name)}</b>
    <small>Mile ${miles(trip.route.cumD[best])} of ${miles(trip.route.distance)} · arrive about ${clock(eta)}</small>
    <small>${open === true ? `<span class="open-yes">Open when you arrive</span>` : open === false ? `<span style="color:var(--stop-text);font-weight:700">Closed when you arrive</span>` : `<span class="open-unknown">Opening hours not listed</span>`}${c.hours ? ` · ${esc(c.hours)}` : ""}</small></div></div>`;
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

// Hills: height along the route, the line coloured like the map.
function profileHtml(o) {
  const e = trip.elev;
  if (!e || e.z.length < 2) return "";
  const W = 600, H = 80, total = trip.route.distance;
  const lo = Math.min(...e.z), hi = Math.max(...e.z), span = Math.max(30, hi - lo);
  const x = (d) => (d / total * W).toFixed(1), y = (z) => (H - 6 - (z - lo) / span * (H - 14)).toFixed(1);
  const pts = e.d.map((d, i) => `${x(d)},${y(e.z[i])}`);
  const colour = levelColours();
  const lines = o.segs.map((g) => {
    const idx = e.d.map((_, i) => i).filter((i) => e.d[i] >= g.from.dist - 1 && e.d[i] <= g.to.dist + 1);
    if (idx.length < 2) return "";
    return `<polyline points="${idx.map((i) => `${x(e.d[i])},${y(e.z[i])}`).join(" ")}" fill="none" stroke="${colour[g.level]}" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"${LINE_DASH[g.level] ? ` stroke-dasharray="${LINE_DASH[g.level]}"` : ""}/>`;
  }).join("");
  const st = climbStats(e.z);
  return `<div class="profile"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hills: ${st.up} metres of climbing, ${st.min} to ${st.max} metres high.">
      <polygon class="area" points="0,${H} ${pts.join(" ")} ${W},${H}"/>${lines}</svg>
    <div class="stats-line"><span>↗ ${st.up} m climbing</span><span>↘ ${st.down} m descending</span><span>${st.min}–${st.max} m high</span>${trip.bike !== "motorbike" && st.up / (total / MILE) > 25 ? "<span>Hilly: allow extra time</span>" : ""}</div></div>`;
}

// --- Drawing a ride on the map -----------------------------------------------------------

function drawTrip(o, fit) {
  Object.values(layers).forEach((l) => l.clearLayers());
  const { coords } = trip.route, colour = levelColours();
  const tappable = (m) => m.on("click", (e) => { L.DomEvent.stop(e); m.toggleTooltip(); });

  // Other loops: thin grey lines you can tap to switch.
  trip.choices.forEach((c, i) => {
    if (i === trip.alt) return;
    L.polyline(c.route.coords, { color: "#5f6f67", weight: 4, opacity: 0.45, dashArray: "2 7" }).addTo(layers.alts)
      .bindTooltip(`Option ${i + 1}: ${miles(c.route.distance)} mi. Tap to show`).on("click", (e) => { L.DomEvent.stop(e); chooseAlt(i); });
  });

  L.polyline(coords, { color: "#fff", weight: 10, opacity: 0.95 }).addTo(layers.route);
  if (prefs.colour !== "weather" && trip.route.cls) {
    // Surface colours: join consecutive stretches of the same class into one line.
    let start = 0;
    for (let i = 1; i <= trip.route.cls.length; i++) {
      if (i < trip.route.cls.length && trip.route.cls[i] === trip.route.cls[start]) continue;
      const s = SURFACE[trip.route.cls[start]];
      L.polyline(coords.slice(start, i + 1), { color: s.colour, weight: 6, opacity: 0.95, lineCap: s.dash ? "butt" : "round", dashArray: s.dash })
        .bindTooltip(s.name, { sticky: true }).addTo(layers.route);
      start = i;
    }
  } else {
    o.segs.forEach((g) => {
      const line = [[g.from.lat, g.from.lon], ...coords.slice(g.from.gi + 1, g.to.gi + 1), [g.to.lat, g.to.lon]];
      L.polyline(line, { color: colour[g.level], weight: g.level === 2 ? 7 : 6, opacity: 0.95, lineCap: "round", dashArray: LINE_DASH[g.level] }).addTo(layers.route);
    });
  }

  const tip = (p, k) => {
    const h = p.h, i = p.at, b = wxBits(h, i);
    return `<b>${k === 0 ? "Start" : k === o.pts.length - 1 ? "End" : "Mile " + miles(p.dist)} · ${clock(p.eta)} · ${VERDICT[p.level].title}</b><br>${WMO[h.weather_code[i]] ?? ""}, ${b.temp}° · ${b.fall}<br>Wind from the ${compass(h.wind_direction_10m[i])}, ${Math.round(h.wind_speed_10m[i])} mph, gusts ${Math.round(h.wind_gusts_10m[i])}`;
  };
  const pin = (cls, ll, title, html = "") => L.marker(ll, { title, keyboard: false, icon: L.divIcon({ className: "", html: `<div class="${cls}">${html}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(layers.marks);
  pin("pin-start", coords[0], trip.from.name);
  if (trip.ride === "ab") pin("pin-end", coords[coords.length - 1], trip.to.name);
  const c = trip.option.cafe;
  if (c) tappable(L.marker([c.lat, c.lon], { title: c.name, icon: L.divIcon({ className: "", html: '<div class="pin-cafe">☕</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) })
    .bindTooltip(`<b>${esc(c.name)}</b><br>Café stop`, { direction: "top", offset: [0, -14] })).addTo(layers.marks);

  chips = o.pts.map((p, k) => {
    const b = wxBits(p.h, p.at);
    const marker = tappable(L.marker([p.lat, p.lon], { keyboard: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
      html: `<div class="wchip b${p.level}">${p.level ? `<b class="tg">${["", "!", "×"][p.level]}</b>` : ""}${svg(b.icon)}<span>${b.temp}°</span>${b.arrow}</div>` }) })
      .bindTooltip(tip(p, k), { direction: "top", offset: [0, -30] }));
    return { marker, ll: L.latLng(p.lat, p.lon), level: p.level, end: k === 0 || k === o.pts.length - 1 ? 1 : 0 };
  });
  if (fit) fitTo(L.latLngBounds(coords));
  layoutChips();
}

// Weather tags, thinned so they never overlap. Hazards and the ends win space first.
function layoutChips() {
  layers.tags.clearLayers();
  const placed = [];
  const order = chips.map((c, k) => ({ ...c, k })).sort((a, b) => b.level - a.level || b.end - a.end || a.k - b.k);
  for (const c of order) {
    const pt = map.latLngToLayerPoint(c.ll);
    if (placed.some((q) => Math.abs(q.x - pt.x) < 104 && Math.abs(q.y - pt.y) < 34)) continue;
    placed.push(pt);
    c.marker.addTo(layers.tags);
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
    trip = null; chips = [];
    Object.values(layers).forEach((l) => l.clearLayers());
    L.marker([pos.lat, pos.lon], { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(layers.marks);
    $("intro").hidden = true;
    body.innerHTML = hereHtml(data, place, lim());
    countUp(body);
    setStatus("");
    setCollapsed(true, place ? `Riding near ${place}` : "Riding near you");
    setSheet("half");
    fitTo(L.latLng(pos.lat, pos.lon).toBounds(3000));
  } catch (e) {
    setStatus(e.message && !/^weather/.test(e.message) ? e.message : "Couldn't fetch the weather right now. Please try again in a moment.", true);
    setSheet("half");
  } finally {
    b.classList.remove("loading"); b.querySelector("span").textContent = "Safe to ride here?";
  }
});

renderHow();
