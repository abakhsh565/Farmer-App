import { useEffect, useState } from 'react';
import { BellOff, ChevronLeft, CloudSun, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import {
  ALERT_CATEGORIES,
  ALERT_CATEGORY_KEYS,
  type AlertPreferenceCategory,
} from '@/intelligence/alertPreferences';
import { useAlertPreferences } from '@/intelligence/useAlertPreferences';
import { useOnline } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';

/**
 * Alert settings, reached from the previously inert Notifications row in Profile.
 *
 * This is a settings screen, not an alert dashboard. It writes one explicit
 * preference object and says plainly that push delivery is unavailable in this
 * build. It does not request an OS notification permission it cannot honour.
 */
export function AlertSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t } = useLocale();
  const { account, prompt } = useSession();
  const online = useOnline();
  const preferences = useAlertPreferences({
    accountId: account?.id ?? null,
    enabled: Boolean(account),
    online,
  });
  const [inApp, setInApp] = useState(preferences.preferences.inApp);
  const [categories, setCategories] = useState<AlertPreferenceCategory[]>(
    preferences.preferences.categories,
  );
  const [formError, setFormError] = useState<MessageKey | null>(null);

  useEffect(() => {
    setInApp(preferences.preferences.inApp);
    setCategories(preferences.preferences.categories);
  }, [preferences.preferences]);

  const canEdit =
    account !== null &&
    online &&
    preferences.status === 'ready' &&
    !preferences.saving;

  const toggleCategory = (category: AlertPreferenceCategory) => {
    setCategories((current) =>
      current.includes(category)
        ? current.filter((entry) => entry !== category)
        : [...current, category],
    );
  };

  const save = async () => {
    if (inApp && categories.length === 0) {
      setFormError('alerts.settings.emptyCategory');
      return;
    }
    setFormError(null);
    const saved = await preferences.save({
      inApp,
      push: false,
      categories,
      consentVersion: preferences.preferences.consentVersion,
    });
    if (saved) toast.success(t('alerts.settings.saved'));
    else setFormError('alerts.settings.saveFailed');
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-8">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <h1 className="text-heading">{t('alerts.settings.title')}</h1>
      </div>

      <p className="mt-3 max-w-[48ch] text-body-sm leading-relaxed text-muted-foreground">
        {t('alerts.settings.intro')}
      </p>

      {!account ? (
        <EmptyState
          icon={BellOff}
          title={t('alerts.settings.signIn')}
          body={t('alerts.settings.signInBody')}
          action={
            <button
              type="button"
              onClick={() => prompt('session.why.alerts')}
              className="h-11 rounded-full bg-primary px-5 text-body text-primary-foreground"
            >
              {t('profile.account.signIn')}
            </button>
          }
        />
      ) : null}

      {account && (preferences.status === 'idle' || preferences.status === 'loading') ? (
        <LoadingState label={t('alerts.settings.loading')} />
      ) : null}

      {account && preferences.status === 'error' ? (
        <ErrorState
          title={t('alerts.settings.loadError')}
          body={t('alerts.settings.loadError')}
          onRetry={preferences.refresh}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}

      {account && preferences.status === 'offline' ? (
        <EmptyState
          icon={CloudSun}
          title={t('alerts.offline')}
          body={t('alerts.settings.offline')}
        />
      ) : null}

      {account && preferences.status === 'ready' ? (
        <>
          <section className="mt-5 rounded-md border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-body font-medium">{t('alerts.settings.inApp')}</p>
                <p className="mt-1 text-body-sm leading-relaxed text-muted-foreground">
                  {t('alerts.settings.inAppHint')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={inApp}
                aria-label={t('alerts.settings.inApp')}
                disabled={!canEdit}
                onClick={() => setInApp((current) => !current)}
                className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
                  inApp ? 'border-brand bg-brand' : 'border-border bg-muted'
                }`}
              >
                <span
                  className={`absolute top-0.5 size-5 rounded-full bg-card shadow-sm transition-transform ${
                    inApp ? 'end-0.5' : 'start-0.5'
                  }`}
                  aria-hidden
                />
              </button>
            </div>
          </section>

          <section className="mt-4 rounded-md border border-border bg-card p-4">
            <div className="flex items-start gap-2">
              <BadgeCheckIcon />
              <div>
                <p className="text-body font-medium">{t('alerts.settings.categories')}</p>
                <p className="mt-1 text-body-sm leading-relaxed text-muted-foreground">
                  {t('alerts.settings.categoriesHint')}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {ALERT_CATEGORIES.map((category) => {
                const selected = categories.includes(category);
                return (
                  <button
                    key={category}
                    type="button"
                    aria-pressed={selected}
                    disabled={!canEdit}
                    onClick={() => toggleCategory(category)}
                    className={`min-h-9 rounded-full border px-3 text-body-sm disabled:opacity-50 ${
                      selected
                        ? 'border-brand bg-brand-soft text-brand'
                        : 'border-border bg-background text-muted-foreground'
                    }`}
                  >
                    {t(ALERT_CATEGORY_KEYS[category])}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-4 rounded-md border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-body font-medium">{t('alerts.settings.push')}</p>
                <p className="mt-1 text-body-sm leading-relaxed text-muted-foreground">
                  {t('alerts.settings.pushUnavailable')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={preferences.preferences.push}
                aria-label={t('alerts.settings.push')}
                disabled
                className="relative mt-0.5 h-7 w-12 shrink-0 rounded-full border border-border bg-muted opacity-50"
              >
                <span className="absolute start-0.5 top-0.5 size-5 rounded-full bg-card shadow-sm" aria-hidden />
              </button>
            </div>
          </section>

          <div className="mt-4 flex items-start gap-2 rounded-md bg-muted p-3.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t('alerts.settings.safety')}
            </p>
          </div>

          <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
            {t('alerts.settings.consent')}
          </p>

          {formError ? (
            <p role="alert" className="mt-3 text-body-sm text-red-700 dark:text-red-100">
              {t(formError)}
            </p>
          ) : null}
          {preferences.saveFailed && !formError ? (
            <p role="alert" className="mt-3 text-body-sm text-red-700 dark:text-red-100">
              {t('alerts.settings.saveFailed')}
            </p>
          ) : null}

          <Button
            className="mt-4 h-11 w-full rounded-full"
            disabled={!canEdit}
            onClick={() => void save()}
          >
            {t('alerts.settings.save')}
          </Button>

        </>
      ) : null}
    </div>
  );
}

function BadgeCheckIcon() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft">
      <ShieldCheck className="size-4 text-brand" aria-hidden />
    </span>
  );
}
