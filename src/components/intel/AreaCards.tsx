import { AlertTriangle, Sprout } from 'lucide-react';
import { SectionLabel } from '@/components/SectionLabel';
import type { MessageKey } from '@/i18n/catalog';
import { formatDay } from '@/i18n/format';
import { useLocale } from '@/i18n/LocaleProvider';
import { useInsights } from '@/insights/InsightProvider';
import { assessDiseasePressure, type DiseasePressure } from '@/intel/disease';
import { cropCodeOf, nextCropAdvice, SEASON_KEYS } from '@/intel/season';
import { useLocation } from '@/location/LocationProvider';
import { useForecast } from '@/services/hooks';

/**
 * The two area cards: disease trends, and crop suitability.
 *
 * Each is one row, drawn as the official-advisory row is drawn — a tinted icon
 * square, a bold **heading**, a caption **subheading** under it. One heading, one
 * subheading, nothing else: the card is a single statement about the farmer's own
 * area, and a second line of furniture would make it a report instead.
 *
 * They read `useLocation()`, which is the same saved place the header prints and
 * the same point the weather card is fetched for. There is no second "here".
 *
 * Neither claims more than it holds. The disease heading is what the forecast
 * does to the *likelihood* of disease around that field and area, never a
 * sighting of disease in it, and its subheading carries the rain and the
 * temperature the level was read from. The crop heading is what suits this field
 * after the standing crop, and its subheading is the season and the crop it
 * follows — not a margin.
 */

/** A week: long enough for a rain pattern, short enough to stay a forecast. */
const FORECAST_DAYS = 7;

const CARD = 'mt-2 divide-y divide-border rounded-lg border border-border bg-card';

/** The calm tint, and the attention tint the advisory row's alerts use. */
const TINT_CALM = 'bg-brand-soft text-brand';
const TINT_ALERT = 'bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100';
const TINT_QUIET = 'bg-muted text-muted-foreground';

const LEVEL_ANSWER: Record<DiseasePressure, MessageKey> = {
  low: 'home.disease.answer.low',
  watch: 'home.disease.answer.watch',
  favourable: 'home.disease.answer.favourable',
  unknown: 'home.disease.answer.unknown',
};

/** One tint per level, so the colour and the words cannot disagree. */
const LEVEL_TINT: Record<DiseasePressure, string> = {
  low: TINT_CALM,
  watch: TINT_ALERT,
  favourable: TINT_ALERT,
  unknown: TINT_QUIET,
};

/**
 * One row of an area card — the advisory row's furniture, to the class: a tinted
 * icon square, a heading, a subheading. No chevron: the advisory row opens a
 * portal, these rows open nothing yet, and a chevron on a row with no destination
 * is a control that lies about itself.
 */
function Row({
  icon: Icon,
  tint,
  heading,
  subheading,
}: {
  icon: typeof AlertTriangle;
  tint: string;
  heading: string;
  subheading: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-md ${tint}`}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium leading-snug">{heading}</span>
        <span className="mt-1 block truncate text-caption text-muted-foreground">{subheading}</span>
      </span>
    </li>
  );
}

export function AreaCards() {
  const { t, locale } = useLocale();
  const location = useLocation();
  const insights = useInsights();

  const forecast = useForecast(location.activePoint, FORECAST_DAYS);
  const disease = assessDiseasePressure(forecast.data);

  const cropNameKey = insights.primary?.nameKey ?? null;
  const currentCode = cropCodeOf(cropNameKey);
  const advice = nextCropAdvice({ currentCode, now: Date.now() });

  /*
   * The first part of the saved label — "Swat River", not the whole
   * "Swat River, Khyber Pakhtunkhwa, Pakistan". The header above prints the full
   * place; these subheadings are one caption line, and the advisory row they are
   * drawn from truncates rather than wraps, so the area has to be short enough to
   * survive that.
   */
  const area = location.placeLabel.split(',')[0]?.trim() || location.placeLabel;
  const cropName = cropNameKey ? t(cropNameKey) : null;
  const best = advice.options[0] ? t(advice.options[0].nameKey) : null;

  /*
   * The subheading is the evidence, not a repeat of the heading: the rain the
   * level was read from, the temperature it spans, and the area it was read for.
   * A window with no temperatures in it states the rain and the area alone rather
   * than a range with a hole in it.
   */
  const diseaseSub =
    disease.level === 'unknown'
      ? t('home.disease.nofeed', { area })
      : disease.minC !== null && disease.maxC !== null
        ? t('home.disease.sub', {
            rain: disease.rainDays,
            days: disease.days,
            min: Math.round(disease.minC),
            max: Math.round(disease.maxC),
            area,
          })
        : t('home.disease.sub.rainOnly', { rain: disease.rainDays, days: disease.days, area });

  const season = t(SEASON_KEYS[advice.season]);
  const sowing = advice.open
    ? t('home.nextCrop.context', { season, crop: cropName ?? '' })
    : t('home.nextCrop.context.opens', {
        season,
        date: formatDay(new Date(advice.opensOn), locale),
        crop: cropName ?? '',
      });

  return (
    <div className="flex flex-col gap-3">
      {/* What the week's weather does to the likelihood of disease here. */}
      <div>
        <SectionLabel>{t('home.disease.title')}</SectionLabel>
        <ul className={CARD}>
          <Row
            icon={AlertTriangle}
            tint={LEVEL_TINT[disease.level]}
            heading={t(LEVEL_ANSWER[disease.level])}
            subheading={diseaseSub}
          />
        </ul>
      </div>

      {/* What suits this field once the standing crop is off it. */}
      <div>
        <SectionLabel>{t('home.nextCrop.title')}</SectionLabel>
        <ul className={CARD}>
          {currentCode === null ? (
            <Row
              icon={Sprout}
              tint={TINT_QUIET}
              heading={t('home.nextCrop.nocrop')}
              subheading={t('home.nextCrop.basis')}
            />
          ) : (
            <Row
              icon={Sprout}
              tint={best ? TINT_CALM : TINT_QUIET}
              heading={
                best
                  ? t('home.nextCrop.answer', { crop: best })
                  : t('home.nextCrop.none', { crop: cropName ?? '' })
              }
              subheading={best ? sowing : t('home.nextCrop.basis')}
            />
          )}
        </ul>
      </div>
    </div>
  );
}
