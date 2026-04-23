import { ZoneType } from '../types';

export interface AnalyzedZone {
  name: string;
  type: ZoneType;
  x: number;
  y: number;
  width: number;
  height: number;
  detected_plants: string[];
  description: string;
}

export interface GardenAnalysisResult {
  zones: AnalyzedZone[];
  garden_width_m: number;
  garden_height_m: number;
  overall_description: string;
}

const VALID_ZONE_TYPES: ZoneType[] = [
  'raised_bed', 'flower_bed', 'lawn', 'tree', 'vegetable_patch',
  'fruit', 'shrub', 'path', 'other',
];

export async function analyzeGardenPhotos(
  imageBase64Array: string[],
  apiKey: string
): Promise<GardenAnalysisResult> {
  const imageContent = imageBase64Array.slice(0, 4).map((b64) => ({
    type: 'image_url' as const,
    image_url: {
      url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`,
      detail: 'high' as const,
    },
  }));

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `Analysiere diese Gartenfotos und erstelle eine digitale Karte. Erkenne alle sichtbaren Gartenbereiche (Hochbeete, Blumenbeete, Rasen, Bäume, Gemüsegärten, Obstpflanzen, Sträucher, Wege usw.).

Für jede Zone gib zurück:
- name: deutscher Name der Zone
- type: eines von (raised_bed, flower_bed, lawn, tree, vegetable_patch, fruit, shrub, path, other)
- x, y: Position in Prozent (0-100), wobei (0,0) oben links ist
- width, height: Größe in Prozent (0-100) der Gesamtfläche
- detected_plants: Array mit bis zu 3 deutschen Pflanzennamen in dieser Zone
- description: kurze deutsche Beschreibung

Schätze auch:
- garden_width_m: ungefähre Breite in Metern
- garden_height_m: ungefähre Höhe in Metern
- overall_description: kurze deutsche Zusammenfassung des Gartens

Antworte NUR mit gültigem JSON ohne Markdown:
{"zones":[...],"garden_width_m":number,"garden_height_m":number,"overall_description":"string"}`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any).error?.message ?? 'Gartenanalyse fehlgeschlagen');
  }

  const data = await response.json();
  let text: string = (data.choices?.[0]?.message?.content ?? '{}').trim();
  text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');

  const result = JSON.parse(text) as GardenAnalysisResult;

  return {
    garden_width_m: result.garden_width_m ?? 10,
    garden_height_m: result.garden_height_m ?? 8,
    overall_description: result.overall_description ?? '',
    zones: (result.zones ?? []).map((z) => ({
      ...z,
      type: VALID_ZONE_TYPES.includes(z.type) ? z.type : 'other',
      x: Math.max(0, Math.min(90, z.x)),
      y: Math.max(0, Math.min(90, z.y)),
      width: Math.max(5, Math.min(95, z.width)),
      height: Math.max(5, Math.min(95, z.height)),
      detected_plants: z.detected_plants ?? [],
      description: z.description ?? '',
    })),
  };
}
