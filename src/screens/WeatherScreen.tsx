import {
  ChevronLeft,
  CloudRain,
  Droplets,
  RefreshCw,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatRelativeTime, formatWeekdayDate, intlLocale } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { useForecast, useWeather } from '@/services/hooks';
import { daylightProgress, sunTimes, type SunTimes } from '@/services/sun';
import type { WeatherDay } from '@/services/types';

/**
 * The sky over the farmer's own place, at full size.
 *
 * The Home card carries the one number a farmer needs before walking out. This
 * screen is what the card opens into: the same reading, given room — the sun's
 * real path across today, the three times that path is pinned to, the numbers the
 * card squeezes into a line, and the next few days.
 *
 * Two rules inherited from the card, because a bigger screen is not a licence to
 * relax them:
 *
 * · every figure comes from the weather service, and a missing one is an em dash,
 *   never a zero. The sun times are not in that service at all, so they are
 *   *computed* from the farmer's coordinates (`services/sun`) rather than guessed
 *   from a 6 AM–6 PM placeholder. Where the sun does not cross the horizon, no
 *   times are printed.
 *
 * · the reading's age travels with it. "updated 2h" is on the page, and the
 *   refresh control asks the same service the card asks.
 *
 * Motion is deliberate rather than decorative: the temperature counts up once,
 * the arc draws itself and the sun travels to *now* along it, and the tiles settle
 * in behind. All of it yields to `prefers-reduced-motion`, because a screen that
 * animates at a farmer with vestibular sensitivity is a screen they cannot use.
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Whether a number may animate at all.
 *
 * requestAnimationFrame is throttled to a standstill in a tab that is not on
 * screen. A count-up that starts at zero and never receives a frame would sit
 * there claiming 0°, which is not a slow animation — it is a wrong reading. So
 * animation is opt-in on visibility as well as on the motion preference.
 */
const canAnimate = () =>
  typeof document !== 'undefined' && !document.hidden && !prefersReducedMotion();

/** Counts from zero to the reading, once. Null stays null — never a fake zero. */
function useCountUp(target: number | null, durationMs = 850): number | null {
  const [value, setValue] = useState<number | null>(() =>
    target === null ? null : canAnimate() ? 0 : target,
  );

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    if (!canAnimate()) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (at: number) => {
      const progress = Math.min(1, (at - start) / durationMs);
      /* Ease-out cubic: fast where the number is least legible, slow at the end. */
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return target === null ? null : value;
}

/** The sun's seat on the arc: fraction 0 is the left horizon, 1 the right. */
function sunPoint(fraction: number) {
  const angle = Math.PI - Math.PI * fraction;
  return { x: 160 + 140 * Math.cos(angle), y: 100 - 88 * Math.sin(angle) };
}

/** The same travel, animated once on mount so the eye follows it to "now". */
function useAnimatedFraction(target: number): number {
  const [value, setValue] = useState(() => (canAnimate() ? 0 : target));

  useEffect(() => {
    if (!canAnimate()) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (at: number) => {
      const progress = Math.min(1, (at - start) / 1100);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return value;
}

export function WeatherScreen({ onBack }: { onBack: () => void }) {
  const { t, locale } = useLocale();
  const location = useLocation();
  const weather = useWeather(location.activePoint);
  const forecast = useForecast(location.activePoint, 4);

  const reading = weather.sourced;
  const now = Date.now();
  const times = sunTimes(new Date(now), location.activePoint);
  const animatedTemp = useCountUp(reading?.data.tempC ?? null);

  const condition = reading?.data.conditionKey
    ? t(reading.data.conditionKey)
    : reading?.data.conditionText ?? null;

  return (
    <div className="weather-sky relative flex min-h-dvh flex-col px-5 pt-4 pb-10 text-foreground">
      <header className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('common.back')}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-white/40 text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>

        <div className="min-w-0 text-center">
          <p className="text-title">{t('weather.screenTitle')}</p>
          <p className="mt-0.5 truncate text-label text-foreground/70">
            {location.placeLabel || t('location.none')}
          </p>
        </div>

        <button
          type="button"
          onClick={weather.retry}
          aria-label={t('weather.refresh')}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-white/40 text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
        >
          <RefreshCw
            className={`size-4 ${weather.refreshing ? 'animate-spin' : ''}`}
            aria-hidden
          />
        </button>
      </header>

      {weather.status === 'loading' ? (
        <div className="mt-16 flex flex-col items-center gap-3" role="status" aria-live="polite">
          <div className="h-24 w-44 animate-pulse rounded-lg bg-foreground/10" />
          <div className="h-4 w-32 animate-pulse rounded-full bg-foreground/10" />
          <span className="sr-only">{t('weather.loading')}</span>
        </div>
      ) : (
        <section className="mt-12 flex flex-col items-center text-center">
          {/*
            One number, set in the serif at hero size. The count-up is a single
            performance, not a loop: a temperature that keeps moving is a
            temperature a farmer cannot read.
          */}
          <p className="text-hero font-serif lining-nums tabular-nums animate-in fade-in zoom-in-95 duration-700 fill-mode-both motion-reduce:animate-none">
            {animatedTemp === null ? '—' : `${Math.round(animatedTemp)}°`}
          </p>

          <p className="mt-3 text-lead animate-in fade-in slide-in-from-bottom-2 duration-700 delay-150 fill-mode-both motion-reduce:animate-none">
            {condition ?? t('weather.noReading')}
          </p>

          <p className="mt-1 text-label text-foreground/70 animate-in fade-in duration-700 delay-300 fill-mode-both motion-reduce:animate-none">
            {t('weather.today', { date: formatWeekdayDate(new Date(now), locale) })}
          </p>

          {reading?.status === 'failing' || weather.status === 'error' ? (
            <button
              type="button"
              onClick={weather.retry}
              className="mt-3 rounded-full bg-white/40 px-4 py-2 text-label text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
            >
              {t('common.tryAgain')}
            </button>
          ) : null}
        </section>
      )}

      {times ? (
        <section className="mt-10 animate-in fade-in duration-700 fill-mode-both delay-200 motion-reduce:animate-none">
          <SunArc times={times} now={now} />
        </section>
      ) : null}

      <section className="mt-8 grid grid-cols-2 gap-3">
        <Metric
          Icon={Droplets}
          label={t('weather.metricHumidity')}
          value={
            reading?.data.humidityPct == null ? '—' : `${Math.round(reading.data.humidityPct)}%`
          }
          delay={220}
        />
        <Metric
          Icon={Wind}
          label={t('weather.metricWind')}
          value={reading?.data.windKph == null ? '—' : `${Math.round(reading.data.windKph)} km/h`}
          delay={290}
        />
        <Metric
          Icon={CloudRain}
          label={t('weather.metricRain')}
          value={reading?.data.precipMm == null ? '—' : `${reading.data.precipMm} mm`}
          delay={360}
        />
        <Metric
          Icon={Thermometer}
          label={t('weather.metricFeels')}
          value={
            reading?.data.feelsLikeC == null
              ? '—'
              : `${Math.round(reading.data.feelsLikeC)}°`
          }
          delay={430}
        />
      </section>

      {forecast.data.length > 0 ? (
        <section className="mt-8">
          <p className="text-overline uppercase text-foreground/70">
            {t('weather.forecastTitle')}
          </p>
          <ul className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {forecast.data.map((day, index) => (
              <ForecastDay key={day.date} day={day} index={index} />
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        The same two sentences the Home card carries, kept in one place here rather
        than re-worded: a farmer moving between the two surfaces must not read two
        different spray windows for the same morning.
      */}
      <section className="mt-8 rounded-lg border border-foreground/10 bg-white/40 p-4 dark:bg-white/10">
        <p className="text-body font-medium">{t('weather.spray')}</p>
        <p className="mt-1 text-body-sm text-foreground/70">{t('weather.rain')}</p>
      </section>

      {reading ? (
        <p className="mt-5 flex items-center justify-center gap-1.5 text-caption text-foreground/60">
          <RefreshCw className="size-3" aria-hidden />
          {t('weather.updated', {
            time: formatRelativeTime(reading.observedAt, now, t),
          })}
        </p>
      ) : null}
    </div>
  );
}

/* ── the arc ─────────────────────────────────────────────────────────────── */

function SunArc({ times, now }: { times: SunTimes; now: number }) {
  const { t, locale } = useLocale();
  const night = now < times.sunrise || now > times.sunset;
  const fraction = useAnimatedFraction(daylightProgress(now, times));
  const sun = sunPoint(fraction);

  const clock = (at: number) =>
    new Intl.DateTimeFormat(intlLocale(locale), {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(at));

  return (
    <>
      <svg
        viewBox="0 0 320 120"
        className="w-full"
        role="img"
        aria-label={`${t('weather.sunrise')} ${clock(times.sunrise)} · ${t('weather.sunset')} ${clock(times.sunset)}`}
      >
        <line
          x1="14"
          y1="100"
          x2="306"
          y2="100"
          className="stroke-foreground/20"
          strokeWidth="1"
        />
        <path
          d="M 20 100 A 140 88 0 0 1 300 100"
          fill="none"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - fraction}
          className="stroke-foreground/40"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* A soft glow that breathes, so the sun reads as light rather than a dot. */}
        <circle
          cx={sun.x}
          cy={sun.y}
          r="15"
          className={night ? 'fill-foreground/10' : 'fill-amber-300/60 animate-pulse'}
        />
        <circle
          cx={sun.x}
          cy={sun.y}
          r="6.5"
          className={night ? 'fill-foreground/40' : 'fill-amber-600'}
        />
      </svg>

      <div className="mt-1 grid grid-cols-3 text-center">
        <SunTime Icon={Sunrise} label={t('weather.sunrise')} value={clock(times.sunrise)} />
        <SunTime Icon={Sun} label={t('weather.solarNoon')} value={clock(times.solarNoon)} />
        <SunTime Icon={Sunset} label={t('weather.sunset')} value={clock(times.sunset)} />
      </div>

      {night ? (
        <p className="mt-2 text-center text-caption text-foreground/60">{t('weather.night')}</p>
      ) : null}
    </>
  );
}

function SunTime({
  Icon,
  label,
  value,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Icon className="size-4 text-foreground/70" aria-hidden />
      <p className="text-body font-medium tabular-nums">{value}</p>
      <p className="text-caption text-foreground/70">{label}</p>
    </div>
  );
}

/* ── the numbers and the days ────────────────────────────────────────────── */

function Metric({
  Icon,
  label,
  value,
  delay,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  delay: number;
}) {
  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-lg border border-foreground/10 bg-white/40 p-3.5 duration-700 motion-safe:transition-transform motion-safe:hover:-translate-y-0.5 motion-reduce:animate-none dark:bg-white/10"
    >
      <p className="flex items-center gap-1.5 text-label text-foreground/70">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </p>
      <p className="mt-1.5 font-serif text-figure lining-nums tabular-nums">{value}</p>
    </div>
  );
}

function ForecastDay({ day, index }: { day: WeatherDay; index: number }) {
  const { t, locale } = useLocale();
  const name = new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day.date}T12:00:00Z`));

  return (
    <li
      style={{ animationDelay: `${120 + index * 80}ms` }}
      className="min-w-24 animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-lg border border-foreground/10 bg-white/40 p-3 text-center duration-700 motion-reduce:animate-none dark:bg-white/10"
    >
      <p className="text-label text-foreground/70">{name}</p>
      <div className="mt-2 flex items-baseline justify-center gap-1.5">
        <span className="font-serif text-subheading tabular-nums">
          {day.maxC === null ? '—' : `${Math.round(day.maxC)}°`}
        </span>
        <span className="text-caption text-foreground/60 tabular-nums">
          {day.minC === null ? '—' : `${Math.round(day.minC)}°`}
        </span>
      </div>
      {day.precipMm !== null && day.precipMm > 0 ? (
        <p className="mt-1.5 flex items-center justify-center gap-1 text-caption text-foreground/70">
          <CloudRain className="size-3" aria-hidden />
          {day.precipMm} mm
        </p>
      ) : (
        <p className="mt-1.5 text-caption text-foreground/50">{t('common.steady')}</p>
      )}
    </li>
  );
}
