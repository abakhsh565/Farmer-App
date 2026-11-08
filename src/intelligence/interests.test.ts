import { describe, expect, it } from 'vitest';
import {
  groupInterestSettings,
  interestLabel,
  interestSourceKey,
  parseInterestSetting,
  parseInterestSettings,
  type InterestSetting,
} from './interests';

const row = (overrides: Partial<InterestSetting> = {}): InterestSetting => ({
  topic: 'topic:pest',
  cropCode: null,
  weight: 0.42,
  confidence: 0.6,
  source: 'behaviour',
  pinned: false,
  updatedAt: null,
  ...overrides,
});

describe('interest rows', () => {
  it('maps the RPC shape and preserves the server order', () => {
    const parsed = parseInterestSettings([
      {
        topic: 'topic:market',
        weight: 0.7,
        confidence: 0.8,
        source: 'explicit',
        pinned: true,
        crop_code: 'cotton',
        updated_at: '2026-11-03T10:00:00.000Z',
      },
      {
        topic: 'topic:pest',
        weight: 0.3,
        confidence: 0.4,
        source: 'behaviour',
        pinned: false,
        crop_code: null,
        updated_at: null,
      },
    ]);

    expect(parsed.map((entry) => entry.topic)).toEqual(['topic:market', 'topic:pest']);
    expect(parsed[0]).toMatchObject({
      source: 'explicit',
      pinned: true,
      cropCode: 'cotton',
      updatedAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('drops malformed and duplicate rows rather than rendering half a card', () => {
    const parsed = parseInterestSettings([
      { topic: 'not-a-topic', weight: 0.5 },
      { topic: 'topic:pest', weight: 'high' },
      { topic: 'topic:pest', weight: 0.4 },
      { topic: 'topic:market', weight: 0.2 },
      null,
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed.map((entry) => entry.topic)).toEqual(['topic:pest', 'topic:market']);
  });

  it('treats an unknown source as learned instead of trusting a stray value', () => {
    expect(parseInterestSetting({ topic: 'topic:pest', weight: 0.4, source: 'admin' })).toMatchObject(
      { source: 'behaviour' },
    );
  });
});

describe('interest grouping', () => {
  it('puts pinned first, then explicit, then learned without reordering inside a group', () => {
    const groups = groupInterestSettings([
      row({ topic: 'topic:market', weight: 0.9 }),
      row({ topic: 'topic:pest', pinned: true }),
      row({ topic: 'topic:weather', source: 'explicit' }),
      row({ topic: 'topic:activity', source: 'feedback' }),
    ]);

    expect(groups.pinned.map((entry) => entry.topic)).toEqual(['topic:pest']);
    expect(groups.chosen.map((entry) => entry.topic)).toEqual(['topic:weather']);
    expect(groups.learned.map((entry) => entry.topic)).toEqual([
      'topic:market',
      'topic:activity',
    ]);
  });

  it('describes provenance without exposing weights or confidence', () => {
    const t = (key: string) => key;
    expect(interestSourceKey(row({ pinned: true }))).toBe('interests.source.pinned');
    expect(interestSourceKey(row({ source: 'explicit' }))).toBe('interests.source.explicit');
    expect(interestSourceKey(row({ source: 'feedback' }))).toBe('interests.source.learned');
    expect(interestLabel('topic:pest', t)).toBe('interests.topic.pest');
    expect(interestLabel('topic:whitefly', t)).toBe('Whitefly');
    expect(interestLabel('product:urea', t)).toBe('Urea');
  });
});
