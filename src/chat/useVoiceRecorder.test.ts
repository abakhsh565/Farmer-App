import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceRecorder } from './useVoiceRecorder';

/**
 * The recorder's state machine, driven with a fake MediaRecorder.
 *
 * The three states are the contract: a recording becomes a *preview*, never a sent
 * message, and cancel throws the bytes away instead of quietly keeping them. Those
 * are the properties a phone in a pocket depends on.
 */

/** Bytes the fake recorder produces; overridden so "too short" can be tested. */
let recordedBytes = 2000;

class FakeRecorder {
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/mp4';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(recordedBytes)], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

const stopTrack = vi.fn();

function installMicrophone() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
}

beforeEach(() => {
  recordedBytes = 2000;
  installMicrophone();
});

afterEach(() => {
  vi.unstubAllGlobals();
  stopTrack.mockClear();
});

describe('useVoiceRecorder', () => {
  it('records, then holds the result as a preview instead of sending it', async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.status).toBe('recording'));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.status).toBe('preview'));

    expect(result.current.recording?.blob.size).toBe(2000);
    expect(result.current.recording?.mimeType).toBe('audio/mp4');
    /* The microphone is released as soon as the recording ends. */
    expect(stopTrack).toHaveBeenCalled();

    const taken = result.current.take();
    expect(taken?.blob.size).toBe(2000);
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.recording).toBeNull();
  });

  it('throws the recording away when it is cancelled', async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.status).toBe('recording'));

    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.recording).toBeNull();
  });

  it('says the microphone was refused rather than failing silently', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('denied', 'NotAllowedError');
        }),
      },
    });

    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });

    await waitFor(() => expect(result.current.failure).toBe('denied'));
    expect(result.current.status).toBe('idle');
  });

  it('treats a tap as too short rather than as a message', async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });
    recordedBytes = 10;
    act(() => result.current.stop());

    await waitFor(() => expect(result.current.failure).toBe('empty'));
    expect(result.current.status).toBe('idle');
  });
});
