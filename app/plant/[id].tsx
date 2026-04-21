import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGardenStore } from '../../src/store/useGardenStore';
import { Colors, PLANT_EMOJIS, HEALTH_COLORS, HEALTH_LABELS, ACTION_LABELS } from '../../src/constants';
import { formatDate, nextWateringDate } from '../../src/services/careRules';
import { CareAction, HealthStatus } from '../../src/types';

const ACTIONS: { action: CareAction; emoji: string; label: string }[] = [
  { action: 'watered', emoji: '💧', label: 'Gegossen' },
  { action: 'pruned', emoji: '✂️', label: 'Beschnitten' },
  { action: 'fertilized', emoji: '🌿', label: 'Gedüngt' },
  { action: 'health_check', emoji: '🔍', label: 'Geprüft' },
];

const HEALTH_OPTIONS: HealthStatus[] = ['healthy', 'needs_attention', 'sick'];

export default function PlantDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { plants, updatePlant, deletePlant, addCareLog, logsForPlant, recomputeSuggestions } =
    useGardenStore();

  const plant = plants.find((p) => p.id === id);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<CareAction | null>(null);

  if (!plant) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Pflanze nicht gefunden.</Text>
      </View>
    );
  }

  // Assign to non-nullable const so TypeScript narrows correctly inside closures
  const p = plant;
  const logs = logsForPlant(p.id);
  const emoji = PLANT_EMOJIS[p.type] ?? '🌱';
  const healthColor = HEALTH_COLORS[p.health_status];
  const healthLabel = HEALTH_LABELS[p.health_status];
  const nextWater = nextWateringDate(p);
  const isOverdue = nextWater !== null && nextWater <= new Date();

  function handleAction(action: CareAction) {
    setPendingAction(action);
    setNoteInput('');
    setShowNoteModal(true);
  }

  function confirmAction() {
    if (!pendingAction) return;
    const now = new Date().toISOString();

    if (pendingAction === 'watered') {
      updatePlant(p.id, { last_watered_at: now });
    }

    addCareLog({
      id: `log-${Date.now()}`,
      plant_id: p.id,
      user_id: 'local',
      action: pendingAction,
      notes: noteInput.trim() || null,
      logged_at: now,
    });

    recomputeSuggestions();
    setShowNoteModal(false);
    setPendingAction(null);
  }

  function handleDeletePlant() {
    Alert.alert('Pflanze löschen', `"${p.name}" wirklich löschen?`, [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Löschen',
        style: 'destructive',
        onPress: () => {
          deletePlant(p.id);
          recomputeSuggestions();
          router.back();
        },
      },
    ]);
  }

  function setHealthStatus(status: HealthStatus) {
    updatePlant(p.id, { health_status: status });
    setShowHealthModal(false);
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {/* Header photo */}
      {p.photo_url ? (
        <Image source={{ uri: p.photo_url }} style={styles.photo} />
      ) : (
        <View style={styles.emojiHero}>
          <Text style={styles.emojiHeroText}>{emoji}</Text>
        </View>
      )}

      {/* Name & health */}
      <View style={styles.nameRow}>
        <View style={styles.nameBlock}>
          <Text style={styles.name}>{p.name}</Text>
          {p.species ? <Text style={styles.species}>{p.species}</Text> : null}
        </View>
        <TouchableOpacity
          style={[styles.healthBadge, { backgroundColor: healthColor + '20' }]}
          onPress={() => setShowHealthModal(true)}
          activeOpacity={0.8}
        >
          <View style={[styles.healthDot, { backgroundColor: healthColor }]} />
          <Text style={[styles.healthLabel, { color: healthColor }]}>{healthLabel}</Text>
        </TouchableOpacity>
      </View>

      {/* Info cards */}
      <View style={styles.infoGrid}>
        <View style={styles.infoCard}>
          <Text style={styles.infoEmoji}>💧</Text>
          <Text style={styles.infoValue}>{formatDate(p.last_watered_at)}</Text>
          <Text style={styles.infoLabel}>Zuletzt gegossen</Text>
        </View>
        <View style={[styles.infoCard, isOverdue && styles.infoCardWarning]}>
          <Text style={styles.infoEmoji}>📅</Text>
          <Text style={[styles.infoValue, isOverdue && { color: Colors.danger }]}>
            {nextWater ? nextWater.toLocaleDateString('de-DE') : '—'}
          </Text>
          <Text style={styles.infoLabel}>{isOverdue ? 'Überfällig!' : 'Nächstes Gießen'}</Text>
        </View>
        <View style={styles.infoCard}>
          <Text style={styles.infoEmoji}>🔄</Text>
          <Text style={styles.infoValue}>alle {p.watering_interval_days}d</Text>
          <Text style={styles.infoLabel}>Intervall</Text>
        </View>
      </View>

      {/* Care notes */}
      {p.care_notes ? (
        <View style={styles.notesCard}>
          <Text style={styles.notesTitle}>Pflegehinweise</Text>
          <Text style={styles.notesText}>{p.care_notes}</Text>
        </View>
      ) : null}

      {/* Quick actions */}
      <Text style={styles.sectionTitle}>Aktion erfassen</Text>
      <View style={styles.actionsGrid}>
        {ACTIONS.map((a) => (
          <TouchableOpacity
            key={a.action}
            style={styles.actionBtn}
            onPress={() => handleAction(a.action)}
            activeOpacity={0.75}
          >
            <Text style={styles.actionEmoji}>{a.emoji}</Text>
            <Text style={styles.actionLabel}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Care log */}
      {logs.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Pflegeprotokoll</Text>
          <View style={styles.logList}>
            {logs.slice(0, 10).map((log) => (
              <View key={log.id} style={styles.logItem}>
                <View style={styles.logLeft}>
                  <Text style={styles.logAction}>{ACTION_LABELS[log.action] ?? log.action}</Text>
                  {log.notes ? <Text style={styles.logNote}>{log.notes}</Text> : null}
                </View>
                <Text style={styles.logDate}>
                  {new Date(log.logged_at).toLocaleDateString('de-DE')}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}

      {/* Delete */}
      <TouchableOpacity style={styles.deleteBtn} onPress={handleDeletePlant} activeOpacity={0.8}>
        <Text style={styles.deleteBtnText}>🗑️ Pflanze löschen</Text>
      </TouchableOpacity>

      {/* Health modal */}
      <Modal visible={showHealthModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Gesundheitsstatus setzen</Text>
            {HEALTH_OPTIONS.map((status) => (
              <TouchableOpacity
                key={status}
                style={[
                  styles.healthOption,
                  p.health_status === status && {
                    backgroundColor: HEALTH_COLORS[status] + '15',
                    borderColor: HEALTH_COLORS[status],
                  },
                ]}
                onPress={() => setHealthStatus(status)}
              >
                <View style={[styles.healthDot, { backgroundColor: HEALTH_COLORS[status] }]} />
                <Text style={styles.healthOptionText}>{HEALTH_LABELS[status]}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.modalCancelBtn}
              onPress={() => setShowHealthModal(false)}
            >
              <Text style={styles.modalCancelText}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Note modal */}
      <Modal visible={showNoteModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {pendingAction ? ACTIONS.find((a) => a.action === pendingAction)?.emoji : ''}{' '}
              {pendingAction ? ACTION_LABELS[pendingAction] : ''}
            </Text>
            <TextInput
              style={styles.noteInput}
              value={noteInput}
              onChangeText={setNoteInput}
              placeholder="Optionale Notiz (z.B. Menge, Beobachtung…)"
              placeholderTextColor={Colors.textSecondary}
              multiline
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setShowNoteModal(false)}>
                <Text style={styles.modalCancelText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmBtn} onPress={confirmAction}>
                <Text style={styles.modalConfirmText}>Speichern</Text>
              </TouchableOpacity>
            </View>
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
  notFound: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notFoundText: {
    color: Colors.textSecondary,
    fontSize: 16,
  },
  photo: {
    width: '100%',
    height: 240,
  },
  emojiHero: {
    width: '100%',
    height: 180,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiHeroText: {
    fontSize: 80,
  },
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 20,
    paddingBottom: 12,
  },
  nameBlock: {
    flex: 1,
    gap: 4,
  },
  name: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  species: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },
  healthBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 5,
    marginLeft: 10,
  },
  healthDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  healthLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  infoGrid: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  infoCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 2,
  },
  infoCardWarning: {
    borderColor: Colors.danger,
    backgroundColor: '#FEF2F2',
  },
  infoEmoji: {
    fontSize: 20,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  infoLabel: {
    fontSize: 10,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  notesCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 6,
  },
  notesTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  notesText: {
    fontSize: 14,
    color: Colors.textPrimary,
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  actionBtn: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
    gap: 4,
  },
  actionEmoji: {
    fontSize: 28,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  logList: {
    marginHorizontal: 16,
    marginBottom: 24,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  logItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  logLeft: {
    flex: 1,
    gap: 2,
  },
  logAction: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  logNote: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  logDate: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  deleteBtn: {
    marginHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.danger,
  },
  deleteBtnText: {
    color: Colors.danger,
    fontWeight: '700',
    fontSize: 15,
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
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  healthOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  healthOptionText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  noteInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
    minHeight: 80,
    textAlignVertical: 'top',
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
});
