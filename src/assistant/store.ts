/**
 * The assistant's conversation, as data.
 *
 * The product decided that what a farmer asks is worth keeping, and this is that
 * decision made checkable: a question and its answer are a *document*, written to
 * the phone first and to the backend through the same queue every other store
 * uses. Reopening the app finds the conversation where it was left, and a farmer
 * who signs in on a second phone finds it there too — which is the point of
 * persisting it at all rather than holding it in a screen's state.
 *
 * Three rules, and each is here because the alternative is a store that lies:
 *
 *  · **The conversation is bounded, not unbounded.** Two hundred turns is far
 *    more than a season of questions and small enough that the document stays a
 *    document. The oldest turns fall off the front — the store keeps the recent
 *    past, which is what a farmer scrolls back for, and never pretends to be an
 *    archive.
 *
 *  · **A turn is text and a label, not a rendered component.** What is stored is
 *    what was said and the few facts needed to say where it came from. A stored
 *    reply can therefore be read by a future build whose cards look different,
 *    which is exactly what a schema-free JSON document cannot promise if it
 *    carries a component's props.
 *
 *  · **A broken document is refused, not repaired.** One unreadable turn throws
 *    the document away and starts empty, the same strictness the other stores
 *    apply: a half-parsed history shown as if it were the record is worse than an
 *    empty one, because the farmer cannot tell what is missing.
 *
 * The rich half of a reply — the weather tiles, the shop rows, the market prices
 * — is deliberately *not* here. It is live service output with its own
 * observation time, and re-showing last week's numbers as today's answer after a
 * reload would be the exact confidence this app refuses to fake. The stored turn
 * keeps the sentence and its source; the cards are re-made when the question is
 * asked again.
 */

export type AssistantTurnRole = 'farmer' | 'assistant';

/** Which shape the answer had, so a reloaded history can still label it. */
export type AssistantTurnKind = 'answer' | 'weather' | 'dealers' | 'market' | 'scan' | 'failed';

export type AssistantTurn = {
  /** Stable per turn, and the key the screen uses for its own live extras. */
  id: string;
  /** When it was said, so a conversation reads as a sequence rather than a list. */
  at: number;
  role: AssistantTurnRole;
  /** A farmer's words, or the assistant's lead sentence. */
  text: string;
  /** The photo a farmer sent instead of typing, by name. */
  photo?: string;
  /** The assistant's second line: a source, a confidence, a caveat. */
  detail?: string;
  /** Set on assistant turns only. */
  kind?: AssistantTurnKind;
};

export type AssistantState = {
  turns: AssistantTurn[];
};

/**
 * How much of a conversation is kept.
 *
 * Two hundred turns is roughly a month of daily questions; past that the document
 * would grow without the farmer gaining anything, and the queue would carry that
 * weight on every write.
 */
export const MAX_TURNS = 200;

const KINDS: ReadonlySet<string> = new Set<AssistantTurnKind>([
  'answer',
  'weather',
  'dealers',
  'market',
  'scan',
  'failed',
]);

export function createState(): AssistantState {
  return { turns: [] };
}

/** One more turn, oldest dropped once the conversation is longer than the bound. */
export function append(state: AssistantState, turn: AssistantTurn): AssistantState {
  const turns = [...state.turns, turn];
  return { turns: turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns };
}

export function serialise(state: AssistantState): string {
  return JSON.stringify(state);
}

/**
 * Read a stored conversation back.
 *
 * Strict on purpose: `null` means "this build cannot read this document", and the
 * document layer answers that by keeping the backend's copy untouched instead of
 * overwriting it with an empty one. Returning half a history would take that
 * safety away.
 */
export function hydrate(raw: string | null): AssistantState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AssistantState>;
    if (!Array.isArray(parsed.turns)) return null;

    const turns: AssistantTurn[] = [];

    for (const value of parsed.turns) {
      if (!value || typeof value !== 'object') return null;
      const turn = value as Record<string, unknown>;

      if (typeof turn.id !== 'string' || turn.id.length === 0) return null;
      if (typeof turn.at !== 'number' || !Number.isFinite(turn.at)) return null;
      if (turn.role !== 'farmer' && turn.role !== 'assistant') return null;
      if (typeof turn.text !== 'string') return null;
      if (turn.photo !== undefined && typeof turn.photo !== 'string') return null;
      if (turn.detail !== undefined && typeof turn.detail !== 'string') return null;
      if (turn.kind !== undefined && !KINDS.has(turn.kind as string)) return null;

      turns.push({
        id: turn.id,
        at: turn.at,
        role: turn.role,
        text: turn.text,
        ...(typeof turn.photo === 'string' ? { photo: turn.photo } : {}),
        ...(typeof turn.detail === 'string' ? { detail: turn.detail } : {}),
        ...(typeof turn.kind === 'string' ? { kind: turn.kind as AssistantTurnKind } : {}),
      });
    }

    return { turns };
  } catch {
    return null;
  }
}

/**
 * An id for one turn.
 *
 * Random rather than a counter: the counter restarted at 1 on every launch, so a
 * conversation that survived a reload had two turns with the same id and the
 * screen keyed both to one row.
 */
export function turnId(now: number = Date.now()): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `turn-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
