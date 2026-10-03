import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, POST_MAX, RATE_LIMIT_COUNT } from '@/data/community-rules';
import { checkAttachment, checkEntry, findBlockedTerm, isTooLong } from './validate';

const NOW = 1_700_000_000_000;

const mine = (texts: string[], each = 5 * 60_000) =>
  texts.map((text, index) => ({ body: { text }, createdAt: NOW - index * each }));

describe('community validation', () => {
  it('refuses an empty post, including one that is only whitespace', () => {
    expect(checkEntry({ text: '', max: POST_MAX, mine: [], now: NOW })).toBe(
      'community.error.empty',
    );
    expect(checkEntry({ text: '   \n  ', max: POST_MAX, mine: [], now: NOW })).toBe(
      'community.error.empty',
    );
  });

  it('counts the length of the trimmed text, not what is around it', () => {
    expect(isTooLong(`  ${'a'.repeat(POST_MAX)}  `, POST_MAX)).toBe(false);
    expect(isTooLong('a'.repeat(POST_MAX + 1), POST_MAX)).toBe(true);
    expect(
      checkEntry({ text: 'a'.repeat(POST_MAX + 1), max: POST_MAX, mine: [], now: NOW }),
    ).toBe('community.error.long');
  });

  /**
   * The filter has to work in all three scripts, because the abuse arrives in
   * whichever one the sender writes in — and because a rule that only reads
   * English is a rule that only protects English speakers.
   */
  it('catches a term the rules disallow in any of the three scripts', () => {
    expect(findBlockedTerm('you are an idiot')).toBe('idiot');
    expect(findBlockedTerm('تو بیوقوف ہے')).toBe('بیوقوف');
    expect(findBlockedTerm('bewakoof bhai')).toBe('bewakoof');
    expect(findBlockedTerm('The leaves are curling')).toBeNull();
    // Case is not the farmer's problem.
    expect(findBlockedTerm('IDIOT')).toBe('idiot');
  });

  it('reports the rule that was broken rather than posting it', () => {
    expect(
      checkEntry({ text: 'this spray is stupid advice', max: POST_MAX, mine: [], now: NOW }),
    ).toBe('community.error.rules');
  });

  it('refuses the same thing twice in a row, in any casing or spacing', () => {
    expect(
      checkEntry({ text: 'Rate kya hai', max: POST_MAX, mine: mine(['rate kya hai']), now: NOW }),
    ).toBe('community.error.duplicate');
  });

  it('lets the same words through once they have fallen out of the lookback', () => {
    // Newest first, so the matching entry is the fourth one back.
    const older = mine(['a', 'b', 'c', 'rate kya hai']);
    expect(checkEntry({ text: 'rate kya hai', max: POST_MAX, mine: older, now: NOW })).toBeNull();
  });

  it('stops a burst of posting, then allows it again after the window', () => {
    const burst = Array.from({ length: RATE_LIMIT_COUNT }, (_, index) => ({
      body: { text: `post ${index}` },
      createdAt: NOW - index * 1000,
    }));

    expect(checkEntry({ text: 'one more', max: POST_MAX, mine: burst, now: NOW })).toBe(
      'community.error.tooFast',
    );

    // The same count, all of it older than the window: nothing to throttle.
    const stale = burst.map((entry, index) => ({
      ...entry,
      createdAt: NOW - 120_000 - index * 1000,
    }));
    expect(checkEntry({ text: 'one more', max: POST_MAX, mine: stale, now: NOW })).toBeNull();
  });

  it('accepts a photo or a video and refuses anything else', () => {
    expect(checkAttachment({ type: 'image/jpeg', size: 1024 })).toBeNull();
    expect(checkAttachment({ type: 'video/mp4', size: 1024 })).toBeNull();
    expect(checkAttachment({ type: 'application/pdf', size: 1024 })).toBe(
      'community.error.fileType',
    );
  });

  it('refuses a file too large to hold, and says so rather than failing later', () => {
    expect(checkAttachment({ type: 'image/png', size: ATTACHMENT_MAX_BYTES + 1 })).toBe(
      'community.error.fileSize',
    );
    expect(checkAttachment({ type: 'image/png', size: ATTACHMENT_MAX_BYTES })).toBeNull();
  });

  it('checks the words before the speed: a bad post is told what is wrong with it', () => {
    const burst = Array.from({ length: RATE_LIMIT_COUNT }, (_, index) => ({
      body: { text: `post ${index}` },
      createdAt: NOW - index * 1000,
    }));

    // Both rules broken; the one about the text is the one worth saying.
    expect(checkEntry({ text: 'you idiot', max: POST_MAX, mine: burst, now: NOW })).toBe(
      'community.error.rules',
    );
  });
});
