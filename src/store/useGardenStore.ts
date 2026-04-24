import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { Garden, Plant, CareLog, WeatherData, CareSuggestion, GardenZone, PlacedElement } from '../types';
import { generateCareSuggestions } from '../services/careRules';

const HISTORY_LIMIT = 50;

interface GardenStore {
  // Auth
  session: Session | null;
  setSession: (session: Session | null) => void;

  // Gardens
  gardens: Garden[];
  activeGardenId: string | null;
  setGardens: (gardens: Garden[]) => void;
  addGarden: (garden: Garden) => void;
  updateGarden: (id: string, updates: Partial<Garden>) => void;
  deleteGarden: (id: string) => void;
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
  openAiApiKey: string;
  setOpenAiApiKey: (key: string) => void;

  // Zones
  zones: GardenZone[];
  addZone: (zone: GardenZone) => void;
  updateZone: (id: string, updates: Partial<GardenZone>) => void;
  deleteZone: (id: string) => void;
  zonesForGarden: (gardenId: string) => GardenZone[];
  setZones: (zones: GardenZone[]) => void;

  // Care suggestions (derived, not persisted)
  careSuggestions: CareSuggestion[];
  recomputeSuggestions: () => void;

  // ── Garden Designer ────────────────────────────────────────────────────────
  placedElements: PlacedElement[];
  // history stacks are in-memory only (not persisted)
  _undoStack: PlacedElement[][];
  _redoStack: PlacedElement[][];
  designerZoom: number;
  designerViewMode: 'top' | 'perspective';
  selectedElementId: string | null;

  placeElement: (el: PlacedElement) => void;
  removeElement: (uid: string) => void;
  clearDesigner: (gardenId: string) => void;
  placedForGarden: (gardenId: string) => PlacedElement[];

  designerUndo: () => void;
  designerRedo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  setDesignerZoom: (zoom: number) => void;
  setDesignerViewMode: (mode: 'top' | 'perspective') => void;
  setSelectedElementId: (id: string | null) => void;
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
      updateGarden: (id, updates) =>
        set((s) => ({
          gardens: s.gardens.map((g) => (g.id === id ? { ...g, ...updates } : g)),
        })),
      deleteGarden: (id) =>
        set((s) => {
          const remaining = s.gardens.filter((g) => g.id !== id);
          const newActiveId =
            s.activeGardenId === id
              ? (remaining[0]?.id ?? null)
              : s.activeGardenId;
          return {
            gardens: remaining,
            activeGardenId: newActiveId,
            plants: s.plants.filter((p) => p.garden_id !== id),
            careLogs: s.careLogs.filter((l) =>
              s.plants.some((p) => p.garden_id !== id && p.id === l.plant_id)
            ),
            zones: s.zones.filter((z) => z.garden_id !== id),
            placedElements: s.placedElements.filter((e) => e.gardenId !== id),
            _undoStack: [],
            _redoStack: [],
          };
        }),
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
      openAiApiKey: '',
      setOpenAiApiKey: (key) => set({ openAiApiKey: key }),

      zones: [],
      addZone: (zone) => set((s) => ({ zones: [...s.zones, zone] })),
      updateZone: (id, updates) =>
        set((s) => ({
          zones: s.zones.map((z) => (z.id === id ? { ...z, ...updates } : z)),
        })),
      deleteZone: (id) => set((s) => ({ zones: s.zones.filter((z) => z.id !== id) })),
      zonesForGarden: (gardenId) => get().zones.filter((z) => z.garden_id === gardenId),
      setZones: (zones) => set({ zones }),

      careSuggestions: [],
      recomputeSuggestions: () => {
        const { plants, activeGardenId, weather } = get();
        const gardenPlants = plants.filter((p) => p.garden_id === activeGardenId);
        const suggestions = generateCareSuggestions(gardenPlants, weather);
        set({ careSuggestions: suggestions });
      },

      // ── Garden Designer ──────────────────────────────────────────────────
      placedElements: [],
      _undoStack: [],
      _redoStack: [],
      designerZoom: 1,
      designerViewMode: 'top',
      selectedElementId: null,

      placedForGarden: (gardenId) =>
        get().placedElements.filter((e) => e.gardenId === gardenId),

      placeElement: (el) =>
        set((s) => {
          const snapshot = s.placedElements.filter((e) => e.gardenId === el.gardenId);
          return {
            placedElements: [...s.placedElements, el],
            _undoStack: [...s._undoStack.slice(-HISTORY_LIMIT + 1), snapshot],
            _redoStack: [],
          };
        }),

      removeElement: (uid) =>
        set((s) => {
          const target = s.placedElements.find((e) => e.id === uid);
          if (!target) return {};
          const snapshot = s.placedElements.filter((e) => e.gardenId === target.gardenId);
          return {
            placedElements: s.placedElements.filter((e) => e.id !== uid),
            _undoStack: [...s._undoStack.slice(-HISTORY_LIMIT + 1), snapshot],
            _redoStack: [],
          };
        }),

      clearDesigner: (gardenId) =>
        set((s) => {
          const snapshot = s.placedElements.filter((e) => e.gardenId === gardenId);
          return {
            placedElements: s.placedElements.filter((e) => e.gardenId !== gardenId),
            _undoStack: [...s._undoStack.slice(-HISTORY_LIMIT + 1), snapshot],
            _redoStack: [],
          };
        }),

      designerUndo: () =>
        set((s) => {
          if (s._undoStack.length === 0) return {};
          const prev = s._undoStack[s._undoStack.length - 1];
          const gardenId = prev[0]?.gardenId ?? s._undoStack.flat()[0]?.gardenId;
          const current = gardenId
            ? s.placedElements.filter((e) => e.gardenId === gardenId)
            : [];
          const others = gardenId
            ? s.placedElements.filter((e) => e.gardenId !== gardenId)
            : s.placedElements;
          return {
            placedElements: [...others, ...prev],
            _undoStack: s._undoStack.slice(0, -1),
            _redoStack: [...s._redoStack.slice(-HISTORY_LIMIT + 1), current],
          };
        }),

      designerRedo: () =>
        set((s) => {
          if (s._redoStack.length === 0) return {};
          const next = s._redoStack[s._redoStack.length - 1];
          const gardenId = next[0]?.gardenId ?? s._redoStack.flat()[0]?.gardenId;
          const current = gardenId
            ? s.placedElements.filter((e) => e.gardenId === gardenId)
            : [];
          const others = gardenId
            ? s.placedElements.filter((e) => e.gardenId !== gardenId)
            : s.placedElements;
          return {
            placedElements: [...others, ...next],
            _redoStack: s._redoStack.slice(0, -1),
            _undoStack: [...s._undoStack.slice(-HISTORY_LIMIT + 1), current],
          };
        }),

      canUndo: () => get()._undoStack.length > 0,
      canRedo: () => get()._redoStack.length > 0,

      setDesignerZoom: (zoom) => set({ designerZoom: zoom }),
      setDesignerViewMode: (mode) => set({ designerViewMode: mode }),
      setSelectedElementId: (id) => set({ selectedElementId: id }),
    }),
    {
      name: 'garden-store',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const dedup = <T extends { id: string }>(arr: T[]): T[] => {
          const seen = new Set<string>();
          return arr.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        };
        state.gardens = dedup(state.gardens);
        state.plants = dedup(state.plants);
        state.zones = dedup(state.zones);
        state.careLogs = dedup(state.careLogs);
        // Dedup placed elements by uid
        const seen = new Set<string>();
        state.placedElements = state.placedElements.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
        // History stacks are never persisted — reset on rehydration
        state._undoStack = [];
        state._redoStack = [];
      },
      partialize: (state) => ({
        gardens: state.gardens,
        activeGardenId: state.activeGardenId,
        plants: state.plants,
        careLogs: state.careLogs,
        locationLat: state.locationLat,
        locationLon: state.locationLon,
        plantIdApiKey: state.plantIdApiKey,
        anthropicApiKey: state.anthropicApiKey,
        openAiApiKey: state.openAiApiKey,
        zones: state.zones,
        weather: state.weather,
        weatherLastFetched: state.weatherLastFetched,
        placedElements: state.placedElements,
        designerZoom: state.designerZoom,
        designerViewMode: state.designerViewMode,
        // selectedElementId, _undoStack, _redoStack intentionally NOT persisted
      }),
    }
  )
);
