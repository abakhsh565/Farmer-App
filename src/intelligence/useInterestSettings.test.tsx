import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InterestSetting } from './interests';
import { useInterestSettings } from './useInterestSettings';

const row = (overrides: Partial<InterestSetting> = {}): InterestSetting => ({
  topic: 'topic:pest',
  cropCode: null,
  weight: 0.42,
  confidence: 0.6,
  source: 'behaviour',
  pinned: false,
  updatedAt: null,
  ...overrides,
});

const base = {
  accountId: 'account-a',
  enabled: true,
  online: true,
};

describe('useInterestSettings', () => {
  it('loads the list once and reports ready', async () => {
    const load = vi.fn(async () => [row(), row({ topic: 'topic:market', pinned: true })]);
    const { result } = renderHook(() => useInterestSettings({ ...base, load }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.settings.map((entry) => entry.topic)).toEqual([
      'topic:pest',
      'topic:market',
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('treats empty as ready, not as an error', async () => {
    const load = vi.fn(async () => []);
    const { result } = renderHook(() => useInterestSettings({ ...base, load }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.settings).toEqual([]);
  });

  it('keeps the last list while offline and never calls the server', async () => {
    const load = vi.fn(async () => [row()]);
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) =>
        useInterestSettings({ ...base, online, load }),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ online: false });

    expect(result.current.status).toBe('offline');
    expect(result.current.settings).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports a failed load without inventing a list', async () => {
    const load = vi.fn(async () => null);
    const { result } = renderHook(() => useInterestSettings({ ...base, load }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.settings).toEqual([]);
  });

  it('replaces the row only after a confirmed pin', async () => {
    const load = vi.fn(async () => [row()]);
    const pin = vi.fn(async () => row({ pinned: true, source: 'explicit' }));
    const { result } = renderHook(() => useInterestSettings({ ...base, load, pin }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    let accepted = false;
    await act(async () => {
      accepted = await result.current.setPinned('topic:pest', true);
    });

    expect(accepted).toBe(true);
    expect(pin).toHaveBeenCalledWith('topic:pest', true);
    expect(result.current.settings[0]).toMatchObject({ pinned: true, source: 'explicit' });
  });

  it('leaves the list unchanged and reports failure when pinning is refused', async () => {
    const load = vi.fn(async () => [row()]);
    const pin = vi.fn(async () => null);
    const { result } = renderHook(() => useInterestSettings({ ...base, load, pin }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    let accepted = true;
    await act(async () => {
      accepted = await result.current.setPinned('topic:pest', true);
    });

    expect(accepted).toBe(false);
    expect(result.current.saveFailed).toBe(true);
    expect(result.current.settings[0]?.pinned).toBe(false);
  });

  it('removes a row only after confirmed dismissal', async () => {
    const load = vi.fn(async () => [row()]);
    const dismiss = vi.fn(async () => true);
    const { result } = renderHook(() => useInterestSettings({ ...base, load, dismiss }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.remove('topic:pest');
    });

    expect(result.current.settings).toEqual([]);
  });

  it('does not call a mutation while offline', async () => {
    const load = vi.fn(async () => [row()]);
    const pin = vi.fn(async () => row({ pinned: true }));
    const { result } = renderHook(() =>
      useInterestSettings({ ...base, online: false, load, pin }),
    );

    expect(result.current.status).toBe('offline');
    let accepted = true;
    await act(async () => {
      accepted = await result.current.setPinned('topic:pest', true);
    });

    expect(accepted).toBe(false);
    expect(pin).not.toHaveBeenCalled();
  });

  it('refetches for a different account', async () => {
    const load = vi.fn(async () => [row()]);
    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string }) =>
        useInterestSettings({ ...base, accountId, load }),
      { initialProps: { accountId: 'account-a' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ accountId: 'account-b' });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
