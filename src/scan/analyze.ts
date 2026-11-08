/**
 * The assistant's gates, as decisions rather than prose.
 *
 * Three rules from the PRD become three outcomes here, and every one of them is
 * reachable from the UI, because "we will refuse off-topic questions" is worth
 * nothing if the refusal path does not exist:
 *
 *  · **Domain gate** — the assistant answers farming, or it says it cannot.
 *    Politics, cricket and general knowledge are not answered from model
 *    knowledge, however easy the answer would be.
 *  · **Coverage** — an agriculture question the approved sources do not cover is
 *    not answered by guessing; it is routed to a verified expert.
 *  · **Confidence** — a match below the threshold is never presented as a
 *    treatment recommendation.
 *
 * A demo cannot run a real classifier, so this is a deliberate keyword gate over
 * the vocabulary this audience actually uses, in Latin script and in Urdu. What
 * matters for the product — and what the tests hold — is that the *outcomes* are
 * distinguished and that nothing falls through to a guess.
 */

export type Gate = 'agriculture' | 'off_domain' | 'not_covered';

import type { AiCitation } from '@/services/types';

export type Verdict =
  | {
      kind: 'answer';
      gate: 'agriculture';
      text?: string;
      citations?: AiCitation[];
      generation?: 'model' | 'retrieval';
      caveats?: string[];
    }
  | { kind: 'refuse'; gate: 'off_domain' }
  | { kind: 'escalate'; gate: 'not_covered' };

const AGRICULTURE = [
  'cotton', 'kapas', 'wheat', 'gandum', 'maize', 'makai', 'rice', 'chawal',
  'crop', 'fasal', 'plant', 'poda', 'leaf', 'patta', 'pest', 'keera', 'worm',
  'sundi', 'bollworm', 'spray', 'spraying', 'fertilizer', 'khad', 'urea', 'dap',
  'water', 'pani', 'irrigation', 'weather', 'mausam', 'rain', 'barish', 'mandi',
  'rate', 'bhao', 'price', 'dealer', 'seed', 'beej', 'harvest', 'chinai', 'soil',
  'mitti', 'disease', 'bimari', 'virus', 'fungus', 'pesticide', 'dawa', 'sowing',
  'بوائی', 'کپاس', 'گندم', 'مکئی', 'چاول', 'فصل', 'پودا', 'پتہ', 'کیڑا', 'سنڈی',
  'سپرے', 'کھاد', 'یوریا', 'پانی', 'موسم', 'بارش', 'منڈی', 'بھاؤ', 'بیج', 'مٹی',
  'بیماری', 'دوا',
];

const OFF_DOMAIN = [
  'politics', 'election', 'cricket', 'match', 'football', 'movie', 'film',
  'song', 'religion', 'pray', 'news', 'bitcoin', 'joke', 'lottery',
  'سیاست', 'الیکشن', 'کرکٹ', 'میچ', 'فلم', 'مذہب', 'خبر',
];

/** Below this a diagnosis is a candidate, never a recommendation. */
export const CONFIDENCE_THRESHOLD = 70;

/**
 * Latin terms match on word boundaries; other scripts match as substrings.
 *
 * This is not fussiness. Plain substring matching let *spray* register as *pray*,
 * so a farmer asking when to spray was told the assistant only answers farming
 * questions. Urdu has no `\b` in JavaScript's sense, so those terms keep the
 * looser match — which is right for a language where the term is the word.
 */
function containsTerm(haystack: string, word: string): boolean {
  const term = word.toLowerCase();
  if (!/^[a-z][a-z ]*$/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(haystack);
}

export function isOffDomain(text: string): boolean {
  const haystack = text.trim().toLowerCase();
  return OFF_DOMAIN.some((word) => containsTerm(haystack, word));
}

export function isAgricultural(text: string): boolean {
  const haystack = text.trim().toLowerCase();
  return AGRICULTURE.some((word) => containsTerm(haystack, word));
}

/**
 * Off-domain is checked first and wins: a question that mentions both the weather
 * and an election is not a farming question, and being *nearly* on topic is not
 * the bar the rule sets.
 */
export function gate(text: string): Gate {
  if (isOffDomain(text)) return 'off_domain';
  if (isAgricultural(text)) return 'agriculture';
  return 'not_covered';
}

export function verdictFor(text: string): Verdict {
  const result = gate(text);
  if (result === 'agriculture') return { kind: 'answer', gate: 'agriculture' };
  if (result === 'off_domain') return { kind: 'refuse', gate: 'off_domain' };
  return { kind: 'escalate', gate: 'not_covered' };
}

/** A low-confidence or high-risk case goes to a human, not to a spray schedule. */
export function shouldEscalate(confidence: number, risk: 'normal' | 'high' = 'normal'): boolean {
  return confidence < CONFIDENCE_THRESHOLD || risk === 'high';
}
