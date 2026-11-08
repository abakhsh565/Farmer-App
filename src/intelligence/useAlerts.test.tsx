import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseAlerts } from './alerts';
import { useAlerts, type AlertsApi } from './useAlerts';

const rows = parseAlerts([
  {
    notification_id: 'notif-1',
    recommendation_id: 'rec-1',
    kind: 'weather',
    title: 'Thunderstorm reported',
    body: 'Avoid spraying now.',
    source: 'weather',
    alert_level: 'urgent',
    is_read: false,
    action_kind: 'open_weather',
    reason_code: 'weather_observation',
  },
]);

const api = (overrides: Partial<AlertsApi> = {}): AlertsApi => ({
  load: vi.fn(async () => rows),
  markRead: vi.fn(async () => true),
  dismiss: vi.fn(async () => true),
  readAll: vi.fn(async () => 1),
  ...overrides,
});

const setup = (overrides: Partial<AlertsApi> = {}, online = true) => {
  const client = api(overrides);
  const hook = renderHook(() =>
    useAlerts({ accountId: 'account-a', enabled: true, online, api: client }),
  );
  return { ...hook, client };
};

describe('useAlerts', () => {
  it('loads alerts and reports unread state', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.alerts.map((row) => row.notificationId)).toEqual(['notif-1']);
    expect(result.current.unread).toBe(1);
  });

  it('distinguishes an empty feed from a failed read', async () => {
    const empty = setup({ load: vi.fn(async () => []) });
    await waitFor(() => expect(empty.result.current.status).toBe('empty'));

    const failed = setup({
      load: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await waitFor(() => expect(failed.result.current.status).toBe('error'));
    expect(failed.result.current.alerts).toEqual([]);
  });

  it('does not call the server while offline', () => {
    const { result, client } = setup({}, false);
    expect(result.current.status).toBe('offline');
    expect(client.load).not.toHaveBeenCalled();
  });

  it('marks read optimistically and keeps the server confirmation', async () => {
    const { result, client } = setup();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.markRead('notif-1');
    });

    expect(client.markRead).toHaveBeenCalledWith('notif-1');
    expect(result.current.alerts[0]?.isRead).toBe(true);
    expect(result.current.unread).toBe(0);
  });

  it('rolls a failed read back rather than showing an unconfirmed state', async () => {
    const { result } = setup({ markRead: vi.fn(async () => false) });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.markRead('notif-1');
    });

    expect(result.current.alerts[0]?.isRead).toBe(false);
  });

  it('removes a dismissed alert and restores it when the write fails', async () => {
    const accepted = setup();
    await waitFor(() => expect(accepted.result.current.status).toBe('ready'));
    await act(async () => {
      await accepted.result.current.dismiss('notif-1');
    });
    expect(accepted.result.current.alerts).toEqual([]);

    const rejected = setup({ dismiss: vi.fn(async () => false) });
    await waitFor(() => expect(rejected.result.current.status).toBe('ready'));
    await act(async () => {
      await rejected.result.current.dismiss('notif-1');
    });
    expect(rejected.result.current.alerts).toHaveLength(1);
  });
});
