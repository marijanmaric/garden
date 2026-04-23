import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Alert,
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useGardenStore } from '../../src/store/useGardenStore';
import { EmptyState } from '../../src/components/EmptyState';
import { Colors, ZONE_COLORS, ZONE_EMOJIS, ZONE_TYPE_LABELS } from '../../src/constants';
import { GardenZone } from '../../src/types';

const CANVAS_W = Dimensions.get('window').width - 32;
const CANVAS_H = CANVAS_W * 0.65;

export default function GardenScreen() {
  const router = useRouter();
  const {
    gardens,
    activeGardenId,
    activeGarden,
    setActiveGarden,
    zonesForGarden,
    deleteZone,
    plants,
  } = useGardenStore();

  const [selectedZone, setSelectedZone] = useState<GardenZone | null>(null);

  const garden = activeGarden();
  const zones = garden ? zonesForGarden(garden.id) : [];

  function handleDeleteZone(zone: GardenZone) {
    Alert.alert('Zone löschen', `"${zone.name}" wirklich löschen?`, [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Löschen',
        style: 'destructive',
        onPress: () => {
          deleteZone(zone.id);
          setSelectedZone(null);
        },
      },
    ]);
  }

  const gardenPlants = garden
    ? plants.filter((p) => p.garden_id === garden.id)
    : [];

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Gartenplan</Text>
        <TouchableOpacity
          style={styles.scanBtn}
          onPress={() => router.push('/onboarding/scan')}
          activeOpacity={0.8}
        >
          <Text style={styles.scanBtnText}>📸 Neu scannen</Text>
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
              <Text style={[styles.gardenTabText, g.id === activeGardenId && styles.gardenTabTextActive]}>
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
          subtitle="Scanne deinen Garten mit der Kamera und die KI erstellt automatisch eine digitale Karte."
          actionLabel="Garten scannen"
          onAction={() => router.push('/onboarding/scan')}
        />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Stats row */}
          <View style={styles.statsRow}>
            <Text style={styles.statsText}>
              🗺️ {zones.length} Zone{zones.length !== 1 ? 'n' : ''} ·{' '}
              🌱 {gardenPlants.length} Pflanze{gardenPlants.length !== 1 ? 'n' : ''}
            </Text>
            <TouchableOpacity onPress={() => router.push('/plant/add')} activeOpacity={0.8}>
              <Text style={styles.addPlantLink}>+ Pflanze</Text>
            </TouchableOpacity>
          </View>

          {/* Garden map canvas */}
          <View style={[styles.canvas, { height: CANVAS_H }]}>
            {zones.length === 0 ? (
              <View style={styles.emptyCanvas}>
                <Text style={styles.emptyCanvasText}>Noch keine Zonen · Garten scannen</Text>
              </View>
            ) : (
              zones.map((zone) => (
                <TouchableOpacity
                  key={zone.id}
                  style={[
                    styles.zone,
                    {
                      left: `${zone.x}%`,
                      top: `${zone.y}%`,
                      width: `${zone.width}%`,
                      height: `${zone.height}%`,
                      backgroundColor: ZONE_COLORS[zone.type] + 'BB',
                      borderColor: ZONE_COLORS[zone.type],
                    },
                    selectedZone?.id === zone.id && styles.zoneSelected,
                  ]}
                  onPress={() => setSelectedZone(zone)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.zoneEmoji}>{ZONE_EMOJIS[zone.type]}</Text>
                  <Text style={styles.zoneName} numberOfLines={2}>{zone.name}</Text>
                </TouchableOpacity>
              ))
            )}
          </View>

          {/* Zone list */}
          {zones.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Gartenzonen</Text>
              {zones.map((zone) => (
                <TouchableOpacity
                  key={zone.id}
                  style={styles.zoneCard}
                  onPress={() => setSelectedZone(zone)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.zoneCardBar, { backgroundColor: ZONE_COLORS[zone.type] }]} />
                  <View style={styles.zoneCardContent}>
                    <Text style={styles.zoneCardEmoji}>{ZONE_EMOJIS[zone.type]}</Text>
                    <View style={styles.zoneCardInfo}>
                      <Text style={styles.zoneCardName}>{zone.name}</Text>
                      <Text style={styles.zoneCardType}>{ZONE_TYPE_LABELS[zone.type]}</Text>
                      {zone.detected_plants.length > 0 && (
                        <Text style={styles.zoneCardPlants} numberOfLines={1}>
                          🌱 {zone.detected_plants.join(', ')}
                        </Text>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {zones.length === 0 && (
            <TouchableOpacity
              style={styles.rescanPrompt}
              onPress={() => router.push('/onboarding/scan')}
              activeOpacity={0.8}
            >
              <Text style={styles.rescanPromptEmoji}>📸</Text>
              <Text style={styles.rescanPromptText}>
                Jetzt Garten scannen und Zonen automatisch erkennen lassen
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}

      {/* Zone detail modal */}
      <Modal visible={!!selectedZone} transparent animationType="slide">
        <TouchableOpacity
          style={styles.modalOverlay}
          onPress={() => setSelectedZone(null)}
          activeOpacity={1}
        >
          <View style={styles.modalCard}>
            {selectedZone && (
              <>
                <Text style={styles.modalEmoji}>{ZONE_EMOJIS[selectedZone.type]}</Text>
                <Text style={styles.modalTitle}>{selectedZone.name}</Text>
                <Text style={styles.modalType}>{ZONE_TYPE_LABELS[selectedZone.type]}</Text>

                {selectedZone.description ? (
                  <Text style={styles.modalDesc}>{selectedZone.description}</Text>
                ) : null}

                {selectedZone.detected_plants.length > 0 && (
                  <View style={styles.modalPlants}>
                    <Text style={styles.modalPlantsTitle}>Erkannte Pflanzen</Text>
                    {selectedZone.detected_plants.map((p, i) => (
                      <Text key={i} style={styles.modalPlantItem}>🌱 {p}</Text>
                    ))}
                  </View>
                )}

                <View style={styles.modalBtns}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => setSelectedZone(null)}
                  >
                    <Text style={styles.modalCancelText}>Schließen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalDeleteBtn}
                    onPress={() => handleDeleteZone(selectedZone)}
                  >
                    <Text style={styles.modalDeleteText}>Löschen</Text>
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
  root: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
  },
  title: { fontSize: 26, fontWeight: '800', color: Colors.textPrimary },
  scanBtn: {
    backgroundColor: Colors.primary, borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  scanBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  gardenTabs: { paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  gardenTab: {
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7,
    backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border,
  },
  gardenTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  gardenTabText: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  gardenTabTextActive: { color: '#fff' },

  statsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, marginBottom: 10,
  },
  statsText: { fontSize: 13, color: Colors.textSecondary },
  addPlantLink: { fontSize: 13, color: Colors.primary, fontWeight: '700' },

  canvas: {
    marginHorizontal: 16, backgroundColor: '#E8F5E9',
    borderRadius: 16, overflow: 'hidden',
    borderWidth: 1.5, borderColor: Colors.border,
    marginBottom: 20, position: 'relative',
  },
  emptyCanvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyCanvasText: { color: Colors.textSecondary, fontSize: 13 },

  zone: {
    position: 'absolute', borderWidth: 1.5, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', padding: 4,
  },
  zoneSelected: { borderWidth: 3, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, elevation: 4 },
  zoneEmoji: { fontSize: 20 },
  zoneName: { fontSize: 9, color: '#fff', fontWeight: '700', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.4)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },

  section: { paddingHorizontal: 16, marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary, marginBottom: 10 },

  zoneCard: {
    flexDirection: 'row', backgroundColor: Colors.surface,
    borderRadius: 14, marginBottom: 8, overflow: 'hidden',
    borderWidth: 1, borderColor: Colors.border,
  },
  zoneCardBar: { width: 5 },
  zoneCardContent: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  zoneCardEmoji: { fontSize: 30 },
  zoneCardInfo: { flex: 1, gap: 2 },
  zoneCardName: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  zoneCardType: { fontSize: 12, color: Colors.textSecondary },
  zoneCardPlants: { fontSize: 12, color: Colors.primary, marginTop: 2 },

  rescanPrompt: {
    marginHorizontal: 16, marginBottom: 24,
    backgroundColor: Colors.primary + '15', borderRadius: 14,
    padding: 20, alignItems: 'center', gap: 10,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
  },
  rescanPromptEmoji: { fontSize: 40 },
  rescanPromptText: { fontSize: 14, color: Colors.primary, fontWeight: '600', textAlign: 'center' },

  modalOverlay: {
    flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 28, gap: 8,
  },
  modalEmoji: { fontSize: 52, textAlign: 'center' },
  modalTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary, textAlign: 'center' },
  modalType: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginBottom: 4 },
  modalDesc: { fontSize: 14, color: Colors.textPrimary, lineHeight: 20 },
  modalPlants: { gap: 4 },
  modalPlantsTitle: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  modalPlantItem: { fontSize: 14, color: Colors.textPrimary },
  modalBtns: { flexDirection: 'row', gap: 12, marginTop: 8 },
  modalCancelBtn: {
    flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1.5, borderColor: Colors.border,
  },
  modalCancelText: { color: Colors.textSecondary, fontWeight: '600', fontSize: 15 },
  modalDeleteBtn: {
    flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1.5, borderColor: Colors.danger,
  },
  modalDeleteText: { color: Colors.danger, fontWeight: '700', fontSize: 15 },
});
