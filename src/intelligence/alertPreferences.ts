/**
 * Alert preferences share the existing `farmer_preferences` row rather than a
 * fourth settings store. The server validates categories and refuses a push
 * opt-in while no sender is configured; this parser mirrors the safe shape for
 * the client and clamps a stale `push: true` when the capability is unavailable.
 */

export const ALERT_CATEGORIES = ['weather', 'pest', 'disease', 'crop_stage'] as const;

export type AlertPreferenceCategory = (typeof ALERT_CATEGORIES)[number];

export type AlertPreferences = {
  inApp: boolean;
  push: boolean;
  categories: AlertPreferenceCategory[];
  consentVersion: number;
  consentAt: string | null;
  pushAvailable: boolean;
};

export type AlertPreferencesInput = {
  inApp: boolean;
  push: boolean;
  categories: AlertPreferenceCategory[];
  consentVersion: number;
};

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  inApp: true,
  push: false,
  categories: [...ALERT_CATEGORIES],
  consentVersion: 0,
  consentAt: null,
  pushAvailable: false,
};

export const ALERT_CATEGORY_KEYS: Readonly<
  Record<AlertPreferenceCategory, 'alerts.settings.weather' | 'alerts.settings.pest' | 'alerts.settings.disease' | 'alerts.settings.cropStage'>
> = {
  weather: 'alerts.settings.weather',
  pest: 'alerts.settings.pest',
  disease: 'alerts.settings.disease',
  crop_stage: 'alerts.settings.cropStage',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAlertCategories(input: unknown): AlertPreferenceCategory[] {
  if (!Array.isArray(input)) return [...ALERT_CATEGORIES];
  const seen = new Set<AlertPreferenceCategory>();
  for (const value of input) {
    if (typeof value === 'string' && ALERT_CATEGORIES.includes(value as AlertPreferenceCategory)) {
      seen.add(value as AlertPreferenceCategory);
    }
  }
  return ALERT_CATEGORIES.filter((category) => seen.has(category));
}

export function parseAlertPreferences(input: unknown): AlertPreferences | null {
  if (!isRecord(input)) return null;
  const pushAvailable = input.push_available === true || input.pushAvailable === true;
  const rawCategories = input.categories;
  const categories = normalizeAlertCategories(rawCategories);
  const rawVersion = input.consent_version ?? input.consentVersion;
  const consentVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion)
      ? Math.max(0, Math.trunc(rawVersion))
      : 0;
  const consentAt = input.consent_at ?? input.consentAt;

  return {
    inApp: input.in_app === true || input.inApp === true,
    push: (input.push === true) && pushAvailable,
    categories,
    consentVersion,
    consentAt: typeof consentAt === 'string' ? consentAt : null,
    pushAvailable,
  };
}
