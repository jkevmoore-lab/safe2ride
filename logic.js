// Safe2Ride weather logic. No DOM access here so it can be tested on its own.

const PAST_HOURS = 6, FORECAST_HOURS = 13;

// Thresholds differ by vehicle. Wind values are mph, rain mm/h.
const LIMITS = {
  bicycle:   { gustCare: 25, gustStop: 38, windCare: 18, rainCare: 1.0, rainStop: 6 },
  motorbike: { gustCare: 35, gustStop: 50, windCare: 28, rainCare: 2.0, rainStop: 8 },
};

const WMO = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers",
  82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

async function fetchWeather(lat, lon) {
  const vars = "temperature_2m,apparent_temperature,dew_point_2m,precipitation,snowfall,weather_code,visibility,wind_speed_10m,wind_gusts_10m,soil_temperature_0cm,is_day";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + `&hourly=${vars}&past_hours=${PAST_HOURS}&forecast_hours=${FORECAST_HOURS}&wind_speed_unit=mph&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather " + res.status);
  return res.json();
}

async function fetchPlace(lat, lon) {
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await res.json();
    return j.locality || j.city || j.principalSubdivision || "";
  } catch { return ""; }
}

// Assess riding conditions at hour index `at`, looking `ahead` hours forward
// and up to PAST_HOURS back. Returns { level: 0 go | 1 care | 2 stop, reasons }.
function assess(h, mode, at, ahead = 3) {
  const L = LIMITS[mode];
  const n = h.time.length;
  const past = range(Math.max(0, at - PAST_HOURS), at), next = range(at, Math.min(at + ahead, n));
  const max = (arr, idx) => Math.max(...idx.map((i) => arr[i] ?? 0));
  const sum = (arr, idx) => idx.reduce((s, i) => s + (arr[i] ?? 0), 0);
  const min = (arr, idx) => Math.min(...idx.map((i) => arr[i] ?? 99));

  const reasons = [];
  const add = (level, kind, text) => reasons.push({ level, kind, text });

  const codesAhead = next.map((i) => h.weather_code[i]);
  const pastRain = sum(h.precipitation, past);
  const recentRain = sum(h.precipitation, past.slice(-3));
  const airNow = h.temperature_2m[at];
  const coldest = Math.min(min(h.soil_temperature_0cm, next), min(h.temperature_2m, next));

  if (codesAhead.some((c) => c >= 95)) add(2, "storm", "Thunderstorms expected in the next few hours.");
  const snowAhead = sum(h.snowfall, next), snowPast = sum(h.snowfall, past);
  if (snowAhead > 0) add(2, "snow", `Snow forecast (${snowAhead.toFixed(1)} cm).`);
  else if (snowPast > 0) add(2, "snow", `Snow has fallen in the last ${PAST_HOURS} hours, so roads may be covered.`);

  if (codesAhead.some((c) => [56, 57, 66, 67].includes(c))) add(2, "ice", "Freezing rain or drizzle forecast: black ice is likely.");
  if (coldest <= 0 && (pastRain > 0 || h.dew_point_2m[at] >= airNow - 1)) {
    add(2, "ice", `Road surface around ${coldest.toFixed(0)}°C with moisture about: high risk of ice.`);
  } else if (coldest <= 3) {
    add(1, "ice", `Near freezing (${coldest.toFixed(0)}°C). Watch for frost on shaded roads and bridges.`);
  }

  const gust = max(h.wind_gusts_10m, next), wind = max(h.wind_speed_10m, next);
  if (gust >= L.gustStop) add(2, "wind", `Gusts up to ${Math.round(gust)} mph: strong enough to push you across the road.`);
  else if (gust >= L.gustCare || wind >= L.windCare) add(1, "wind", `Windy, with gusts up to ${Math.round(gust)} mph. Take care in exposed spots.`);

  const rainAhead = max(h.precipitation, next);
  if (rainAhead >= L.rainStop) add(2, "rain", `Heavy rain forecast (up to ${rainAhead.toFixed(1)} mm/h): poor grip and visibility.`);
  else if (rainAhead >= L.rainCare) add(1, "rain", `Rain forecast (up to ${rainAhead.toFixed(1)} mm/h). Allow longer braking distances.`);
  else if (rainAhead > 0) add(0, "rain", "Some light rain possible.");

  if (recentRain >= 0.5 && rainAhead < L.rainCare) add(1, "wet", `${recentRain.toFixed(1)} mm of rain in the last 3 hours: roads are likely still wet and slippery.`);
  else if (pastRain > 0 && recentRain < 0.5) add(0, "wet", `Some rain earlier (${pastRain.toFixed(1)} mm in the last ${PAST_HOURS} hours); roads may be damp in places.`);

  const vis = min(h.visibility, next);
  if (vis < 200) add(2, "fog", `Visibility down to ${Math.round(vis)} m (fog).`);
  else if (vis < 1000) add(1, "fog", `Reduced visibility (${(vis / 1000).toFixed(1)} km). Use lights and be seen.`);

  if (max(h.temperature_2m, next) >= 30) add(1, "heat", "Very hot. Carry water and watch for soft, melting tarmac.");

  if (h.is_day[at] === 0) add(0, "dark", "It's dark: use lights and reflective kit.");

  reasons.sort((a, b) => b.level - a.level);
  return { level: Math.max(0, ...reasons.map((r) => r.level)), reasons };
}

// Longest run of "go" hours from `from` onwards. Returns { start, end } (end exclusive) or null.
function bestWindow(levels, from) {
  let best = null, start = null;
  for (let i = from; i <= levels.length; i++) {
    if (i < levels.length && levels[i] === 0) { if (start === null) start = i; continue; }
    if (start !== null && (!best || i - start > best.end - best.start)) best = { start, end: i };
    start = null;
  }
  return best;
}

function range(a, b) { return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i); }
