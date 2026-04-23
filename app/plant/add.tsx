import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { requestCameraPermission } from '../../src/utils/permissions';
import { useGardenStore } from '../../src/store/useGardenStore';
import { identifyPlant, imageUriToBase64Prefix } from '../../src/services/plantId';
import { Colors, PLANT_EMOJIS, PLANT_TYPE_LABELS } from '../../src/constants';
import { PlantType, PlantIdResult } from '../../src/types';

const PLANT_TYPES = Object.keys(PLANT_EMOJIS) as PlantType[];

export default function AddPlantScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ gridX?: string; gridY?: string; gardenId?: string }>();

  const { addPlant, activeGardenId, plantIdApiKey, recomputeSuggestions } = useGardenStore();

  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [idResults, setIdResults] = useState<PlantIdResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  const [name, setName] = useState('');
  const [species, setSpecies] = useState('');
  const [type, setType] = useState<PlantType>('other');
  const [wateringDays, setWateringDays] = useState('3');
  const [careNotes, setCareNotes] = useState('');

  const gardenId = params.gardenId ?? activeGardenId ?? '';
  const gridX = params.gridX ? parseInt(params.gridX) : null;
  const gridY = params.gridY ? parseInt(params.gridY) : null;

  async function pickImage(fromCamera: boolean) {
    if (fromCamera) {
      const granted = await requestCameraPermission();
      if (!granted) return;
    }
    const fn = fromCamera
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;

    const result = await fn({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setPhotoUri(asset.uri);

    if (!plantIdApiKey) {
      Alert.alert(
        'API-Key fehlt',
        'Pflanze wird ohne Identifikation hinzugefügt. Du kannst den Plant.id API-Key in den Einstellungen hinterlegen.'
      );
      return;
    }

    if (!asset.base64) return;
    setIdentifying(true);
    try {
      const imageData = imageUriToBase64Prefix(asset.base64);
      const results = await identifyPlant(imageData, plantIdApiKey);
      setIdResults(results);
      setShowResults(true);
    } catch (err: any) {
      Alert.alert('Identifikation fehlgeschlagen', err.message ?? 'Unbekannter Fehler');
    } finally {
      setIdentifying(false);
    }
  }

  function applyIdResult(result: PlantIdResult) {
    setName(result.common_names[0] ?? result.name);
    setSpecies(result.name);
    if (result.watering) {
      const days = parseInt(result.watering);
      if (!isNaN(days)) setWateringDays(String(days));
    }
    if (result.wiki_description) {
      setCareNotes(result.wiki_description.slice(0, 200));
    }
    setShowResults(false);
  }

  function handleSave() {
    if (!name.trim()) {
      Alert.alert('Fehler', 'Bitte einen Namen eingeben.');
      return;
    }
    if (!gardenId) {
      Alert.alert('Fehler', 'Kein aktiver Garten. Bitte zuerst einen Garten anlegen.');
      return;
    }

    const days = parseInt(wateringDays);
    const plant = {
      id: `plant-${Date.now()}`,
      garden_id: gardenId,
      user_id: 'local',
      name: name.trim(),
      species: species.trim() || null,
      type,
      grid_x: gridX,
      grid_y: gridY,
      photo_url: photoUri,
      watering_interval_days: isNaN(days) || days < 1 ? 3 : days,
      last_watered_at: null,
      health_status: 'healthy' as const,
      care_notes: careNotes.trim() || null,
      created_at: new Date().toISOString(),
    };

    addPlant(plant);
    recomputeSuggestions();
    router.back();
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Photo */}
      <View style={styles.photoSection}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.photo} />
        ) : (
          <View style={styles.photoPlaceholder}>
            <Text style={styles.photoPlaceholderEmoji}>📷</Text>
            <Text style={styles.photoPlaceholderText}>Foto für Identifikation</Text>
          </View>
        )}

        <View style={styles.photoButtons}>
          <TouchableOpacity
            style={styles.photoBtn}
            onPress={() => pickImage(true)}
            disabled={identifying}
            activeOpacity={0.8}
          >
            <Text style={styles.photoBtnText}>📷 Kamera</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.photoBtn}
            onPress={() => pickImage(false)}
            disabled={identifying}
            activeOpacity={0.8}
          >
            <Text style={styles.photoBtnText}>🖼️ Galerie</Text>
          </TouchableOpacity>
        </View>

        {identifying && (
          <View style={styles.identifyingRow}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={styles.identifyingText}>Pflanze wird identifiziert…</Text>
          </View>
        )}
      </View>

      {/* Form */}
      <View style={styles.form}>
        <Text style={styles.label}>Name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="z.B. Rosenbusch, Tomate, Apfelbaum"
          placeholderTextColor={Colors.textSecondary}
        />

        <Text style={styles.label}>Art / Sorte</Text>
        <TextInput
          style={styles.input}
          value={species}
          onChangeText={setSpecies}
          placeholder="z.B. Rosa canina, Solanum lycopersicum"
          placeholderTextColor={Colors.textSecondary}
          autoCapitalize="sentences"
        />

        <Text style={styles.label}>Typ</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeScroll}>
          <View style={styles.typeRow}>
            {PLANT_TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.typeChip, type === t && styles.typeChipActive]}
                onPress={() => setType(t)}
                activeOpacity={0.8}
              >
                <Text style={styles.typeEmoji}>{PLANT_EMOJIS[t]}</Text>
                <Text style={[styles.typeLabel, type === t && styles.typeLabelActive]}>
                  {PLANT_TYPE_LABELS[t]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.label}>Gießintervall (Tage)</Text>
        <TextInput
          style={[styles.input, styles.inputSmall]}
          value={wateringDays}
          onChangeText={setWateringDays}
          keyboardType="number-pad"
          placeholder="3"
          placeholderTextColor={Colors.textSecondary}
        />

        <Text style={styles.label}>Pflegehinweise</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={careNotes}
          onChangeText={setCareNotes}
          placeholder="Standort, besondere Hinweise, Dünger…"
          placeholderTextColor={Colors.textSecondary}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />

        {gridX !== null && (
          <View style={styles.positionBadge}>
            <Text style={styles.positionText}>
              📍 Position im Garten: ({gridX}, {gridY})
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.8}>
          <Text style={styles.saveBtnText}>Pflanze speichern 🌱</Text>
        </TouchableOpacity>
      </View>

      {/* ID Results Modal */}
      <Modal visible={showResults} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Pflanze erkannt</Text>
            <Text style={styles.modalSub}>Wähle die passende Pflanze:</Text>
            <ScrollView style={styles.resultsList}>
              {idResults.map((r, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.resultItem}
                  onPress={() => applyIdResult(r)}
                  activeOpacity={0.75}
                >
                  <View style={styles.resultTop}>
                    <Text style={styles.resultName}>{r.common_names[0] ?? r.name}</Text>
                    <View style={[styles.probBadge, { backgroundColor: r.probability > 70 ? Colors.success + '22' : Colors.warning + '22' }]}>
                      <Text style={[styles.probText, { color: r.probability > 70 ? Colors.success : Colors.warning }]}>
                        {r.probability}%
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.resultSpecies}>{r.name}</Text>
                  {r.wiki_description ? (
                    <Text style={styles.resultDesc} numberOfLines={2}>
                      {r.wiki_description}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalSkipBtn}
              onPress={() => setShowResults(false)}
            >
              <Text style={styles.modalSkipText}>Manuell eingeben</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingBottom: 48,
  },
  photoSection: {
    margin: 16,
    gap: 12,
  },
  photo: {
    width: '100%',
    height: 220,
    borderRadius: 16,
  },
  photoPlaceholder: {
    width: '100%',
    height: 180,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  photoPlaceholderEmoji: {
    fontSize: 48,
  },
  photoPlaceholderText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  photoButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  photoBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  photoBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  identifyingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    justifyContent: 'center',
    padding: 8,
  },
  identifyingText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '500',
  },
  form: {
    padding: 16,
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginTop: 12,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  inputSmall: {
    width: 100,
  },
  inputMultiline: {
    height: 100,
    paddingTop: 11,
  },
  typeScroll: {
    marginBottom: 4,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  typeChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  typeEmoji: {
    fontSize: 16,
  },
  typeLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  typeLabelActive: {
    color: '#fff',
  },
  positionBadge: {
    backgroundColor: Colors.primaryLight + '25',
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  positionText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
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
    padding: 24,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  modalSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  resultsList: {
    maxHeight: 400,
  },
  resultItem: {
    backgroundColor: Colors.background,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    gap: 4,
  },
  resultTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  resultName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    flex: 1,
  },
  probBadge: {
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  probText: {
    fontSize: 12,
    fontWeight: '700',
  },
  resultSpecies: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },
  resultDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  modalSkipBtn: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 12,
  },
  modalSkipText: {
    color: Colors.textSecondary,
    fontWeight: '600',
    fontSize: 14,
  },
});
