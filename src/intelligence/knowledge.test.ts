import { describe, expect, it, vi } from 'vitest';
import {
  retrievalText,
  retrieveKnowledge,
  type KnowledgeHit,
} from '../../supabase/functions/_shared/knowledge';

const row = {
  id: 'entry-1',
  slug: 'cotton-pink-bollworm-etl',
  version: 1,
  title_en: 'Pink bollworm economic threshold',
  title_ur: 'گلابی سنڈی کی معاشی حد',
  body_en: 'Count 5 larvae per 100 bolls before spraying.',
  body_ur: 'سپرے سے پہلے 100 ڈوڈوں میں 5 سنڈیاں گنیں۔',
  topic: 'pest',
  problem_type: 'pest',
  symptoms: ['holes in bolls'],
  regions: ['Punjab'],
  crop_code: 'cotton',
  provenance: 'Punjab Agriculture Department',
  evidence_tier: 'verified',
  source_code: 'punjab_agri',
  source_name: 'Punjab Agriculture Department',
  source_url: 'https://agripunjab.gov.pk/pw_economic',
  source_published_on: null,
  source_updated_on: null,
  source_accessed_on: '2026-11-03',
  source_publisher: 'Punjab Agriculture Department',
  source_license: 'Government of Pakistan — public advisory',
  stages: ['vegetative', 'flowering'],
  districts: ['Multan', 'Bahawalpur'],
  stale: false,
  score: 0.82,
  used_embedding: false,
};

describe('knowledge retrieval', () => {
  it('passes only the bounded public query and crop/region preferences to the RPC', async () => {
    const rpc = vi.fn(async () => ({ data: [row], error: null }));
    const result = await retrieveKnowledge({ rpc }, 'How do I control pink bollworm?', {
      cropCode: 'cotton',
      district: 'Multan',
      stage: 'flowering',
      limit: 99,
    });

    expect(rpc).toHaveBeenCalledWith('ai_knowledge_search', {
      p_query: 'How do I control pink bollworm?',
      p_crop: 'cotton',
      p_district: 'Multan',
      p_stage: 'flowering',
      p_limit: 8,
    });
    expect(result.hits[0]).toMatchObject({
      slug: 'cotton-pink-bollworm-etl',
      evidenceTier: 'verified',
      sourceName: 'Punjab Agriculture Department',
      sourceUrl: 'https://agripunjab.gov.pk/pw_economic',
      sourceAccessedOn: '2026-11-03',
      sourcePublisher: 'Punjab Agriculture Department',
      sourceLicense: 'Government of Pakistan — public advisory',
      stages: ['vegetative', 'flowering'],
      districts: ['Multan', 'Bahawalpur'],
      stale: false,
      symptoms: ['holes in bolls'],
    });
    expect(result.mode).toBe('keyword');
  });

  it('does not invent a result when retrieval fails', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'offline' } }));
    await expect(retrieveKnowledge({ rpc }, 'pink bollworm')).resolves.toEqual({
      hits: [],
      mode: 'keyword',
    });
  });

  it('passes no stage when the caller has none, leaving stage-neutral guidance eligible', async () => {
    const rpc = vi.fn(async () => ({ data: [row], error: null }));
    await retrieveKnowledge({ rpc }, 'pink bollworm', { cropCode: 'cotton' });

    expect(rpc).toHaveBeenCalledWith(
      'ai_knowledge_search',
      expect.objectContaining({ p_stage: null }),
    );
  });

  it('surfaces a stale source instead of silently presenting it as current', async () => {
    const rpc = vi.fn(async () => ({ data: [{ ...row, stale: true }], error: null }));
    const result = await retrieveKnowledge({ rpc }, 'pink bollworm', { cropCode: 'cotton' });
    expect(result.hits[0]?.stale).toBe(true);
  });

  it('treats an unknown tier as supplementary rather than verified', async () => {
    const rpc = vi.fn(async () => ({ data: [{ ...row, evidence_tier: 'made-up' }], error: null }));
    const result = await retrieveKnowledge({ rpc }, 'pink bollworm');
    expect(result.hits[0]?.evidenceTier).toBe('supplementary');
  });

  it('uses the correct language for a direct retrieval fallback', () => {
    const hit: KnowledgeHit = {
      id: row.id,
      slug: row.slug,
      version: row.version,
      title: row.title_en,
      titleUr: row.title_ur,
      body: row.body_en,
      bodyUr: row.body_ur,
      topic: row.topic,
      problemType: row.problem_type,
      symptoms: row.symptoms,
      regions: row.regions,
      cropCode: row.crop_code,
      provenance: row.provenance,
      evidenceTier: 'verified',
      sourceCode: row.source_code,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      sourcePublishedOn: null,
      sourceUpdatedOn: null,
      sourceAccessedOn: row.source_accessed_on,
      sourcePublisher: row.source_publisher,
      sourceLicense: row.source_license,
      stages: row.stages,
      districts: row.districts,
      stale: row.stale,
      score: row.score,
    };

    expect(retrievalText([hit], 'en')).toContain(row.body_en);
    expect(retrievalText([hit], 'ur')).toContain(row.body_ur);
    expect(retrievalText([], 'en')).toBeNull();
  });
});