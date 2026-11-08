/**
 * Loads and mutates the farmer's interest settings.
 *
 * The rules mirror the personalization hook: one fetch per account, no request
 * storm on render, and a failure never becomes a fabricated success. Offline keeps
 * the last list that was actually loaded but disables every write.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceConfig } from '@/services/config';
import { getIntelligenceGateway } from './client';
import type { InterestSetting } from './interests';

export type InterestSettingsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

const defaultLoad = async (): Promise<InterestSetting[] | null> => {
  const gateway = await getIntelligenceGateway(serviceConfig.supabase);
  if (!gateway) return null;
  return gateway.readInterestSettings();
};

const defaultPin = async (
  topic: string,
  pinned: boolean,
): Promise<InterestSetting | null> => {
  const gateway = await getIntelligenceGateway(serviceConfig.supabase);
  if (!gateway) return null;
  return gateway.setInterestPin(topic, pinned);
};

const defaultDismiss = async (topic: string): Promise<boolean> => {
  const gateway = await getIntelligenceGateway(serviceConfig.supabase);
  if (!gateway) return false;
  return gateway.dismissInterest(topic);
};

export type InterestSettingsValue = {
  settings: InterestSetting[];
  status: InterestSettingsStatus;
  pendingTopic: string | null;
  saveFailed: boolean;
  refresh: () => void;
  setPinned: (topic: string, pinned: boolean) => Promise<boolean>;
  remove: (topic: string) => Promise<boolean>;
};

export function useInterestSettings(params: {
  accountId: string | null;
  enabled: boolean;
  online: boolean;
  /** Injectable for tests; the default reads through the shared gateway. */
  load?: () => Promise<InterestSetting[] | null>;
  pin?: (topic: string, pinned: boolean) => Promise<InterestSetting | null>;
  dismiss?: (topic: string) => Promise<boolean>;
}): InterestSettingsValue {
  const { accountId, enabled, online } = params;
  const loadRef = useRef(params.load ?? defaultLoad);
  const pinRef = useRef(params.pin ?? defaultPin);
  const dismissRef = useRef(params.dismiss ?? defaultDismiss);
  loadRef.current = params.load ?? defaultLoad;
  pinRef.current = params.pin ?? defaultPin;
  dismissRef.current = params.dismiss ?? defaultDismiss;

  const [settings, setSettings] = useState<InterestSetting[]>([]);
  const [status, setStatus] = useState<InterestSettingsStatus>('idle');
  const [pendingTopic, setPendingTopic] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !accountId) {
      requested.current = null;
      setSettings([]);
      setStatus('idle');
      return;
    }

    if (!online) {
      // Keep the last real list for reading; a write is impossible until the
      // connection returns, and the screen says so rather than pretending.
      requested.current = null;
      setStatus('offline');
      return;
    }

    const key = `${accountId}:${attempt}`;
    if (requested.current === key) return;
    requested.current = key;

    let cancelled = false;
    setStatus('loading');

    void (async () => {
      try {
        const rows = await loadRef.current();
        if (cancelled) return;
        if (rows === null) {
          setStatus('error');
          return;
        }
        setSettings(rows);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // A cancelled request (StrictMode's first mount, or an account switch) can
      // never deliver; let the next mount or account try the same key again.
      if (requested.current === key) requested.current = null;
    };
  }, [accountId, enabled, online, attempt]);

  const refresh = useCallback(() => {
    setSaveFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  const setPinned = useCallback(
    async (topic: string, pinned: boolean) => {
      if (!enabled || !online || pendingTopic !== null) return false;
      setPendingTopic(topic);
      setSaveFailed(false);
      try {
        const updated = await pinRef.current(topic, pinned);
        if (!updated) {
          setSaveFailed(true);
          return false;
        }
        setSettings((current) =>
          current.map((entry) => (entry.topic === topic ? updated : entry)),
        );
        return true;
      } catch {
        setSaveFailed(true);
        return false;
      } finally {
        setPendingTopic(null);
      }
    },
    [enabled, online, pendingTopic],
  );

  const remove = useCallback(
    async (topic: string) => {
      if (!enabled || !online || pendingTopic !== null) return false;
      setPendingTopic(topic);
      setSaveFailed(false);
      try {
        const dismissed = await dismissRef.current(topic);
        if (!dismissed) {
          setSaveFailed(true);
          return false;
        }
        setSettings((current) => current.filter((entry) => entry.topic !== topic));
        return true;
      } catch {
        setSaveFailed(true);
        return false;
      } finally {
        setPendingTopic(null);
      }
    },
    [enabled, online, pendingTopic],
  );

  return { settings, status, pendingTopic, saveFailed, refresh, setPinned, remove };
}
