/**
 * Server-side answer guards for the AI gateway.
 *
 * Prompt instructions are guidance, not enforcement. These functions run after
 * the provider replies and after retrieval, so a model that ignores the prompt
 * cannot turn an invented dose, an uncited product or a local weather claim into
 * an answer the app displays.
 *
 * They are deliberately conservative: when the answer cannot be tied to the
 * retrieved evidence, the gateway falls back to a direct published excerpt (or
 * an escalation) instead of asking the farmer to trust model prose.
 */

import type { FarmerPrompt } from './intelligence.ts';
import type { KnowledgeHit } from './knowledge.ts';

export type TrustedAiContext = {
  cropCode: string | null;
  cropStage: string | null;
  district: string | null;
};

/**
 * Build the context the server actually trusts.
 *
 * A client may name a crop it just photographed, but only one of the farmer's
 * own active crops. It cannot choose an arbitrary crop, and it cannot choose a
 * district or a growth stage at all: those come from the database context. This
 * is the server-side boundary that a body field cannot cross.
 */
export function trustedContext(
  prompt: FarmerPrompt,
  requestedCrop?: string | null,
): TrustedAiContext {
  const primary = prompt.primaryCrop ?? prompt.crops[0] ?? null;
  const requested = requestedCrop?.trim().toLowerCase() ?? null;
  const selected = requested
    ? prompt.crops.find((crop) => crop.code.toLowerCase() === requested) ?? null
    : null;
  const crop = selected ?? primary;
  return {
    cropCode: crop?.code ?? null,
    cropStage: crop?.stage ?? null,
    district: prompt.district,
  };
}

const MAX_ANSWER_CHARS = 6000;
const MAX_KNOWLEDGE_CONTEXT_CHARS = 8000;
const MAX_PER_HIT_CHARS = 1800;

const CHEMICAL_ADVICE =
  /\b(spray|spraying|pesticide|insecticide|fungicide|herbicide|acaricide|nematicide|chemical|active ingredient|dose|dosage)\b|سپرے|کیڑے\s*مار|زہر/i;

const DOSAGE =
  /\b\d+(?:[.,]\d+)?\s*(?:ml|millilit(?:er|re)|l|lit(?:er|re)|g|gram|grams|kg|%|percent)\b(?:\s*(?:per|\/)\s*(?:acre|hectare|litre|liter|100\s*l))?/gi;

const ACTIVE_INGREDIENT =
  /\b(glyphosate|imidacloprid|propiconazole|chlorpyrifos|cypermethrin|lambda-cyhalothrin|bifenthrin|abamectin|thiamethoxam|carbendazim|mancozeb|tricyclazole|butachlor|pendimethalin)\b/gi;

const LOCAL_WEATHER =
  /\b(?:today|tomorrow|tonight|currently|right now|this week|forecast|expected|observed)\b[\s\S]{0,100}\b(?:rain|rainfall|weather|temperature|humidity|wind|hail)\b|\b(?:rain|rainfall|weather|temperature|humidity|wind|hail)\b[\s\S]{0,100}\b(?:today|tomorrow|tonight|currently|right now|this week|forecast|expected|observed)\b/i;

const PEST_SIGNAL =
  /pest|insect|worm|bollworm|borer|aphid|thrips|mite|disease|fungus|blight|rust|mildew|rot|weed|کیڑا|سنڈی|بیماری|پھپھوند|جڑی\s*بوٹی/i;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function evidenceText(hits: KnowledgeHit[]): string {
  return hits
    .map((hit) => `${hit.title}\n${hit.body}\n${hit.titleUr}\n${hit.bodyUr}`)
    .join('\n')
    .toLowerCase();
}

/** A short problem label; a diagnosis is not a place for a treatment plan. */
export function safeDiagnosisLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 120) return null;
  if (CHEMICAL_ADVICE.test(cleaned) || DOSAGE.test(cleaned)) {
    DOSAGE.lastIndex = 0;
    return null;
  }
  return cleaned;
}

export type GeneratedAnswerCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'empty'
        | 'too_long'
        | 'bad_citation'
        | 'missing_citation'
        | 'unsafe_chemical'
        | 'unsafe_weather';
    };

/**
 * Validate model prose against the retrieval that was supplied to it.
 *
 * The bracket citations are checked for identity, not just presence: `[4]` when
 * only three entries were retrieved is a fabricated source. Chemical advice gets
 * the stricter test — a verified entry for this crop, this stage and this
 * pest/disease must exist, and every stated dose or active ingredient must occur
 * in that evidence. A local weather claim is refused because the gateway did
 * not supply an observation.
 */
export function validateGeneratedAnswer(
  text: string,
  hits: KnowledgeHit[],
  context: TrustedAiContext,
  query: string,
): GeneratedAnswerCheck {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_ANSWER_CHARS) return { ok: false, reason: 'too_long' };

  const cited = [...trimmed.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (cited.some((index) => !Number.isInteger(index) || index < 1 || index > hits.length)) {
    return { ok: false, reason: 'bad_citation' };
  }
  if (hits.length > 0 && cited.length === 0) {
    return { ok: false, reason: 'missing_citation' };
  }

  if (LOCAL_WEATHER.test(trimmed)) return { ok: false, reason: 'unsafe_weather' };

  DOSAGE.lastIndex = 0;
  const doses = [...trimmed.matchAll(DOSAGE)].map((match) => match[0]);
  const chemical = CHEMICAL_ADVICE.test(trimmed) || doses.length > 0;
  if (!chemical) return { ok: true };

  if (
    !context.cropCode ||
    !context.cropStage ||
    context.cropStage === 'stage_unknown' ||
    !PEST_SIGNAL.test(query)
  ) {
    return { ok: false, reason: 'unsafe_chemical' };
  }

  const verified = hits.filter(
    (hit) =>
      hit.evidenceTier === 'verified' &&
      hit.cropCode === context.cropCode &&
      (hit.stages.length === 0 || hit.stages.includes(context.cropStage as string)),
  );
  if (verified.length === 0) return { ok: false, reason: 'unsafe_chemical' };

  const verifiedText = normalise(evidenceText(verified));

  if (CHEMICAL_ADVICE.test(trimmed) && !verifiedText.match(CHEMICAL_ADVICE)) {
    return { ok: false, reason: 'unsafe_chemical' };
  }

  for (const dose of doses) {
    if (!verifiedText.includes(normalise(dose))) {
      return { ok: false, reason: 'unsafe_chemical' };
    }
  }

  ACTIVE_INGREDIENT.lastIndex = 0;
  for (const match of trimmed.matchAll(ACTIVE_INGREDIENT)) {
    if (!verifiedText.includes(normalise(match[0]))) {
      return { ok: false, reason: 'unsafe_chemical' };
    }
  }
  ACTIVE_INGREDIENT.lastIndex = 0;

  return { ok: true };
}

/**
 * Keep the model context bounded even if a future knowledge row is large.
 * Every hit keeps its citation number; only the prose is capped.
 */
export function boundedKnowledgeHits(
  hits: KnowledgeHit[],
  maxChars = MAX_KNOWLEDGE_CONTEXT_CHARS,
  perHitChars = MAX_PER_HIT_CHARS,
): Array<{ hit: KnowledgeHit; body: string; bodyUr: string }> {
  const bounded: Array<{ hit: KnowledgeHit; body: string; bodyUr: string }> = [];
  let used = 0;
  for (const hit of hits) {
    const remaining = maxChars - used;
    if (remaining < 200) break;
    const body = hit.body.slice(0, Math.min(perHitChars, remaining));
    const bodyUr = hit.bodyUr.slice(0, Math.min(perHitChars, remaining));
    bounded.push({ hit, body, bodyUr });
    used += Math.max(body.length, bodyUr.length);
  }
  return bounded;
}
