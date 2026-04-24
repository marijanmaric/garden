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
// GEMÜSE / VEGETABLES  (40 Einträge)
// ─────────────────────────────────────────────────────────────────────────────
const vegetables: GardenElement[] = [
  // Fruchtgemüse
  { id: 'tomate',       name: 'Tomate',        emoji: '🍅', category: 'vegetable', size: 1, tileColor: '#FFEBEE', wateringDays: 1 },
  { id: 'gurke',        name: 'Gurke',         emoji: '🥒', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 1 },
  { id: 'zucchini',     name: 'Zucchini',      emoji: '🥒', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'paprika',      name: 'Paprika',       emoji: '🫑', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'aubergine',    name: 'Aubergine',     emoji: '🍆', category: 'vegetable', size: 1, tileColor: '#EDE7F6', wateringDays: 2 },
  { id: 'kürbis',       name: 'Kürbis',        emoji: '🎃', category: 'vegetable', size: 2, tileColor: '#FFF3E0', wateringDays: 2 },
  { id: 'mais',         name: 'Mais',          emoji: '🌽', category: 'vegetable', size: 1, tileColor: '#FFFDE7', wateringDays: 2 },
  // Wurzelgemüse
  { id: 'karotte',      name: 'Karotte',       emoji: '🥕', category: 'vegetable', size: 1, tileColor: '#FFF3E0', wateringDays: 3 },
  { id: 'kartoffel',    name: 'Kartoffel',     emoji: '🥔', category: 'vegetable', size: 1, tileColor: '#EFEBE9', wateringDays: 4 },
  { id: 'rote-bete',    name: 'Rote Bete',     emoji: '🟣', category: 'vegetable', size: 1, tileColor: '#F3E5F5', wateringDays: 3 },
  { id: 'radieschen',   name: 'Radieschen',    emoji: '🔴', category: 'vegetable', size: 1, tileColor: '#FFEBEE', wateringDays: 2 },
  { id: 'pastinake',    name: 'Pastinake',     emoji: '🥕', category: 'vegetable', size: 1, tileColor: '#FFF8E1', wateringDays: 4 },
  { id: 'sellerie',     name: 'Sellerie',      emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'süsskartoffel', name: 'Süßkartoffel', emoji: '🍠', category: 'vegetable', size: 1, tileColor: '#FFF3E0', wateringDays: 3 },
  { id: 'meerrettich',  name: 'Meerrettich',   emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 5 },
  // Blattgemüse & Salate
  { id: 'salat',        name: 'Salat',         emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 1 },
  { id: 'spinat',       name: 'Spinat',        emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'mangold',      name: 'Mangold',       emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'rucola',       name: 'Rucola',        emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'feldsalat',    name: 'Feldsalat',     emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'endivie',      name: 'Endivie',       emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#F1F8E9', wateringDays: 2 },
  { id: 'pak-choi',     name: 'Pak Choi',      emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'kale',         name: 'Grünkohl',      emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  // Kohlgemüse
  { id: 'brokkoli',     name: 'Brokkoli',      emoji: '🥦', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'blumenkohl',   name: 'Blumenkohl',    emoji: '🥦', category: 'vegetable', size: 1, tileColor: '#F1F8E9', wateringDays: 3 },
  { id: 'kohlrabi',     name: 'Kohlrabi',      emoji: '🥦', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'wirsing',      name: 'Wirsing',       emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'rotkohl',      name: 'Rotkohl',       emoji: '🥬', category: 'vegetable', size: 1, tileColor: '#EDE7F6', wateringDays: 3 },
  { id: 'rosenkohl',    name: 'Rosenkohl',     emoji: '🥦', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  // Zwiebelgewächse & Hülsenfrüchte
  { id: 'zwiebel',      name: 'Zwiebel',       emoji: '🧅', category: 'vegetable', size: 1, tileColor: '#FFF8E1', wateringDays: 4 },
  { id: 'porree',       name: 'Lauch / Porree', emoji: '🧅', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'knoblauch',    name: 'Knoblauch',     emoji: '🧄', category: 'vegetable', size: 1, tileColor: '#FFF8E1', wateringDays: 7 },
  { id: 'erbsen',       name: 'Erbsen',        emoji: '🫛', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'bohnen',       name: 'Bohnen',        emoji: '🫘', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  // Sonstiges
  { id: 'fenchel',      name: 'Fenchel',       emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'artischocke',  name: 'Artischocke',   emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'rhabarber',    name: 'Rhabarber',     emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#FFEBEE', wateringDays: 4 },
  { id: 'spargel',      name: 'Spargel',       emoji: '🌿', category: 'vegetable', size: 1, tileColor: '#F1F8E9', wateringDays: 3 },
  { id: 'topinambur',   name: 'Topinambur',    emoji: '🌻', category: 'vegetable', size: 1, tileColor: '#FFF8DC', wateringDays: 5 },
  { id: 'steckrübe',    name: 'Steckrübe',     emoji: '🟡', category: 'vegetable', size: 1, tileColor: '#FFFDE7', wateringDays: 4 },
];

// ─────────────────────────────────────────────────────────────────────────────
// OBST & BEEREN / FRUITS  (25 Einträge)
// ─────────────────────────────────────────────────────────────────────────────
const fruits: GardenElement[] = [
  // Klassische Beeren
  { id: 'erdbeere',        name: 'Erdbeere',         emoji: '🍓', category: 'fruit', size: 1, tileColor: '#FFEBEE', wateringDays: 1 },
  { id: 'himbeere',        name: 'Himbeere',         emoji: '🫐', category: 'fruit', size: 1, tileColor: '#FCE4EC', wateringDays: 2 },
  { id: 'brombeere',       name: 'Brombeere',        emoji: '🫐', category: 'fruit', size: 1, tileColor: '#EDE7F6', wateringDays: 2 },
  { id: 'heidelbeere',     name: 'Heidelbeere',      emoji: '🫐', category: 'fruit', size: 1, tileColor: '#E8EAF6', wateringDays: 3 },
  { id: 'rote-johannisbeere', name: 'Rote Johannisbeere', emoji: '🍒', category: 'fruit', size: 1, tileColor: '#FFEBEE', wateringDays: 3 },
  { id: 'schwarze-johannisbeere', name: 'Schwarze Johannisbeere', emoji: '🫐', category: 'fruit', size: 1, tileColor: '#EDE7F6', wateringDays: 3 },
  { id: 'stachelbeere',    name: 'Stachelbeere',     emoji: '🟢', category: 'fruit', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  // Kletterpflanzen & Ranker
  { id: 'weintraube',      name: 'Weintraube',       emoji: '🍇', category: 'fruit', size: 2, tileColor: '#EDE7F6', wateringDays: 4 },
  { id: 'kiwi',            name: 'Kiwi',             emoji: '🥝', category: 'fruit', size: 2, tileColor: '#E8F5E9', wateringDays: 3 },
  // Besondere Beeren & Sträucher
  { id: 'sanddorn',        name: 'Sanddorn',         emoji: '🟠', category: 'fruit', size: 1, tileColor: '#FFF3E0', wateringDays: 7 },
  { id: 'aronia',          name: 'Aronia',           emoji: '🫐', category: 'fruit', size: 1, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'cranberry',       name: 'Cranberry',        emoji: '🔴', category: 'fruit', size: 1, tileColor: '#FFEBEE', wateringDays: 3 },
  { id: 'holunderbeere',   name: 'Holunderbeere',    emoji: '🫐', category: 'fruit', size: 2, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'preiselbeere',    name: 'Preiselbeere',     emoji: '🔴', category: 'fruit', size: 1, tileColor: '#FFEBEE', wateringDays: 4 },
  { id: 'felsenbirne',     name: 'Felsenbirne',      emoji: '🍒', category: 'fruit', size: 1, tileColor: '#FCE4EC', wateringDays: 5 },
  { id: 'honigbeere',      name: 'Honigbeere',       emoji: '🟡', category: 'fruit', size: 1, tileColor: '#FFFDE7', wateringDays: 4 },
  { id: 'physalis',        name: 'Physalis',         emoji: '🏮', category: 'fruit', size: 1, tileColor: '#FFF3E0', wateringDays: 3 },
  { id: 'maulbeere',       name: 'Maulbeere',        emoji: '🫐', category: 'fruit', size: 2, tileColor: '#EDE7F6', wateringDays: 5 },
  { id: 'cornelkirsche',   name: 'Kornelkirsche',    emoji: '🔴', category: 'fruit', size: 2, tileColor: '#FFEBEE', wateringDays: 5 },
  // Melonen & Kürbisfrüchte
  { id: 'melone',          name: 'Melone',           emoji: '🍈', category: 'fruit', size: 2, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'wassermelone',    name: 'Wassermelone',     emoji: '🍉', category: 'fruit', size: 2, tileColor: '#FFEBEE', wateringDays: 2 },
  // Exotisch (Kübelpflanzen, Winterschutz)
  { id: 'feige-kübel',     name: 'Feige (Kübel)',    emoji: '🌳', category: 'fruit', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'granatapfel',     name: 'Granatapfel',      emoji: '🍎', category: 'fruit', size: 1, tileColor: '#FFEBEE', wateringDays: 4 },
  { id: 'passionsfrucht',  name: 'Passionsfrucht',   emoji: '🟣', category: 'fruit', size: 1, tileColor: '#EDE7F6', wateringDays: 2 },
  { id: 'kaktusfeige',     name: 'Kaktusfeige',      emoji: '🌵', category: 'fruit', size: 1, tileColor: '#E8F5E9', wateringDays: 14 },
];

// ─────────────────────────────────────────────────────────────────────────────
// KRÄUTER / HERBS  (25 Einträge)
// ─────────────────────────────────────────────────────────────────────────────
const herbs: GardenElement[] = [
  // Mediterrane Kräuter
  { id: 'basilikum',      name: 'Basilikum',       emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 1 },
  { id: 'rosmarin',       name: 'Rosmarin',        emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 7 },
  { id: 'thymian',        name: 'Thymian',         emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 7 },
  { id: 'oregano',        name: 'Oregano',         emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 7 },
  { id: 'salbei',         name: 'Salbei',          emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 7 },
  { id: 'lavendel-kraut', name: 'Lavendel',        emoji: '💜', category: 'herb', size: 1, tileColor: '#EDE7F6', wateringDays: 7 },
  // Heimische Kräuter
  { id: 'petersilie',     name: 'Petersilie',      emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'schnittlauch',   name: 'Schnittlauch',    emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'dill',           name: 'Dill',            emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 2 },
  { id: 'koriander',      name: 'Koriander',       emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 2 },
  { id: 'majoran',        name: 'Majoran',         emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 5 },
  { id: 'bohnenkraut',    name: 'Bohnenkraut',     emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 5 },
  { id: 'estragon',       name: 'Estragon',        emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 4 },
  { id: 'liebstöckel',    name: 'Liebstöckel',     emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'lorbeer',        name: 'Lorbeer',         emoji: '🍃', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 7 },
  // Minzen & Melissen
  { id: 'minze',          name: 'Minze',           emoji: '🌿', category: 'herb', size: 1, tileColor: '#E0F2F1', wateringDays: 2 },
  { id: 'zitronenmelisse', name: 'Zitronenmelisse', emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 3 },
  { id: 'pfefferminze',   name: 'Pfefferminze',    emoji: '🌿', category: 'herb', size: 1, tileColor: '#E0F2F1', wateringDays: 2 },
  // Essbare Wildkräuter
  { id: 'bärlauch',       name: 'Bärlauch',        emoji: '🧄', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 4 },
  { id: 'waldmeister',    name: 'Waldmeister',     emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 4 },
  { id: 'borretsch',      name: 'Borretsch',       emoji: '🔵', category: 'herb', size: 1, tileColor: '#E3F2FD', wateringDays: 3 },
  { id: 'kapuzinerkresse', name: 'Kapuzinerkresse', emoji: '🌸', category: 'herb', size: 1, tileColor: '#FFF3E0', wateringDays: 2 },
  // Spezielle Kräuter
  { id: 'kümmel',         name: 'Kümmel',          emoji: '🌿', category: 'herb', size: 1, tileColor: '#F1F8E9', wateringDays: 5 },
  { id: 'fenchel-kraut',  name: 'Fenchel (Kraut)', emoji: '🌿', category: 'herb', size: 1, tileColor: '#E8F5E9', wateringDays: 3 },
  { id: 'ysop',           name: 'Ysop',            emoji: '🌿', category: 'herb', size: 1, tileColor: '#EDE7F6', wateringDays: 5 },
];

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export const GARDEN_ELEMENTS: GardenElement[] = [
  ...flowers,
  ...trees,
  ...vegetables,
  ...fruits,
  ...herbs,
  // structures, water, landscape, accessory — added in later steps
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
