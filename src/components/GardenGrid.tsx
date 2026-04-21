import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Plant, Garden } from '../types';
import { Colors, PLANT_EMOJIS } from '../constants';

const CELL_SIZE = Math.floor((Dimensions.get('window').width - 32) / 10);

interface Props {
  garden: Garden;
  plants: Plant[];
  onCellPress: (x: number, y: number, plant?: Plant) => void;
  selectedCell?: { x: number; y: number } | null;
}

export function GardenGrid({ garden, plants, onCellPress, selectedCell }: Props) {
  const plantMap = new Map<string, Plant>();
  plants.forEach((p) => {
    if (p.grid_x !== null && p.grid_y !== null) {
      plantMap.set(`${p.grid_x}-${p.grid_y}`, p);
    }
  });

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.grid}>
          {Array.from({ length: garden.grid_rows }).map((_, row) => (
            <View key={row} style={styles.row}>
              {Array.from({ length: garden.grid_cols }).map((_, col) => {
                const plant = plantMap.get(`${col}-${row}`);
                const isSelected = selectedCell?.x === col && selectedCell?.y === row;
                const emoji = plant ? PLANT_EMOJIS[plant.type] ?? '🌱' : null;

                return (
                  <TouchableOpacity
                    key={col}
                    style={[
                      styles.cell,
                      plant && styles.cellOccupied,
                      isSelected && styles.cellSelected,
                    ]}
                    onPress={() => onCellPress(col, row, plant)}
                    activeOpacity={0.7}
                  >
                    {emoji ? (
                      <Text style={styles.cellEmoji}>{emoji}</Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grid: {
    padding: 4,
    gap: 3,
  },
  row: {
    flexDirection: 'row',
    gap: 3,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    backgroundColor: '#E8F5E9',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#C8E6C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellOccupied: {
    backgroundColor: '#A5D6A7',
    borderColor: Colors.primary,
  },
  cellSelected: {
    borderColor: Colors.primaryDark,
    borderWidth: 2,
    backgroundColor: '#B2DFDB',
  },
  cellEmoji: {
    fontSize: CELL_SIZE * 0.55,
  },
});
