import { describe, expect, it } from 'vitest';
import { alertCategory, alertIsExpired, alertTrustKey, parseAlerts } from './alerts';

const wire = {
  notification_id: 'notif-1',
  recommendation_id: 'rec-1',
  crop_id: 'crop-1',
  crop_code: 'cotton',
  kind: 'weather',
  title: 'Thunderstorm reported',
  title_ur: 'گرج چمک کی اطلاع',
  body: 'Avoid spraying now.',
  body_ur: 'ابھی سپرے نہ کریں۔',
  source: 'weather',
  alert_source_kind: 'weather_observation',
  source_label: 'Open-Meteo',
  source_url: 'https://api.open-meteo.com/',
  evidence_tier: null,
  confidence: 0.95,
  alert_level: 'urgent',
  alert_at: '2026-11-03T10:00:00.000Z',
  valid_until: '2026-11-03T12:00:00.000Z',
  is_read: false,
  reason_code: 'weather_observation',
  reason_context: { crop_code: 'cotton', stage: 'fruiting' },
  action_kind: 'open_weather',
  action_label: 'Check weather',
  action_label_ur: 'موسم دیکھیں',
  created_at: '2026-11-03T10:00:00.000Z',
};

describe('parseAlerts', () => {
  it('validates and normalises a wire row without changing server order', () => {
    const rows = parseAlerts([
      wire,
      { ...wire, notification_id: 'notif-2', recommendation_id: 'rec-2', title: 'Heavy rain' },
    ]);

    expect(rows.map((row) => row.notificationId)).toEqual(['notif-1', 'notif-2']);
    expect(rows[0]).toMatchObject({
      cropCode: 'cotton',
      level: 'urgent',
      sourceUrl: 'https://api.open-meteo.com/',
      actionKind: 'open_weather',
      reasonCode: 'weather_observation',
      isRead: false,
    });
  });

  it('drops duplicates, malformed levels and missing identities', () => {
    const rows = parseAlerts([
      wire,
      wire,
      { ...wire, notification_id: 'bad-level', alert_level: 'certain' },
      { ...wire, notification_id: '', recommendation_id: '' },
      null,
    ]);

    expect(rows).toHaveLength(1);
  });

  it('refuses a non-HTTPS source link', () => {
    const [row] = parseAlerts([{ ...wire, source_url: 'http://untrusted.example' }]);
    expect(row?.sourceUrl).toBeNull();
  });

  it('caps a response at twenty rows', () => {
    const rows = parseAlerts(
      Array.from({ length: 25 }, (_, index) => ({
        ...wire,
        notification_id: `notif-${index}`,
        recommendation_id: `rec-${index}`,
      })),
    );
    expect(rows).toHaveLength(20);
  });
});

describe('alert presentation helpers', () => {
  it('maps recommendation kinds onto alert categories', () => {
    expect(alertCategory('weather')).toBe('weather');
    expect(alertCategory('pest')).toBe('pest');
    expect(alertCategory('disease')).toBe('disease');
    expect(alertCategory('crop_stage')).toBe('crop_stage');
    expect(alertCategory('general')).toBe('crop_stage');
  });

  it('distinguishes observed weather from verified knowledge', () => {
    const [weather] = parseAlerts([wire]);
    expect(weather ? alertTrustKey(weather) : null).toBe('weather');
    const [verified] = parseAlerts([
      { ...wire, alert_source_kind: 'knowledge', evidence_tier: 'verified' },
    ]);
    expect(verified ? alertTrustKey(verified) : null).toBe('verified');
  });

  it('separates official advisories and forecast risks from observations', () => {
    const [official] = parseAlerts([
      {
        ...wire,
        alert_source_kind: 'official_advisory',
        source: 'knowledge_base',
        evidence_tier: 'verified',
      },
    ]);
    expect(official?.alertSourceKind).toBe('official_advisory');
    expect(official ? alertTrustKey(official) : null).toBe('official');

    const [forecast] = parseAlerts([
      { ...wire, alert_source_kind: 'forecast_risk', source: 'weather', evidence_tier: null },
    ]);
    expect(forecast?.alertSourceKind).toBe('forecast_risk');
    expect(forecast ? alertTrustKey(forecast) : null).toBe('forecast');
  });

  it('falls back safely for a legacy weather row without the new field', () => {
    const { alert_source_kind: _ignored, ...legacy } = wire;
    const [row] = parseAlerts([legacy]);
    expect(row?.alertSourceKind).toBe('weather_observation');
  });

  it('treats an expired validity window as expired', () => {
    const [row] = parseAlerts([wire]);
    expect(row).not.toBeNull();
    if (row) {
      expect(alertIsExpired(row, new Date('2026-11-03T11:00:00.000Z').getTime())).toBe(false);
      expect(alertIsExpired(row, new Date('2026-11-03T13:00:00.000Z').getTime())).toBe(true);
    }
  });
});
