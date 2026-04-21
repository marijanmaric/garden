import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useGardenStore } from '../../src/store/useGardenStore';
import { GardenGrid } from '../../src/components/GardenGrid';
import { EmptyState } from '../../src/components/EmptyState';
import { Colors, PLANT_EMOJIS, HEALTH_COLORS } from '../../src/constants';
import { Plant } from '../../src/types';

export default function GardenScreen() {
  const router = useRouter();
  const { gardens, activeGardenId, activeGarden, addGarden, setActiveGarden, plants, plantsForGarden } =
    useGardenStore();

  const [showNewGarden, setShowNewGarden] = useState(false);
  const [newGardenName, setNewGardenName] = useState('');
  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [cellPlant, setCellPlant] = useState<Plant | null>(null);
  const [showCellModal, setShowCellModal] = useState(false);

  const garden = activeGarden();
  const gardenPlants = garden ? plantsForGarden(garden.id) : [];

  function handleCreateGarden() {
    if (!newGardenName.trim()) {
      Alert.alert('Fehler', 'Bitte Gartenname eingeben');
      return;
    }
    const g = {
      id: `garden-${Date.now()}`,
      user_id: 'local',
      name: newGardenName.trim(),
      location_lat: null,
      location_lon: null,
      grid_rows: 10,
      grid_cols: 10,
      created_at: new Date().toISOString(),
    };
    addGarden(g);
    setNewGardenName('');
    setShowNewGarden(false);
  }

  function handleCellPress(x: number, y: number, plant?: Plant) {
    setSelectedCell({ x, y });
    if (plant) {
      setCellPlant(plant);
      setShowCellModal(true);
    } else {
      // Empty cell – navigate to add plant with pre-selected position
      router.push({ pathname: '/plant/add', params: { gridX: x, gridY: y, gardenId: garden?.id } });
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Gartenplan</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setShowNewGarden(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.addBtnText}>+ Garten</Text>
        </TouchableOpacity>
      </View>

      {/* Garden selector */}
      {gardens.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.gardenTabs}
        >
          {gardens.map((g) => (
            <TouchableOpacity
              key={g.id}
              style={[styles.gardenTab, g.id === activeGardenId && styles.gardenTabActive]}
              onPress={() => setActiveGarden(g.id)}
            >
              <Text
                style={[styles.gardenTabText, g.id === activeGardenId && styles.gardenTabTextActive]}
              >
                {g.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {!garden ? (
        <EmptyState
          emoji="🏡"
          title="Noch kein Garten"
          subtitle="Erstelle deinen ersten digitalen Garten und platziere deine Pflanzen auf dem Plan."
          actionLabel="Garten anlegen"
          onAction={() => setShowNewGarden(true)}
        />
      ) : (
        <>
          <View style={styles.gridInfo}>
            <Text style={styles.gridInfoText}>
              🌱 {gardenPlants.length} Pflanze{gardenPlants.length !== 1 ? 'n' : ''} ·{' '}
              {garden.grid_rows}×{garden.grid_cols} Felder
            </Text>
            <TouchableOpacity onPress={() => router.push('/plant/add')} activeOpacity={0.8}>
              <Text style={styles.addPlantLink}>+ Pflanze</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.gridContainer}>
            <GardenGrid
              garden={garden}
              plants={gardenPlants}
              onCellPress={handleCellPress}
              selectedCell={selectedCell}
            />
          </View>

          <View style={styles.legend}>
            <Text style={styles.legendTitle}>Legende</Text>
            <View style={styles.legendItems}>
              {gardenPlants.slice(0, 6).map((p) => (
                <View key={p.id} style={styles.legendItem}>
                  <Text style={styles.legendEmoji}>{PLANT_EMOJIS[p.type] ?? '🌱'}</Text>
                  <Text style={styles.legendName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <View
                    style={[styles.legendDot, { backgroundColor: HEALTH_COLORS[p.health_status] }]}
                  />
                </View>
              ))}
            </View>
          </View>
        </>
      )}

      {/* New garden modal */}
      <Modal visible={showNewGarden} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Neuen Garten anlegen</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="z.B. Hintergarten, Balkon, Gewächshaus…"
              value={newGardenName}
              onChangeText={setNewGardenName}
              autoFocus
              placeholderTextColor={Colors.textSecondary}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowNewGarden(false)}
              >
                <Text style={styles.modalCancelText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmBtn} onPress={handleCreateGarden}>
                <Text style={styles.modalConfirmText}>Anlegen</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Cell plant detail modal */}
      <Modal visible={showCellModal} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          onPress={() => setShowCellModal(false)}
          activeOpacity={1}
        >
          <View style={styles.modalCard}>
            {cellPlant && (
              <>
                <Text style={styles.cellModalEmoji}>{PLANT_EMOJIS[cellPlant.type] ?? '🌱'}</Text>
                <Text style={styles.modalTitle}>{cellPlant.name}</Text>
                {cellPlant.species ? (
                  <Text style={styles.cellModalSpecies}>{cellPlant.species}</Text>
                ) : null}
                <View style={styles.modalBtns}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => setShowCellModal(false)}
                  >
                    <Text style={styles.modalCancelText}>Schließen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalConfirmBtn}
                    onPress={() => {
                      setShowCellModal(false);
                      router.push(`/plant/${cellPlant.id}`);
                    }}
                  >
                    <Text style={styles.modalConfirmText}>Details</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  addBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  addBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  gardenTabs: {
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 12,
  },
  gardenTab: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  gardenTabActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  gardenTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  gardenTabTextActive: {
    color: '#fff',
  },
  gridInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  gridInfoText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  addPlantLink: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: '700',
  },
  gridContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  legend: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  legendTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  legendItems: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.background,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  legendEmoji: {
    fontSize: 14,
  },
  legendName: {
    fontSize: 12,
    color: Colors.textPrimary,
    maxWidth: 70,
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 28,
    gap: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  modalBtns: {
    flexDirection: 'row',
    gap: 12,
  },
  modalCancelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  modalCancelText: {
    color: Colors.textSecondary,
    fontWeight: '600',
    fontSize: 15,
  },
  modalConfirmBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: Colors.primary,
  },
  modalConfirmText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  cellModalEmoji: {
    fontSize: 48,
    textAlign: 'center',
  },
  cellModalSpecies: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
