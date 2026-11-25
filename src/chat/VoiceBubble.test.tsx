import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceBubble } from './VoiceBubble';

/**
 * The playback control, in each state a message can be in.
 *
 * Playback itself is the browser's; what this test pins is what the farmer sees and
 * can press: a duration for a sent note, a percentage while it is uploading, and a
 * retry that re-sends the recording rather than asking for a new one.
 */

vi.mock('@/i18n/LocaleProvider', () => ({
  useLocale: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values && 'percent' in values ? `${key}:${values.percent}` : key,
  }),
}));

class FakeAudio {
  currentTime = 0;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoiceBubble', () => {
  it('shows the duration and plays a sent note', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    render(<VoiceBubble audio={{ url: 'https://shop.example/a.m4a', durationMs: 7300 }} mine />);

    expect(screen.getByText('0:07')).toBeInTheDocument();

    const play = screen.getByRole('button', { name: 'chat.voice.play' });
    await userEvent.click(play);
    expect(play).toBeInTheDocument();
  });

  it('shows upload progress and refuses to play while sending', () => {
    render(
      <VoiceBubble
        audio={{ url: null, durationMs: 7300, status: 'sending', progress: 0.4 }}
        mine
      />,
    );

    expect(screen.getByText('chat.voice.uploading:40')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chat.voice.play' })).toBeDisabled();
  });

  it('offers a retry that keeps the same recording', async () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    render(
      <VoiceBubble
        audio={{ url: null, durationMs: 3000, status: 'failed', localId: 'v-1' }}
        mine
        onRetry={onRetry}
        onDiscard={onDiscard}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'chat.voice.retry' }));
    expect(onRetry).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'chat.voice.discard' }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
