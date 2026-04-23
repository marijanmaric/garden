import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
  ScrollView,
  Dimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { requestCameraPermission } from '../../src/utils/permissions';
import { useGardenStore } from '../../src/store/useGardenStore';
import { scanGardenPhoto, DetectedPlant } from '../../src/services/gardenScan';
import { Colors, PLANT_EMOJIS } from '../../src/constants';

const GRID_SIZE = Math.floor((Dimensions.get('window').width - 48) / 10);

type Step = 'capture' | 'analyzing' | 'results';

export default function GardenScanScreen() {
  const router = useRouter();
  const { anthropicApiKey, activeGardenId, addPlant, recomputeSuggestions } = useGardenStore();

  const [step, setStep] = useState<Step>('capture');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedPlant[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  async function pickImage(fromCamera: boolean) {
    const fn = fromCamera
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;

    const result = await fn({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    if (!asset.base64) {
      Alert.alert('Fehler', 'Bild konnte nicht geladen werden.');
      return;
    }

    if (!anthropicApiKey) {
      Alert.alert(
        'API-Key fehlt',
        'Bitte einen Anthropic API-Key in den Einstellungen hinterlegen.'
      );
      return;
    }

    setPhotoUri(asset.uri);
    setStep('analyzing');

    try {
      const plants = await scanGardenPhoto(asset.base64, anthropicApiKey);
      if (plants.length === 0) {
        Alert.alert('Keine Pflanzen gefunden', 'Versuch ein klareres Foto zu machen.');
        setStep('capture');
        return;
      }
      setDetected(plants);
      setSelected(new Set(plants.map((_, i) => i)));
      setStep('results');
    } catch (err: any) {
      Alert.alert('Analyse fehlgeschlagen', err.message ?? 'Unbekannter Fehler');
      setStep('capture');
    }
  }

  function toggleSelect(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }

  function confirmPlants() {
    if (!activeGardenId) {
      Alert.alert('Fehler', 'Kein aktiver Garten. Bitte zuerst einen Garten anlegen.');
      return;
    }

    const now = new Date().toISOString();
    detected.forEach((p, i) => {
      if (!selected.has(i)) return;
      addPlant({
        id: `plant-scan-${Date.now()}-${i}`,
        garden_id: activeGardenId,
        user_id: 'local',
        name: p.name,
        species: p.species || null,
        type: p.type,
        grid_x: p.grid_x,
        grid_y: p.grid_y,
        photo_url: null,
        watering_interval_days: 3,
        last_watered_at: null,
        health_status: 'healthy',
        care_notes: null,
        created_at: now,
      });
    });

    recomputeSuggestions();
    Alert.alert(
      'Garten angelegt ✅',
      `${selected.size} Pflanze${selected.size !== 1 ? 'n' : ''} zum Garten hinzugefügt.`,
      [{ text: 'OK', onPress: () => router.replace('/(tabs)/garden') }]
    );
  }

  // ── Grid preview ──────────────────────────────────────────────
  const plantMap = new Map<string, DetectedPlant>();
  detected.forEach((p, i) => {
    if (selected.has(i)) plantMap.set(`${p.grid_x}-${p.grid_y}`, p);
  });

  function renderGrid() {
    return (
      <View style={styles.grid}>
        {Array.from({ length: 10 }).map((_, row) => (
          <View key={row} style={styles.gridRow}>
            {Array.from({ length: 10 }).map((_, col) => {
              const plant = plantMap.get(`${col}-${row}`);
              return (
                <View key={col} style={[styles.cell, plant && styles.cellOccupied]}>
                  {plant ? (
                    <Text style={styles.cellEmoji}>{PLANT_EMOJIS[plant.type] ?? '🌱'}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────────
  if (step === 'capture') {
    return (
      <View style={styles.root}>
        <View style={styles.hero}>
          {photoUri ? (
            <Image source={{ uri: photoUri }} style={styles.heroImage} />
          ) : (
            <View style={styles.heroPlaceholder}>
              <Text style={styles.heroEmoji}>📸</Text>
              <Text style={styles.heroText}>Foto deines Gartens aufnehmen</Text>
              <Text style={styles.heroSub}>
                KI erkennt Pflanzen und platziert sie automatisch im Raster
              </Text>
            </View>
          )}
        </View>

        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.photoBtn} onPress={() => pickImage(true)} activeOpacity={0.8}>
            <Text style={styles.photoBtnText}>📷  Kamera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.photoBtn, styles.photoBtnOutline]} onPress={() => pickImage(false)} activeOpacity={0.8}>
            <Text style={[styles.photoBtnText, styles.photoBtnOutlineText]}>🖼️  Galerie</Text>
          </TouchableOpacity>
        </View>

        {!anthropicApiKey && (
          <View style={styles.warningBadge}>
            <Text style={styles.warningText}>
              ⚠️ Kein Anthropic API-Key – in Einstellungen hinterlegen
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (step === 'analyzing') {
    return (
      <View style={[styles.root, styles.center]}>
        {photoUri && <Image source={{ uri: photoUri }} style={styles.analyzeThumb} />}
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: 32 }} />
        <Text style={styles.analyzingText}>KI analysiert deinen Garten…</Text>
        <Text style={styles.analyzingSub}>Pflanzen werden erkannt und positioniert</Text>
      </View>
    );
  }

  // step === 'results'
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.resultsContent}>
      <Text style={styles.resultsTitle}>
        {detected.length} Pflanze{detected.length !== 1 ? 'n' : ''} erkannt
      </Text>
      <Text style={styles.resultsSub}>
        {selected.size} ausgewählt · Tippe zum De-/Aktivieren
      </Text>

      {renderGrid()}

      <View style={styles.plantList}>
        {detected.map((p, i) => {
          const isSelected = selected.has(i);
          return (
            <TouchableOpacity
              key={i}
              style={[styles.plantRow, !isSelected && styles.plantRowDimmed]}
              onPress={() => toggleSelect(i)}
              activeOpacity={0.7}
            >
              <Text style={styles.plantRowEmoji}>{PLANT_EMOJIS[p.type] ?? '🌱'}</Text>
              <View style={styles.plantRowInfo}>
                <Text style={styles.plantRowName}>{p.name}</Text>
                {p.species ? <Text style={styles.plantRowSpecies}>{p.species}</Text> : null}
                <Text style={styles.plantRowMeta}>
                  Position ({p.grid_x}, {p.grid_y}) · {p.confidence}% sicher
                </Text>
              </View>
              <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
                {isSelected && <Text style={styles.checkmark}>✓</Text>}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity
        style={[styles.confirmBtn, selected.size === 0 && styles.confirmBtnDisabled]}
        onPress={confirmPlants}
        disabled={selected.size === 0}
        activeOpacity={0.8}
      >
        <Text style={styles.confirmBtnText}>
          {selected.size} Pflanze{selected.size !== 1 ? 'n' : ''} zum Garten hinzufügen ✅
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.rescanBtn} onPress={() => setStep('capture')} activeOpacity={0.8}>
        <Text style={styles.rescanBtnText}>Neu scannen</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center' },

  hero: { flex: 1 },
  heroImage: { width: '100%', height: 320 },
  heroPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 40,
  },
  heroEmoji: { fontSize: 72 },
  heroText: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  heroSub: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },

  btnRow: { flexDirection: 'row', gap: 12, padding: 20 },
  photoBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  photoBtnOutline: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: Colors.primary,
  },
  photoBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  photoBtnOutlineText: { color: Colors.primary },

  warningBadge: {
    marginHorizontal: 20,
    marginBottom: 20,
    backgroundColor: Colors.warning + '20',
    borderRadius: 10,
    padding: 12,
  },
  warningText: { color: Colors.warning, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  analyzeThumb: {
    width: 200,
    height: 200,
    borderRadius: 16,
    opacity: 0.7,
  },
  analyzingText: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: 16,
  },
  analyzingSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 6,
  },

  resultsContent: { paddingBottom: 48 },
  resultsTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  resultsSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    paddingHorizontal: 20,
    marginBottom: 16,
    marginTop: 2,
  },

  grid: { marginHorizontal: 20, marginBottom: 20, gap: 2 },
  gridRow: { flexDirection: 'row', gap: 2 },
  cell: {
    width: GRID_SIZE,
    height: GRID_SIZE,
    backgroundColor: '#E8F5E9',
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellOccupied: { backgroundColor: '#A5D6A7' },
  cellEmoji: { fontSize: GRID_SIZE * 0.6 },

  plantList: { gap: 8, marginHorizontal: 16, marginBottom: 16 },
  plantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  plantRowDimmed: { opacity: 0.4 },
  plantRowEmoji: { fontSize: 32 },
  plantRowInfo: { flex: 1, gap: 2 },
  plantRowName: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  plantRowSpecies: { fontSize: 12, color: Colors.textSecondary, fontStyle: 'italic' },
  plantRowMeta: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },

  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700' },

  confirmBtn: {
    backgroundColor: Colors.primary,
    marginHorizontal: 16,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 10,
  },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  rescanBtn: {
    marginHorizontal: 16,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  rescanBtnText: { color: Colors.textSecondary, fontWeight: '600', fontSize: 14 },
});
