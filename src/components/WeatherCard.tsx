import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WeatherData, DailyWeather } from '../types';
import { Colors, WMO_CODES, WMO_EMOJI } from '../constants';

interface Props {
  weather: WeatherData;
  locationName?: string;
}

function DayItem({ day }: { day: DailyWeather }) {
  const emoji = WMO_EMOJI[day.weathercode] ?? '🌤️';
  const date = new Date(day.date);
  const label = date.toLocaleDateString('de-DE', { weekday: 'short' });
  return (
    <View style={styles.dayItem}>
      <Text style={styles.dayLabel}>{label}</Text>
      <Text style={styles.dayEmoji}>{emoji}</Text>
      <Text style={styles.dayTemp}>{day.temp_max}°</Text>
      {day.precipitation_probability > 40 && (
        <Text style={styles.dayRain}>{day.precipitation_probability}%</Text>
      )}
    </View>
  );
}

export function WeatherCard({ weather, locationName }: Props) {
  const emoji = WMO_EMOJI[weather.weathercode] ?? '🌤️';
  const description = WMO_CODES[weather.weathercode] ?? 'Unbekannt';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.location}>{locationName ?? 'Mein Garten'}</Text>
          <Text style={styles.description}>{description}</Text>
        </View>
        <View style={styles.tempRow}>
          <Text style={styles.weatherEmoji}>{emoji}</Text>
          <Text style={styles.temp}>{weather.temperature}°C</Text>
        </View>
      </View>

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{weather.wind_speed} km/h</Text>
          <Text style={styles.statLabel}>Wind</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{weather.precipitation} mm</Text>
          <Text style={styles.statLabel}>Niederschlag</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{weather.daily[0]?.precipitation_probability ?? 0}%</Text>
          <Text style={styles.statLabel}>Regenrisiko</Text>
        </View>
      </View>

      <View style={styles.forecast}>
        {weather.daily.slice(0, 7).map((day) => (
          <DayItem key={day.date} day={day} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.primary,
    borderRadius: 20,
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  location: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '500',
  },
  description: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 2,
  },
  tempRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weatherEmoji: {
    fontSize: 36,
  },
  temp: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  stat: {
    alignItems: 'center',
    flex: 1,
  },
  statDivider: {
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  statValue: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  statLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    marginTop: 2,
  },
  forecast: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  dayItem: {
    alignItems: 'center',
    flex: 1,
  },
  dayLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    marginBottom: 2,
  },
  dayEmoji: {
    fontSize: 16,
    marginBottom: 2,
  },
  dayTemp: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  dayRain: {
    color: '#95D5B2',
    fontSize: 10,
  },
});
