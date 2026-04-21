import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
} from 'react-native';
import { useGardenStore } from '../../src/store/useGardenStore';
import { supabase, isSupabaseConfigured } from '../../src/lib/supabase';
import { Colors } from '../../src/constants';

export default function ProfileScreen() {
  const { session, setSession, plantIdApiKey, setPlantIdApiKey, gardens, plants } =
    useGardenStore();
  const [apiKeyInput, setApiKeyInput] = useState(plantIdApiKey);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);

  async function handleSignOut() {
    Alert.alert('Abmelden', 'Wirklich abmelden?', [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Abmelden',
        style: 'destructive',
        onPress: async () => {
          if (isSupabaseConfigured) await supabase.auth.signOut();
          setSession(null);
        },
      },
    ]);
  }

  function saveApiKey() {
    setPlantIdApiKey(apiKeyInput.trim());
    Alert.alert('Gespeichert ✅', 'Plant.id API-Key wurde gespeichert.');
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Einstellungen</Text>

      {/* Account */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>KONTO</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.avatar}>👤</Text>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>
                {session?.user?.email ?? 'Demo-Modus'}
              </Text>
              <Text style={styles.rowSub}>
                {isSupabaseConfigured ? 'Supabase-Konto' : 'Lokal gespeichert'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Stats */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>STATISTIK</Text>
        <View style={styles.statsCard}>
          <View style={styles.statItem}>
            <Text style={styles.statNum}>{gardens.length}</Text>
            <Text style={styles.statLabel}>Gärten</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statNum}>{plants.length}</Text>
            <Text style={styles.statLabel}>Pflanzen</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statNum}>
              {plants.filter((p) => p.health_status === 'healthy').length}
            </Text>
            <Text style={styles.statLabel}>Gesund</Text>
          </View>
        </View>
      </View>

      {/* Plant.id API */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>PFLANZENIDENTIFIKATION</Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>Plant.id API-Key</Text>
          <Text style={styles.rowSub}>
            Kostenlos registrieren auf plant.id – 100 Identifikationen/Tag gratis
          </Text>
          <View style={styles.apiKeyRow}>
            <TextInput
              style={styles.apiKeyInput}
              value={apiKeyInput}
              onChangeText={setApiKeyInput}
              placeholder="Dein API-Key…"
              secureTextEntry={!apiKeyVisible}
              autoCapitalize="none"
              placeholderTextColor={Colors.textSecondary}
            />
            <TouchableOpacity
              style={styles.eyeBtn}
              onPress={() => setApiKeyVisible((v) => !v)}
            >
              <Text>{apiKeyVisible ? '🙈' : '👁️'}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.saveBtn} onPress={saveApiKey} activeOpacity={0.8}>
            <Text style={styles.saveBtnText}>Speichern</Text>
          </TouchableOpacity>
          {plantIdApiKey ? (
            <View style={styles.keyOkBadge}>
              <Text style={styles.keyOkText}>✅ API-Key gesetzt</Text>
            </View>
          ) : (
            <View style={styles.keyMissingBadge}>
              <Text style={styles.keyMissingText}>⚠️ Kein API-Key – Identifikation deaktiviert</Text>
            </View>
          )}
        </View>
      </View>

      {/* Weather info */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>WETTER</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.avatar}>🌡️</Text>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Open-Meteo (kostenlos)</Text>
              <Text style={styles.rowSub}>Kein API-Key nötig · Wird automatisch geladen</Text>
            </View>
            <View style={styles.activeBadge}>
              <Text style={styles.activeBadgeText}>Aktiv</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} activeOpacity={0.8}>
        <Text style={styles.signOutText}>Abmelden</Text>
      </TouchableOpacity>

      <Text style={styles.version}>GartenApp v1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingTop: 60,
    paddingBottom: 48,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  section: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textSecondary,
    letterSpacing: 1,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  card: {
    backgroundColor: Colors.surface,
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  statsCard: {
    backgroundColor: Colors.surface,
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statDivider: {
    width: 1,
    backgroundColor: Colors.border,
  },
  statNum: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.primary,
  },
  statLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  avatar: {
    fontSize: 32,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  activeBadge: {
    backgroundColor: Colors.success + '20',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  activeBadgeText: {
    color: Colors.success,
    fontSize: 12,
    fontWeight: '700',
  },
  apiKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 10,
    backgroundColor: Colors.background,
  },
  apiKeyInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Colors.textPrimary,
  },
  eyeBtn: {
    padding: 10,
  },
  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  keyOkBadge: {
    backgroundColor: Colors.success + '15',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  keyOkText: {
    color: Colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
  keyMissingBadge: {
    backgroundColor: Colors.warning + '15',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  keyMissingText: {
    color: Colors.warning,
    fontSize: 12,
    fontWeight: '600',
  },
  signOutBtn: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.danger,
  },
  signOutText: {
    color: Colors.danger,
    fontWeight: '700',
    fontSize: 15,
  },
  version: {
    textAlign: 'center',
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 24,
  },
});
