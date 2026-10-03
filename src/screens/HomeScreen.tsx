import {
  AlertTriangle,
  Camera,
  ChevronRight,
  Cloud,
  MapPin,
  MessageCircle,
  Plus,
  ShieldCheck,
  Volume2,
  WifiOff,
} from 'lucide-react';
import { SectionLabel } from '@/components/SectionLabel';
import { Button } from '@/components/ui/button';
import { CropStrip, InsightCard, NotificationBell } from '@/components/insights/Insights';
import { useCredit } from '@/credit/CreditProvider';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import {
  formatHour,
  formatMoney,
  formatNumber,
  formatRelativeTime,
  formatWeekdayDate,
} from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { DEALER_DISPLAY, closingHour, tagLabel } from '@/data/dealers';
import { useDealerSearch, useMarketRates, useWeather } from '@/services/hooks';
import { isRateQuotable, isWeatherUsable, type MarketRate } from '@/services/types';

/**
 * The three commodities the strip shows, in the order the farmer reads them.
 * The service is asked for all of them in one call, so the tiles cannot be a
 * mixture of two different fetches.
 */
const RATE_COMMODITIES: ReadonlyArray<string> = ['cotton', 'wheat', 'maize'];

const midnight = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const TODAY = midnight(new Date());

/**
 * Home answers one question — *is there anything I need to do today?* — so
 * everything on it is either an action or the evidence behind one.
 *
 * Two habits are deliberate. Advice comes from the canonical insight list rather
 * than being written here, which is why the old amber "pink bollworm" strip is
 * gone: it and the insight card were two versions of one recommendation. And the
 * weather and rate figures carry their source and age; a number without them
 * would be a claim the app cannot support.
 */
export function HomeScreen({
  onScan,
  onOpenProfile,
  onOpenChat,
  onOpenDealers,
}: {
  onScan: () => void;
  onOpenProfile: () => void;
  onOpenChat: (dealerKey: string) => void;
  onOpenDealers: () => void;
}) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const now = Date.now();

  /*
   * The weather and the rates come from the same normalised services the
   * assistant reads. That is not tidiness: a Home card showing 34° while the
   * assistant cites 31° for the same morning is the exact failure the rule about
   * "one weather source" exists to prevent, and it is only preventable if the two
   * read the same call.
   */
  const weather = useWeather();
  const reading = weather.sourced;
  const weatherUsable = reading !== null && isWeatherUsable(reading);

  const rates = useMarketRates();
  const rateFor = (commodity: string): MarketRate | undefined =>
    rates.data.find((rate) => rate.commodity.toLowerCase().startsWith(commodity));

  /* The two nearest shops the farmer already trades with, from the dealer service
     rather than a second list written into this screen. */
  const dealerSearch = useDealerSearch({ radiusKm: 10 });
  const nearby = dealerSearch.data.slice(0, 2);

  const openAgreements = credit.data.agreements.filter((entry) => entry.closedAt === null);
  const outstanding = openAgreements.reduce((sum, entry) => sum + credit.outstandingOf(entry), 0);
  const first = openAgreements[0];
  const firstRequest = first ? credit.requestById(first.requestId) : undefined;
  const firstTerms = firstRequest
    ? firstRequest.terms.find((entry) => entry.version === first?.termsVersion)
    : undefined;
  const paidPercent =
    first && firstTerms
      ? Math.round((first.paid / (firstTerms.amount + firstTerms.fee)) * 100)
      : 0;
  const waiting = credit.awaiting[0];

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
      <header className="flex items-center gap-2.5">
        {/* The avatar is the profile entry point. The design puts the farmer's own
            face here and the tab bar's fifth item was "Me"; moving that destination
            into this circle keeps one control instead of two competing ones. */}
        <button
          type="button"
          aria-label={t('profile.open')}
          onClick={onOpenProfile}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand text-subheading font-medium text-brand-foreground"
        >
          {initialsOf(t('farmer.name'))}
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-subheading">
            {t('home.greeting', { name: t('farmer.firstName') })}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-label text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('farmer.place')}</span>
          </p>
        </div>

        <NotificationBell />
      </header>

      {/* The one dark block on the screen — and the reason the rest of the page
          (cream, white cards) reads as calm rather than flat. */}
      <section className="rounded-lg bg-surface-inverted px-4 py-4 text-cream-50">
        <div className="flex items-center justify-between gap-3">
          <p className="text-overline text-brand uppercase">
            {t('weather.today', { date: formatWeekdayDate(TODAY, locale) })}
          </p>
          {weatherUsable ? (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1.5 text-label text-white"
            >
              <Volume2 className="size-4" aria-hidden />
              {t('weather.listen')}
            </button>
          ) : null}
        </div>

        {weather.status === 'loading' ? (
          <p className="mt-3 text-body-sm text-white/70">{t('weather.loading')}</p>
        ) : null}

        {reading !== null && reading.data.tempC !== null ? (
          <div className="mt-3 flex items-center gap-3">
            <Cloud className="size-9 shrink-0 text-white" aria-hidden />
            {/* lining-nums matters: Cormorant defaults to old-style figures, and a
                temperature set in text figures reads as a broken number. */}
            <p className="font-serif text-display lining-nums tabular-nums">
              {Math.round(reading.data.tempC)}°
            </p>
            <p className="text-label leading-relaxed text-white/70">
              {reading.data.conditionKey
                ? t(reading.data.conditionKey)
                : (reading.data.conditionText ?? '')}
              <br />
              {reading.data.humidityPct !== null
                ? `${t('weather.humidity', { value: reading.data.humidityPct })} · `
                : ''}
              {reading.data.windKph !== null
                ? t('weather.windValue', { speed: Math.round(reading.data.windKph) })
                : ''}
            </p>
          </div>
        ) : null}

        {weatherUsable ? (
          <div className="mt-3.5 border-t border-white/20 pt-3.5">
            <p className="text-lead">{t('weather.spray')}</p>
            <p className="mt-1 text-body-sm leading-relaxed text-white/75">{t('weather.rain')}</p>
            {/* The same advice in the other language, which is the point of it: a
                farmer who reads one script gets it without switching the app. */}
            <p
              className="mt-2 text-subheading leading-loose text-brand"
              lang={locale === 'en' ? 'ur' : 'en'}
            >
              {t('weather.sprayOther')}
            </p>
          </div>
        ) : (
          /*
           * Advice that depends on the weather is paused when the reading cannot
           * carry it — but the numbers above, if any, stay: they are the reason the
           * advice is paused, and hiding them would leave the farmer unable to see
           * why. What never happens is advice without a reading behind it.
           */
          <div className="mt-3.5 border-t border-white/20 pt-3.5">
            {/* Two different failures, said differently: a reading that is too old
                to spray on is not the same as a service that answered nothing. */}
            <p className="text-subheading">
              {reading ? t('weather.stale.title') : t('weather.unavailable.title')}
            </p>
            <p className="mt-1 text-body-sm leading-relaxed text-white/75">
              {reading
                ? t('weather.stale', {
                    age: formatRelativeTime(reading.observedAt, Date.now(), t),
                  })
                : t('weather.unavailable.body')}
            </p>
            <button
              type="button"
              onClick={weather.retry}
              className="mt-3 rounded-full bg-white/12 px-4 py-2 text-label text-white"
            >
              {t('common.tryAgain')}
            </button>
          </div>
        )}

        {reading ? (
          <p className="mt-3 flex items-center gap-1.5 text-caption text-white/60">
            {t('weather.source', {
              source: reading.sourceLabel,
              time: formatRelativeTime(reading.observedAt, now, t),
            })}
            {!weatherUsable && reading.data.tempC !== null ? (
              <>
                <AlertTriangle className="size-3.5 shrink-0 text-amber-300" aria-hidden />
                {t('weather.stale', {
                  age: formatRelativeTime(reading.observedAt, now, t),
                })}
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* The canonical advice for the farmer's main crop, then every other active
          crop with its own count — one crop never hides another's alert. */}
      <InsightCard />
      <CropStrip />

      <button
        type="button"
        onClick={onScan}
        className="rounded-lg bg-brand px-4 py-4 text-start text-brand-foreground"
      >
        <span className="flex items-center gap-3.5">
          <span className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-foreground">
            <Camera className="size-7 text-brand" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lead">{t('scanCta.title')}</span>
            <span className="mt-0.5 block text-body-sm leading-snug opacity-80">
              {t('scanCta.body')}
            </span>
          </span>
        </span>
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-foreground/12 px-2.5 py-1 text-caption">
          <WifiOff className="size-3.5" aria-hidden />
          {t('scanCta.offline')}
        </span>
      </button>

      <section className="rounded-lg border border-border bg-card p-4">
        <SectionLabel
          action={
            <button type="button" className="text-label text-brand" onClick={() => credit.open()}>
              {t('credit.ledger')}
            </button>
          }
        >
          {t('credit.title')}
        </SectionLabel>

        <p className="mt-2 font-serif text-figure lining-nums tabular-nums">
          {formatMoney(outstanding, locale, t)}
        </p>
        <p className="mt-1 text-label text-muted-foreground">
          {firstRequest && firstTerms
            ? t('credit.home.open', {
                dealer: t(firstRequest.dealerKey),
                due: t(firstTerms.dueKey),
              })
            : t('credit.home.none')}
        </p>

        {first && firstTerms ? (
          <>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-brand" style={{ width: `${paidPercent}%` }} />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-caption text-muted-foreground">
              <span>{t('credit.card.paid', { percent: paidPercent })}</span>
              <span className="tabular-nums">
                {t('credit.card.outstanding', { amount: formatMoney(outstanding, locale, t) })}
              </span>
            </div>
          </>
        ) : null}

        {waiting ? (
          <button
            type="button"
            onClick={() => credit.open(waiting.id)}
            className="mt-3 flex w-full items-center gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-start dark:bg-amber-500/20"
          >
            <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-100" aria-hidden />
            <span className="flex-1 text-label leading-snug text-amber-900 dark:text-amber-100">
              {t('credit.home.answer')}
            </span>
            <ChevronRight className="size-4 shrink-0 text-amber-700 rtl:rotate-180 dark:text-amber-100" aria-hidden />
          </button>
        ) : null}

        <Button
          variant="outline"
          className="mt-3.5 h-11 w-full gap-1.5 rounded-full text-brand"
          onClick={() => credit.open()}
        >
          <Plus className="size-4" aria-hidden />
          {t('credit.request')}
        </Button>
      </section>

      <section>
        <SectionLabel action={<span className="text-caption text-muted-foreground">{t('market.wazirabad')}</span>}>
          {t('rates.title')}
        </SectionLabel>

        {rates.status === 'loading' ? (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('rates.loading')}</p>
        ) : null}

        {rates.status === 'error' ? (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-body-sm text-muted-foreground">{t('rates.error')}</p>
            <button type="button" onClick={rates.retry} className="text-label text-brand">
              {t('common.tryAgain')}
            </button>
          </div>
        ) : null}

        {rates.status === 'ready' ? (
          <>
            <ul className="mt-2 flex gap-2">
              {RATE_COMMODITIES.map((commodity) => (
                <RateTile
                  key={commodity}
                  commodity={commodity}
                  rate={rateFor(commodity)}
                  now={now}
                />
              ))}
            </ul>
            <p className="mt-1.5 text-caption text-muted-foreground">{t('rates.unit')}</p>
          </>
        ) : null}
      </section>

      <section className="pb-2">
        <SectionLabel
          action={
            <button type="button" onClick={onOpenDealers} className="text-label text-brand">
              {t('common.seeAll')}
            </button>
          }
        >
          {t('dealers.nearYou')}
        </SectionLabel>

        <ul className="mt-2 space-y-2">
          {nearby.map((entry) => {
            const display = DEALER_DISPLAY[entry.id];
            const name = display ? t(display.nameKey) : entry.name;
            const hour = closingHour(entry.id);
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
              >
                <span className="grid size-12 shrink-0 place-items-center rounded-md bg-brand-soft text-subheading text-brand">
                  {initialsOf(name)}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-body font-medium">{name}</span>
                    {entry.verifiedAt !== null ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand">
                        <ShieldCheck className="size-3" aria-hidden />
                        {t('dealers.verified')}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block truncate text-label text-muted-foreground">
                    {[
                      entry.isYourDealer ? t('dealers.yourDealer') : null,
                      t('common.km', { km: formatNumber(entry.distanceKm, locale) }),
                      hour !== null && entry.openNow === true
                        ? t('dealers.openTill', { time: formatHour(hour, t) })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {entry.tags[0] && tagLabel(entry.tags[0]) ? (
                    <span className="mt-1 block truncate text-caption text-muted-foreground">
                      {t('dealers.carries', {
                        tag: t(tagLabel(entry.tags[0]) as MessageKey),
                      })}
                    </span>
                  ) : null}
                </span>

                <button
                  type="button"
                  aria-label={t('dealers.chatAria', { name })}
                  onClick={() => onOpenChat(entry.id)}
                  className={`grid size-11 shrink-0 place-items-center rounded-full ${
                    entry.isYourDealer ? 'bg-brand text-brand-foreground' : 'bg-muted'
                  }`}
                >
                  <MessageCircle className="size-5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/**
 * One mandi rate, with its range and its age.
 *
 * Three rules from the PRD are visible in these few lines, and they are the
 * reason the tile takes the whole normalised rate rather than a number:
 *
 *   · a rate outside the freshness window is shown as stale, never as current
 *   · a value the source did not report shows as unreported — `null` is never
 *     coerced to zero, because zero is a price a farmer can be offered
 *   · the source and the observation time travel with the figure
 */
function RateTile({
  commodity,
  rate,
  now,
}: {
  commodity: string;
  rate: MarketRate | undefined;
  now: number;
}) {
  const { t, locale } = useLocale();
  if (!rate) {
    return (
      <li className="flex-1 rounded-md bg-muted p-3">
        <p className="text-label text-muted-foreground">{commodity}</p>
        <p className="mt-1 text-label leading-snug text-muted-foreground">
          {t('rates.unavailable')}
        </p>
      </li>
    );
  }

  const stale = !isRateQuotable(rate, now);
  const observed = new Date(rate.observedOn).getTime();
  const label = rate.nameKey ? t(rate.nameKey) : rate.nameEn;

  return (
    <li className="flex-1 rounded-md bg-muted p-3">
      <p className="text-label text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-subheading tabular-nums ${stale ? 'text-muted-foreground' : ''}`}
      >
        {rate.modalPrice !== null
          ? formatNumber(rate.modalPrice, locale)
          : t('dealer.products.unknownQty')}
      </p>
      {rate.minPrice !== null && rate.maxPrice !== null ? (
        <p className="mt-0.5 text-caption text-muted-foreground">
          {t('rates.minmax', {
            min: formatNumber(rate.minPrice, locale),
            max: formatNumber(rate.maxPrice, locale),
          })}
        </p>
      ) : null}
      {stale ? (
        <p className="mt-0.5 flex items-center gap-1 text-caption text-amber-700 dark:text-amber-100">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          {t('rates.stale', { age: formatRelativeTime(observed, now, t) })}
        </p>
      ) : null}
      <p className="mt-0.5 text-caption text-muted-foreground">
        {t('rates.source', {
          source: rate.sourceLabel,
          market: rate.marketName,
          time: formatRelativeTime(observed, now, t),
        })}
      </p>
    </li>
  );
}
