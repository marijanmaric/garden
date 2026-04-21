import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CareSuggestion, Priority } from '../types';
import { Colors } from '../constants';

const PRIORITY_COLORS: Record<Priority, string> = {
  high: Colors.danger,
  medium: Colors.warning,
  low: Colors.primaryLight,
};

const PRIORITY_BG: Record<Priority, string> = {
  high: '#FEF2F2',
  medium: '#FFFBEB',
  low: '#ECFDF5',
};

interface Props {
  suggestion: CareSuggestion;
  onDone: (suggestion: CareSuggestion) => void;
}

export function CareTaskItem({ suggestion, onDone }: Props) {
  return (
    <View style={[styles.card, { backgroundColor: PRIORITY_BG[suggestion.priority] }]}>
      <View style={[styles.bar, { backgroundColor: PRIORITY_COLORS[suggestion.priority] }]} />
      <View style={styles.content}>
        <View style={styles.top}>
          <Text style={styles.emoji}>{suggestion.plant_emoji}</Text>
          <View style={styles.texts}>
            <Text style={styles.plantName}>{suggestion.plant_name}</Text>
            <Text style={styles.action}>{suggestion.action}</Text>
            <Text style={styles.reason}>{suggestion.reason}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.doneBtn, { backgroundColor: PRIORITY_COLORS[suggestion.priority] }]}
          onPress={() => onDone(suggestion)}
          activeOpacity={0.7}
        >
          <Text style={styles.doneBtnText}>Erledigt ✓</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    marginBottom: 10,
    marginHorizontal: 16,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  bar: {
    width: 5,
  },
  content: {
    flex: 1,
    padding: 14,
    gap: 10,
  },
  top: {
    flexDirection: 'row',
    gap: 12,
  },
  emoji: {
    fontSize: 32,
    alignSelf: 'center',
  },
  texts: {
    flex: 1,
    gap: 2,
  },
  plantName: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  action: {
    fontSize: 15,
    color: Colors.textPrimary,
    fontWeight: '700',
  },
  reason: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  doneBtn: {
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    alignSelf: 'flex-end',
  },
  doneBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
