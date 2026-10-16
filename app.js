// Safe2Ride shared page helpers: icons, cards, charts, the "Safe to ride here?" check and "How we decide".

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  partly: '<path d="M8 2.5v1.5M2.5 8H4M4.1 4.1l1 1M12 4.1l-1 1"/><path d="M5.2 10.4A3.5 3.5 0 0 1 11.3 7"/><path d="M17.5 20H9a4 4 0 1 1 .9-7.9A5 5 0 0 1 19.4 13 3.5 3.5 0 0 1 17.5 20z"/>',
  cloud: '<path d="M17.5 19H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 20.5 11 4 4 0 0 1 17.5 19z"/>',
  rain: '<path d="M16.5 13H8a4 4 0 1 1 1-7.9A5 5 0 0 1 18.5 7 3 3 0 0 1 16.5 13z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
  snow: '<path d="M16.5 13H8a4 4 0 1 1 1-7.9A5 5 0 0 1 18.5 7 3 3 0 0 1 16.5 13z"/><path d="M8 17v.01M12 19v.01M16 17v.01M10 21.5v.01M14 21.5v.01" stroke-width="2.6"/>',
  fog: '<path d="M4 8h16M3 12h18M5 16h14M8 20h8"/>',
  sleet: '<path d="M16.5 13H8a4 4 0 1 1 1-7.9A5 5 0 0 1 18.5 7 3 3 0 0 1 16.5 13z"/><path d="M8 17l-1 3M16 17l-1 3"/><path d="M12 18v.01M11 21.5v.01" stroke-width="2.6"/>',
  arrow: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  storm: '<path d="M16.5 13H8a4 4 0 1 1 1-7.9A5 5 0 0 1 18.5 7 3 3 0 0 1 16.5 13z"/><path d="M13 13l-3 4.5h4L11 22"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 16h15a3 3 0 1 1-3 3M3 12h7"/>',
  temp: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ice: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  heat: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const REASON_ICON = { storm: "storm", snow: "snow", ice: "ice", wind: "wind", rain: "rain", wet: "drop", fog: "fog", heat: "heat", dark: "moon",
  soak: "rain", headwind: "wind", tailwind: "wind", crosswind: "wind" };
const VERDICT = [
  { cls: "go", title: "Good to go", mark: "M24 37l8 8 16-17" },
  { cls: "care", title: "Ride with care", mark: "M36 22v16M36 48v.5" },
  { cls: "stop", title: "Not advised", mark: "M27 27l18 18M45 27L27 45" },
];

function weatherIcon(code, isDay) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code === 3) return "cloud";
  if (code === 1 || code === 2) return isDay ? "partly" : "cloud";
  return isDay ? "sun" : "moon";
}

const $ = (id) => document.getElementById(id);

// Small per-browser memory: settings, saved and recent places. Fails quietly in private mode.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("s2r." + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("s2r." + k, JSON.stringify(v)); } catch {} },
};

function setStatus(t, error = false) { const el = $("status"); el.textContent = t; el.classList.toggle("error", error && !!t); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
const LINE_DASH = [null, "10 8", "1 9"];   // weather: take care = dashed, not advised = dotted
function levelColours() {
  const css = getComputedStyle(document.documentElement);
  return ["--go", "--care", "--stop"].map((v) => css.getPropertyValue(v).trim());
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject(new Error(`Location only works over a secure connection. Try https://${location.host}${location.pathname}`));
    if (!navigator.geolocation) return reject(new Error("Your browser can't share its location. Type a starting point instead."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, name: "Your location", label: "Your location" }),
      (err) => reject(new Error(err.code === 1 ? deniedHelp() : "Couldn't get your location. Please try again.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });
}

// Once someone has said no, the browser won't ask again until they change it in settings.
function deniedHelp() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return /CriOS/.test(ua)
      ? "Location is blocked. On iPhone: Settings › Chrome › Location › While Using the App, then tap the button again."
      : "Location is blocked. On iPhone: tap \"aA\" in the address bar › Website Settings › Location › Allow. If that's not there, check Settings › Privacy & Security › Location Services › Safari Websites.";
  }
  if (/Android/.test(ua)) {
    return "Location is blocked. Tap the icon left of the web address › Permissions › Location › Allow, then tap the button again. Also check your phone's Location is switched on.";
  }
  return "Location is blocked. Click the icon left of the web address, allow Location for this site, then try again.";
}

// Rain bars and a gust line, one column per hour, lined up with the hour chips below.
function rainChart(h, now) {
  const n = h.time.length, step = 72, W = n * step - 8, H = 70, base = 58;
  const maxR = Math.max(2, ...h.precipitation), maxG = Math.max(40, ...h.wind_gusts_10m);
  const x = (i) => i * step + 32, gy = (g) => base - g / maxG * 48;
  const peak = h.wind_gusts_10m.reduce((a, g, i) => (g > h.wind_gusts_10m[a] ? i : a), 0);
  const bars = h.precipitation.map((mm, i) => {
    if (mm <= 0) return "";
    const bh = Math.max(2, mm / maxR * 40), op = i < now ? ' opacity=".45"' : "";
    return `<rect class="rb" x="${x(i) - 18}" y="${base - bh}" width="36" height="${bh}" rx="3"${op}/>`
      + (mm >= 0.1 ? `<text class="rl" x="${x(i)}" y="${base - bh - 4}"${op}>${mm.toFixed(1)}</text>` : "");
  }).join("");
  const line = h.wind_gusts_10m.map((g, i) => `${x(i)},${gy(g).toFixed(1)}`).join(" ");
  const label = `Rain and gusts by hour. Heaviest rain ${Math.max(...h.precipitation).toFixed(1)} mm in an hour; strongest gust ${Math.round(h.wind_gusts_10m[peak])} mph at ${h.time[peak].slice(11, 16)}.`;
  return `<svg class="rainchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <line class="base" x1="0" x2="${W}" y1="${base}" y2="${base}"/>${bars}
    <polyline class="gl" points="${line}"/><circle class="gd" cx="${x(peak)}" cy="${gy(h.wind_gusts_10m[peak])}" r="3.5"/>
    <text class="rl" x="${x(peak)}" y="${gy(h.wind_gusts_10m[peak]) - 7}">${Math.round(h.wind_gusts_10m[peak])} mph</text></svg>`;
}

// Verdict level as colour plus a symbol, so it reads without colour vision.
function lvPill(level, i) {
  return `<span class="lvp l${level}"${i != null ? ` style="--i:${i}"` : ""} role="img" aria-label="${VERDICT[level].title}">${["✓", "!", "×"][level]}</span>`;
}

// Verdict level as colour plus a symbol, so it reads without colour vision.
function lvPill(level, i) {
  return `<span class="lvp l${level}"${i != null ? ` style="--i:${i}"` : ""} role="img" aria-label="${VERDICT[level].title}">${["✓", "!", "×"][level]}</span>`;
}
function legend() {
  return `<div class="legend">${VERDICT.map((v, l) => `<span>${lvPill(l)}${l === 1 ? "Take care" : v.title}</span>`).join("")}</div>`;
}

// Compact weather for one hour: icon (rain/sleet/snow aware), temperature, what's falling, wind arrow.
function wxBits(h, i) {
  const kind = precipType(h, i), code = h.weather_code[i];
  const icon = kind === "freezing" ? "sleet" : kind || (code >= 51 && code < 95 ? "cloud" : weatherIcon(code, h.is_day[i]));
  const mm = h.precipitation[i];
  const fall = { rain: `${mm.toFixed(1)} mm rain`, sleet: `sleet ${mm.toFixed(1)} mm`, snow: `snow ${h.snowfall[i].toFixed(1)} cm`, freezing: "freezing rain" }[kind] || "dry";
  const ws = h.wind_speed_10m[i], dir = h.wind_direction_10m[i];
  const arrow = `<span class="wa w${ws < 10 ? 0 : ws < 20 ? 1 : ws < 30 ? 2 : 3}" style="--r:${(dir + 180) % 360}deg" title="Wind from the ${compass(dir)}, ${Math.round(ws)} mph">${svg("arrow")}<i>${Math.round(ws)}</i></span>`;
  return { icon, fall, arrow, temp: Math.round(h.temperature_2m[i]) };
}

function badge(level) {
  return `<svg class="badge" viewBox="0 0 72 72" aria-hidden="true"><circle class="bg" cx="36" cy="36" r="32"/><circle class="ring" cx="36" cy="36" r="32" pathLength="1"/><path class="mark" pathLength="1" d="${VERDICT[level].mark}"/></svg>`;
}

function scoreTiles(sc) {
  return `<div class="scores">${[["ice", "Ice", sc.ice, ""], ["rain", "Soak", sc.rain, "how wet you'll get"], ["wind", "Wind", sc.wind, ""]].map(([icon, name, r, sub]) => {
    const t = r.score >= 7 ? 2 : r.score >= 4 ? 1 : 0;
    return `<div class="score" title="${name} risk ${r.score} out of 10">
      <span class="head">${svg(icon)}${name} risk</span>${sub ? `<span class="sub">${sub}</span>` : ""}
      <span class="num"><span class="count" data-to="${r.score}">0</span><small> /10</small></span>
      <span class="gauge"><i class="s${t}" style="width:${Math.max(4, r.score * 10)}%"></i></span>
      <span class="lbl s${t}">${r.label}</span><span class="det">${esc(r.detail)}</span>
    </div>`; }).join("")}</div>`;
}

function reasonList(reasons, empty) {
  return reasons.length
    ? `<ul class="reasons">${reasons.map((r) => `<li class="l${r.level}"><span class="ico">${svg(REASON_ICON[r.kind] || "cloud")}</span><p>${esc(r.text)}</p></li>`).join("")}</ul>`
    : `<p class="empty">${empty}</p>`;
}

// Animate score numbers from 0 up to their value.
function countUp(root = $("panel-body")) {
  const els = root.querySelectorAll(".count");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return els.forEach((el) => el.textContent = el.dataset.to);
  const start = performance.now() + 500, dur = 900;
  const tick = (t) => {
    const p = Math.max(0, Math.min(1, (t - start) / dur)), e = 1 - Math.pow(1 - p, 3);
    els.forEach((el) => el.textContent = Math.round(e * el.dataset.to));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Backstop: animation frames pause in background tabs, so make sure the final values land.
  setTimeout(() => els.forEach((el) => el.textContent = el.dataset.to), 500 + dur + 100);
}

// Results of "Safe to ride here?" as cards. `mode` = "bicycle" or "motorbike";
// `a` is the API's assessment of this weather (see assessHere in api.js).
function hereHtml(data, place, mode, a) {
  const h = data.hourly, n = h.time.length, now = Math.min(PAST_HOURS, n - 1);
  const { level, reasons, levels } = a;
  const win = bestWindow(levels, now);
  const hhmm = (i) => h.time[i].slice(11, 16);
  const who = mode === "bicycle" ? "cycle" : "ride your motorbike";
  const V = VERDICT[level];
  const text = [`Conditions look fine to ${who}.`, `You can ${who}, but conditions need extra care.`, `We'd advise against choosing to ${who} right now.`][level];
  let bestHtml;
  if (!win) bestHtml = `<b>No clear window in the next 12 hours</b><small>Every hour has at least one hazard, so check the reasons below.</small>`;
  else if (win.start === now) bestHtml = `<b>Good now until ${win.end >= n ? "at least " + hhmm(n - 1) : hhmm(win.end)}</b><small>Clear riding conditions from right now.</small>`;
  else bestHtml = `<b>Best time to ride: ${hhmm(win.start)}–${win.end >= n ? hhmm(n - 1) + "+" : hhmm(win.end)}</b><small>The longest stretch of clear conditions ahead.</small>`;
  let k = 0;
  const card = (cls, inner) => `<div class="card reveal ${cls}" style="--i:${k++}">${inner}</div>`;
  return card(`verdict ${V.cls}`, `${badge(level)}
      <div><h2>${V.title}</h2><p>${text}</p><p class="summary">${esc(a.summary)}</p>
        ${place ? `<span class="place">${svg("pin")}${esc(place)}</span>` : ""}
        <small class="disc">Guidance only: use your own judgement on the road.</small></div>`)
    + card("", `<h2 class="ch">Ride window</h2>
      <div class="best"><span class="ico">${svg("clock")}</span><span>${bestHtml}</span></div>
      <div class="hours-wrap">${rainChart(h, now)}<div class="hours">${h.time.map((_, i) => {
        const b = wxBits(h, i);
        return `<div class="hour ${i < now ? "past" : ""} ${i === now ? "now" : ""}" title="${VERDICT[levels[i]].title}: ${WMO[h.weather_code[i]] ?? ""}">
          <span class="t">${i === now ? "Now" : hhmm(i)}</span>${svg(b.icon)}<b>${b.temp}°</b>${lvPill(levels[i], i)}</div>`;
      }).join("")}</div></div>
      <div class="chart-key"><span class="kr">Rain (mm per hour)</span><span class="kg">Gusts (mph)</span><span>Faded = last ${PAST_HOURS} hours</span></div>${legend()}`)
    + card("", `<h2 class="ch">Risk scores · next 3 hours <a href="#how">How we score</a></h2>${scoreTiles(a.scores)}`)
    + card("", `<h2 class="ch">Why</h2>${reasonList(reasons, "No weather hazards found for the next 3 hours.")}`)
    + card("quiet", `<h2 class="ch">Right now · ${WMO[h.weather_code[now]] ?? ""}</h2><div class="stats">
        <div class="stat">${svg("temp")}<small>Air · feels like</small><strong>${Math.round(h.temperature_2m[now])}°</strong> <em>${Math.round(h.apparent_temperature[now])}°</em></div>
        <div class="stat">${svg("ice")}<small>Road surface</small><strong>${Math.round(h.soil_temperature_0cm[now])}°C</strong></div>
        <div class="stat">${svg("wind")}<small>Wind · gusts</small><strong>${Math.round(h.wind_speed_10m[now])}</strong> <em>${Math.round(h.wind_gusts_10m[now])} mph from the ${compass(h.wind_direction_10m[now])}</em></div>
        <div class="stat">${svg("drop")}<small>Rain now · last ${PAST_HOURS}h</small><strong>${h.precipitation[now].toFixed(1)}</strong> <em>${h.precipitation.slice(0, now).reduce((a, b) => a + b, 0).toFixed(1)} mm</em></div>
        <div class="stat">${svg("eye")}<small>Visibility</small><strong>${h.visibility[now] >= 10000 ? "10+" : (h.visibility[now] / 1000).toFixed(1)}</strong> <em>km</em></div>
      </div>`);
}

// "How we decide". The weather thresholds and scoring live in the private Safe2Ride API, so this
// describes them in words; the surface table is still built from the same tables the routing uses.
function renderHow() {
  const fit = (b, id) => ["✓", "take care", "✗"][SURFACE_FIT[b][id]];
  $("how-body").innerHTML = `
    <p>Every check looks at the last ${PAST_HOURS} hours, right now and the next 12. The verdict is the worst weather hazard in the next 3 hours, or anywhere along your route at the time you'll be there.</p>
    <h3>The three verdicts</h3>
    <ul><li>${lvPill(0)} <b>Good to go</b>: no hazards found.</li>
      <li>${lvPill(1)} <b>Ride with care</b>: at least one hazard that needs extra care.</li>
      <li>${lvPill(2)} <b>Not advised</b>: at least one hazard we'd avoid riding in.</li></ul>
    <h3>What we look for</h3>
    <p>Gusts and strong wind, rain and how much of it you'd ride through, roads still wet from earlier rain, ice and frost on the road surface, snow, freezing rain, thunderstorms, fog and poor visibility, and extreme heat. Along a route we also look at headwinds, tailwinds and crosswinds for the direction you're riding.</p>
    <p>Bicycles and motorbikes have their own limits: a gust that's fine on a motorbike can push a bike across the road.</p>
    <h3>Road and surface grades</h3>
    <p>Every stretch of a cycle route is graded from OpenStreetMap's road and surface tags.</p>
    <table><tr><th></th><th>Road</th><th>Gravel</th><th>MTB</th></tr>
      ${SURFACES.map((x) => `<tr><td><span class="sw" style="display:inline-block;vertical-align:middle;margin-right:6px;background:${x.colour}"></span>${x.name}</td><td>${fit("road", x.id)}</td><td>${fit("gravel", x.id)}</td><td>${fit("mtb", x.id)}</td></tr>`).join("")}</table>
    <p>Busy roads are A-roads and main B-roads. Grade 1 is compacted or fine gravel; Grade 2 is loose gravel, dirt or rougher farm tracks; Grade 3 is grass, mud, sand or mountain-bike trails.</p>
    <h3>Risk scores, 0 to 10</h3>
    <ul><li><b>Ice</b>: how cold the road surface gets, and how much moisture is about to freeze on it.</li>
      <li><b>Soak</b> (how wet you'll get): the rain you'd ride through, weighted by how likely it is.</li>
      <li><b>Wind</b>: your strongest gust against your vehicle's limit.</li></ul>
    <h3>Loops and café stops</h3>
    <p>We try loops in up to six directions, heading out into the wind so it's behind you on the way home, and pick the one that best matches your distance with the fewest busy roads, unsuitable surfaces and retraced roads (and the least climbing if you prefer flat). Cafés come from OpenStreetMap; we pick one near halfway, open when you'd arrive if its hours are known.</p>
    <p>Safe2Ride is guidance only: it can't see the road in front of you.</p>`;
}
