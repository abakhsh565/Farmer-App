import type { CropInstance } from '@/insights/store';

/**
 * The one translation from the farmer's local crop document to the server's
 * validated crop context.
 *
 * The local document is deliberately offline-first, while the recommendation
 * engine works from `crop_instances`. This adapter sends only catalog codes and
 * server enum stages; an unrecognised local key is omitted rather than guessed,
 * because a wrong crop code would attach the wrong advice to a field.
 */
export const SERVER_CROP_STAGES = [
  'planned',
  'sown',
  'germinating',
  'vegetative',
  'flowering',
  'fruiting',
  'maturity',
  'harvested',
  'failed',
] as const;

export type ServerCropStage = (typeof SERVER_CROP_STAGES)[number];

export type ServerCropContext = {
  crop_code: string;
  stage: ServerCropStage;
  primary: boolean;
};

const CROP_CODES: Readonly<Record<string, string>> = {
  'crop.cotton': 'cotton',
  'crop.wheat': 'wheat',
  'crop.rice': 'rice',
  'crop.maize': 'maize',
  'crop.sugarcane': 'sugarcane',
  'crop.gram': 'gram',
  'crop.potato': 'potato',
  'crop.mustard': 'mustard',
  'crop.mungbean': 'mungbean',
  'crop.onion': 'onion',
};

const STAGE_BY_KEY: Readonly<Record<string, ServerCropStage>> = {
  'crop.stage.planned': 'planned',
  'crop.stage.sowing': 'sown',
  'crop.stage.sown': 'sown',
  'crop.stage.germinating': 'germinating',
  'crop.stage.growing': 'vegetative',
  'crop.stage.vegetative': 'vegetative',
  'crop.stage.flowering': 'flowering',
  'crop.stage.bollFormation': 'fruiting',
  'crop.stage.fruiting': 'fruiting',
  'crop.stage.maturity': 'maturity',
  'crop.stage.harvested': 'harvested',
  'crop.stage.failed': 'failed',
};

const MAX_CROPS = 12;

export function toServerCrops(crops: readonly CropInstance[]): ServerCropContext[] {
  const out: ServerCropContext[] = [];
  const indexes = new Map<string, number>();

  for (const crop of crops) {
    const cropCode = CROP_CODES[crop.nameKey];
    const stage = STAGE_BY_KEY[crop.stageKey];
    if (!cropCode || !stage) continue;

    const existing = indexes.get(cropCode);
    if (existing !== undefined) {
      if (crop.primary) out[existing] = { ...out[existing]!, primary: true };
      continue;
    }

    if (out.length >= MAX_CROPS) break;
    indexes.set(cropCode, out.length);
    out.push({ crop_code: cropCode, stage, primary: crop.primary });
  }

  return out;
}

/** A stable cache key for "the server already knows this crop context". */
export function cropContextKey(crops: readonly CropInstance[]): string {
  return toServerCrops(crops)
    .map((crop) => `${crop.crop_code}:${crop.stage}:${crop.primary ? '1' : '0'}`)
    .join('|');
}
