import { Bug, ChevronDown, CloudRain, ExternalLink, RefreshCw, Sprout } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDay, formatRelativeTime } from '@/i18n/format';
import type { MessageKey } from '@/i18n/catalog';
import {
  alertCategory,
  alertTrustKey,
  type AlertCategory,
  type AlertRow,
} from '@/intelligence/alerts';
import type { AlertsStatus } from '@/intelligence/useAlerts';
import { cropLabel, stageLabel } from '@/components/insights/PersonalizedAdvice';

const LEVEL_KEYS: Readonly<Record<AlertRow['level'], MessageKey>> = {
  urgent: 'alerts.level.urgent',
  watch: 'alerts.level.watch',
  info: 'alerts.level.info',
};

const CATEGORY_KEYS: Readonly<Record<AlertCategory, MessageKey>> = {
  weather: 'alerts.category.weather',
  pest: 'alerts.category.pest',
  disease: 'alerts.category.disease',
  crop_stage: 'alerts.category.cropStage',
};

const TRUST_KEYS: Readonly<Record<string, MessageKey>> = {
  weather: 'alerts.trust.weather',
  official: 'alerts.trust.official',
  forecast: 'alerts.trust.forecast',
  verified: 'alerts.trust.verified',
  supplementary: 'alerts.trust.supplementary',
  community: 'alerts.trust.community',
};

const ICONS = {
  weather: CloudRain,
  pest: Bug,
  disease: Bug,
  crop_stage: Sprout,
} as const;

function reasonText(
  row: AlertRow,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  const context = row.reasonContext;
  const crop = cropLabel(
    typeof context.crop_code === 'string' ? context.crop_code : row.cropCode ?? undefined,
    t,
  );
  const stage = stageLabel(typeof context.stage === 'string' ? context.stage : undefined, t);

  if (row.alertSourceKind === 'official_advisory') {
    return t('alerts.reason.official');
  }
  if (row.alertSourceKind === 'forecast_risk') {
    return t('alerts.reason.forecast');
  }
  if (row.reasonCode === 'crop_stage') {
    return crop && stage
      ? t('alerts.reason.cropStage', { crop, stage })
      : crop
        ? t('alerts.reason.crop', { crop })
        : t('alerts.reason.general');
  }
  if (row.reasonCode === 'weather_observation' || row.source === 'weather') {
    return t('alerts.reason.weather');
  }
  return crop ? t('alerts.reason.crop', { crop }) : t('alerts.reason.general');
}

/**
 * The compact Home alert. It is inside the existing crop card, not a second
 * advice surface, and it never hides the fact that the evidence is an observed
 * reading. Details are one tap away; dismissal is the farmer's, and it writes
 * through the same server pointer as the bell.
 */
export function ProactiveAlert({
  alerts,
  status,
  onRead,
  onDismiss,
  onScan,
  onOpenWeather,
  onRefresh,
}: {
  alerts: readonly AlertRow[];
  status: AlertsStatus;
  onRead: (notificationId: string) => void | Promise<boolean>;
  onDismiss: (notificationId: string) => void | Promise<boolean>;
  onScan?: () => void;
  onOpenWeather?: () => void;
  onRefresh?: () => void;
}) {
  const { t, locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const top = alerts[0];

  useEffect(() => {
    setExpanded(false);
  }, [top?.notificationId]);

  if (!top) {
    if (status === 'loading') {
      return (
        <p role="status" className="text-body-sm text-muted-foreground">
          {t('alerts.loading')}
        </p>
      );
    }
    if (status === 'error') {
      return (
        <div role="alert" className="rounded-md border border-border bg-muted p-3.5">
          <p className="text-body-sm text-muted-foreground">{t('alerts.error')}</p>
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="mt-2 inline-flex items-center gap-1.5 text-body-sm font-medium text-brand"
            >
              <RefreshCw className="size-4" aria-hidden />
              {t('alerts.retry')}
            </button>
          ) : null}
        </div>
      );
    }
    if (status === 'offline') {
      return (
        <p role="status" className="text-body-sm text-muted-foreground">
          {t('alerts.offline')}
        </p>
      );
    }
    return null;
  }

  const localized = locale === 'ur';
  const title = localized ? top.titleUr ?? top.title : top.title;
  const body = localized ? top.bodyUr ?? top.body : top.body;
  const category = alertCategory(top.kind);
  const Icon = ICONS[category];
  const trust = alertTrustKey(top);
  const alertTime = top.alertAt ?? top.createdAt;
  const at = alertTime ? new Date(alertTime).getTime() : Number.NaN;
  const when = Number.isFinite(at) ? formatRelativeTime(at, Date.now(), t) : null;
  const valid = top.validUntil ? new Date(top.validUntil) : null;
  const validLabel =
    valid && Number.isFinite(valid.getTime())
      ? t('alerts.validUntil', { date: formatDay(valid, locale) })
      : null;
  const publishedValue =
    typeof top.reasonContext.published_at === 'string'
      ? top.reasonContext.published_at
      : typeof top.reasonContext.issued_on === 'string'
        ? top.reasonContext.issued_on
        : null;
  const published = publishedValue ? new Date(publishedValue) : null;
  const publishedLabel =
    published && Number.isFinite(published.getTime())
      ? t('alerts.published', { date: formatDay(published, locale) })
      : null;
  const region = typeof top.reasonContext.district === 'string' ? top.reasonContext.district : null;
  const sourceUrl =
    top.sourceUrl && top.sourceUrl.startsWith('https://') ? top.sourceUrl : null;
  const action =
    top.actionKind === 'open_scan' && onScan
      ? { label: t('insight.action.scan'), run: onScan }
      : top.actionKind === 'open_weather' && onOpenWeather
        ? { label: t('insight.action.weather'), run: onOpenWeather }
        : null;
  const tone =
    top.level === 'urgent'
      ? 'border-amber-600/40 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/15'
      : top.level === 'watch'
        ? 'border-amber-500/30 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10'
        : 'border-brand/25 bg-brand-soft';

  const openDetails = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void onRead(top.notificationId);
  };

  return (
    <section
      aria-label={t('alerts.overline')}
      className={`rounded-md border p-3.5 ${tone}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-card/70 px-2 py-0.5 text-caption font-medium text-foreground">
          <Icon className="size-3.5" aria-hidden />
          {t(CATEGORY_KEYS[category])}
        </span>
        <span className="rounded-full bg-card/70 px-2 py-0.5 text-caption font-medium text-foreground">
          {t(LEVEL_KEYS[top.level])}
        </span>
        {when ? (
          <span className="text-caption text-muted-foreground">{when}</span>
        ) : null}
      </div>

      <h3 className="mt-2 text-lead leading-snug">{title}</h3>
      <p className="mt-1.5 text-body-sm leading-relaxed text-muted-foreground">{body}</p>
      <p className="mt-2 text-label text-brand">{reasonText(top, t)}</p>

      <p className="mt-1 flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
        <span>{top.sourceLabel ?? t('alerts.source')}</span>
        {trust ? (
          <>
            <span aria-hidden>·</span>
            <span>{t(TRUST_KEYS[trust] ?? 'alerts.trust.verified')}</span>
          </>
        ) : null}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {action ? (
          <Button
            className="h-10 rounded-full"
            onClick={() => {
              void onRead(top.notificationId);
              action.run();
            }}
          >
            <span className="text-body-sm">{action.label}</span>
          </Button>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={openDetails}
          className="inline-flex items-center gap-1 rounded-full px-1 py-2 text-body-sm font-medium text-brand"
        >
          {expanded ? t('alerts.hideDetails') : t('alerts.details')}
          <ChevronDown
            className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={() => void onDismiss(top.notificationId)}
          className="ms-auto inline-flex items-center gap-1 rounded-full px-1 py-2 text-body-sm text-muted-foreground"
        >
          {t('alerts.dismiss')}
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 border-t border-border pt-2">
          <dl className="text-caption">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t('alerts.source')}</dt>
              <dd className="text-end">{top.sourceLabel ?? t('alerts.source')}</dd>
            </div>
            {trust ? (
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t('alerts.evidence')}</dt>
                <dd className="text-end">{t(TRUST_KEYS[trust] ?? 'alerts.trust.verified')}</dd>
              </div>
            ) : null}
            {publishedLabel ? (
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t('alerts.publishedLabel')}</dt>
                <dd className="text-end">{publishedLabel}</dd>
              </div>
            ) : null}
            {region ? (
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t('alerts.region')}</dt>
                <dd className="text-end">{region}</dd>
              </div>
            ) : null}
            {validLabel ? (
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t('insight.validUntil')}</dt>
                <dd className="text-end">{validLabel}</dd>
              </div>
            ) : null}
          </dl>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-brand underline decoration-border underline-offset-2"
            >
              {t('alerts.viewSource')}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
      ) : null}

      {alerts.length > 1 ? (
        <p className="mt-2 text-caption text-muted-foreground">
          {t('alerts.more', { count: alerts.length - 1 })}
        </p>
      ) : null}
    </section>
  );
}
