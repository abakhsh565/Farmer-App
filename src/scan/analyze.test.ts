import { describe, expect, it } from 'vitest';
import { CONFIDENCE_THRESHOLD, gate, shouldEscalate, verdictFor } from './analyze';

/**
 * The assistant's boundaries, as assertions.
 *
 * A refusal that is never tested is a refusal that quietly stops happening, so
 * the off-domain path is asserted in both scripts, and the "we do not know" path
 * is asserted separately from the "this is not farming" path — they are different
 * answers to the farmer.
 */

describe('the domain gate', () => {
  it('answers farming questions in either script', () => {
    expect(gate('When should I spray my cotton?')).toBe('agriculture');
    expect(gate('کپاس پر گلابی سنڈی کا علاج کیا ہے؟')).toBe('agriculture');
    expect(gate('What is the wheat rate in the mandi today?')).toBe('agriculture');
  });

  it('refuses politics, sport and general knowledge', () => {
    expect(verdictFor('Who will win the election?').kind).toBe('refuse');
    expect(verdictFor('Which team won the cricket match?').kind).toBe('refuse');
    expect(verdictFor('کرکٹ کا میچ کون جیتا؟').kind).toBe('refuse');
  });

  it('treats an off-topic word as decisive, even in a farming sentence', () => {
    expect(gate('Is this weather good for the election rally in my village?')).toBe('off_domain');
    expect(gate('کرکٹ میچ کے بعد کپاس کو پانی دینا چاہیے؟')).toBe('off_domain');
  });

  it('routes an agriculture question the sources do not cover to a person', () => {
    expect(verdictFor('Can I grow saffron on my roof in Wazirabad?').kind).toBe('escalate');
    /* An agricultural market question stays inside the domain — support prices are
       a farming question even when the answer comes from outside the app. */
    expect(gate('Will the support price of wheat change?')).toBe('agriculture');
  });

  it('never answers from nothing', () => {
    const verdict = verdictFor('What is the answer to everything?');
    expect(verdict.kind).not.toBe('answer');
  });
});

describe('the confidence threshold', () => {
  it('escalates below the threshold and passes at it', () => {
    expect(shouldEscalate(CONFIDENCE_THRESHOLD - 1)).toBe(true);
    expect(shouldEscalate(CONFIDENCE_THRESHOLD)).toBe(false);
  });

  it('escalates a high-risk case however confident the match is', () => {
    expect(shouldEscalate(95, 'high')).toBe(true);
  });
});
