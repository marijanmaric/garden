import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { Garden, Plant, CareLog, WeatherData, CareSuggestion } from '../types';
import { generateCareSuggestions } from '../services/careRules';

interface GardenStore {
  // Auth
  session: Session | null;
  setSession: (session: Session | null) => void;

  // Gardens
  gardens: Garden[];
  activeGardenId: string | null;
  setGardens: (gardens: Garden[]) => void;
  addGarden: (garden: Garden) => void;
  setActiveGarden: (id: string) => void;
  activeGarden: () => Garden | null;

  // Plants
  plants: Plant[];
  setPlants: (plants: Plant[]) => void;
  addPlant: (plant: Plant) => void;
  updatePlant: (id: string, updates: Partial<Plant>) => void;
  deletePlant: (id: string) => void;
  plantsForGarden: (gardenId: string) => Plant[];

  // Care logs
  careLogs: CareLog[];
  addCareLog: (log: CareLog) => void;
  logsForPlant: (plantId: string) => CareLog[];

  // Weather
  weather: WeatherData | null;
  weatherLastFetched: string | null;
  setWeather: (weather: WeatherData) => void;

  // Location
  locationLat: number | null;
  locationLon: number | null;
  setLocation: (lat: number, lon: number) => void;

  // API keys
  plantIdApiKey: string;
  setPlantIdApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;

  // Care suggestions (derived, not persisted)
  careSuggestions: CareSuggestion[];
  recomputeSuggestions: () => void;
}

export const useGardenStore = create<GardenStore>()(
  persist(
    (set, get) => ({
      session: null,
      setSession: (session) => set({ session }),

      gardens: [],
      activeGardenId: null,
      setGardens: (gardens) => set({ gardens }),
      addGarden: (garden) =>
        set((s) => ({
          gardens: [...s.gardens, garden],
          activeGardenId: s.activeGardenId ?? garden.id,
        })),
      setActiveGarden: (id) => set({ activeGardenId: id }),
      activeGarden: () => {
        const { gardens, activeGardenId } = get();
        return gardens.find((g) => g.id === activeGardenId) ?? null;
      },

      plants: [],
      setPlants: (plants) => set({ plants }),
      addPlant: (plant) =>
        set((s) => {
          const plants = [...s.plants, plant];
          return { plants };
        }),
      updatePlant: (id, updates) =>
        set((s) => ({
          plants: s.plants.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),
      deletePlant: (id) =>
        set((s) => ({
          plants: s.plants.filter((p) => p.id !== id),
          careLogs: s.careLogs.filter((l) => l.plant_id !== id),
        })),
      plantsForGarden: (gardenId) => get().plants.filter((p) => p.garden_id === gardenId),

      careLogs: [],
      addCareLog: (log) =>
        set((s) => ({
          careLogs: [log, ...s.careLogs],
        })),
      logsForPlant: (plantId) =>
        get()
          .careLogs.filter((l) => l.plant_id === plantId)
          .sort((a, b) => new Date(b.logged_at).getTime() - new Date(a.logged_at).getTime()),

      weather: null,
      weatherLastFetched: null,
      setWeather: (weather) =>
        set({ weather, weatherLastFetched: new Date().toISOString() }),

      locationLat: null,
      locationLon: null,
      setLocation: (lat, lon) => set({ locationLat: lat, locationLon: lon }),

      plantIdApiKey: '',
      setPlantIdApiKey: (key) => set({ plantIdApiKey: key }),
      anthropicApiKey: '',
      setAnthropicApiKey: (key) => set({ anthropicApiKey: key }),

      careSuggestions: [],
      recomputeSuggestions: () => {
        const { plants, activeGardenId, weather } = get();
        const gardenPlants = plants.filter((p) => p.garden_id === activeGardenId);
        const suggestions = generateCareSuggestions(gardenPlants, weather);
        set({ careSuggestions: suggestions });
      },
    }),
    {
      name: 'garden-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        gardens: state.gardens,
        activeGardenId: state.activeGardenId,
        plants: state.plants,
        careLogs: state.careLogs,
        locationLat: state.locationLat,
        locationLon: state.locationLon,
        plantIdApiKey: state.plantIdApiKey,
        anthropicApiKey: state.anthropicApiKey,
        weather: state.weather,
        weatherLastFetched: state.weatherLastFetched,
      }),
    }
  )
);
