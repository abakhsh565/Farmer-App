import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoBubble } from './PhotoBubble';

/**
 * A photo in the thread, in each state it can be in.
 *
 * The picture itself is the browser's; what this pins is what the farmer can tell
 * apart: a photo still uploading says so, a photo that reached the shop is drawn from
 * a link minted for it, and a link that could not be made says so instead of showing
 * a broken image with no explanation.
 */

vi.mock('@/i18n/LocaleProvider', () => ({
  useLocale: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values && 'percent' in values ? `${key}:${values.percent}` : key,
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PhotoBubble', () => {
  it('mints the link for a sent photo instead of storing one', async () => {
    const onResolve = vi.fn(async () => 'https://shop.example/signed/photo.jpg');
    const { container } = render(
      <PhotoBubble image={{ url: null, serverId: 'm3', mimeType: 'image/jpeg' }} mine onResolve={onResolve} />,
    );

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('img')?.src).toBe('https://shop.example/signed/photo.jpg'));
  });

  it('shows the upload’s own percentage while the photo is on its way', () => {
    render(
      <PhotoBubble
        image={{ url: null, status: 'sending', progress: 0.4, localBlob: new Blob([new Uint8Array(8)]) }}
        mine
      />,
    );

    expect(screen.getByText('chat.voice.uploading:40')).toBeInTheDocument();
  });

  it('offers a retry that keeps the same photo', async () => {
    const onRetry = vi.fn();
    render(
      <PhotoBubble
        image={{ url: null, status: 'failed', localId: 'm-1', localBlob: new Blob([new Uint8Array(8)]) }}
        mine
        onRetry={onRetry}
      />,
    );

    screen.getByRole('button', { name: 'chat.voice.retry' }).click();
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByText('chat.photo.failed')).toBeInTheDocument();
  });

  it('says the photo could not be loaded when no link can be made', async () => {
    const onResolve = vi.fn(async () => null);
    render(<PhotoBubble image={{ url: null, serverId: 'm9' }} mine onResolve={onResolve} />);

    await waitFor(() => expect(screen.getByText('chat.photo.unavailable')).toBeInTheDocument());
  });
});
