import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoiceComposer } from './VoiceComposer';

vi.mock('@/i18n/LocaleProvider', () => ({
  useLocale: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values && 'duration' in values ? `${key}:${values.duration}` : key,
  }),
}));

vi.mock('@/shop/api/media', () => ({
  formatDuration: (ms: number) => `0:0${Math.floor(ms / 1000)}`,
}));

/**
 * The recording bar while a note is being made.
 *
 * The square stop control is gone on purpose: the right-hand control is the send
 * arrow, and one press both ends the recording and hands it to the shop. Cancel is
 * the only way to end a recording without sending it.
 */
describe('VoiceComposer recording state', () => {
  const renderBar = () => {
    const onSendNow = vi.fn();
    const onCancel = vi.fn();
    render(
      <VoiceComposer
        status="recording"
        durationMs={5200}
        recording={null}
        onSendNow={onSendNow}
        onCancel={onCancel}
        onSend={vi.fn()}
      />,
    );
    return { onSendNow, onCancel };
  };

  it('offers a send arrow instead of a separate stop control', async () => {
    const { onSendNow } = renderBar();

    expect(screen.queryByRole('button', { name: 'chat.voice.stop' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'chat.voice.send' }));
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it('keeps cancel as the way to abandon a recording', async () => {
    const { onCancel } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: 'chat.voice.cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
