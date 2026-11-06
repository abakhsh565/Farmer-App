/**
 * Alert settings are account data. This hook reads the one alerts preference
 * object and writes it through the server RPC; it never derives defaults locally
 * for a write. Saving is confirmed by the server before the draft is accepted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceConfig } from '@/services/config';
import { getIntelligenceGateway } from './client';
import {
  DEFAULT_ALERT_PREFERENCES,
  type AlertPreferences,
  type AlertPreferencesInput,
} from './alertPreferences';

export type AlertPreferencesStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

type AlertPreferencesApi = {
  load: () => Promise<AlertPreferences | null>;
  save: (input: AlertPreferencesInput) => Promise<AlertPreferences | null>;
};

const defaultApi: AlertPreferencesApi = {
  async load() {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    return gateway ? gateway.readAlertPreferences() : null;
  },
  async save(input) {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    return gateway ? gateway.saveAlertPreferences(input) : null;
  },
};

export type AlertPreferencesState = {
  preferences: AlertPreferences;
  status: AlertPreferencesStatus;
  saving: boolean;
  saveFailed: boolean;
  refresh: () => void;
  save: (input: AlertPreferencesInput) => Promise<AlertPreferences | null>;
};

export function useAlertPreferences(params: {
  accountId: string | null;
  enabled: boolean;
  online: boolean;
  api?: AlertPreferencesApi;
}): AlertPreferencesState {
  const { accountId, enabled, online } = params;
  const api = params.api ?? defaultApi;
  const [preferences, setPreferences] = useState<AlertPreferences>(DEFAULT_ALERT_PREFERENCES);
  const [status, setStatus] = useState<AlertPreferencesStatus>('idle');
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requested = useRef<string | null>(null);
  const latest = useRef(api);
  latest.current = api;

  useEffect(() => {
    if (!enabled || !accountId) {
      requested.current = null;
      setPreferences(DEFAULT_ALERT_PREFERENCES);
      setStatus('idle');
      return;
    }
    if (!online) {
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
        const loaded = await latest.current.load();
        if (cancelled) return;
        if (loaded === null) {
          setStatus('error');
          return;
        }
        setPreferences(loaded);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (requested.current === key) requested.current = null;
    };
  }, [accountId, enabled, online, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  const save = useCallback(async (input: AlertPreferencesInput) => {
    setSaving(true);
    setSaveFailed(false);
    const saved = await latest.current.save(input).catch(() => null);
    setSaving(false);
    if (saved === null) {
      setSaveFailed(true);
      return null;
    }
    setPreferences(saved);
    setStatus('ready');
    return saved;
  }, []);

  return { preferences, status, saving, saveFailed, refresh, save };
}
