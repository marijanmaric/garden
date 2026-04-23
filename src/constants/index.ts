import { PlantType, ZoneType } from '../types';

export const Colors = {
  primary: '#2D6A4F',
  primaryLight: '#52B788',
  primaryDark: '#1B4332',
  secondary: '#95D5B2',
  background: '#F0F7F0',
  surface: '#FFFFFF',
  textPrimary: '#1B2E2A',
  textSecondary: '#6B7280',
  border: '#D1E8D8',
  warning: '#F59E0B',
  danger: '#EF4444',
  success: '#10B981',
  info: '#3B82F6',
  overlay: 'rgba(0,0,0,0.5)',
};

export const PLANT_EMOJIS: Record<PlantType, string> = {
  tree: '🌳',
  flower: '🌸',
  vegetable: '🥦',
  herb: '🌿',
  grass: '🌱',
  cactus: '🌵',
  succulent: '🪴',
  shrub: '🌲',
  fruit: '🍎',
  other: '🌱',
};

export const PLANT_TYPE_LABELS: Record<PlantType, string> = {
  tree: 'Baum',
  flower: 'Blume',
  vegetable: 'Gemüse',
  herb: 'Kräuter',
  grass: 'Gras / Rasen',
  cactus: 'Kaktus',
  succulent: 'Sukkulente',
  shrub: 'Strauch',
  fruit: 'Obstpflanze',
  other: 'Sonstige',
};

export const HEALTH_LABELS: Record<string, string> = {
  healthy: 'Gesund',
  needs_attention: 'Aufmerksamkeit nötig',
  sick: 'Krank',
};

export const HEALTH_COLORS: Record<string, string> = {
  healthy: Colors.success,
  needs_attention: Colors.warning,
  sick: Colors.danger,
};

export const ACTION_LABELS: Record<string, string> = {
  watered: 'Gegossen',
  pruned: 'Beschnitten',
  fertilized: 'Gedüngt',
  health_check: 'Gesundheitscheck',
};

export const WMO_CODES: Record<number, string> = {
  0: 'Klar',
  1: 'Überwiegend klar',
  2: 'Teilweise bewölkt',
  3: 'Bewölkt',
  45: 'Neblig',
  48: 'Neblig',
  51: 'Leichter Nieselregen',
  53: 'Nieselregen',
  55: 'Starker Nieselregen',
  61: 'Leichter Regen',
  63: 'Regen',
  65: 'Starker Regen',
  71: 'Leichter Schnee',
  73: 'Schnee',
  75: 'Starker Schnee',
  80: 'Regenschauer',
  81: 'Regenschauer',
  82: 'Starke Regenschauer',
  95: 'Gewitter',
  96: 'Gewitter mit Hagel',
  99: 'Schweres Gewitter',
};

export const WMO_EMOJI: Record<number, string> = {
  0: '☀️',
  1: '🌤️',
  2: '⛅',
  3: '☁️',
  45: '🌫️',
  48: '🌫️',
  51: '🌦️',
  53: '🌦️',
  55: '🌧️',
  61: '🌧️',
  63: '🌧️',
  65: '🌧️',
  71: '🌨️',
  73: '❄️',
  75: '❄️',
  80: '🌦️',
  81: '🌧️',
  82: '⛈️',
  95: '⛈️',
  96: '⛈️',
  99: '⛈️',
};
