import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { requestCameraPermission } from '../../src/utils/permissions';
import { useGardenStore } from '../../src/store/useGardenStore';
import { generateId } from '../../src/utils/generateId';
import { analyzeGardenPhotos, GardenAnalysisResult } from '../../src/services/gardenAnalysis';
import { Colors, ZONE_COLORS, ZONE_EMOJIS, ZONE_TYPE_LABELS } from '../../src/constants';

const CANVAS_W = Dimensions.get('window').width - 48;
const CANVAS_H = CANVAS_W * 0.65;
const MAX_PHOTOS = 4;

type Step = 'intro' | 'capture' | 'analyzing' | 'results';

const ANALYSIS_STEPS = [
  'Fotos werden hochgeladen…',
  'Pflanzen werden erkannt…',
  'Gartenzonen werden kartiert…',
  'Digitaler Zwilling wird erstellt…',
];

export default function OnboardingScanScreen() {
  const router = useRouter();
  const { openAiApiKey, addGarden, setActiveGarden, addZone, addPlant, recomputeSuggestions } =
    useGardenStore();

  const [step, setStep] = useState<Step>('intro');
  const [photos, setPhotos] = useState<Array<{ uri: string; base64: string }>>([]);
  const [analysisStep, setAnalysisStep] = useState(0);
  const [result, setResult] = useState<GardenAnalysisResult | null>(null);

  async function pickPhoto() {
    if (photos.length >= MAX_PHOTOS) return;
    const granted = await requestCameraPermission();
    if (!granted) return;
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      allowsEditing: false,
    });
    if (res.canceled || !res.assets[0]?.base64) return;
    setPhotos((prev) => [
      ...prev,
      { uri: res.assets[0].uri, base64: res.assets[0].base64! },
    ]);
  }

  async function pickFromGallery() {
    if (photos.length >= MAX_PHOTOS) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: MAX_PHOTOS - photos.length,
    });
    if (res.canceled) return;
    const newPhotos = res.assets
      .filter((a) => a.base64)
      .map((a) => ({ uri: a.uri, base64: a.base64! }));
    setPhotos((prev) => [...prev, ...newPhotos].slice(0, MAX_PHOTOS));
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  async function startAnalysis() {
    if (photos.length === 0) {
      Alert.alert('Keine Fotos', 'Bitte mindestens ein Foto aufnehmen.');
      return;
    }
    if (!openAiApiKey) {
      Alert.alert(
        'OpenAI API-Key fehlt',
        'Bitte einen OpenAI API-Key in den Einstellungen hinterlegen.'
      );
      return;
    }

    setStep('analyzing');
    setAnalysisStep(0);

    const timer = setInterval(() => {
      setAnalysisStep((n) => Math.min(n + 1, ANALYSIS_STEPS.length - 1));
    }, 1800);

    try {
      const analysisResult = await analyzeGardenPhotos(
        photos.map((p) => p.base64),
        openAiApiKey
      );
      clearInterval(timer);
      setAnalysisStep(ANALYSIS_STEPS.length - 1);
      setResult(analysisResult);
      setTimeout(() => setStep('results'), 600);
    } catch (err: any) {
      clearInterval(timer);
      Alert.alert('Analyse fehlgeschlagen', err.message ?? 'Unbekannter Fehler');
      setStep('capture');
    }
  }

  function confirmGarden() {
    if (!result) return;

    const gardenId = generateId('garden');
    const now = new Date().toISOString();

    addGarden({
      id: gardenId,
      user_id: 'local',
      name: 'Mein Garten',
      location_lat: null,
      location_lon: null,
      grid_rows: 10,
      grid_cols: 10,
      created_at: now,
    });
    setActiveGarden(gardenId);

    result.zones.forEach((z, i) => {
      const zoneId = generateId('zone');
      addZone({
        id: zoneId,
        garden_id: gardenId,
        name: z.name,
        type: z.type,
        x: z.x,
        y: z.y,
        width: z.width,
        height: z.height,
        detected_plants: z.detected_plants,
        description: z.description,
        created_at: now,
      });

      z.detected_plants.slice(0, 1).forEach((plantName, pi) => {
        addPlant({
          id: generateId('plant'),
          garden_id: gardenId,
          user_id: 'local',
          name: plantName,
          species: null,
          type: z.type === 'tree' ? 'tree'
              : z.type === 'flower_bed' ? 'flower'
              : z.type === 'vegetable_patch' ? 'vegetable'
              : z.type === 'fruit' ? 'fruit'
              : z.type === 'shrub' ? 'shrub'
              : 'other',
          grid_x: Math.round(z.x / 10),
          grid_y: Math.round(z.y / 10),
          photo_url: null,
          watering_interval_days: 3,
          last_watered_at: null,
          health_status: 'healthy',
          care_notes: z.description,
          created_at: now,
        });
      });
    });

    recomputeSuggestions();
    router.replace('/(tabs)/garden');
  }

  // ── Intro ──────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.introContent}>
        <Text style={styles.introEmoji}>🌿</Text>
        <Text style={styles.introTitle}>Dein digitaler Garten</Text>
        <Text style={styles.introSub}>
          Filme oder fotografiere deinen Garten aus verschiedenen Winkeln.
          Die KI erstellt automatisch eine digitale Karte mit allen Pflanzen und Beeten.
        </Text>

        <View style={styles.stepsContainer}>
          {[
            { emoji: '📸', text: 'Bis zu 4 Fotos aufnehmen' },
            { emoji: '🤖', text: 'KI erkennt Pflanzen & Zonen' },
            { emoji: '🗺️', text: 'Digitale Gartenkarte wird erstellt' },
            { emoji: '💧', text: 'Smarte Pflegetipps & Erinnerungen' },
          ].map((s, i) => (
            <View key={i} style={styles.stepRow}>
              <Text style={styles.stepEmoji}>{s.emoji}</Text>
              <Text style={styles.stepText}>{s.text}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => setStep('capture')}
          activeOpacity={0.8}
        >
          <Text style={styles.primaryBtnText}>Garten scannen starten</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.skipBtn}
          onPress={() => router.replace('/(tabs)')}
          activeOpacity={0.8}
        >
          <Text style={styles.skipBtnText}>Überspringen</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Capture ────────────────────────────────────────────────────
  if (step === 'capture') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.captureContent}>
        <Text style={styles.captureTitle}>Gartenfotos aufnehmen</Text>
        <Text style={styles.captureSub}>
          {photos.length}/{MAX_PHOTOS} Fotos · Verschiedene Winkel & Bereiche
        </Text>

        <View style={styles.photoGrid}>
          {Array.from({ length: MAX_PHOTOS }).map((_, i) => {
            const photo = photos[i];
            return photo ? (
              <View key={i} style={styles.photoThumb}>
                <Image source={{ uri: photo.uri }} style={styles.photoThumbImg} />
                <TouchableOpacity
                  style={styles.photoRemove}
                  onPress={() => removePhoto(i)}
                >
                  <Text style={styles.photoRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                key={i}
                style={styles.photoSlot}
                onPress={pickPhoto}
                activeOpacity={0.7}
              >
                <Text style={styles.photoSlotPlus}>+</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.captureBtns}>
          <TouchableOpacity
            style={[styles.captureBtn, photos.length >= MAX_PHOTOS && styles.captureBtnDisabled]}
            onPress={pickPhoto}
            disabled={photos.length >= MAX_PHOTOS}
            activeOpacity={0.8}
          >
            <Text style={styles.captureBtnText}>📷  Kamera</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.captureBtn, styles.captureBtnOutline, photos.length >= MAX_PHOTOS && styles.captureBtnDisabled]}
            onPress={pickFromGallery}
            disabled={photos.length >= MAX_PHOTOS}
            activeOpacity={0.8}
          >
            <Text style={[styles.captureBtnText, { color: Colors.primary }]}>🖼️  Galerie</Text>
          </TouchableOpacity>
        </View>

        {photos.length > 0 && (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={startAnalysis}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>
              KI-Analyse starten ({photos.length} Foto{photos.length !== 1 ? 's' : ''})
            </Text>
          </TouchableOpacity>
        )}

        {!openAiApiKey && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>
              ⚠️ Kein OpenAI API-Key – in Einstellungen hinterlegen
            </Text>
          </View>
        )}
      </ScrollView>
    );
  }

  // ── Analyzing ──────────────────────────────────────────────────
  if (step === 'analyzing') {
    return (
      <View style={[styles.root, styles.analyzeCenter]}>
        <Text style={styles.analyzeEmoji}>🤖</Text>
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: 8 }} />
        <Text style={styles.analyzeTitle}>Garten wird analysiert…</Text>
        <View style={styles.analyzeSteps}>
          {ANALYSIS_STEPS.map((s, i) => (
            <View key={i} style={styles.analyzeStepRow}>
              <Text style={styles.analyzeStepDot}>
                {i < analysisStep ? '✅' : i === analysisStep ? '🔄' : '⏳'}
              </Text>
              <Text
                style={[
                  styles.analyzeStepText,
                  i <= analysisStep && styles.analyzeStepTextActive,
                ]}
              >
                {s}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // ── Results ────────────────────────────────────────────────────
  if (!result) return null;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.resultsContent}>
      <Text style={styles.resultsTitle}>Garten erkannt 🎉</Text>
      <Text style={styles.resultsSub}>{result.overall_description}</Text>
      <Text style={styles.resultsMeta}>
        ca. {result.garden_width_m}m × {result.garden_height_m}m ·{' '}
        {result.zones.length} Zone{result.zones.length !== 1 ? 'n' : ''}
      </Text>

      {/* Mini zone map */}
      <View style={[styles.mapCanvas, { height: CANVAS_H }]}>
        {result.zones.map((z, i) => (
          <View
            key={i}
            style={[
              styles.mapZone,
              {
                left: `${z.x}%`,
                top: `${z.y}%`,
                width: `${z.width}%`,
                height: `${z.height}%`,
                backgroundColor: ZONE_COLORS[z.type] + 'CC',
                borderColor: ZONE_COLORS[z.type],
              },
            ]}
          >
            <Text style={styles.mapZoneEmoji}>{ZONE_EMOJIS[z.type]}</Text>
            <Text style={styles.mapZoneName} numberOfLines={1}>{z.name}</Text>
          </View>
        ))}
      </View>

      {/* Zone list */}
      <View style={styles.zoneList}>
        {result.zones.map((z, i) => (
          <View key={i} style={styles.zoneRow}>
            <View
              style={[styles.zoneColorDot, { backgroundColor: ZONE_COLORS[z.type] }]}
            />
            <View style={styles.zoneRowInfo}>
              <Text style={styles.zoneRowName}>
                {ZONE_EMOJIS[z.type]} {z.name}
              </Text>
              <Text style={styles.zoneRowType}>{ZONE_TYPE_LABELS[z.type]}</Text>
              {z.detected_plants.length > 0 && (
                <Text style={styles.zoneRowPlants}>
                  🌱 {z.detected_plants.join(', ')}
                </Text>
              )}
            </View>
          </View>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={confirmGarden} activeOpacity={0.8}>
        <Text style={styles.primaryBtnText}>Garten bestätigen & öffnen ✅</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.skipBtn}
        onPress={() => { setPhotos([]); setStep('capture'); }}
        activeOpacity={0.8}
      >
        <Text style={styles.skipBtnText}>Neu scannen</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  // Intro
  introContent: { alignItems: 'center', padding: 24, paddingTop: 40, paddingBottom: 48 },
  introEmoji: { fontSize: 72, marginBottom: 16 },
  introTitle: { fontSize: 26, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  introSub: {
    fontSize: 15, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginTop: 12, marginBottom: 28,
  },
  stepsContainer: { width: '100%', gap: 14, marginBottom: 32 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepEmoji: { fontSize: 28, width: 40, textAlign: 'center' },
  stepText: { fontSize: 15, color: Colors.textPrimary, fontWeight: '500', flex: 1 },

  // Capture
  captureContent: { padding: 20, paddingBottom: 48 },
  captureTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 4 },
  captureSub: { fontSize: 13, color: Colors.textSecondary, marginBottom: 20 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  photoThumb: { width: '47%', aspectRatio: 1, borderRadius: 14, overflow: 'hidden' },
  photoThumbImg: { width: '100%', height: '100%' },
  photoRemove: {
    position: 'absolute', top: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12,
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
  },
  photoRemoveText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  photoSlot: {
    width: '47%', aspectRatio: 1, borderRadius: 14,
    backgroundColor: Colors.surface, borderWidth: 2,
    borderColor: Colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  photoSlotPlus: { fontSize: 36, color: Colors.textSecondary },
  captureBtns: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  captureBtn: {
    flex: 1, backgroundColor: Colors.primary, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  captureBtnOutline: {
    backgroundColor: 'transparent', borderWidth: 2, borderColor: Colors.primary,
  },
  captureBtnDisabled: { opacity: 0.4 },
  captureBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  warningBox: {
    backgroundColor: Colors.warning + '20', borderRadius: 10,
    padding: 12, marginTop: 12,
  },
  warningText: { color: Colors.warning, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  // Analyzing
  analyzeCenter: { alignItems: 'center', justifyContent: 'center' },
  analyzeEmoji: { fontSize: 64 },
  analyzeTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginTop: 16, marginBottom: 24 },
  analyzeSteps: { gap: 14, width: '80%' },
  analyzeStepRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  analyzeStepDot: { fontSize: 18, width: 28 },
  analyzeStepText: { fontSize: 14, color: Colors.textSecondary, flex: 1 },
  analyzeStepTextActive: { color: Colors.textPrimary, fontWeight: '600' },

  // Results
  resultsContent: { padding: 20, paddingBottom: 48 },
  resultsTitle: { fontSize: 24, fontWeight: '800', color: Colors.textPrimary, marginBottom: 6 },
  resultsSub: { fontSize: 14, color: Colors.textSecondary, lineHeight: 20, marginBottom: 4 },
  resultsMeta: { fontSize: 12, color: Colors.primary, fontWeight: '600', marginBottom: 16 },
  mapCanvas: {
    width: '100%', backgroundColor: '#E8F5E9',
    borderRadius: 16, overflow: 'hidden',
    borderWidth: 1.5, borderColor: Colors.border,
    marginBottom: 20, position: 'relative',
  },
  mapZone: {
    position: 'absolute', borderWidth: 1.5, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', padding: 2,
  },
  mapZoneEmoji: { fontSize: 16 },
  mapZoneName: { fontSize: 8, color: '#fff', fontWeight: '700', textAlign: 'center' },
  zoneList: { gap: 10, marginBottom: 24 },
  zoneRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: Colors.surface, borderRadius: 14,
    padding: 14, borderWidth: 1, borderColor: Colors.border,
  },
  zoneColorDot: { width: 14, height: 14, borderRadius: 7, marginTop: 3 },
  zoneRowInfo: { flex: 1, gap: 2 },
  zoneRowName: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  zoneRowType: { fontSize: 12, color: Colors.textSecondary },
  zoneRowPlants: { fontSize: 12, color: Colors.primary, marginTop: 2 },

  // Shared
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: 14,
    paddingVertical: 15, alignItems: 'center', marginBottom: 10, width: '100%',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  skipBtn: {
    borderRadius: 14, paddingVertical: 13, alignItems: 'center',
    borderWidth: 1.5, borderColor: Colors.border, width: '100%',
  },
  skipBtnText: { color: Colors.textSecondary, fontWeight: '600', fontSize: 14 },
});
