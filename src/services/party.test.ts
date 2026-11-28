import { describe, expect, it } from 'vitest';
import { needsPartyRepair } from './party';

/**
 * The recogniser behind the self-repairing location write.
 *
 * Two properties matter and pull against each other: it must catch the refusal a
 * session without a party row produces, and it must not catch anything else — a
 * retry of a genuine "you may not do this" is a second identical failure told to the
 * farmer more slowly.
 */
describe('needsPartyRepair', () => {
  it('recognises the refusal a session without a party produces', () => {
    expect(needsPartyRepair('Sign in to save a location.')).toBe(true);
    expect(needsPartyRepair('new row violates row-level security policy')).toBe(true);
    expect(needsPartyRepair('JWT expired')).toBe(true);
  });

  it('leaves every other refusal alone', () => {
    expect(needsPartyRepair('Latitude must be between -90 and 90.')).toBe(false);
    expect(needsPartyRepair('A location name is required.')).toBe(false);
    expect(needsPartyRepair('duplicate key value violates unique constraint')).toBe(false);
  });
});
