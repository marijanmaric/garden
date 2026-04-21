import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Plant } from '../types';
import { Colors, PLANT_EMOJIS, HEALTH_COLORS, HEALTH_LABELS } from '../constants';
import { formatDate } from '../services/careRules';

interface Props {
  plant: Plant;
  onPress: () => void;
}

export function PlantCard({ plant, onPress }: Props) {
  const emoji = PLANT_EMOJIS[plant.type] ?? '🌱';
  const healthColor = HEALTH_COLORS[plant.health_status] ?? Colors.success;
  const healthLabel = HEALTH_LABELS[plant.health_status] ?? plant.health_status;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.photoContainer}>
        {plant.photo_url ? (
          <Image source={{ uri: plant.photo_url }} style={styles.photo} />
        ) : (
          <View style={styles.emojiPlaceholder}>
            <Text style={styles.emojiLarge}>{emoji}</Text>
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {plant.name}
        </Text>
        {plant.species ? (
          <Text style={styles.species} numberOfLines={1}>
            {plant.species}
          </Text>
        ) : null}
        <View style={styles.row}>
          <View style={[styles.healthBadge, { backgroundColor: healthColor + '22' }]}>
            <View style={[styles.healthDot, { backgroundColor: healthColor }]} />
            <Text style={[styles.healthText, { color: healthColor }]}>{healthLabel}</Text>
          </View>
        </View>
        <Text style={styles.meta}>Gegossen: {formatDate(plant.last_watered_at)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  photoContainer: {
    width: 90,
    height: 90,
  },
  photo: {
    width: 90,
    height: 90,
  },
  emojiPlaceholder: {
    width: 90,
    height: 90,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiLarge: {
    fontSize: 40,
  },
  info: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
    gap: 3,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  species: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    marginTop: 4,
  },
  healthBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 4,
  },
  healthDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  healthText: {
    fontSize: 11,
    fontWeight: '600',
  },
  meta: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});
