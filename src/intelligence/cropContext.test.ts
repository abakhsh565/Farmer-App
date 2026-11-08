import { describe, expect, it } from 'vitest';
import type { CropInstance } from '@/insights/store';
import { cropContextKey, toServerCrops } from './cropContext';

const crop = (overrides: Partial<CropInstance> = {}): CropInstance => ({
  id: 'crop-1',
  nameKey: 'crop.cotton',
  stageKey: 'crop.stage.bollFormation',
  stageConfirmed: true,
  plantedAt: 1_700_000_000_000,
  primary: true,
  ...overrides,
});

describe('server crop context', () => {
  it('maps only catalog codes and server stage values', () => {
    expect(
      toServerCrops([
        crop(),
        crop({ id: 'crop-2', nameKey: 'crop.wheat', stageKey: 'crop.stage.sowing', primary: false }),
      ]),
    ).toEqual([
      { crop_code: 'cotton', stage: 'fruiting', primary: true },
      { crop_code: 'wheat', stage: 'sown', primary: false },
    ]);
  });

  it('omits a crop it cannot map instead of guessing a code or stage', () => {
    expect(
      toServerCrops([
        crop({ nameKey: 'crop.unknown' as CropInstance['nameKey'] }),
        crop({ nameKey: 'crop.maize', stageKey: 'crop.stage.unknown' as CropInstance['stageKey'] }),
      ]),
    ).toEqual([]);
  });

  it('keeps one row per crop and preserves a primary flag from a duplicate', () => {
    expect(
      toServerCrops([
        crop({ id: 'first', primary: false }),
        crop({ id: 'second', primary: true }),
      ]),
    ).toEqual([{ crop_code: 'cotton', stage: 'fruiting', primary: true }]);
  });

  it('caps the context at twelve crops and builds a stable key', () => {
    const crops = Array.from({ length: 13 }, (_, index) =>
      crop({
        id: `crop-${index}`,
        nameKey: `crop.${index}` as CropInstance['nameKey'],
        stageKey: 'crop.stage.growing',
        primary: index === 0,
      }),
    );
    const mapped = toServerCrops(crops);
    expect(mapped).toHaveLength(0);
    expect(cropContextKey([crop()])).toBe('cotton:fruiting:1');
  });
});
