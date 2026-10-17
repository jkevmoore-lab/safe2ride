// Safe2Ride route card: the HTML for a planned ride. `trip` is the planned ride (see analyse() in ui.js),
// `chosen` the departure option being shown. Building HTML only: ui.js wires up the buttons.

import { PAST_HOURS, compass } from "./logic.js";
import { MILE, climbStats, miles, clock, duration } from "./route.js";
import { openAt } from "./loop.js";
import { VERDICT, esc, num, svg, lvPill, wxBits, scoreTiles, reasonList } from "./app.js";

const BIKE_NAME = { road: "road bike", gravel: "gravel bike", mtb: "mountain bike", motorbike: "motorbike" };
const HAZARD_WORD = { storm: "Storms", snow: "Snow", ice: "Ice", wind: "Wind", crosswind: "Wind", headwind: "Headwind",
  rain: "Rain", soak: "Rain", wet: "Wet roads", fog: "Fog", heat: "Heat", dark: "Dark", data: "Missing data" };
const ISSUE_NAME = { busy: "busy road", g1: "smooth track (Grade 1)", g2: "rough track (Grade 2)", g3: "MTB-only track (Grade 3)", unknown: "path with unknown surface" };

function rideTitle(trip) {
  const fromName = trip.from.name === "Your location" ? "your location" : trip.from.name;
  return trip.ride === "loop" ? `${miles(trip.route.distance)}-mile loop from ${fromName}` : `${trip.from.name} → ${trip.to.name}`;
}

// The whole results card. `first` = a newly planned ride (cards animate in).
// `nav`: { n: routes found so far, more: whether › can look for another }.
function tripHtml(trip, chosen, first, nav) {
  const o = trip.options[chosen], best = trip.options[trip.best], cycle = trip.bike !== "motorbike";
  const backWord = trip.ride === "loop" ? "back" : "arrive";
  const hazard = (d) => (d.level ? HAZARD_WORD[d.reasons.find((r) => r.level === d.level)?.kind] || VERDICT[d.level].title : "Clear");
  const anim = (i) => (first ? `reveal" style="--i:${i}` : "swap");
  const several = nav.n > 1 || nav.more;
  const sub = trip.alt === 0 ? (several ? "Best match" : "") : trip.ride === "loop" ? `Heads ${compass(trip.option.heading ?? 0)} first` : "Alternative route";
  const note = cycle && trip.opts.cafe ? cafeNote(trip) : "";
  const climb = trip.route.climb || (trip.elev ? climbStats(trip.elev.z).up : 0);

  return `
    <div class="card rdlg ${anim(0)}">
      <div class="rhead">
        <button type="button" class="arr" id="prev" aria-label="Previous route" ${trip.alt === 0 ? "disabled" : ""}>‹</button>
        <div class="rt"><b>${several ? `Route ${trip.alt + 1}${nav.more ? "" : ` of ${nav.n}`}` : "Your route"}</b><small>${esc(sub)}</small></div>
        <button type="button" class="arr" id="next" aria-label="${trip.alt + 1 < nav.n ? "Next route" : "Find another route"}" ${trip.alt + 1 < nav.n || nav.more ? "" : "disabled"}>›</button>
      </div>
      <p class="rsum"><span class="vpill l${o.level}">${["✓", "!", "×"][o.level]} ${VERDICT[o.level].title}</span>
        ${miles(trip.route.distance)} mi · ${duration(trip.route.duration)} · leave ${chosen === 0 ? "now" : clock(o.dep)}, ${backWord} ${clock(o.arrive)}${climb ? ` · ↗ ${Math.round(climb)} m` : ""}</p>
      ${risksHtml(trip, o)}
      ${aiBox(trip, chosen)}
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
      ${trip.stats?.issues.length ? `<h3>Surfaces to watch</h3>${issuesHtml(trip, trip.stats)}` : ""}
      ${trip.elev ? `<h3>Hills</h3>${profileHtml(trip)}` : ""}
      <h3>Weather risk <a href="#how">How we score</a></h3>${scoreTiles(o.scores)}
      <h3>Why</h3>${reasonList(o.reasons, "No weather hazards found along the route.")}
      <h3>Along the way</h3>${pointsHtml(trip, o)}
      ${note ? `<p class="note">${note}</p>` : ""}
    </details>`;
}

// A point's worst hazard in a word or two (the API lists each point's hazard kinds, worst first).
function pointHazard(p) {
  return HAZARD_WORD[p.kinds?.[0]] || VERDICT[p.level].title;
}

// Risk points: a pill for each weather point with a hazard (at most 5, the worst), in order along the route.
function risksHtml(trip, o) {
  const risky = o.pts.map((p, k) => ({ p, k })).filter(({ p }) => p.level > 0);
  if (!risky.length) return "";
  const shown = [...risky].sort((a, b) => b.p.level - a.p.level || a.k - b.k).slice(0, 5).sort((a, b) => a.k - b.k);
  const where = (k) => (k === 0 ? "start" : k === o.pts.length - 1 ? (trip.ride === "loop" ? "home" : "end") : `mi ${miles(o.pts[k].dist)}`);
  return `<div class="risks" role="group" aria-label="Risk points">${shown.map(({ p, k }) =>
    `<button type="button" class="risk l${p.level}" data-pt="${k}" title="Show on the map"><b class="tg">${["", "!", "×"][p.level]}</b>${clock(p.eta)} <small>${where(k)}</small> ${esc(pointHazard(p))}</button>`).join("")}</div>`;
}

// The AI-written briefing for departure `chosen`: being written, written, or (if that failed) our own summary instead.
function aiBox(trip, chosen) {
  const text = trip.descs?.[chosen], err = trip.descErr?.[chosen];
  if (text) return `<div class="ai" id="ai" aria-live="polite"><p>${esc(text)}</p><small>Written by AI from this route and forecast. It can get things wrong: the verdict and details above come first.</small></div>`;
  if (err) return `<div class="ai" id="ai" aria-live="polite"><p>${describe(trip, trip.options[chosen], chosen)}</p><small>${esc(err)} <button type="button" class="retry" id="ai-retry">Try again</button></small></div>`;
  const live = trip.descLive?.[chosen];
  if (live) return `<div class="ai live" id="ai" aria-live="polite"><p>${esc(live)}</p></div>`;
  return `<div class="ai writing" id="ai" aria-live="polite"><p>Writing your ride briefing</p></div>`;
}

// The route in a few sentences, without AI: weather, roads, hills, cafés. Shown only when the AI briefing isn't available.
function describe(trip, o) {
  const st = trip.stats;
  const parts = [esc(o.summary)];
  if (st) {
    const main = ["quiet", "path"].filter((k) => st.pct[k] >= 5).map((k) => `${{ quiet: "quiet roads", path: "cycle paths" }[k]} (${Math.round(st.pct[k])}%)`);
    const extra = [];
    if (st.metres.busy >= 100) extra.push(`${miles(st.metres.busy)} mi on busy roads`);
    const rough = st.metres.g1 + st.metres.g2 + st.metres.g3;
    if (rough >= 100) extra.push(`${miles(rough)} mi of unpaved track`);
    const bad = st.issues.filter((x) => x.level === 2).reduce((s, x) => s + x.len, 0);
    parts.push(`${main.length ? `Mostly ${main.join(" and ")}` : "Mixed roads"}${extra.length ? `, with ${extra.join(" and ")}` : ""}.${bad ? ` <b>${miles(bad)} mi isn't suitable for a ${BIKE_NAME[trip.bike]}.</b>` : ""}`);
    const p0 = o.pts[0], rain6 = p0.h.precipitation.slice(Math.max(0, p0.at - PAST_HOURS), p0.at + 1).reduce((a, b) => a + (b ?? 0), 0);
    if (rough + st.metres.unknown > 800 && rain6 >= 1) parts.push("Unpaved stretches will be muddy after the recent rain.");
  }
  if (trip.bike !== "motorbike" && trip.opts.cafe) {
    const c = trip.cafes.length;
    parts.push(c ? `${c} café${c > 1 ? "s" : ""} on the way: tap ☕ on the map.` : trip.option.cafeError ? "Café search isn't responding right now." : "No cafés right on the route.");
  }
  return parts.join(" ");
}

function issuesHtml(trip, st) {
  const where = (d) => (d < 400 ? "near the start" : trip.route.distance - d < 400 ? "near the end" : `around mile ${miles(d)}`);
  const verb = ["", "take care on a", "not suitable for a"];
  return `<ul class="issues">${st.issues.slice(0, 5).map((x) => `<li>${lvPill(x.level)}<span>${miles(x.len)} mi of ${ISSUE_NAME[x.cls]} ${where(x.start)}: ${verb[x.level]} ${BIKE_NAME[trip.bike]}.</span></li>`).join("")}</ul>`;
}

function cafeNote(trip) {
  if (trip.option.cafeRejected) return `The nearest café to halfway, ${esc(trip.option.cafeRejected)}, is only reachable on surfaces that don't suit a ${BIKE_NAME[trip.bike]}, so we've left it out.`;
  return trip.cafes.length ? "Cafés come from OpenStreetMap. Where several are close together we show the best local one." : "";
}

// Café details, shown when you tap or hover over its ☕ on the map.
function cafePopup(trip, chosen, c) {
  const o = trip.options[chosen], eta = o.dep + c.t, open = openAt(c.hours, new Date(eta * 1000));
  return `<b>${esc(c.name)}</b><br>${c.chain ? "Chain" : "Independent"}${trip.option.cafe?.name === c.name ? " · your café stop" : ""}<br>
    Mile ${miles(c.dist)} · about ${clock(eta)}<br>
    ${open === true ? '<span class="open-yes">Open when you get there</span>' : open === false ? '<span class="closed">Closed when you get there</span>' : '<span class="open-unknown">Opening hours not listed</span>'}${c.hours ? `<br><small>${esc(c.hours)}</small>` : ""}`;
}

function pointsHtml(trip, o) {
  return `<ul class="cps">${o.pts.map((p, k) => {
    const g = o.segs[Math.min(k, o.segs.length - 1)], h = p.h, i = p.at, b = wxBits(h, i);
    const wind = g.head >= 6 ? "headwind" : g.head <= -6 ? "tailwind" : h.wind_speed_10m[i] >= 8 ? "crosswind" : "light wind";
    const label = k === 0 ? "Start" : k === o.pts.length - 1 ? (trip.ride === "loop" ? "Back home" : "Arrive") : `Mile ${miles(p.dist)}`;
    return `<li>${lvPill(p.level)}<span><b>${clock(p.eta)}</b></span>${svg(b.icon)}
      <span><b>${label}</b><span class="wx"><span>${b.temp}°</span><span>${b.fall}</span><span>${b.arrow}<span class="w">&nbsp;gusts ${num(h.wind_gusts_10m[i])}</span></span><span class="w">${wind}</span></span></span></li>`;
  }).join("")}</ul>`;
}

// Hills: height along the route.
function profileHtml(trip) {
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

export { BIKE_NAME, rideTitle, tripHtml, aiBox, pointHazard, cafePopup };
