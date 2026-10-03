import { describe, expect, it } from 'vitest';
import { initialsOf } from '@/lib/initials';

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsOf('Ali Traders')).toBe('AT');
    expect(initialsOf('Green Agro Store')).toBe('GA');
  });

  it('works in the Urdu script, where a letter is not one byte', () => {
    expect(initialsOf('علی ٹریڈرز')).toBe('عٹ');
    expect(initialsOf('خان ایگری سینٹر')).toBe('خا');
  });

  it('copes with a single word, extra spaces and an empty name', () => {
    expect(initialsOf('Malik')).toBe('M');
    expect(initialsOf('  Butt   Seeds  ')).toBe('BS');
    expect(initialsOf('')).toBe('');
  });
});
