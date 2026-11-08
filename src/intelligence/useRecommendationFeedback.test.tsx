import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { feedbackKey, useRecommendationFeedback } from './useRecommendationFeedback';

const base = {
  recommendationId: 'rec-1',
  insightRef: 'insight-1',
  context: { screen: 'home', topic: 'pest' },
};

describe('useRecommendationFeedback', () => {
  it('submits helpful with the deterministic idempotency key', async () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useRecommendationFeedback({ ...base, send }));

    let accepted = false;
    await act(async () => {
      accepted = await result.current.submit('helpful');
    });

    expect(accepted).toBe(true);
    expect(result.current.submitted).toBe('helpful');
    expect(send).toHaveBeenCalledWith({
      key: 'feedback:rec-1:helpful',
      verdict: 'helpful',
      recommendationId: 'rec-1',
      insightRef: 'insight-1',
      context: { screen: 'home', topic: 'pest' },
    });
  });

  it('submits not relevant as a distinct verdict and key', async () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useRecommendationFeedback({ ...base, send }));

    await act(async () => {
      await result.current.submit('not_relevant');
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'feedback:rec-1:not_relevant',
        verdict: 'not_relevant',
      }),
    );
  });

  it('retries a failed submission with the same key', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useRecommendationFeedback({ ...base, send }));

    await act(async () => {
      expect(await result.current.submit('helpful')).toBe(false);
    });
    expect(result.current.failed).toBe(true);

    await act(async () => {
      expect(await result.current.submit('helpful')).toBe(true);
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].key).toBe(send.mock.calls[1]?.[0].key);
    expect(result.current.submitted).toBe('helpful');
  });

  it('does not send anything without a recommendation id', async () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useRecommendationFeedback({ ...base, recommendationId: null, send }),
    );

    await act(async () => {
      expect(await result.current.submit('helpful')).toBe(false);
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('does not submit twice after a confirmed verdict', async () => {
    const send = vi.fn(async () => true);
    const { result } = renderHook(() => useRecommendationFeedback({ ...base, send }));

    await act(async () => {
      await result.current.submit('helpful');
    });
    await act(async () => {
      expect(await result.current.submit('not_relevant')).toBe(false);
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resets when the recommendation changes', async () => {
    const send = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ recommendationId }: { recommendationId: string }) =>
        useRecommendationFeedback({ ...base, recommendationId, send }),
      { initialProps: { recommendationId: 'rec-1' } },
    );
    await act(async () => {
      await result.current.submit('helpful');
    });
    expect(result.current.submitted).toBe('helpful');

    rerender({ recommendationId: 'rec-2' });

    await waitFor(() => expect(result.current.submitted).toBeNull());
    await act(async () => {
      await result.current.submit('not_relevant');
    });
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: 'feedback:rec-2:not_relevant',
        recommendationId: 'rec-2',
      }),
    );
  });

  it('caps keys at the server limit', () => {
    expect(feedbackKey('x'.repeat(100), 'not_relevant').length).toBeLessThanOrEqual(100);
  });
});
