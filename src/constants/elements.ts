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
// BÄUME / TREES  (30 Einträge)
// ─────────────────────────────────────────────────────────────────────────────
const trees: GardenElement[] = [
  // Obstbäume
  { id: 'apfelbaum',      name: 'Apfelbaum',       emoji: '🍎', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 7 },
  { id: 'birnbaum',       name: 'Birnbaum',        emoji: '🍐', category: 'tree', size: 2, tileColor: '#F1F8E9', wateringDays: 7 },
  { id: 'kirschbaum',     name: 'Kirschbaum',      emoji: '🍒', category: 'tree', size: 2, tileColor: '#FCE4EC', wateringDays: 7 },
  { id: 'pflaumenbaum',   name: 'Pflaumenbaum',    emoji: '🫐', category: 'tree', size: 2, tileColor: '#EDE7F6', wateringDays: 7 },
  { id: 'pfirsichbaum',   name: 'Pfirsichbaum',    emoji: '🍑', category: 'tree', size: 2, tileColor: '#FFF3E0', wateringDays: 5 },
  { id: 'aprikosenbaum',  name: 'Aprikosenbaum',   emoji: '🍊', category: 'tree', size: 2, tileColor: '#FFF3E0', wateringDays: 5 },
  { id: 'quittenbaum',    name: 'Quittenbaum',     emoji: '🍋', category: 'tree', size: 2, tileColor: '#FFFDE7', wateringDays: 7 },
  { id: 'maulbeerbaum',   name: 'Maulbeerbaum',    emoji: '🫐', category: 'tree', size: 2, tileColor: '#EDE7F6', wateringDays: 5 },
  // Nussbäume
  { id: 'walnussbaum',    name: 'Walnussbaum',     emoji: '🌰', category: 'tree', size: 3, tileColor: '#EFEBE9', wateringDays: 10 },
  { id: 'haselnuss',      name: 'Haselnussstrauch', emoji: '🌰', category: 'tree', size: 2, tileColor: '#EFEBE9', wateringDays: 7 },
  { id: 'kastanie',       name: 'Kastanie',        emoji: '🌰', category: 'tree', size: 3, tileColor: '#EFEBE9', wateringDays: 10 },
  // Zierbäume & Laubbäume
  { id: 'magnolienbaum',  name: 'Magnolie',        emoji: '🌸', category: 'tree', size: 2, tileColor: '#FCE4EC', wateringDays: 5 },
  { id: 'ahornbaum',      name: 'Ahorn',           emoji: '🍁', category: 'tree', size: 2, tileColor: '#FFF3E0', wateringDays: 7 },
  { id: 'lindenbaum',     name: 'Linde',           emoji: '🌳', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 10 },
  { id: 'birkenbaum',     name: 'Birke',           emoji: '🌲', category: 'tree', size: 2, tileColor: '#F1F8E9', wateringDays: 7 },
  { id: 'eichenbaum',     name: 'Eiche',           emoji: '🌳', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 14 },
  { id: 'eschenbaum',     name: 'Esche',           emoji: '🌳', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 14 },
  { id: 'holunderstrauch', name: 'Holunder',       emoji: '🌳', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 5 },
  { id: 'weissdorn',      name: 'Weißdorn',        emoji: '🌳', category: 'tree', size: 2, tileColor: '#F1F8E9', wateringDays: 7 },
  // Nadelbäume
  { id: 'kieferbaum',     name: 'Kiefer',          emoji: '🌲', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 14 },
  { id: 'fichtenbaum',    name: 'Fichte',          emoji: '🎄', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 14 },
  { id: 'laerchenbaum',   name: 'Lärche',          emoji: '🌲', category: 'tree', size: 3, tileColor: '#E8F5E9', wateringDays: 10 },
  { id: 'eibenbaum',      name: 'Eibe',            emoji: '🌲', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 10 },
  { id: 'lebensbaum',     name: 'Lebensbaum',      emoji: '🌲', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 7 },
  // Mediterrane Bäume
  { id: 'olivenbaum',     name: 'Olivenbaum',      emoji: '🫒', category: 'tree', size: 2, tileColor: '#F1F8E9', wateringDays: 10 },
  { id: 'zitronenbaum',   name: 'Zitronenbaum',    emoji: '🍋', category: 'tree', size: 2, tileColor: '#FFFDE7', wateringDays: 4 },
  { id: 'orangenbaum',    name: 'Orangenbaum',     emoji: '🍊', category: 'tree', size: 2, tileColor: '#FFF3E0', wateringDays: 4 },
  { id: 'feigenbaum',     name: 'Feigenbaum',      emoji: '🌳', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 5 },
  // Solitärgehölze
  { id: 'bambus',         name: 'Bambus',          emoji: '🎋', category: 'tree', size: 2, tileColor: '#F1F8E9', wateringDays: 3 },
  { id: 'palme',          name: 'Palme',           emoji: '🌴', category: 'tree', size: 2, tileColor: '#E8F5E9', wateringDays: 4 },
];

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export const GARDEN_ELEMENTS: GardenElement[] = [
  ...flowers,
  ...trees,
  // vegetables, fruits, herbs, structures, water, landscape, accessory — added in later steps
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
