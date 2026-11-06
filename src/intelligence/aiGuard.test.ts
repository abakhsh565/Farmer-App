import { describe, expect, it } from 'vitest';
import {
  boundedKnowledgeHits,
  safeDiagnosisLabel,
  trustedContext,
  validateGeneratedAnswer,
  type TrustedAiContext,
} from '../../supabase/functions/_shared/aiGuard';
import type { FarmerPrompt } from '../../supabase/functions/_shared/intelligence';
import type { KnowledgeHit } from '../../supabase/functions/_shared/knowledge';

const CONTEXT: TrustedAiContext = {
  cropCode: 'cotton',
  cropStage: 'flowering',
  district: 'Multan',
};

const PROMPT: FarmerPrompt = {
  available: true,
  block: '',
  categories: ['crops', 'location'],
  scoringVersion: 2,
  primaryCrop: { code: 'cotton', stage: 'flowering', primary: true },
  crops: [
    { code: 'cotton', stage: 'flowering', primary: true },
    { code: 'wheat', stage: 'sowing', primary: false },
  ],
  district: 'Multan',
};

function hit(overrides: Partial<KnowledgeHit> = {}): KnowledgeHit {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'cotton-pink-bollworm',
    version: 1,
    title: 'Pink bollworm in cotton',
    titleUr: 'کپاس میں گلابی سنڈی',
    body: 'Scout for pink bollworm and spray only above the economic threshold.',
    bodyUr: 'گلابی سنڈی کے لیے کھیت کا معائنہ کریں۔',
    topic: 'pest',
    problemType: 'pest',
    symptoms: ['holes in bolls'],
    regions: ['Punjab'],
    cropCode: 'cotton',
    provenance: 'test fixture',
    evidenceTier: 'verified',
    sourceCode: 'test-source',
    sourceName: 'Test source',
    sourceUrl: null,
    sourcePublishedOn: '2026-01-01',
    sourceUpdatedOn: null,
    sourceAccessedOn: '2026-11-03',
    sourcePublisher: 'Test publisher',
    sourceLicense: 'test licence',
    stages: ['flowering'],
    districts: ['Multan'],
    stale: false,
    score: 0.9,
    ...overrides,
  };
}

describe('AI trusted context', () => {
  it('selects only an active crop and keeps stage and district from the database', () => {
    const selected = trustedContext(PROMPT, 'wheat');
    expect(selected).toEqual({ cropCode: 'wheat', cropStage: 'sowing', district: 'Multan' });

    const ignored = trustedContext(PROMPT, 'rice');
    expect(ignored).toEqual({ cropCode: 'cotton', cropStage: 'flowering', district: 'Multan' });
  });

  it('does not accept a crop when the farmer has no active crop context', () => {
    expect(trustedContext({ ...PROMPT, primaryCrop: null, crops: [], district: null }, 'cotton')).toEqual({
      cropCode: null,
      cropStage: null,
      district: null,
    });
  });
});

describe('AI generated-answer guard', () => {
  it('accepts a cited answer supported by verified crop/stage evidence', () => {
    expect(validateGeneratedAnswer('Scout first, then spray only above threshold. [1]', [hit()], CONTEXT, 'How do I control bollworm?')).toEqual({
      ok: true,
    });
  });

  it('rejects a citation that was not retrieved', () => {
    expect(validateGeneratedAnswer('Spray now. [2]', [hit()], CONTEXT, 'bollworm')).toEqual({
      ok: false,
      reason: 'bad_citation',
    });
  });

  it('requires at least one citation when evidence was supplied', () => {
    expect(validateGeneratedAnswer('Spray now.', [hit()], CONTEXT, 'bollworm')).toEqual({
      ok: false,
      reason: 'missing_citation',
    });
  });

  it('rejects an invented dose even when the entry is verified', () => {
    expect(validateGeneratedAnswer('Apply 2 ml per litre. [1]', [hit()], CONTEXT, 'bollworm')).toEqual({
      ok: false,
      reason: 'unsafe_chemical',
    });
  });

  it('accepts a dose only when it appears in the verified evidence', () => {
    expect(
      validateGeneratedAnswer(
        'Apply 2 ml per litre only above threshold. [1]',
        [hit({ body: 'Apply 2 ml per litre only above the threshold.' })],
        CONTEXT,
        'bollworm',
      ),
    ).toEqual({ ok: true });
  });

  it('rejects a chemical recommendation without a verified stage match', () => {
    expect(
      validateGeneratedAnswer('Spray Confidor. [1]', [hit({ stages: ['sowing'] })], CONTEXT, 'bollworm'),
    ).toEqual({ ok: false, reason: 'unsafe_chemical' });
  });

  it('rejects chemical advice from a supplementary entry', () => {
    expect(
      validateGeneratedAnswer('Spray now. [1]', [hit({ evidenceTier: 'supplementary' })], CONTEXT, 'bollworm'),
    ).toEqual({ ok: false, reason: 'unsafe_chemical' });
  });

  it('rejects a local weather claim', () => {
    expect(validateGeneratedAnswer('Rain is expected today, so do not spray. [1]', [hit()], CONTEXT, 'bollworm')).toEqual({
      ok: false,
      reason: 'unsafe_weather',
    });
  });
});

describe('diagnosis labels and context bounds', () => {
  it('keeps a diagnosis label short and treatment-free', () => {
    expect(safeDiagnosisLabel('Pink bollworm')).toBe('Pink bollworm');
    expect(safeDiagnosisLabel('Apply 2 ml per litre of Confidor')).toBeNull();
    expect(safeDiagnosisLabel('x'.repeat(121))).toBeNull();
  });

  it('bounds the prompt evidence without dropping citation positions', () => {
    const bounded = boundedKnowledgeHits(
      [hit(), hit({ slug: 'second' }), hit({ slug: 'third' })],
      220,
      100,
    );
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.reduce((total, item) => total + Math.max(item.body.length, item.bodyUr.length), 0)).toBeLessThanOrEqual(220);
    expect(bounded[0]?.hit.slug).toBe('cotton-pink-bollworm');
  });
});
