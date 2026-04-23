import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useGardenStore } from '../../src/store/useGardenStore';
import { getWeatherForecast } from '../../src/services/weather';
import { WeatherCard } from '../../src/components/WeatherCard';
import { CareTaskItem } from '../../src/components/CareTaskItem';
import { EmptyState } from '../../src/components/EmptyState';
import { Colors } from '../../src/constants';
import { CareSuggestion } from '../../src/types';

export default function HomeScreen() {
  const router = useRouter();
  const {
    activeGarden,
    weather,
    setWeather,
    weatherLastFetched,
    locationLat,
    locationLon,
    setLocation,
    careSuggestions,
    recomputeSuggestions,
    updatePlant,
    addCareLog,
    plants,
    activeGardenId,
    gardens,
  } = useGardenStore();

  const [refreshing, setRefreshing] = useState(false);
  const garden = activeGarden();

  async function fetchWeather(lat: number, lon: number) {
    try {
      const data = await getWeatherForecast(lat, lon);
      setWeather(data);
    } catch {
      // Keep stale data if fetch fails
    }
  }

  async function requestLocation() {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      // Fall back to stored or default location
      const lat = locationLat ?? 52.52;
      const lon = locationLon ?? 13.41;
      fetchWeather(lat, lon);
      return;
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
    setLocation(loc.coords.latitude, loc.coords.longitude);
    fetchWeather(loc.coords.latitude, loc.coords.longitude);
  }

  useFocusEffect(
    useCallback(() => {
      recomputeSuggestions();

      // Refresh weather if older than 1 hour
      const stale =
        !weatherLastFetched ||
        Date.now() - new Date(weatherLastFetched).getTime() > 3_600_000;

      if (stale) {
        if (locationLat && locationLon) {
          fetchWeather(locationLat, locationLon);
        } else {
          requestLocation();
        }
      }
    }, [plants, activeGardenId, weatherLastFetched])
  );

  async function onRefresh() {
    setRefreshing(true);
    await requestLocation();
    recomputeSuggestions();
    setRefreshing(false);
  }

  function handleTaskDone(suggestion: CareSuggestion) {
    if (suggestion.action.toLowerCase().includes('gieß') ||
        suggestion.action.toLowerCase().includes('water')) {
      updatePlant(suggestion.plant_id, { last_watered_at: new Date().toISOString() });
      addCareLog({
        id: `log-${Date.now()}`,
        plant_id: suggestion.plant_id,
        user_id: 'local',
        action: 'watered',
        notes: null,
        logged_at: new Date().toISOString(),
      });
    }
    recomputeSuggestions();
    Alert.alert('Erledigt ✅', `${suggestion.plant_name} wurde ${suggestion.action.toLowerCase()}.`);
  }

  const totalPlants = plants.filter((p) => p.garden_id === activeGardenId).length;
  const urgentCount = careSuggestions.filter((s) => s.priority === 'high').length;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Guten Tag 🌿</Text>
          <Text style={styles.gardenName}>{garden?.name ?? 'Kein Garten'}</Text>
        </View>
        <TouchableOpacity
          style={styles.scanBtn}
          onPress={() => router.push('/garden/scan')}
          activeOpacity={0.8}
        >
          <Text style={styles.scanBtnText}>📸 Garten scannen</Text>
        </TouchableOpacity>
      </View>

      {/* Quick stats */}
      <View style={styles.stats}>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{totalPlants}</Text>
          <Text style={styles.statLabel}>Pflanzen</Text>
        </View>
        <View style={[styles.statCard, urgentCount > 0 && styles.statCardUrgent]}>
          <Text style={[styles.statNum, urgentCount > 0 && { color: Colors.danger }]}>
            {urgentCount}
          </Text>
          <Text style={styles.statLabel}>Dringend</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{careSuggestions.length}</Text>
          <Text style={styles.statLabel}>Aufgaben</Text>
        </View>
      </View>

      {/* Weather */}
      {weather ? (
        <WeatherCard weather={weather} locationName={garden?.name} />
      ) : (
        <TouchableOpacity style={styles.weatherPlaceholder} onPress={requestLocation}>
          <Text style={styles.weatherPlaceholderText}>🌡️ Wetterdaten laden…</Text>
        </TouchableOpacity>
      )}

      {/* Tasks */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Aufgaben heute</Text>
        {careSuggestions.length > 0 && (
          <Text style={styles.sectionCount}>{careSuggestions.length}</Text>
        )}
      </View>

      {gardens.length === 0 ? (
        <EmptyState
          emoji="🏡"
          title="Noch kein Garten"
          subtitle="Erstelle deinen ersten Garten im Garten-Tab"
          actionLabel="Garten anlegen"
          onAction={() => router.push('/(tabs)/garden')}
        />
      ) : careSuggestions.length === 0 ? (
        <View style={styles.allDone}>
          <Text style={styles.allDoneEmoji}>🎉</Text>
          <Text style={styles.allDoneText}>Alles erledigt – dein Garten ist versorgt!</Text>
        </View>
      ) : (
        careSuggestions.map((s) => (
          <CareTaskItem key={s.id} suggestion={s} onDone={handleTaskDone} />
        ))
      )}

      {gardens.length > 0 && totalPlants === 0 && (
        <TouchableOpacity
          style={styles.addFirstPlant}
          onPress={() => router.push('/plant/add')}
          activeOpacity={0.8}
        >
          <Text style={styles.addFirstPlantText}>+ Erste Pflanze hinzufügen</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingTop: 60,
    paddingBottom: 32,
  },
  header: {
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  greeting: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  gardenName: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginTop: 2,
  },
  stats: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  statCardUrgent: {
    borderColor: Colors.danger + '55',
    backgroundColor: '#FEF2F2',
  },
  statNum: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.primary,
  },
  statLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '500',
    marginTop: 2,
  },
  weatherPlaceholder: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: 'dashed',
  },
  weatherPlaceholderText: {
    color: Colors.textSecondary,
    fontSize: 15,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 10,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  sectionCount: {
    backgroundColor: Colors.primary,
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
  },
  allDone: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  allDoneEmoji: {
    fontSize: 48,
  },
  allDoneText: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  addFirstPlant: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  addFirstPlantText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
