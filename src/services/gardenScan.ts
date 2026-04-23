import { PlantType } from '../types';

export interface DetectedPlant {
  name: string;
  species: string;
  type: PlantType;
  grid_x: number;
  grid_y: number;
  confidence: number;
}

const VALID_TYPES: PlantType[] = [
  'tree', 'flower', 'vegetable', 'herb', 'grass',
  'cactus', 'succulent', 'shrub', 'fruit', 'other',
];

export async function scanGardenPhoto(
  imageBase64: string,
  apiKey: string
): Promise<DetectedPlant[]> {
  const base64Data = imageBase64.startsWith('data:')
    ? imageBase64.split(',')[1]
    : imageBase64;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
          },
          {
            type: 'text',
            text: `Analysiere dieses Gartenfoto. Identifiziere alle sichtbaren Pflanzen oder Pflanzenbereiche. Betrachte das Bild als 10x10 Raster, wobei (0,0) oben links und (9,9) unten rechts ist. Für jede erkannte Pflanze gib zurück: name (deutscher allgemeiner Name), species (wissenschaftlicher Name oder leerer String), type (eines von: tree, flower, vegetable, herb, grass, cactus, succulent, shrub, fruit, other), grid_x (0-9), grid_y (0-9), confidence (0-100). Antworte NUR mit einem gültigen JSON-Array ohne Markdown. Beispiel: [{"name":"Rose","species":"Rosa canina","type":"flower","grid_x":2,"grid_y":3,"confidence":85}]`,
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message ?? 'Gartenanalyse fehlgeschlagen');
  }

  const data = await response.json();
  let text = (data.content?.[0]?.text ?? '[]').trim();
  text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');

  const plants: DetectedPlant[] = JSON.parse(text);

  return plants.map((p) => ({
    ...p,
    species: p.species ?? '',
    type: VALID_TYPES.includes(p.type) ? p.type : 'other',
    grid_x: Math.max(0, Math.min(9, Math.round(p.grid_x))),
    grid_y: Math.max(0, Math.min(9, Math.round(p.grid_y))),
  }));
}
