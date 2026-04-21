import { Plant, WeatherData, CareSuggestion, Priority } from '../types';
import { PLANT_EMOJIS } from '../constants';

export function generateCareSuggestions(
  plants: Plant[],
  weather: WeatherData | null
): CareSuggestion[] {
  const suggestions: CareSuggestion[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayWeather = weather?.daily[0] ?? null;
  const rainToday = (todayWeather?.precipitation ?? 0) > 5;
  const rainProbHigh = (todayWeather?.precipitation_probability ?? 0) >= 70;
  const heatStress = (todayWeather?.temp_max ?? 0) > 35;
  const frost = (todayWeather?.temp_min ?? 20) < 2;

  for (const plant of plants) {
    const emoji = PLANT_EMOJIS[plant.type] ?? '🌱';

    // Watering check
    const lastWatered = plant.last_watered_at ? new Date(plant.last_watered_at) : null;
    const daysSince = lastWatered
      ? Math.floor((today.getTime() - lastWatered.getTime()) / 86_400_000)
      : 999;
    const isDue = daysSince >= plant.watering_interval_days;

    if (isDue) {
      if (rainToday || rainProbHigh) {
        suggestions.push({
          id: `water-skip-${plant.id}`,
          plant_id: plant.id,
          plant_name: plant.name,
          plant_emoji: emoji,
          action: 'Gießen überspringen',
          reason: `Regen erwartet (${todayWeather?.precipitation_probability ?? 0}% Wahrscheinlichkeit)`,
          priority: 'low',
        });
      } else {
        const overdue = daysSince - plant.watering_interval_days;
        const priority: Priority = overdue > 1 ? 'high' : 'medium';
        suggestions.push({
          id: `water-${plant.id}`,
          plant_id: plant.id,
          plant_name: plant.name,
          plant_emoji: emoji,
          action: 'Jetzt gießen',
          reason:
            lastWatered === null
              ? 'Noch nie gegossen'
              : `${daysSince} Tag${daysSince !== 1 ? 'e' : ''} seit dem letzten Gießen`,
          priority,
        });
      }
    }

    // Heat stress
    if (heatStress) {
      suggestions.push({
        id: `heat-${plant.id}`,
        plant_id: plant.id,
        plant_name: plant.name,
        plant_emoji: emoji,
        action: 'Schatten & extra Wasser',
        reason: `Hitze erwartet: ${todayWeather?.temp_max}°C – abends gießen`,
        priority: 'high',
      });
    }

    // Frost warning
    if (frost) {
      suggestions.push({
        id: `frost-${plant.id}`,
        plant_id: plant.id,
        plant_name: plant.name,
        plant_emoji: emoji,
        action: 'Frostschutz prüfen',
        reason: `Frost möglich: ${todayWeather?.temp_min}°C erwartet`,
        priority: 'high',
      });
    }

    // Health alert
    if (plant.health_status === 'sick') {
      suggestions.push({
        id: `health-${plant.id}`,
        plant_id: plant.id,
        plant_name: plant.name,
        plant_emoji: emoji,
        action: 'Gesundheitscheck nötig',
        reason: 'Pflanze als krank markiert',
        priority: 'high',
      });
    } else if (plant.health_status === 'needs_attention') {
      suggestions.push({
        id: `attention-${plant.id}`,
        plant_id: plant.id,
        plant_name: plant.name,
        plant_emoji: emoji,
        action: 'Pflanze kontrollieren',
        reason: 'Aufmerksamkeit erforderlich',
        priority: 'medium',
      });
    }
  }

  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return suggestions.sort((a, b) => order[a.priority] - order[b.priority]);
}

export function nextWateringDate(plant: Plant): Date | null {
  if (!plant.last_watered_at) return new Date();
  const d = new Date(plant.last_watered_at);
  d.setDate(d.getDate() + plant.watering_interval_days);
  return d;
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Noch nie';
  return new Date(dateStr).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
