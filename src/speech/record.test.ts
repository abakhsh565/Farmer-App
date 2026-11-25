import { describe, expect, it, vi } from 'vitest';
import { isUrduText } from './SpeechProvider';
import { recordingSupported, startRecording } from './record';

/**
 * What the microphone promises when it cannot record.
 *
 * The failure this file guards is the one that was reported: a control that says
 * it is listening and never answers. With no recorder in the environment, the
 * start has to say so and hand the button back — never leave it pressed.
 */

describe('the microphone', () => {
  it('reports that this environment cannot record', () => {
    expect(recordingSupported()).toBe(false);
  });

  it('reports a missing recorder instead of pretending to listen', () => {
    const onFailure = vi.fn();
    const onEnd = vi.fn();

    const started = startRecording({ onText: vi.fn(), onFailure, onEnd });

    expect(started).toBeNull();
    expect(onFailure).toHaveBeenCalledWith('unavailable');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('isUrduText', () => {
  it('recognises Urdu script, which an Urdu voice can read as it stands', () => {
    expect(isUrduText('آج موسم ٹھیک ہے')).toBe(true);
  });

  it('treats English and Roman Urdu as needing translation before it is spoken', () => {
    expect(isUrduText('Spray before noon.')).toBe(false);
    expect(isUrduText('aaj mausam theek hai')).toBe(false);
    expect(isUrduText('')).toBe(false);
  });
});
