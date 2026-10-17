// Safe2Ride weather fetching and helpers. No DOM access here so it can be tested on its own.
// The decision rules (thresholds, verdicts, scores) are in the private Safe2Ride API: see api.js.

const PAST_HOURS = 6, FORECAST_HOURS = 13;

const WMO = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers",
  82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

// What we fetch from Open-Meteo and send to the API. Must match contract/v2.json (the tests check).
const WEATHER_VARS = ["temperature_2m", "apparent_temperature", "dew_point_2m", "precipitation", "precipitation_probability", "snowfall",
  "weather_code", "visibility", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "soil_temperature_0cm", "is_day"].join(",");

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + `&hourly=${WEATHER_VARS}&past_hours=${PAST_HOURS}&forecast_hours=${FORECAST_HOURS}&wind_speed_unit=mph&timezone=auto`;
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

// What's falling at hour i: null (dry), "rain", "sleet", "snow" or "freezing" (freezing rain/drizzle).
// Open-Meteo snowfall is cm; 7 cm of snow ≈ 10 mm of water.
function precipType(h, i) {
  const code = h.weather_code[i], mm = h.precipitation[i] ?? 0, snow = h.snowfall?.[i] ?? 0;
  if ([56, 57, 66, 67].includes(code)) return "freezing";
  if (snow > 0) return mm > snow * 10 / 7 * 1.5 + 0.1 || h.temperature_2m[i] > 1.5 ? "sleet" : "snow";
  return mm >= 0.1 ? "rain" : null;
}

function compass(deg) { return Number.isFinite(deg) ? ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16] : "?"; }

function range(a, b) { return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i); }

export { PAST_HOURS, FORECAST_HOURS, WMO, WEATHER_VARS, fetchWeather, fetchPlace, precipType, compass, range };
