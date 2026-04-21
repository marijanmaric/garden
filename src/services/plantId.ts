import { PlantIdResult } from '../types';

const PLANT_ID_URL = 'https://api.plant.id/v2/identify';

export async function identifyPlant(
  imageBase64: string,
  apiKey: string
): Promise<PlantIdResult[]> {
  const response = await fetch(PLANT_ID_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
    },
    body: JSON.stringify({
      images: [imageBase64],
      plant_details: ['common_names', 'watering', 'wiki_description'],
      plant_language: 'de',
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message ?? 'Pflanzenidentifikation fehlgeschlagen');
  }

  const data = await response.json();

  return (data.suggestions ?? []).slice(0, 5).map((s: any) => ({
    name: s.plant_name,
    probability: Math.round((s.probability ?? 0) * 100),
    common_names: s.plant_details?.common_names ?? [],
    wiki_description: s.plant_details?.wiki_description?.value ?? undefined,
    watering: s.plant_details?.watering?.max ?? undefined,
  }));
}

export function imageUriToBase64Prefix(base64: string): string {
  // Expo returns raw base64; Plant.id needs data URI prefix
  if (base64.startsWith('data:')) return base64;
  return `data:image/jpeg;base64,${base64}`;
}
