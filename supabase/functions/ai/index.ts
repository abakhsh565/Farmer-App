/**
 * The AI gateway.
 *
 * The app calls this, never the model vendor. Two consequences follow, and both
 * are PRD requirements rather than implementation preferences:
 *
 *   · The OpenAI key lives here, in the function's environment. A key in the
 *     APK is a key published on the internet.
 *   · The gate, the knowledge base and the confidence rule are enforced on the
 *     server, so a farmer's device cannot make the model answer something the
 *     app is not allowed to say — and the knowledge version cited in an answer
 *     cannot differ from the one the server actually used.
 *
 * Routes, after the function name:
 *
 *   POST /ai/ask       { question, context }        → AiAnswer
 *   POST /ai/diagnose  { imageRef, context }        → AiScanResult
 *   GET  /ai/health                                 → which pieces are configured
 *
 * The shape of the reply is the client's `AiAnswer`/`AiScanResult` contract.
 * Nothing is invented to fill a gap: when the knowledge base does not cover the
 * question, the reply is `not_covered` with an escalation, which is what the
 * development provider does and what the tests assert.
 */

import {
  adminClient,
  callerOf,
  clean,
  fail,
  json,
  preflight,
  readJson,
  routeOf,
} from '../_shared/server.ts';
import { retrieveKnowledge, type KnowledgeHit } from '../_shared/knowledge.ts';
import { complete, modelConfigured, modelName, parseJsonObject } from '../_shared/model.ts';

const FUNCTION = 'ai';

/** Mirrors `AI_CONFIDENCE_THRESHOLD` in the client's service contract. */
const CONFIDENCE_THRESHOLD = 70;

type Gate = 'agriculture' | 'off_domain' | 'not_covered';

type Citation = {
  kind: 'knowledge' | 'weather' | 'market' | 'crop_fact' | 'scan';
  label: string;
  version?: number;
};

type AiContext = {
  cropCode?: string;
  cropStage?: string;
  district?: string;
  language: string;
  weatherUsable?: boolean;
  signalSubjects?: string[];
};

type AiAnswer = {
  gate: Gate;
  confidence: number;
  text?: string;
  refusalReasonKey?: string;
  citations: Citation[];
  escalate: boolean;
  caveats: string[];
};

type AiScanResult = {
  gate: Gate;
  diagnosis: string | null;
  confidence: number;
  uncertaintyKey: string | null;
  product?: {
    canonicalId: string;
    name: string;
    registrationNo: string | null;
    listingDealerIds: string[];
  };
  citations: Citation[];
  escalate: boolean;
};

/* -------------------------------------------------------------------------- */
/* Gates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Terms that place a question outside what this app is for.
 *
 * A word list is a crude instrument, and it is used here deliberately as a
 * *pre-filter* rather than as the decision: a question that looks off-domain is
 * only refused outright when no published knowledge matches it. A farmer asking
 * "how do I price my crop" contains no agricultural keyword at all, and must not
 * be refused because of that.
 */
const OFF_DOMAIN = [
  'cricket', 'football', 'movie', 'song', 'politics', 'election', 'bitcoin',
  'crypto', 'lottery', 'visa', 'passport', 'recipe', 'joke', 'weather in london',
];

const AGRICULTURE_SIGNALS = [
  'crop', 'wheat', 'cotton', 'rice', 'maize', 'sugarcane', 'fertiliser',
  'fertilizer', 'khad', 'pesticide', 'spray', 'water', 'irrigation', 'seed',
  'soil', 'harvest', 'sowing', 'pest', 'disease', 'weed', 'insect', 'leaf',
  'yield', 'mandi', 'price', 'market', 'weather', 'rain', 'livestock', 'cattle',
  'animal', 'buffalo', 'goat', 'wheat', 'گندم', 'کپاس', 'چاول', 'مکئی', 'کھاد',
  'پانی', 'بیج', 'مٹی', 'فصل', 'کیڑا', 'بیماری', 'منڈی', 'بارش', 'موسم',
];

function looksOffDomain(question: string): boolean {
  const lower = question.toLowerCase();
  const hit = OFF_DOMAIN.some((term) => lower.includes(term));
  if (!hit) return false;
  // Only off-domain if nothing agricultural appears beside it.
  return !AGRICULTURE_SIGNALS.some((term) => lower.includes(term));
}

/* -------------------------------------------------------------------------- */
/* Grounding                                                                  */
/* -------------------------------------------------------------------------- */

function caveatsFor(hits: KnowledgeHit[], context: AiContext, mode: 'keyword' | 'semantic'): string[] {
  const caveats: string[] = [];
  if (mode === 'keyword') {
    caveats.push('Answers are drawn from a keyword index over published entries.');
  }
  if (!context.cropCode) {
    caveats.push('No crop was confirmed, so the answer is not crop-specific.');
  }
  if (context.weatherUsable === false) {
    caveats.push('Weather is not usable right now, so no weather-dependent step is given.');
  }
  const oldest = hits.reduce((acc, hit) => Math.max(acc, hit.version), 0);
  if (oldest > 1) {
    caveats.push(`Some cited entries have been revised (up to version ${oldest}).`);
  }
  return caveats;
}

function citationsFor(hits: KnowledgeHit[], context: AiContext): Citation[] {
  const citations: Citation[] = hits.map((hit) => ({
    kind: 'knowledge' as const,
    label: hit.topic || hit.slug,
    version: hit.version,
  }));
  if (context.cropCode) {
    citations.push({
      kind: 'crop_fact',
      label: [context.cropCode, context.cropStage].filter(Boolean).join(', '),
    });
  }
  return citations;
}

/**
 * A confidence number for a grounded answer.
 *
 * It is derived from retrieval, not from the model's self-report. A model asked
 * "how confident are you" answers with a number that tracks its tone, not its
 * evidence; retrieval scores track the evidence. This is the same formula the
 * development provider uses, so a question that escalates in tests escalates in
 * production.
 */
function confidenceFor(hits: KnowledgeHit[], context: AiContext): number {
  if (hits.length === 0) return 0;
  const best = hits[0]!;
  const cropBonus = context.cropCode && best.cropCode === context.cropCode ? 5 : 0;
  return Math.round(Math.min(92, 55 + Math.min(best.score, 1) * 35 + cropBonus));
}

function systemPrompt(context: AiContext, hits: KnowledgeHit[]): string {
  const language = context.language === 'ur' ? 'Urdu' : 'English';
  const knowledge = hits
    .map((hit, index) => `[${index + 1}] ${hit.title} (v${hit.version}, ${hit.provenance})\n${hit.body}`)
    .join('\n\n');

  return [
    'You are an agricultural advisor for smallholder farmers in Punjab, Pakistan.',
    `Answer in ${language}. Keep it short and practical, and name the action to take.`,
    '',
    'Hard rules:',
    '· Use ONLY the numbered knowledge entries below. Do not add facts from memory.',
    '· If the entries do not answer the question, say so plainly and stop.',
    '· Cite the entries you used by their bracketed number, e.g. [1].',
    '· Never name a pesticide dose, brand or product that is not in an entry.',
    '· Do not mention weather unless a reading is provided and marked usable.',
    '',
    `Confirmed crop: ${context.cropCode ?? 'unknown'} (stage: ${context.cropStage ?? 'unknown'})`,
    `District: ${context.district ?? 'unknown'}`,
    `Weather usable for advice: ${context.weatherUsable === true ? 'yes' : 'no'}`,
    '',
    'Knowledge entries:',
    knowledge || '(none retrieved)',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

async function handleAsk(body: Record<string, unknown>): Promise<Response> {
  const question = clean(body.question, 500);
  if (!question) return fail('A question is required.');

  const context = (body.context ?? {}) as AiContext;
  const language = context.language === 'ur' ? 'ur' : 'en';

  // The domain gate runs before retrieval, but only refuses outright when
  // nothing agricultural is present and no published entry matches.
  const client = adminClient();
  const { hits, mode } = await retrieveKnowledge(client, question, {
    cropCode: context.cropCode ?? null,
    limit: 4,
  });

  if (looksOffDomain(question) && hits.length === 0) {
    const refusal: AiAnswer = {
      gate: 'off_domain',
      confidence: 0,
      refusalReasonKey: 'scan.offDomain.title',
      citations: [],
      escalate: false,
      caveats: [],
    };
    return json(refusal);
  }

  if (hits.length === 0) {
    const uncovered: AiAnswer = {
      gate: 'not_covered',
      confidence: 20,
      refusalReasonKey: 'scan.notCovered.title',
      citations: [],
      escalate: true,
      caveats: [
        'No published knowledge entry matched this question.',
        'Nothing was invented to fill the gap — a person can answer it.',
      ],
    };
    return json(uncovered);
  }

  if (!modelConfigured()) {
    // Honest degraded mode: the retrieval is real and citable, the prose is not
    // available. Reported as an error rather than answered from the raw entries,
    // because an unedited bulletin is not an answer to a specific question.
    return fail('The model is not configured on the server.', 503);
  }

  const reply = await complete([
    { role: 'system', content: systemPrompt(context, hits) },
    { role: 'user', content: question },
  ], { maxTokens: 600 });

  if (!reply.ok) {
    return fail(`The model could not answer: ${reply.detail}`, 502);
  }

  const confidence = confidenceFor(hits, context);
  const answer: AiAnswer = {
    gate: 'agriculture',
    confidence,
    text: reply.text,
    citations: citationsFor(hits, context),
    escalate: confidence < CONFIDENCE_THRESHOLD,
    caveats: caveatsFor(hits, context, mode),
  };
  return json(answer);
}

/**
 * Diagnosis is a two-stage pipeline, and the order matters.
 *
 * The image is described first, and the description is then matched against the
 * knowledge base. Asking a vision model to name a pesticide directly is how an
 * app ends up recommending a product nobody approved; asking it to describe what
 * it sees keeps the medical judgement inside the authored entries.
 */
async function handleDiagnose(body: Record<string, unknown>): Promise<Response> {
  const imageRef = clean(body.imageRef, 4000);
  if (!imageRef) return fail('An image reference is required.');

  const context = (body.context ?? {}) as AiContext;

  if (!modelConfigured()) {
    return fail('The model is not configured on the server.', 503);
  }

  const isDataUrl = imageRef.startsWith('data:image/');
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        'Describe what is visible on this crop leaf or plant, and name the most likely problem.',
        `Crop: ${context.cropCode ?? 'unknown'}, stage: ${context.cropStage ?? 'unknown'}.`,
        'Reply as JSON: {"problem": string, "symptoms": string[], "confidence": number, "is_agriculture": boolean}.',
        'Set is_agriculture false if the image is not a plant. Do not name any pesticide or product.',
      ].join('\n'),
    },
  ];
  if (isDataUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageRef } });
  }

  const reply = await complete(
    [
      {
        role: 'system',
        content:
          'You are a plant pathologist. You describe what you see and you never recommend a chemical.',
      },
      { role: 'user', content: userContent as unknown as string },
    ],
    { json: true, maxTokens: 400 },
  );

  if (!reply.ok) {
    return fail(`The image could not be read: ${reply.detail}`, 502);
  }

  const parsed = parseJsonObject(reply.text) ?? {};
  const isAgriculture = parsed.is_agriculture !== false;
  const problem = typeof parsed.problem === 'string' ? parsed.problem : null;

  if (!isAgriculture || !problem) {
    const offDomain: AiScanResult = {
      gate: 'off_domain',
      diagnosis: null,
      confidence: 0,
      uncertaintyKey: 'scan.offDomain.title',
      citations: [],
      escalate: false,
    };
    return json(offDomain);
  }

  // The description is matched against published entries; the product chain
  // comes from the knowledge row, never from the model.
  const client = adminClient();
  const { hits } = await retrieveKnowledge(client, problem, {
    cropCode: context.cropCode ?? null,
    limit: 3,
  });

  if (hits.length === 0) {
    const uncovered: AiScanResult = {
      gate: 'not_covered',
      diagnosis: problem,
      confidence: 25,
      uncertaintyKey: 'scan.notCovered.title',
      citations: [],
      escalate: true,
    };
    return json(uncovered);
  }

  const modelConfidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : 50;
  // Blended, then capped by evidence: a confident model over a thin retrieval
  // does not produce a confident app.
  const confidence = Math.round(Math.min(88, modelConfidence * 0.4 + confidenceFor(hits, context) * 0.6));

  const top = hits[0]!;
  const product = await productChain(client, top);

  const result: AiScanResult = {
    gate: 'agriculture',
    diagnosis: problem,
    confidence,
    uncertaintyKey: confidence < CONFIDENCE_THRESHOLD ? 'scan.uncertainty' : null,
    ...(product ? { product } : {}),
    citations: citationsFor(hits, context),
    escalate: confidence < CONFIDENCE_THRESHOLD,
  };
  return json(result);
}

/**
 * The evidence chain behind a treatment: the canonical product the cited entry
 * names, plus which dealers currently list it. Read from the database, so the
 * shop list cannot disagree with the dealer page.
 */
async function productChain(
  client: ReturnType<typeof adminClient>,
  hit: KnowledgeHit,
): Promise<AiScanResult['product']> {
  const { data } = await client.rpc('ai_product_for_knowledge', { p_slug: hit.slug });
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row || typeof row.canonical_id !== 'string' || typeof row.name !== 'string') return undefined;

  const listings = Array.isArray(row.listing_dealer_ids)
    ? (row.listing_dealer_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];

  return {
    canonicalId: row.canonical_id,
    name: row.name,
    registrationNo: typeof row.registration_no === 'string' ? row.registration_no : null,
    listingDealerIds: listings,
  };
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  const route = routeOf(req, FUNCTION);

  try {
    if (route === 'health') {
      return json({
        ok: true,
        model: modelConfigured() ? modelName() : null,
        modelConfigured: modelConfigured(),
      });
    }

    if (req.method !== 'POST') return fail('Use POST.', 405);

    const caller = await callerOf(req);
    const body = (await readJson<Record<string, unknown>>(req)) ?? {};

    // Identity is recorded for the audit trail but never trusted from the body.
    const context = (body.context ?? {}) as AiContext;
    if (caller.userId) context.signalSubjects = context.signalSubjects ?? [];

    switch (route) {
      case 'ask':
        return await handleAsk(body);
      case 'diagnose':
        return await handleDiagnose(body);
      default:
        return fail(`Unknown route "${route}".`, 404);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
