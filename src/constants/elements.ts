import { GardenElement, ElementCategory } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// BLUMEN / FLOWERS  (50 Einträge)
// ─────────────────────────────────────────────────────────────────────────────
const flowers: GardenElement[] = [
  { id: 'rose',              name: 'Rose',               emoji: '🌹', category: 'flower', size: 1, tileColor: '#FFE4E8', wateringDays: 2 },
  { id: 'tulpe',             name: 'Tulpe',              emoji: '🌷', category: 'flower', size: 1, tileColor: '#FFD6E0', wateringDays: 3 },
  { id: 'sonnenblume',       name: 'Sonnenblume',        emoji: '🌻', category: 'flower', size: 1, tileColor: '#FFF8DC', wateringDays: 2 },
  { id: 'lavendel',          name: 'Lavendel',           emoji: '💜', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 7 },
  { id: 'margerite',         name: 'Margerite',          emoji: '🌼', category: 'flower', size: 1, tileColor: '#FFFDE7', wateringDays: 3 },
  { id: 'orchidee',          name: 'Orchidee',           emoji: '🌺', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 7 },
  { id: 'pfingstrose',       name: 'Pfingstrose',        emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFD6E0', wateringDays: 3 },
  { id: 'lilie',             name: 'Lilie',              emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFF9F0', wateringDays: 3 },
  { id: 'hortensie',         name: 'Hortensie',          emoji: '💐', category: 'flower', size: 1, tileColor: '#E3F2FD', wateringDays: 2 },
  { id: 'veilchen',          name: 'Veilchen',           emoji: '🪻', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 3 },
  { id: 'ringelblume',       name: 'Ringelblume',        emoji: '🌼', category: 'flower', size: 1, tileColor: '#FFF3E0', wateringDays: 3 },
  { id: 'dahlie',            name: 'Dahlie',             emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 2 },
  { id: 'chrysantheme',      name: 'Chrysantheme',       emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFF8E1', wateringDays: 3 },
  { id: 'iris',              name: 'Iris',               emoji: '🪻', category: 'flower', size: 1, tileColor: '#E8EAF6', wateringDays: 4 },
  { id: 'geranie',           name: 'Geranie',            emoji: '🌺', category: 'flower', size: 1, tileColor: '#FFEBEE', wateringDays: 2 },
  { id: 'begonie',           name: 'Begonie',            emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 2 },
  { id: 'petunie',           name: 'Petunie',            emoji: '🌸', category: 'flower', size: 1, tileColor: '#F3E5F5', wateringDays: 1 },
  { id: 'tagetes',           name: 'Tagetes',            emoji: '🌼', category: 'flower', size: 1, tileColor: '#FFF3E0', wateringDays: 2 },
  { id: 'zinnie',            name: 'Zinnie',             emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFE0E6', wateringDays: 3 },
  { id: 'aster',             name: 'Aster',              emoji: '🌸', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 3 },
  { id: 'gladiole',          name: 'Gladiole',           emoji: '💐', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 2 },
  { id: 'jasmin',            name: 'Jasmin',             emoji: '🤍', category: 'flower', size: 1, tileColor: '#F9FBE7', wateringDays: 4 },
  { id: 'flieder',           name: 'Flieder',            emoji: '💜', category: 'flower', size: 2, tileColor: '#F3E5F5', wateringDays: 7 },
  { id: 'hibiskus',          name: 'Hibiskus',           emoji: '🌺', category: 'flower', size: 1, tileColor: '#FFEBEE', wateringDays: 3 },
  { id: 'mohn',              name: 'Mohn',               emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFEBEE', wateringDays: 4 },
  { id: 'nelke',             name: 'Nelke',              emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 3 },
  { id: 'schneeglöckchen',   name: 'Schneeglöckchen',    emoji: '🤍', category: 'flower', size: 1, tileColor: '#F0F4F8', wateringDays: 7 },
  { id: 'krokus',            name: 'Krokus',             emoji: '🪻', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 7 },
  { id: 'narzisse',          name: 'Narzisse',           emoji: '🌼', category: 'flower', size: 1, tileColor: '#FFFDE7', wateringDays: 5 },
  { id: 'hyazinthe',         name: 'Hyazinthe',          emoji: '🪻', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'lupine',            name: 'Lupine',             emoji: '🌾', category: 'flower', size: 1, tileColor: '#E8EAF6', wateringDays: 4 },
  { id: 'löwenmaul',         name: 'Löwenmaul',          emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 3 },
  { id: 'rittersporn',       name: 'Rittersporn',        emoji: '🌸', category: 'flower', size: 1, tileColor: '#E3F2FD', wateringDays: 3 },
  { id: 'sonnenhut',         name: 'Sonnenhut',          emoji: '🌼', category: 'flower', size: 1, tileColor: '#FFF8DC', wateringDays: 4 },
  { id: 'stockrose',         name: 'Stockrose',          emoji: '🌹', category: 'flower', size: 1, tileColor: '#FFE4E8', wateringDays: 3 },
  { id: 'stiefmütterchen',   name: 'Stiefmütterchen',   emoji: '🌸', category: 'flower', size: 1, tileColor: '#F3E5F5', wateringDays: 2 },
  { id: 'primel',            name: 'Primel',             emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFF3E0', wateringDays: 2 },
  { id: 'akelei',            name: 'Akelei',             emoji: '🌸', category: 'flower', size: 1, tileColor: '#F3E5F5', wateringDays: 4 },
  { id: 'vergissmeinnicht',  name: 'Vergissmeinnicht',   emoji: '🌸', category: 'flower', size: 1, tileColor: '#E3F2FD', wateringDays: 3 },
  { id: 'wisterie',          name: 'Wisterie',           emoji: '🌸', category: 'flower', size: 2, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'clematis',          name: 'Clematis',           emoji: '🌸', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 4 },
  { id: 'fingerhut',         name: 'Fingerhut',          emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 4 },
  { id: 'phlox',             name: 'Phlox',              emoji: '🌸', category: 'flower', size: 1, tileColor: '#F3E5F5', wateringDays: 3 },
  { id: 'zierlauch',         name: 'Zierlauch',          emoji: '🪻', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'anemone',           name: 'Anemone',            emoji: '🌸', category: 'flower', size: 1, tileColor: '#FFF9F0', wateringDays: 4 },
  { id: 'rudbeckia',         name: 'Rudbeckia',          emoji: '🌻', category: 'flower', size: 1, tileColor: '#FFF8DC', wateringDays: 3 },
  { id: 'katzenminze',       name: 'Katzenminze',        emoji: '🪻', category: 'flower', size: 1, tileColor: '#EDE7F6', wateringDays: 4 },
  { id: 'cosmea',            name: 'Cosmea',             emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 3 },
  { id: 'funkia',            name: 'Funkia',             emoji: '🌿', category: 'flower', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'astilbe',           name: 'Astilbe',            emoji: '🌸', category: 'flower', size: 1, tileColor: '#FCE4EC', wateringDays: 2 },
];

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export const GARDEN_ELEMENTS: GardenElement[] = [
  ...flowers,
  // trees, vegetables, fruits, herbs, structures, water, landscape, accessory — added in later steps
];

export const ELEMENT_CATEGORIES: { id: ElementCategory; label: string; emoji: string }[] = [
  { id: 'flower',    label: 'Blumen',     emoji: '🌸' },
  { id: 'tree',      label: 'Bäume',      emoji: '🌳' },
  { id: 'vegetable', label: 'Gemüse',     emoji: '🥦' },
  { id: 'fruit',     label: 'Obst',       emoji: '🍓' },
  { id: 'herb',      label: 'Kräuter',    emoji: '🌿' },
  { id: 'structure', label: 'Strukturen', emoji: '🏗️' },
  { id: 'water',     label: 'Wasser',     emoji: '💧' },
  { id: 'landscape', label: 'Landschaft', emoji: '🪨' },
  { id: 'accessory', label: 'Zubehör',    emoji: '💡' },
];

export const ELEMENT_BY_ID = new Map<string, GardenElement>(
  GARDEN_ELEMENTS.map((e) => [e.id, e])
);
