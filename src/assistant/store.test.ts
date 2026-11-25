import { describe, expect, it } from 'vitest';
import { append, createState, hydrate, MAX_TURNS, serialise, turnId } from './store';

const farmer = (text: string, at = 1) => ({ id: `f${at}`, at, role: 'farmer' as const, text });

describe('assistant conversation document', () => {
  it('round-trips a turn through the bytes it stores', () => {
    const state = append(
      createState(),
      { id: 'a1', at: 5, role: 'assistant', text: 'Right now it is clear sky.', kind: 'weather' },
    );

    expect(hydrate(serialise(state))).toEqual(state);
  });

  it('keeps the oldest turns out once the conversation is longer than the bound', () => {
    let state = createState();
    for (let index = 0; index < MAX_TURNS + 5; index += 1) {
      state = append(state, farmer(`q${index}`, index));
    }

    expect(state.turns).toHaveLength(MAX_TURNS);
    expect(state.turns[0]?.text).toBe('q5');
  });

  it('refuses a document with one unreadable turn rather than showing half of it', () => {
    const good = serialise(append(createState(), farmer('what is the cotton rate?')));
    const broken = good.replace('"role":"farmer"', '"role":"shopkeeper"');

    expect(hydrate(broken)).toBeNull();
  });

  it('refuses a document whose turn has an unknown reply kind', () => {
    const raw = JSON.stringify({
      turns: [{ id: 'a', at: 1, role: 'assistant', text: 'hi', kind: 'prophecy' }],
    });

    expect(hydrate(raw)).toBeNull();
  });

  it('treats nothing stored as nothing, and never as an empty conversation', () => {
    expect(hydrate(null)).toBeNull();
    expect(hydrate('')).toBeNull();
  });

  it('gives every turn its own id, including one made after a restart', () => {
    // A counter would have restarted at 1 and collided with a stored turn, which
    // is what made a reloaded conversation render two answers into one row.
    const ids = new Set([turnId(1), turnId(1), turnId(2)]);
    expect(ids.size).toBe(3);
  });
});
