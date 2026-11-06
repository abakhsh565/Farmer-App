import { describe, expect, it } from 'vitest';
import { personalizationNotice } from './status';

const base = {
  account: true,
  online: true,
  status: 'fallback' as const,
  hasLocalAdvice: false,
  hasServerAdvice: false,
  hasCrops: true,
};

describe('personalizationNotice', () => {
  it('shows loading while the first server request is in flight', () => {
    expect(personalizationNotice({ ...base, status: 'loading' })).toBe('insight.loading');
  });

  it('shows an error rather than claiming there is no advice', () => {
    expect(personalizationNotice({ ...base, status: 'error' })).toBe('insight.error');
  });

  it('shows offline when the server cannot be reached', () => {
    expect(personalizationNotice({ ...base, online: false, status: 'fallback' })).toBe(
      'insight.offline',
    );
  });

  it('shows empty when an online farmer has no advice or crops yet', () => {
    expect(personalizationNotice({ ...base, status: 'fallback', hasCrops: false })).toBe(
      'insight.empty',
    );
  });

  it('never covers saved local advice or a successful server feed with a notice', () => {
    expect(personalizationNotice({ ...base, hasLocalAdvice: true })).toBeNull();
    expect(
      personalizationNotice({ ...base, status: 'ready', hasServerAdvice: true }),
    ).toBeNull();
    expect(personalizationNotice({ ...base, account: false })).toBeNull();
  });
});
