/**
 * Loads the signed-in farmer's live alerts and applies read/dismiss actions.
 *
 *  · Alerts are prepared by the JWT-derived server seam; this hook never sends a
 *    farmer id and never computes a rule or a score.
 *  · It replaces the list only after a successful read. Offline is a distinct
 *    state, not an empty list.
 *  · Read and dismiss are optimistic and roll back on a rejected write, so the
 *    screen cannot silently disagree with the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceConfig } from '@/services/config';
import type { CropInstance } from '@/insights/store';
import { cropContextKey } from './cropContext';
import { getIntelligenceGateway } from './client';
import type { AlertRow } from './alerts';

export type AlertsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'offline';

export type AlertsApi = {
  load: () => Promise<AlertRow[]>;
  markRead: (notificationId: string) => Promise<boolean>;
  dismiss: (notificationId: string) => Promise<boolean>;
  readAll: () => Promise<number>;
};

const defaultApi: AlertsApi = {
  async load() {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    if (!gateway) return [];
    await gateway.prepareAlerts();
    const rows = await gateway.readAlerts(20);
    if (rows === null) throw new Error('alert-feed-unavailable');
    return rows;
  },
  async markRead(notificationId) {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    return gateway ? gateway.markAlertRead(notificationId) : false;
  },
  async dismiss(notificationId) {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    return gateway ? gateway.dismissAlert(notificationId) : false;
  },
  async readAll() {
    const gateway = await getIntelligenceGateway(serviceConfig.supabase);
    return gateway ? gateway.readAllAlerts() : 0;
  },
};

export type AlertsFeed = {
  alerts: AlertRow[];
  unread: number;
  status: AlertsStatus;
  refresh: () => void;
  markRead: (notificationId: string) => Promise<boolean>;
  dismiss: (notificationId: string) => Promise<boolean>;
  readAll: () => Promise<number>;
};

const EMPTY_CROPS: readonly CropInstance[] = [];

export function useAlerts(params: {
  accountId: string | null;
  enabled: boolean;
  online: boolean;
  crops?: readonly CropInstance[];
  /** Injectable for the focused tests; the default goes through the gateway. */
  api?: AlertsApi;
}): AlertsFeed {
  const { accountId, enabled, online } = params;
  const api = params.api ?? defaultApi;
  const cropKey = cropContextKey(params.crops ?? EMPTY_CROPS);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [status, setStatus] = useState<AlertsStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const requested = useRef<string | null>(null);
  const latest = useRef(api);
  latest.current = api;
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  useEffect(() => {
    if (!enabled || !accountId) {
      requested.current = null;
      setAlerts([]);
      setStatus('idle');
      return;
    }

    if (!online) {
      requested.current = null;
      setAlerts([]);
      setStatus('offline');
      return;
    }

    const key = `${accountId}:${attempt}:${cropKey}`;
    if (requested.current === key) return;
    requested.current = key;

    let cancelled = false;
    setStatus('loading');

    void (async () => {
      try {
        const rows = await latest.current.load();
        if (cancelled) return;
        setAlerts(rows);
        setStatus(rows.length > 0 ? 'ready' : 'empty');
      } catch {
        if (cancelled) return;
        setAlerts([]);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (requested.current === key) requested.current = null;
    };
  }, [accountId, enabled, online, attempt, cropKey]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  const markRead = useCallback(
    async (notificationId: string) => {
      const before = alertsRef.current;
      setAlerts((current) =>
        current.map((alert) =>
          alert.notificationId === notificationId ? { ...alert, isRead: true } : alert,
        ),
      );
      const accepted = await latest.current.markRead(notificationId).catch(() => false);
      if (!accepted) {
        setAlerts(before);
        return false;
      }
      return true;
    },
    [],
  );

  const dismiss = useCallback(async (notificationId: string) => {
    const before = alertsRef.current;
    setAlerts((current) =>
      current.filter((alert) => alert.notificationId !== notificationId),
    );
    const accepted = await latest.current.dismiss(notificationId).catch(() => false);
    if (!accepted) {
      setAlerts(before);
      return false;
    }
    setStatus(before.length <= 1 ? 'empty' : 'ready');
    return true;
  }, []);

  const readAll = useCallback(async () => {
    const before = alertsRef.current;
    setAlerts((current) => current.map((alert) => ({ ...alert, isRead: true })));
    const count = await latest.current.readAll().catch(() => 0);
    if (count === 0 && before.some((alert) => !alert.isRead)) {
      setAlerts(before);
      return 0;
    }
    return count;
  }, []);

  return {
    alerts,
    unread: alerts.filter((alert) => !alert.isRead).length,
    status,
    refresh,
    markRead,
    dismiss,
    readAll,
  };
}
