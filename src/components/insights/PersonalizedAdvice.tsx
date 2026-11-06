import { Camera, CloudSun, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatRelativeTime } from '@/i18n/format';
import type { RankedRecommendation } from '@/intelligence/feed';
import { interestLabel } from '@/intelligence/interests';
import { InsightFeedback } from './InsightFeedback';

const CROP_KEYS: Readonly<Record<string, MessageKey>> = {
  cotton: 'crop.cotton',
  wheat: 'crop.wheat',
  rice: 'crop.rice',
  maize: 'crop.maize',
  sugarcane: 'crop.sugarcane',
  gram: 'crop.gram',
  potato: 'crop.potato',
  mustard: 'crop.mustard',
  mungbean: 'crop.mungbean',
  onion: 'crop.onion',
};

const STAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  planned: 'crop.stage.planned',
  sown: 'crop.stage.sown',
  germinating: 'crop.stage.germinating',
  vegetative: 'crop.stage.vegetative',
  flowering: 'crop.stage.flowering',
  fruiting: 'crop.stage.fruiting',
  maturity: 'crop.stage.maturity',
  harvested: 'crop.stage.harvested',
  failed: 'crop.stage.failed',
};

const CATEGORY_KEYS: Readonly<Record<string, MessageKey>> = {
  pest: 'insight.category.pest',
  disease: 'insight.category.disease',
  crop_stage: 'insight.category.cropStage',
  weather: 'insight.category.weather',
  market: 'insight.category.market',
  general: 'insight.category.general',
};

export function cropLabel(code: string | undefined, t: (key: MessageKey) => string): string | null {
  if (!code) return null;
  const key = CROP_KEYS[code];
  return key ? t(key) : code.replace(/_/g, ' ');
}

export function stageLabel(stage: string | undefined, t: (key: MessageKey) => string): string | null {
  if (!stage) return null;
  const key = STAGE_KEYS[stage];
  return key ? t(key) : stage.replace(/_/g, ' ');
}

function reasonText(
  row: RankedRecommendation,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  const context = row.reasonContext;
  const crop = cropLabel(
    typeof context.crop_code === 'string' ? context.crop_code : row.cropCode ?? undefined,
    t,
  );
  const stage = stageLabel(typeof context.stage === 'string' ? context.stage : undefined, t);
  const topic =
    typeof context.topic === 'string' ? interestLabel(`topic:${context.topic}`, t) : null;

  switch (row.reasonCode) {
    case 'pinned_interest':
      return topic || crop
        ? t('insight.reason.pinned', { topic: topic ?? crop ?? '' })
        : t('insight.reason.personalized');
    case 'crop_stage':
      return crop && stage
        ? t('insight.reason.cropStage', { crop, stage })
        : crop
          ? t('insight.reason.crop', { crop })
          : t('insight.reason.personalized');
    case 'crop':
      return crop ? t('insight.reason.crop', { crop }) : t('insight.reason.personalized');
    case 'interest':
      return topic ? t('insight.reason.interest', { topic }) : t('insight.reason.personalized');
    case 'weather_now':
      return t('insight.reason.weather');
    default:
      return t('insight.reason.personalized');
  }
}

function trustLabel(row: RankedRecommendation): MessageKey | null {
  if (row.evidenceTier === 'verified') return 'insight.trust.verified';
  if (row.evidenceTier === 'supplementary') return 'insight.trust.supplementary';
  if (row.evidenceTier === 'community') return 'insight.trust.community';
  if (row.source === 'weather') return 'insight.trust.weather';
  return null;
}

/**
 * One list of server-ranked advice inside the existing crop card. It is not a
 * second Home surface: the card itself stays the only recommendation area, and
 * the local document remains what appears when the server feed is unavailable.
 */
export function PersonalizedAdvice({
  rows,
  onScan,
  onOpenWeather,
  onRefresh,
}: {
  rows: readonly RankedRecommendation[];
  onScan?: () => void;
  onOpenWeather?: () => void;
  onRefresh?: () => void;
}) {
  const { t, locale } = useLocale();
  const localized = locale === 'ur';
  if (rows.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-overline uppercase text-brand">{t('insight.forYou')}</p>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t('insight.refresh')}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground"
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <ul className="mt-2 flex flex-col">
        {rows.map((row, index) => {
          const title = localized ? row.titleUr ?? row.title : row.title;
          const body = localized ? row.bodyUr ?? row.body : row.body;
          const category = CATEGORY_KEYS[row.kind] ?? 'insight.category.general';
          const trust = trustLabel(row);
          const at = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
          const when = Number.isFinite(at) ? formatRelativeTime(at, Date.now(), t) : null;
          // Defence in depth: the parser rejects this, but a caller-supplied row
          // must never turn into a non-HTTPS link in the farmer's advice.
          const sourceUrl =
            row.sourceUrl && row.sourceUrl.startsWith('https://') ? row.sourceUrl : null;
          const action =
            row.actionKind === 'open_scan' && onScan
              ? { label: t('insight.action.scan'), run: onScan, icon: Camera }
              : row.actionKind === 'open_weather' && onOpenWeather
                ? { label: t('insight.action.weather'), run: onOpenWeather, icon: CloudSun }
                : null;

          return (
            <li
              key={row.recommendationId}
              className={
                index === 0
                  ? 'mt-2'
                  : 'mt-3.5 border-t border-border pt-3.5'
              }
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand">
                  {t(category)}
                </span>
                {trust ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
                    {t(trust)}
                  </span>
                ) : null}
              </div>

              <p className="mt-2 text-lead leading-snug">{title}</p>
              <p className="mt-1.5 text-body-sm leading-relaxed text-muted-foreground">{body}</p>
              <p className="mt-2 text-label text-brand">{reasonText(row, t)}</p>

              <p className="mt-1 flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
                <span>{row.sourceLabel ?? t('insight.source')}</span>
                {when ? <span aria-hidden>·</span> : null}
                {when ? <span>{when}</span> : null}
                {sourceUrl ? (
                  <>
                    <span aria-hidden>·</span>
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-6 items-center gap-0.5 underline decoration-border underline-offset-2"
                    >
                      {t('insight.viewSource')}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </>
                ) : null}
              </p>

              {action ? (
                <Button
                  className="mt-3 h-10 rounded-full"
                  onClick={action.run}
                >
                  <action.icon className="size-4" aria-hidden />
                  <span className="text-body-sm">{action.label}</span>
                </Button>
              ) : null}

              <InsightFeedback
                insightId={`server:${row.recommendationId}`}
                insightKind={row.kind}
                recommendationId={row.recommendationId}
                compact
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
