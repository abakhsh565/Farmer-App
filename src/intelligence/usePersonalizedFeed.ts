/**
 * Fetches the server's ranked recommendations for the signed-in farmer.
 *
 *  · It sends the validated local crop context first, so the engine can generate
 *    advice for what the farmer actually grows.
 *  · It never blanks the feed on a failed refresh. The local document remains the
 *    offline fallback; only a real request failure becomes `error`.
 *  · It fetches once per account and crop context, plus explicit refreshes or a
 *    connectivity recovery. A failing RPC is not retried on every render.
 *  · It never writes server rows into the farmer's local document.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CropInstance } from '@/insights/store';
import { serviceConfig } from '@/services/config';
import { getIntelligenceGateway } from './client';
import { cropContextKey, toServerCrops } from './cropContext';
import {
  parseRankedRecommendations,
  type RankedRecommendation,
} from './feed';

export type PersonalizationStatus = 'idle' | 'loading' | 'ready' | 'fallback' | 'error';

const EMPTY_CROPS: readonly CropInstance[] = [];

const defaultLoad = async (crops: readonly CropInstance[]): Promise<RankedRecommendation[]> => {
  const gateway = await getIntelligenceGateway(serviceConfig.supabase);
  if (!gateway) return [];

  // A failed prepare must not hide recommendations that already exist. The feed
  // read below is the authoritative outcome.
  await gateway.prepareRecommendations(toServerCrops(crops));

  const rows = await gateway.readRankedFeed(20);
  if (rows === null) throw new Error('recommendation-feed-unavailable');
  return parseRankedRecommendations(rows);
};

export type PersonalizedFeed = {
  ranked: RankedRecommendation[];
  status: PersonalizationStatus;
  refresh: () => void;
};

export function usePersonalizedFeed(params: {
  accountId: string | null;
  enabled: boolean;
  online: boolean;
  crops?: readonly CropInstance[];
  /** Injectable for tests; the default reads through the shared gateway. */
  load?: (crops: readonly CropInstance[]) => Promise<RankedRecommendation[]>;
}): PersonalizedFeed {
  const { accountId, enabled, online } = params;
  const crops = params.crops ?? EMPTY_CROPS;
  const load = params.load ?? defaultLoad;
  const cropKey = cropContextKey(crops);

  const [ranked, setRanked] = useState<RankedRecommendation[]>([]);
  const [status, setStatus] = useState<PersonalizationStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const requested = useRef<string | null>(null);
  const latest = useRef({ crops, load });
  latest.current = { crops, load };

  useEffect(() => {
    if (!enabled || !accountId) {
      requested.current = null;
      setRanked([]);
      setStatus('idle');
      return;
    }

    if (!online) {
      // Offline is a fallback, not a cached ranking: presenting yesterday's
      // server order as current would misrepresent what the app knows.
      requested.current = null;
      setRanked([]);
      setStatus('fallback');
      return;
    }

    const key = `${accountId}:${attempt}:${cropKey}`;
    if (requested.current === key) return;
    requested.current = key;

    let cancelled = false;
    setStatus('loading');

    void (async () => {
      try {
        const rows = await latest.current.load(latest.current.crops);
        if (cancelled) return;
        setRanked(rows);
        setStatus(rows.length > 0 ? 'ready' : 'fallback');
      } catch {
        if (cancelled) return;
        setRanked([]);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // Allow StrictMode's second mount to retry the same key; the first request
      // was cancelled and can never deliver.
      if (requested.current === key) requested.current = null;
    };
  }, [accountId, enabled, online, attempt, cropKey, load]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  return { ranked, status, refresh };
}
