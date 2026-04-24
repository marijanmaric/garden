import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Animated,
  Alert,
  Modal,
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useGardenStore } from '../../src/store/useGardenStore';
import { Colors } from '../../src/constants';
import { GARDEN_ELEMENTS, ELEMENT_CATEGORIES, ELEMENT_BY_ID } from '../../src/constants/elements';
import { generateId } from '../../src/utils/generateId';
import { GardenElement, ElementCategory, PlacedElement } from '../../src/types';

// ── Care tips by category ──────────────────────────────────────────────────────
const CATEGORY_CARE: Record<ElementCategory, { sunlight: string; soil: string; tip: string }> = {
  flower:    { sunlight: '☀️ Sonnig bis halbschattig', soil: '🌱 Humusreicher Boden',     tip: 'Verwelkte Blüten regelmäßig entfernen für längere Blüte.' },
  tree:      { sunlight: '☀️ Vollsonnig',               soil: '🌱 Tiefgründiger Boden',   tip: 'Mulch um den Stamm schützt Wurzeln und hält Feuchtigkeit.' },
  vegetable: { sunlight: '☀️ Vollsonnig',               soil: '🌱 Nährstoffreicher Boden', tip: 'Regelmäßig düngen und gleichmäßig gießen.' },
  fruit:     { sunlight: '☀️ Sonnig',                   soil: '🌱 Durchlässiger Boden',   tip: 'Früchte rechtzeitig ernten für optimalen Geschmack.' },
  herb:      { sunlight: '☀️ Sonnig bis halbschattig', soil: '🌱 Magerer, trockener Boden', tip: 'Nicht zu viel gießen – Staunässe vermeiden.' },
  structure: { sunlight: '—',                           soil: '—',                         tip: 'Regelmäßig auf Schäden und Witterungseinflüsse prüfen.' },
  water:     { sunlight: '☀️ Sonnig bis schattig',      soil: '—',                         tip: 'Wasserqualität und Algenwuchs regelmäßig kontrollieren.' },
  landscape: { sunlight: '—',                           soil: '—',                         tip: 'Saisonal reinigen und ggf. nachbessern.' },
  accessory: { sunlight: '—',                           soil: '—',                         tip: 'Vor dem Winter einlagern oder witterungsfest abdecken.' },
};

// ── Grid constants ─────────────────────────────────────────────────────────────
const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const GRID_COLS = 20;
const GRID_ROWS = 20;
const GRID_GAP = 1;
const BASE_CELL = Math.floor((SCREEN_W - 32) / GRID_COLS);

// ── Panel constants ────────────────────────────────────────────────────────────
const PANEL_EXPANDED = Math.min(420, SCREEN_H * 0.50);
const PANEL_HANDLE = 52;
const PANEL_COLLAPSED = PANEL_EXPANDED - PANEL_HANDLE;

const ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0];
const TILE_W = Math.floor((SCREEN_W - 32 - 12) / 5);

export default function GardenScreen() {
  const router = useRouter();
  const {
    gardens, activeGardenId, activeGarden, setActiveGarden, addGarden,
    updateGarden, deleteGarden,
    placedForGarden, placeElement, removeElement, clearDesigner,
    designerUndo, designerRedo, canUndo, canRedo,
    designerZoom, setDesignerZoom,
    designerViewMode, setDesignerViewMode,
    selectedElementId, setSelectedElementId,
  } = useGardenStore();

  const [panelOpen, setPanelOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<ElementCategory | null>(null);
  const [detailElement, setDetailElement] = useState<PlacedElement | null>(null);
  const [gardenSheet, setGardenSheet] = useState<{ visible: boolean; gardenId: string | null }>({ visible: false, gardenId: null });
  const [gardenNameInput, setGardenNameInput] = useState('');
  const panelAnim = useRef(new Animated.Value(PANEL_COLLAPSED)).current;

  const garden = activeGarden();
  const gardenElements = garden ? placedForGarden(garden.id) : [];

  // O(1) cell lookup
  const placedMap = useMemo(() => {
    const map = new Map<string, PlacedElement>();
    for (const el of gardenElements) map.set(`${el.x},${el.y}`, el);
    return map;
  }, [gardenElements]);

  // Filtered library list
  const filteredElements = useMemo(() => {
    const q = search.toLowerCase();
    return GARDEN_ELEMENTS.filter(
      (e) =>
        (activeCategory === null || e.category === activeCategory) &&
        (q === '' || e.name.toLowerCase().includes(q))
    );
  }, [search, activeCategory]);

  const selectedElement = selectedElementId ? ELEMENT_BY_ID.get(selectedElementId) ?? null : null;
  const cellSize = Math.round(BASE_CELL * designerZoom);
  const gridWidth = cellSize * GRID_COLS + GRID_GAP * (GRID_COLS - 1);

  // Panel slide
  function togglePanel() {
    const toValue = panelOpen ? PANEL_COLLAPSED : 0;
    Animated.spring(panelAnim, { toValue, useNativeDriver: true, tension: 70, friction: 12 }).start();
    setPanelOpen((v) => !v);
  }
  function closePanel() {
    Animated.spring(panelAnim, { toValue: PANEL_COLLAPSED, useNativeDriver: true, tension: 70, friction: 12 }).start();
    setPanelOpen(false);
  }

  function zoomIn() {
    const idx = ZOOM_STEPS.indexOf(designerZoom);
    if (idx < ZOOM_STEPS.length - 1) setDesignerZoom(ZOOM_STEPS[idx + 1]);
  }
  function zoomOut() {
    const idx = ZOOM_STEPS.indexOf(designerZoom);
    if (idx > 0) setDesignerZoom(ZOOM_STEPS[idx - 1]);
  }

  const handleCellPress = useCallback(
    (col: number, row: number) => {
      const existing = placedMap.get(`${col},${row}`);
      if (existing) {
        if (selectedElementId) {
          // Overwrite mode: remove old, place new
          removeElement(existing.id);
        } else {
          setDetailElement(existing);
        }
        return;
      }
      if (!selectedElementId || !garden) return;
      placeElement({
        id: generateId('el'),
        elementId: selectedElementId,
        x: col,
        y: row,
        gardenId: garden.id,
        placedAt: new Date().toISOString(),
      });
    },
    [placedMap, selectedElementId, garden, placeElement, removeElement]
  );

  function createBlankGarden() {
    const id = generateId('garden');
    addGarden({
      id,
      user_id: 'local',
      name: 'Mein Garten',
      location_lat: null,
      location_lon: null,
      grid_rows: GRID_ROWS,
      grid_cols: GRID_COLS,
      created_at: new Date().toISOString(),
    });
    setActiveGarden(id);
  }

  function openGardenSheet(gId: string) {
    const g = gardens.find((x) => x.id === gId);
    setGardenNameInput(g?.name ?? '');
    setGardenSheet({ visible: true, gardenId: gId });
  }

  function saveGardenName() {
    if (!gardenSheet.gardenId || !gardenNameInput.trim()) return;
    updateGarden(gardenSheet.gardenId, { name: gardenNameInput.trim() });
    setGardenSheet({ visible: false, gardenId: null });
  }

  function handleDeleteGarden() {
    if (!gardenSheet.gardenId) return;
    const g = gardens.find((x) => x.id === gardenSheet.gardenId);
    Alert.alert(
      'Garten löschen',
      `"${g?.name ?? 'Garten'}" und alle enthaltenen Daten löschen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: () => {
            deleteGarden(gardenSheet.gardenId!);
            setGardenSheet({ visible: false, gardenId: null });
          },
        },
      ]
    );
  }

  function selectElement(el: GardenElement) {
    setSelectedElementId(el.id === selectedElementId ? null : el.id);
    closePanel();
  }

  function handleClear() {
    if (!garden) return;
    Alert.alert('Garten leeren', 'Alle platzierten Elemente löschen?', [
      { text: 'Abbrechen', style: 'cancel' },
      { text: 'Leeren', style: 'destructive', onPress: () => clearDesigner(garden.id) },
    ]);
  }

  const perspectiveTransform =
    designerViewMode === 'perspective'
      ? ([{ perspective: 900 }, { rotateX: '30deg' }] as any)
      : [];

  return (
    <View style={styles.root}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.title}>Gartenplan</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.iconBtn, designerViewMode === 'perspective' && styles.iconBtnActive]}
            onPress={() => setDesignerViewMode(designerViewMode === 'top' ? 'perspective' : 'top')}
          >
            <Text style={styles.iconBtnText}>{designerViewMode === 'top' ? '🗺️' : '📐'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => router.push('/onboarding/scan')}
            activeOpacity={0.8}
          >
            <Text style={styles.scanBtnText}>📸 Scannen</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Garden selector tabs ── */}
      {gardens.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gardenTabs}>
          {gardens.map((g) => (
            <TouchableOpacity
              key={g.id}
              style={[styles.gardenTab, g.id === activeGardenId && styles.gardenTabActive]}
              onPress={() => setActiveGarden(g.id)}
              activeOpacity={0.8}
            >
              <Text style={[styles.gardenTabText, g.id === activeGardenId && styles.gardenTabTextActive]}>
                {g.name}
              </Text>
              {g.id === activeGardenId && (
                <TouchableOpacity
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => openGardenSheet(g.id)}
                >
                  <Text style={styles.gardenTabGear}>⚙️</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.gardenTabAdd} onPress={createBlankGarden} activeOpacity={0.8}>
            <Text style={styles.gardenTabAddText}>＋</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ── Toolbar ── */}
      <View style={styles.toolbar}>
        <TouchableOpacity style={[styles.toolBtn, !canUndo() && styles.toolBtnDisabled]} onPress={designerUndo} disabled={!canUndo()}>
          <Text style={styles.toolBtnText}>↩️</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.toolBtn, !canRedo() && styles.toolBtnDisabled]} onPress={designerRedo} disabled={!canRedo()}>
          <Text style={styles.toolBtnText}>↪️</Text>
        </TouchableOpacity>
        <View style={styles.toolSep} />
        <TouchableOpacity style={[styles.toolBtn, designerZoom <= ZOOM_STEPS[0] && styles.toolBtnDisabled]} onPress={zoomOut} disabled={designerZoom <= ZOOM_STEPS[0]}>
          <Text style={styles.toolBtnText}>➖</Text>
        </TouchableOpacity>
        <Text style={styles.zoomLabel}>{Math.round(designerZoom * 100)}%</Text>
        <TouchableOpacity style={[styles.toolBtn, designerZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] && styles.toolBtnDisabled]} onPress={zoomIn} disabled={designerZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>
          <Text style={styles.toolBtnText}>➕</Text>
        </TouchableOpacity>
        <View style={styles.toolSep} />
        <TouchableOpacity style={styles.toolBtn} onPress={handleClear}>
          <Text style={styles.toolBtnText}>🗑️</Text>
        </TouchableOpacity>
      </View>

      {/* ── Active element bar ── */}
      {selectedElement && (
        <TouchableOpacity style={styles.activeBar} onPress={() => setSelectedElementId(null)}>
          <Text style={styles.activeBarEmoji}>{selectedElement.emoji}</Text>
          <Text style={styles.activeBarName}>{selectedElement.name} platzieren — Tippe auf eine Zelle</Text>
          <Text style={styles.activeBarCancel}>✕</Text>
        </TouchableOpacity>
      )}

      {/* ── Canvas ── */}
      {!garden ? (
        <View style={styles.emptyScreen}>
          <Text style={styles.emptyEmoji}>🏡</Text>
          <Text style={styles.emptyTitle}>Noch kein Garten</Text>
          <Text style={styles.emptySub}>Scanne deinen Garten oder starte direkt mit dem Editor.</Text>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/onboarding/scan')} activeOpacity={0.8}>
            <Text style={styles.emptyBtnText}>📸 Garten scannen</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.emptyBtnOutline} onPress={createBlankGarden} activeOpacity={0.8}>
            <Text style={styles.emptyBtnOutlineText}>✏️ Leeren Garten anlegen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          horizontal
          style={styles.canvasScroll}
          contentContainerStyle={{ width: Math.max(SCREEN_W, gridWidth + 32) }}
          showsHorizontalScrollIndicator={false}
        >
          <View style={[styles.gridWrapper, { transform: perspectiveTransform }]}>
            {Array.from({ length: GRID_ROWS }, (_, row) => (
              <View key={row} style={styles.gridRow}>
                {Array.from({ length: GRID_COLS }, (_, col) => {
                  const placed = placedMap.get(`${col},${row}`);
                  const element = placed ? ELEMENT_BY_ID.get(placed.elementId) : undefined;
                  const isTarget = !!selectedElement && !placed;
                  return (
                    <TouchableOpacity
                      key={col}
                      activeOpacity={placed ? 0.6 : 0.85}
                      onPress={() => handleCellPress(col, row)}
                      style={[
                        styles.cell,
                        {
                          width: cellSize,
                          height: cellSize,
                          marginRight: col < GRID_COLS - 1 ? GRID_GAP : 0,
                          backgroundColor: element
                            ? element.tileColor
                            : isTarget
                            ? Colors.primaryLight + '28'
                            : '#D4EDDA',
                          borderColor: isTarget
                            ? Colors.primaryLight + '80'
                            : 'rgba(100,160,100,0.2)',
                        },
                      ]}
                    >
                      {element && (
                        <Text style={{ fontSize: cellSize * 0.58, lineHeight: cellSize * 0.72 }} numberOfLines={1}>
                          {element.emoji}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {/* ── Element detail sheet ── */}
      <Modal
        visible={detailElement !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailElement(null)}
      >
        <View style={styles.detailOverlay}>
          <View style={styles.detailCard}>
            {detailElement && (() => {
              const el = ELEMENT_BY_ID.get(detailElement.elementId);
              const care = el ? CATEGORY_CARE[el.category] : null;
              return (
                <>
                  <Text style={styles.detailEmoji}>{el?.emoji ?? '🌿'}</Text>
                  <Text style={styles.detailName}>{el?.name ?? 'Element'}</Text>
                  {care && (
                    <View style={styles.detailCareBox}>
                      {care.sunlight !== '—' && (
                        <Text style={styles.detailCareRow}>{care.sunlight}</Text>
                      )}
                      {care.soil !== '—' && (
                        <Text style={styles.detailCareRow}>{care.soil}</Text>
                      )}
                      {el?.wateringDays && (
                        <Text style={styles.detailCareRow}>💧 Alle {el.wateringDays} Tage gießen</Text>
                      )}
                      <Text style={styles.detailTip}>💡 {care.tip}</Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.detailRemoveBtn}
                    onPress={() => { removeElement(detailElement.id); setDetailElement(null); }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.detailRemoveBtnText}>🗑️ Entfernen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.detailCloseBtn} onPress={() => setDetailElement(null)} activeOpacity={0.8}>
                    <Text style={styles.detailCloseBtnText}>Schließen</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* ── Garden management sheet ── */}
      <Modal
        visible={gardenSheet.visible}
        transparent
        animationType="slide"
        onRequestClose={() => setGardenSheet({ visible: false, gardenId: null })}
      >
        <View style={styles.detailOverlay}>
          <View style={styles.detailCard}>
            <Text style={styles.detailName}>Garten bearbeiten</Text>
            <View style={styles.gardenSheetInputRow}>
              <TextInput
                style={styles.gardenSheetInput}
                value={gardenNameInput}
                onChangeText={setGardenNameInput}
                placeholder="Gartenname"
                placeholderTextColor={Colors.textSecondary}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={saveGardenName}
              />
            </View>
            <TouchableOpacity style={styles.emptyBtn} onPress={saveGardenName} activeOpacity={0.8}>
              <Text style={styles.emptyBtnText}>Speichern</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.detailRemoveBtn} onPress={handleDeleteGarden} activeOpacity={0.8}>
              <Text style={styles.detailRemoveBtnText}>🗑️ Garten löschen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.detailCloseBtn}
              onPress={() => setGardenSheet({ visible: false, gardenId: null })}
              activeOpacity={0.8}
            >
              <Text style={styles.detailCloseBtnText}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Element library panel ── */}
      <Animated.View style={[styles.panel, { transform: [{ translateY: panelAnim }] }]}>
        {/* Handle */}
        <TouchableOpacity style={styles.panelHandle} onPress={togglePanel} activeOpacity={0.8}>
          <View style={styles.panelBar} />
          <Text style={styles.panelTitle}>{panelOpen ? '▼  Elemente' : '▲  Elemente'}</Text>
        </TouchableOpacity>

        {/* Search */}
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Suche…"
            placeholderTextColor={Colors.textSecondary}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} style={styles.searchClear}>
              <Text style={{ color: Colors.textSecondary }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Category tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catTabs}>
          <TouchableOpacity
            style={[styles.catTab, activeCategory === null && styles.catTabActive]}
            onPress={() => setActiveCategory(null)}
          >
            <Text style={[styles.catTabText, activeCategory === null && styles.catTabTextActive]}>Alle</Text>
          </TouchableOpacity>
          {ELEMENT_CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              style={[styles.catTab, activeCategory === cat.id && styles.catTabActive]}
              onPress={() => setActiveCategory(activeCategory === cat.id ? null : cat.id)}
            >
              <Text style={[styles.catTabText, activeCategory === cat.id && styles.catTabTextActive]}>
                {cat.emoji} {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Elements grid */}
        <ScrollView style={styles.elementsScroll} showsVerticalScrollIndicator={false}>
          {filteredElements.length === 0 ? (
            <Text style={styles.noResults}>Keine Elemente gefunden</Text>
          ) : (
            <View style={styles.elementsGrid}>
              {filteredElements.map((el) => (
                <TouchableOpacity
                  key={el.id}
                  style={[
                    styles.elementTile,
                    { backgroundColor: el.tileColor },
                    el.id === selectedElementId && styles.elementTileActive,
                  ]}
                  onPress={() => selectElement(el)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.elementEmoji}>{el.emoji}</Text>
                  <Text style={styles.elementName} numberOfLines={2}>{el.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 8,
  },
  title: { fontSize: 24, fontWeight: '800', color: Colors.textPrimary },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  iconBtnActive: { backgroundColor: Colors.primary + '20', borderColor: Colors.primary },
  iconBtnText: { fontSize: 16 },
  scanBtn: { backgroundColor: Colors.primary, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6 },
  scanBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  gardenTabs: { paddingHorizontal: 16, gap: 8, marginBottom: 6, alignItems: 'center' },
  gardenTab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border,
  },
  gardenTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  gardenTabText: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  gardenTabTextActive: { color: '#fff' },
  gardenTabGear: { fontSize: 12 },
  gardenTabAdd: {
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border,
    borderStyle: 'dashed',
  },
  gardenTabAddText: { fontSize: 16, color: Colors.primary, fontWeight: '700' },

  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6, gap: 6 },
  toolBtn: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center',
  },
  toolBtnDisabled: { opacity: 0.3 },
  toolBtnText: { fontSize: 16 },
  toolSep: { width: 1, height: 22, backgroundColor: Colors.border, marginHorizontal: 2 },
  zoomLabel: { fontSize: 11, fontWeight: '700', color: Colors.textSecondary, minWidth: 34, textAlign: 'center' },

  activeBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 6,
    backgroundColor: Colors.primary + '15', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: Colors.primary + '40',
  },
  activeBarEmoji: { fontSize: 20 },
  activeBarName: { flex: 1, fontSize: 12, fontWeight: '600', color: Colors.primary },
  activeBarCancel: { fontSize: 13, color: Colors.textSecondary, fontWeight: '700' },

  canvasScroll: { flex: 1 },
  gridWrapper: { paddingLeft: 8, paddingTop: 4, paddingBottom: PANEL_HANDLE + 8 },
  gridRow: { flexDirection: 'row', marginBottom: GRID_GAP },
  cell: { borderRadius: 3, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, overflow: 'hidden' },

  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: PANEL_EXPANDED,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 16,
  },
  panelHandle: { height: PANEL_HANDLE, alignItems: 'center', justifyContent: 'center', gap: 4 },
  panelBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border },
  panelTitle: { fontSize: 11, fontWeight: '700', color: Colors.textSecondary, letterSpacing: 0.5 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8,
    backgroundColor: Colors.background, borderRadius: 10, borderWidth: 1.5, borderColor: Colors.border,
  },
  searchInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: Colors.textPrimary },
  searchClear: { padding: 8 },

  catTabs: { paddingHorizontal: 16, gap: 6, marginBottom: 10 },
  catTab: {
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5,
    backgroundColor: Colors.background, borderWidth: 1.5, borderColor: Colors.border,
  },
  catTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catTabText: { fontSize: 12, fontWeight: '600', color: Colors.textSecondary },
  catTabTextActive: { color: '#fff' },

  elementsScroll: { flex: 1, paddingHorizontal: 16 },
  elementsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 24 },
  elementTile: {
    width: TILE_W, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, paddingVertical: 8, paddingHorizontal: 4,
    borderWidth: 2, borderColor: 'transparent',
  },
  elementTileActive: { borderColor: Colors.primary },
  elementEmoji: { fontSize: 26, marginBottom: 3 },
  elementName: { fontSize: 9, fontWeight: '600', color: Colors.textPrimary, textAlign: 'center' },
  noResults: { textAlign: 'center', color: Colors.textSecondary, fontSize: 14, marginTop: 24 },

  // Empty state
  emptyScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  emptyEmoji: { fontSize: 64 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  emptySub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  emptyBtn: {
    marginTop: 8, backgroundColor: Colors.primary, borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 28, alignItems: 'center',
  },
  emptyBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  emptyBtnOutline: {
    borderWidth: 1.5, borderColor: Colors.primary, borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 28, alignItems: 'center',
  },
  emptyBtnOutlineText: { color: Colors.primary, fontSize: 15, fontWeight: '700' },

  // Detail sheet
  detailOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end',
  },
  detailCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 28, paddingBottom: 40, alignItems: 'center',
  },
  detailEmoji: { fontSize: 72, marginBottom: 8 },
  detailName: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 16, textAlign: 'center' },
  detailCareBox: {
    width: '100%', backgroundColor: Colors.background, borderRadius: 14,
    padding: 16, gap: 8, marginBottom: 20,
  },
  detailCareRow: { fontSize: 14, color: Colors.textPrimary, fontWeight: '600' },
  detailTip: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18, marginTop: 4 },
  detailRemoveBtn: {
    width: '100%', backgroundColor: '#FF3B3010', borderRadius: 13,
    paddingVertical: 13, alignItems: 'center', marginBottom: 10,
    borderWidth: 1.5, borderColor: '#FF3B30',
  },
  detailRemoveBtnText: { color: '#FF3B30', fontSize: 15, fontWeight: '700' },
  detailCloseBtn: {
    width: '100%', backgroundColor: Colors.surface, borderRadius: 13,
    paddingVertical: 13, alignItems: 'center',
    borderWidth: 1.5, borderColor: Colors.border,
  },
  detailCloseBtnText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
