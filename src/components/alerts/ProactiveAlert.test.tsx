import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { parseAlerts } from '@/intelligence/alerts';

vi.mock('@/components/insights/PersonalizedAdvice', () => ({
  cropLabel: (code: string | undefined) => (code ? code : null),
  stageLabel: (stage: string | undefined) => (stage ? stage : null),
}));

import { ProactiveAlert } from './ProactiveAlert';

const alert = (overrides: Record<string, unknown> = {}) =>
  parseAlerts([
    {
      notification_id: 'notif-1',
      recommendation_id: 'rec-1',
      crop_code: 'cotton',
      kind: 'weather',
      title: 'Thunderstorm reported near your farm',
      title_ur: 'آپ کے کھیت کے قریب گرج چمک کی اطلاع',
      body: 'Avoid spraying now.',
      body_ur: 'ابھی سپرے نہ کریں۔',
      source: 'weather',
      source_label: 'Open-Meteo',
      source_url: 'https://api.open-meteo.com/',
      alert_level: 'urgent',
      alert_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      is_read: false,
      reason_code: 'weather_observation',
      reason_context: { crop_code: 'cotton', stage: 'fruiting' },
      action_kind: 'open_weather',
      action_label: 'Check weather',
      action_label_ur: 'موسم دیکھیں',
      ...overrides,
    },
  ]);

const renderAlert = (props: Partial<Parameters<typeof ProactiveAlert>[0]> = {}) => {
  const onRead = vi.fn(async () => true);
  const onDismiss = vi.fn(async () => true);
  const onOpenWeather = vi.fn();
  const result = render(
    <LocaleProvider>
      <ProactiveAlert
        alerts={alert()}
        status="ready"
        onRead={onRead}
        onDismiss={onDismiss}
        onOpenWeather={onOpenWeather}
        {...props}
      />
    </LocaleProvider>,
  );
  return { ...result, onRead, onDismiss, onOpenWeather };
};

describe('ProactiveAlert', () => {
  beforeEach(() => {
    localStorage.setItem('agri-shop.locale', 'en');
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  });

  it('shows the observed weather evidence and action, and marks it read on action', async () => {
    const user = userEvent.setup();
    const { onRead, onOpenWeather } = renderAlert();

    expect(screen.getByText('Thunderstorm reported near your farm')).toBeInTheDocument();
    expect(screen.getByText('Reported for your saved area')).toBeInTheDocument();
    expect(screen.getByText('Observed weather')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check weather' }));
    expect(onRead).toHaveBeenCalledWith('notif-1');
    expect(onOpenWeather).toHaveBeenCalledTimes(1);
  });

  it('keeps the source behind Details and marks read only when opened', async () => {
    const user = userEvent.setup();
    const { onRead } = renderAlert();

    expect(screen.queryByRole('link', { name: /View source/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details' }));

    expect(onRead).toHaveBeenCalledWith('notif-1');
    expect(screen.getByRole('link', { name: /View source/ })).toHaveAttribute(
      'href',
      'https://api.open-meteo.com/',
    );
    expect(screen.getByText('Evidence')).toBeInTheDocument();
  });

  it('dismisses through the provided callback', async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderAlert();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('notif-1');
  });

  it('renders loading, offline and error states without inventing an alert', () => {
    const base = {
      alerts: [],
      onRead: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <LocaleProvider>
        <ProactiveAlert {...base} status="loading" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Checking for alerts');

    rerender(
      <LocaleProvider>
        <ProactiveAlert {...base} status="offline" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Offline');

    rerender(
      <LocaleProvider>
        <ProactiveAlert {...base} status="error" onRefresh={() => {}} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Alerts could not be loaded');
  });

  it('uses Urdu copy and inherits RTL', async () => {
    localStorage.setItem('agri-shop.locale', 'ur');
    renderAlert();

    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(screen.getByText('آپ کے کھیت کے قریب گرج چمک کی اطلاع')).toBeInTheDocument();
    expect(screen.getByText('ابھی سپرے نہ کریں۔')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'موسم دیکھیں' })).toBeInTheDocument();
  });
});
