/**
 * Knowledge retrieval for the AI gateway.
 *
 * The PRD's rule is that advice must cite what it came from. That is only
 * checkable if retrieval returns rows with identity — an entry's slug, version,
 * source and evidence tier — so the answer can name them. A retrieval layer that
 * returns bare strings makes citation impossible and the rule unenforceable.
 *
 * Retrieval is deliberately simple: PostgreSQL full-text search over the
 * authored content, ranked, filtered by crop, district and stage when the caller
 * knows them. The `embedding` column exists for a semantic upgrade, and the fact
 * that it is empty is reported rather than hidden — `mode` comes back as
 * `keyword` so the caller can disclose that answers are drawn from a keyword
 * index.
 *
 * Nothing here imports Deno, which lets the same logic be tested outside the
 * Edge runtime.
 */

export type KnowledgeEvidenceTier = 'verified' | 'supplementary' | 'community';

export type KnowledgeHit = {
  id: string;
  slug: string;
  version: number;
  title: string;
  titleUr: string;
  body: string;
  bodyUr: string;
  topic: string;
  problemType: string;
  symptoms: string[];
  regions: string[];
  cropCode: string | null;
  provenance: string;
  evidenceTier: KnowledgeEvidenceTier;
  sourceCode: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  sourcePublishedOn: string | null;
  sourceUpdatedOn: string | null;
  sourceAccessedOn: string | null;
  sourcePublisher: string | null;
  sourceLicense: string | null;
  stages: string[];
  districts: string[];
  /** The source has passed its review interval or the evidence is near expiry. */
  stale: boolean;
  score: number;
};

type Client = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type Retrieval = {
  hits: KnowledgeHit[];
  /** `keyword` today; `semantic` once embeddings are populated. */
  mode: 'keyword' | 'semantic';
};

function text(value: unknown, max = 4000): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\u0000/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : null;
}

function textArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, 80))
    .filter((item): item is string => item !== null)
    .slice(0, max);
}

function tier(value: unknown): KnowledgeEvidenceTier {
  return value === 'verified' || value === 'community' ? value : 'supplementary';
}

function date(value: unknown): string | null {
  const raw = text(value, 40);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export async function retrieveKnowledge(
  client: Client,
  question: string,
  opts: {
    cropCode?: string | null;
    district?: string | null;
    stage?: string | null;
    limit?: number;
  } = {},
): Promise<Retrieval> {
  const limit = Math.max(1, Math.min(opts.limit ?? 4, 8));
  const { data, error } = await client.rpc('ai_knowledge_search', {
    p_query: question,
    p_crop: opts.cropCode ?? null,
    p_district: opts.district ?? null,
    p_stage: opts.stage ?? null,
    p_limit: limit,
  });

  if (error) {
    // Retrieval failure is not an answer. The caller turns an empty retrieval
    // into `not_covered` with an escalation, which is the honest outcome: the
    // model is never asked to fill a gap the knowledge base left.
    return { hits: [], mode: 'keyword' };
  }

  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const hits: KnowledgeHit[] = [];
  let semantic = false;

  for (const row of rows) {
    const slug = text(row.slug, 120);
    const title = text(row.title_en, 300);
    const body = text(row.body_en, 4000);
    if (!slug || !title || !body) continue;
    if (row.used_embedding === true) semantic = true;

    hits.push({
      id: text(row.id, 80) ?? slug,
      slug,
      version: typeof row.version === 'number' ? row.version : 1,
      title,
      titleUr: text(row.title_ur, 300) ?? title,
      body,
      bodyUr: text(row.body_ur, 4000) ?? body,
      topic: text(row.topic, 60) ?? 'general',
      problemType: text(row.problem_type, 40) ?? 'other',
      symptoms: textArray(row.symptoms),
      regions: textArray(row.regions),
      cropCode: text(row.crop_code, 40),
      provenance: text(row.provenance, 400) ?? 'unattributed',
      evidenceTier: tier(row.evidence_tier),
      sourceCode: text(row.source_code, 80),
      sourceName: text(row.source_name, 200),
      sourceUrl: text(row.source_url, 500),
      sourcePublishedOn: date(row.source_published_on),
      sourceUpdatedOn: date(row.source_updated_on),
      sourceAccessedOn: date(row.source_accessed_on),
      sourcePublisher: text(row.source_publisher, 200),
      sourceLicense: text(row.source_license, 200),
      stages: textArray(row.stages, 20),
      districts: textArray(row.districts, 30),
      stale: row.stale === true,
      score: typeof row.score === 'number' ? row.score : 0,
    });
  }

  return { hits, mode: semantic ? 'semantic' : 'keyword' };
}

/**
 * The deterministic answer used when the model is unavailable or over quota.
 *
 * It is deliberately an excerpt of the highest-ranked published entry, not a
 * synthesis. The UI labels it as retrieval-only, so a farmer is never told that
 * a model produced words it did not produce.
 */
export function retrievalText(
  hits: KnowledgeHit[],
  language: string,
): string | null {
  const top = hits[0];
  if (!top) return null;
  const title = language === 'ur' ? top.titleUr : top.title;
  const body = language === 'ur' ? top.bodyUr : top.body;
  return `${title}\n\n${body}`;
}
