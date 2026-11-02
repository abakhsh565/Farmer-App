import { describe, expect, it } from 'vitest';
import {
  activeForCrop,
  addCrop,
  createSeed,
  hydrate,
  primaryCrop,
  removeCrop,
  serialise,
  visibleNotifications,
  type InsightData,
} from './store';

/**
 * The crop list, and the rule that nothing appears in it that the farmer did not
 * put there.
 *
 * This store used to seed two crops and three pieces of advice, so every install
 * opened on advice about cotton nobody had planted. The advice was coherent and
 * entirely invented, which is worse than obviously broken data: it reads as the
 * product working. These tests pin the honest version — an empty first run, and
 * a crop list that only ever grows by the farmer's own choice.
 */

const NOW = Date.UTC(2026, 9, 4);
const DAY = 24 * 60 * 60 * 1000;

describe('the first run', () => {
  it('has no crops and no advice, because nobody has told the app anything', () => {
    const seed = createSeed(NOW);

    expect(seed.crops).toEqual([]);
    expect(seed.insights).toEqual([]);
    expect(seed.notifications).toEqual([]);
    expect(primaryCrop(seed)).toBeUndefined();
  });

  /*
   * The recommendation surfaces key off a primary crop, so with none there is
   * nothing to render and nothing invented. This is the property that makes the
   * empty seed safe rather than a screen that throws.
   */
  it('offers no advice for a farmer with no crops', () => {
    const seed = createSeed(NOW);

    expect(activeForCrop(seed, 'crop-cotton', NOW)).toEqual([]);
    expect(visibleNotifications(seed, NOW)).toEqual([]);
  });

  /*
   * A seed is written to the phone on first launch, so it has to survive the same
   * read-back as any other document. A seed that cannot be re-read would look
   * like a corrupt document on the next start.
   */
  it('round-trips through the document format', () => {
    const seed = createSeed(NOW);
    expect(hydrate(serialise(seed))).toEqual(seed);
  });
});

describe('adding a crop', () => {
  const empty = (): InsightData => createSeed(NOW);

  it('makes the first crop the main one without asking', () => {
    const withCotton = addCrop(
      empty(),
      { nameKey: 'crop.cotton', stageKey: 'crop.stage.bollFormation' },
      NOW,
    );

    expect(withCotton.crops).toHaveLength(1);
    expect(primaryCrop(withCotton)?.nameKey).toBe('crop.cotton');
  });

  /*
   * The farmer confirming a stage is different from the app inferring one from a
   * planting date, and the two must not look alike downstream: an unconfirmed
   * stage is labelled as an estimate everywhere it is shown.
   */
  it('treats a stage the farmer did not confirm as an estimate', () => {
    const inferred = addCrop(
      empty(),
      { nameKey: 'crop.cotton', stageKey: 'crop.stage.bollFormation' },
      NOW,
    );
    expect(inferred.crops[0]?.stageConfirmed).toBe(false);

    const confirmed = addCrop(
      empty(),
      { nameKey: 'crop.wheat', stageKey: 'crop.stage.sowing', stageConfirmed: true },
      NOW,
    );
    expect(confirmed.crops[0]?.stageConfirmed).toBe(true);
  });

  /*
   * Adding the same crop twice is one crop. The id is derived from the crop and
   * the planting moment, so a double tap — or the same farmer on two phones — does
   * not produce two entries or two competing sets of advice.
   */
  it('is idempotent for the same crop and planting date', () => {
    const input = { nameKey: 'crop.cotton' as const, stageKey: 'crop.stage.bollFormation' as const, plantedAt: NOW - 100 * DAY };
    const once = addCrop(empty(), input, NOW);
    const twice = addCrop(once, input, NOW);

    expect(twice.crops).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('does not steal the main crop from the one already chosen', () => {
    const cotton = addCrop(
      empty(),
      { nameKey: 'crop.cotton', stageKey: 'crop.stage.bollFormation' },
      NOW,
    );
    const both = addCrop(cotton, { nameKey: 'crop.wheat', stageKey: 'crop.stage.sowing' }, NOW);

    expect(both.crops).toHaveLength(2);
    expect(both.crops.filter((crop) => crop.primary)).toHaveLength(1);
    expect(primaryCrop(both)?.nameKey).toBe('crop.cotton');
  });
});

describe('removing a crop', () => {
  /* Ids are derived from the crop and its planting moment, so these are the ids
     the two crops actually get rather than invented ones. */
  const COTTON_AT = NOW - 100 * DAY;
  const WHEAT_AT = NOW - 10 * DAY;

  const cottonId = `crop-crop-cotton-${COTTON_AT}`;
  const wheatId = `crop-crop-wheat-${WHEAT_AT}`;

  const two = (): InsightData => {
    const cotton = addCrop(
      createSeed(NOW),
      { nameKey: 'crop.cotton', stageKey: 'crop.stage.bollFormation', plantedAt: COTTON_AT },
      NOW,
    );
    return addCrop(
      cotton,
      { nameKey: 'crop.wheat', stageKey: 'crop.stage.sowing', plantedAt: WHEAT_AT },
      NOW,
    );
  };

  it('leaves the remaining crops alone when a non-main crop goes', () => {
    const after = removeCrop(two(), wheatId);

    expect(after.crops.map((crop) => crop.nameKey)).toEqual(['crop.cotton']);
    expect(primaryCrop(after)?.nameKey).toBe('crop.cotton');
  });

  /*
   * Removing the main crop must not leave the app pointing at a crop that is
   * gone — every recommendation surface reads `primaryCrop`, so a dangling id
   * would render an empty card with no explanation.
   */
  it('hands the main role on when the main crop is removed', () => {
    const after = removeCrop(two(), cottonId);

    expect(after.crops.map((crop) => crop.nameKey)).toEqual(['crop.wheat']);
    expect(after.crops.filter((crop) => crop.primary)).toHaveLength(1);
    expect(primaryCrop(after)?.nameKey).toBe('crop.wheat');
  });

  it('is a no-op for a crop that is not there', () => {
    const start = two();
    expect(removeCrop(start, 'crop-maize')).toBe(start);
  });
});