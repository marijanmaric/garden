import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useGardenStore } from '../../src/store/useGardenStore';
import { PlantCard } from '../../src/components/PlantCard';
import { EmptyState } from '../../src/components/EmptyState';
import { Colors } from '../../src/constants';
import { HealthStatus } from '../../src/types';

type Filter = 'all' | HealthStatus;

const FILTERS: { key: Filter; label: string; emoji: string }[] = [
  { key: 'all', label: 'Alle', emoji: '🌿' },
  { key: 'healthy', label: 'Gesund', emoji: '✅' },
  { key: 'needs_attention', label: 'Achtung', emoji: '⚠️' },
  { key: 'sick', label: 'Krank', emoji: '🚨' },
];

export default function PlantsScreen() {
  const router = useRouter();
  const { plants, activeGardenId } = useGardenStore();

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const gardenPlants = plants.filter((p) => p.garden_id === activeGardenId);

  const filtered = gardenPlants.filter((p) => {
    const matchesFilter = filter === 'all' || p.health_status === filter;
    const matchesSearch =
      search.trim() === '' ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.species?.toLowerCase() ?? '').includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Meine Pflanzen</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push('/plant/add')}
          activeOpacity={0.8}
        >
          <Text style={styles.addBtnText}>+ Pflanze</Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Pflanze suchen…"
          value={search}
          onChangeText={setSearch}
          placeholderTextColor={Colors.textSecondary}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Text style={styles.clearBtn}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {FILTERS.map((f) => {
          const count =
            f.key === 'all'
              ? gardenPlants.length
              : gardenPlants.filter((p) => p.health_status === f.key).length;
          return (
            <TouchableOpacity
              key={f.key}
              style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.8}
            >
              <Text style={styles.filterEmoji}>{f.emoji}</Text>
              <Text style={[styles.filterLabel, filter === f.key && styles.filterLabelActive]}>
                {f.label}
              </Text>
              {count > 0 && (
                <View style={[styles.filterBadge, filter === f.key && styles.filterBadgeActive]}>
                  <Text style={[styles.filterBadgeText, filter === f.key && { color: Colors.primary }]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* List */}
      <ScrollView contentContainerStyle={styles.list}>
        {gardenPlants.length === 0 ? (
          <EmptyState
            emoji="🌱"
            title="Noch keine Pflanzen"
            subtitle="Füge deine erste Pflanze hinzu – fotografiere sie einfach und lass sie automatisch identifizieren."
            actionLabel="Erste Pflanze hinzufügen"
            onAction={() => router.push('/plant/add')}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            emoji="🔍"
            title="Keine Treffer"
            subtitle="Keine Pflanze passt zu deiner Suche oder dem Filter."
          />
        ) : (
          filtered.map((p) => (
            <PlantCard
              key={p.id}
              plant={p}
              onPress={() => router.push(`/plant/${p.id}`)}
            />
          ))
        )}
      </ScrollView>
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
    paddingBottom: 12,
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 11,
    color: Colors.textPrimary,
  },
  clearBtn: {
    fontSize: 14,
    color: Colors.textSecondary,
    paddingLeft: 8,
  },
  filterRow: {
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 12,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: Colors.primary + '15',
    borderColor: Colors.primary,
  },
  filterEmoji: {
    fontSize: 13,
  },
  filterLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  filterLabelActive: {
    color: Colors.primary,
  },
  filterBadge: {
    backgroundColor: Colors.background,
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  filterBadgeActive: {
    backgroundColor: Colors.secondary,
  },
  filterBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  list: {
    paddingBottom: 32,
  },
});
