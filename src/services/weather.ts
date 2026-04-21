import { WeatherData } from '../types';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

export async function getWeatherForecast(lat: number, lon: number): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: 'temperature_2m,precipitation,wind_speed_10m,weathercode',
    daily:
      'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weathercode',
    forecast_days: '7',
    timezone: 'auto',
  });

  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) throw new Error('Wetterdaten konnten nicht geladen werden');

  const data = await res.json();

  return {
    temperature: Math.round(data.current.temperature_2m),
    precipitation: data.current.precipitation,
    wind_speed: Math.round(data.current.wind_speed_10m),
    weathercode: data.current.weathercode,
    daily: (data.daily.time as string[]).map((date, i) => ({
      date,
      temp_max: Math.round(data.daily.temperature_2m_max[i]),
      temp_min: Math.round(data.daily.temperature_2m_min[i]),
      precipitation: data.daily.precipitation_sum[i],
      precipitation_probability: data.daily.precipitation_probability_max[i],
      weathercode: data.daily.weathercode[i],
    })),
  };
}

export function getWeatherForGardenLocation(): { lat: number; lon: number } {
  // Default to Berlin – replaced once user grants location permission
  return { lat: 52.52, lon: 13.41 };
}
