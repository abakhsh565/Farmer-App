/**
 * Knowledge retrieval for the AI gateway.
 *
 * The PRD's rule is that advice must cite what it came from. That is only
 * checkable if retrieval returns rows with identity — an entry's slug, version
 * and provenance — so the answer can name them. A retrieval layer that returns
 * bare strings makes citation impossible and the rule unenforceable.
 *
 * Retrieval is deliberately simple: PostgreSQL full-text search over the
 * authored content, ranked, filtered by crop and stage when the caller knows
 * them. The `embedding` column exists for a semantic upgrade, and the fact that
 * it is empty is reported rather than hidden — `mode` comes back as `keyword`
 * so the caller can disclose that answers are drawn from a keyword index.
 */

export type KnowledgeHit = {
  id: string;
  slug: string;
  version: number;
  title: string;
  body: string;
  topic: string;
  cropCode: string | null;
  provenance: string;
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

export async function retrieveKnowledge(
  client: Client,
  question: string,
  opts: { cropCode?: string | null; limit?: number } = {},
): Promise<Retrieval> {
  const limit = Math.max(1, Math.min(opts.limit ?? 4, 8));
  const { data, error } = await client.rpc('ai_knowledge_search', {
    p_query: question,
    p_crop: opts.cropCode ?? null,
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
    const slug = typeof row.slug === 'string' ? row.slug : null;
    const title = typeof row.title_en === 'string' ? row.title_en : null;
    const body = typeof row.body_en === 'string' ? row.body_en : null;
    if (!slug || !title || !body) continue;
    if (row.used_embedding === true) semantic = true;

    hits.push({
      id: typeof row.id === 'string' ? row.id : slug,
      slug,
      version: typeof row.version === 'number' ? row.version : 1,
      title,
      body,
      topic: typeof row.topic === 'string' ? row.topic : 'general',
      cropCode: typeof row.crop_code === 'string' ? row.crop_code : null,
      provenance: typeof row.provenance === 'string' ? row.provenance : 'unattributed',
      score: typeof row.score === 'number' ? row.score : 0,
    });
  }

  return { hits, mode: semantic ? 'semantic' : 'keyword' };
}