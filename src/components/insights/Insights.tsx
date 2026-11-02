import { BellRing, Camera, ChevronRight, Sprout, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useCredit } from '@/credit/CreditProvider';
import { useSession } from '@/session/SessionProvider';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDay, formatRelativeTime } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { useInsights } from '@/insights/InsightProvider';
import { cropById, insightById, stageIsEstimate } from '@/insights/store';

/**
 * The two surfaces that consume the canonical insight: the card on Home, and the
 * sheet behind the bell. Both render the same record — the sheet looks the
 * insight up by id, and the notification item carries nothing but that id — so
 * the advice a farmer taps is the advice they read.
 *
 * The section on Home is one list, not two: every crop that has something to say
 * appears in it, the farmer's main crop first, and a crop with nothing live is
 * left out of it entirely. Recommendations still evaluate independently — one
 * crop's advice never hides another's — but a crop that has none is no longer a
 * row of the screen saying so. The tiles that used to do that are gone: a tile
 * whose whole content was "Nothing right now" cost a row to report that nothing
 * had happened.
 *
 * The card is the farmer's whole crop, not only its advice: the scanner belongs to
 * this card too (`onScan`), because "what does my crop need" and "what is wrong
 * with this leaf" are one question asked with two buttons — and because the big
 * scan block that used to sit under this card was a second, louder answer to it.
 *
 * A crop with no advice is not offered a card explaining its own emptiness: a
 * farmer with an account is told nothing, because there is nothing to tell. A
 * farmer without one gets the copy this app's review asked to have back, on the
 * same card, and only when there is a crop for it to be about. Making a crop
 * primary is a labelled button in the detail sheet, not a tap-anywhere affordance
 * — it is a decision the farmer makes, not one they stumble into.
 */

export function CropCard({ onScan }: { onScan: () => void }) {
  const { t } = useLocale();
  const insights = useInsights();
  const { account, requestIdentity } = useSession();
  const now = Date.now();
  const primary = insights.primary;

  /*
   * The list the section renders: the main crop first, then the farmer's other
   * crops in the order they were added — each with the advice it actually has.
   * A crop with nothing live produces no row here at all.
   */
  const ordered = primary
    ? [primary, ...insights.crops.filter((crop) => crop.id !== primary.id)]
    : insights.crops;
  const rows = ordered.flatMap((crop) => {
    const advice = insights.forCrop(crop.id);
    const top = advice[0];
    /* `flatMap` rather than `filter`: the row is built only where there is advice
       to put in it, so the advice below is never the optional one. */
    return top ? [{ crop, advice, top }] : [];
  });

  /*
   * The card always has one thing to offer — the scanner — so it is never absent.
   * What varies is whether there is advice to list, and whether the copy the
   * review asked for belongs on it.
   */
  const showsAdvice = rows.length > 0;
  const showsGuestCopy = rows.length === 0 && !account && primary !== undefined;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      {showsAdvice ? (
      <ul className="flex flex-col">
        {rows.map(({ crop, advice, top }, index) => {
          return (
            <li
              key={crop.id}
              className={index === 0 ? '' : 'mt-3.5 border-t border-border pt-3.5'}
            >
              {/* Which crop this is about, said identically for every crop: the
                  main one is marked, not rendered differently. */}
              <span className="flex items-center gap-1.5">
                <Sprout className="size-3.5 shrink-0 text-brand" aria-hidden />
                <span className="truncate text-body font-medium">{t(crop.nameKey)}</span>
                {crop.primary ? (
                  <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-caption text-brand">
                    {t('insight.main')}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-caption text-muted-foreground">
                {t(crop.stageKey)}
                {stageIsEstimate(crop) ? ` · ${t('insight.estimated')}` : ''}
              </span>

              <p className="mt-2 text-lead leading-snug">{t(top.titleKey)}</p>
              <p className="mt-1.5 text-body-sm leading-relaxed text-muted-foreground">
                {t(top.bodyKey)}
              </p>
              <p className="mt-2 text-caption text-muted-foreground">
                {t('insight.confidence', { percent: top.confidence })} ·{' '}
                {t('insight.evidence', {
                  source: t(top.sourceKey),
                  time: formatRelativeTime(top.createdAt, now, t),
                })}
              </p>
              {/* The row opens the highest-ranked advice, so when a crop has more
                  than one thing to look at, the count is what says so. */}
              {advice.length > 1 ? (
                <p className="mt-1 text-caption text-brand">
                  {t('insight.count', { count: advice.length })}
                </p>
              ) : null}
              {/* The type token goes on a span, not on the Button: `text-*` on the
                  button itself collides with its own foreground colour in the class
                  merge, and a filled button with no visible label is the kind of bug
                  that only shows up in a screenshot. */}
              <div className="mt-3 flex gap-2">
                <Button
                  className="h-10 flex-1 rounded-full"
                  onClick={() => insights.open(top.id)}
                >
                  <span className="text-body-sm">{t(top.actionKey)}</span>
                </Button>
                <Button
                  variant="outline"
                  className="h-10 rounded-full"
                  onClick={() => insights.act(top.id)}
                >
                  <span className="text-body-sm">{t('insight.done')}</span>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      ) : null}

      {/*
        Before there is an account — and only when there is a crop for the words to
        be about — what the farmer can expect here, and the way to it. No header row
        above it: the card is already about the crop, and saying so twice was the
        thing this replaced. The sentence is deliberately general — it does not name
        the crop, because the card already does, and the invitation is the same
        whoever is standing in front of it. The action is words, not a button.
      */}
      {showsGuestCopy ? (
        <div>
          <p className="text-body font-medium">{t('insight.signIn.title')}</p>
          <p className="mt-1.5 text-body-sm leading-relaxed text-muted-foreground">
            {t('insight.signIn.body')}
          </p>
          <button
            type="button"
            onClick={() => requestIdentity(() => undefined, 'session.why.advice')}
            className="mt-2 inline-flex py-0.5 text-body-sm font-medium text-brand"
          >
            {t('insight.signIn.action')}
          </button>
        </div>
      ) : null}

      {/*
        The scanner, as a row on this card rather than the block it used to be: the
        same flow, one line, in the company of the crop it is about.
      */}
      <button
        type="button"
        onClick={onScan}
        className={[
          'flex w-full items-center gap-3 text-start',
          showsAdvice || showsGuestCopy ? 'mt-3.5 border-t border-border pt-3.5' : '',
        ].join(' ')}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted">
          <Camera className="size-5 text-brand" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body-sm font-medium">{t('scanCta.title')}</span>
          <span className="mt-0.5 block text-caption text-muted-foreground">
            {t('scanCta.offline')}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-brand rtl:rotate-180" aria-hidden />
      </button>
    </section>
  );
}

/** The bell. Credit answers and crop advice, each pointing at its own object. */
export function NotificationBell() {
  const { t } = useLocale();
  const insights = useInsights();

  return (
    <button
      type="button"
      aria-label={t('home.notifications')}
      onClick={insights.openNotifications}
      className="relative grid size-10 shrink-0 place-items-center rounded-full bg-muted"
    >
      <BellRing className="size-5" aria-hidden />
      {insights.unread > 0 ? (
        <span className="absolute end-2 top-2 size-2 rounded-full bg-red-500 ring-2 ring-card" />
      ) : null}
    </button>
  );
}

export function InsightSheets() {
  const { t, locale } = useLocale();
  const insights = useInsights();
  const credit = useCredit();

  const insight = insights.openInsightId
    ? insightById(insights.data, insights.openInsightId)
    : undefined;
  const crop = insight ? cropById(insights.data, insight.cropId) : undefined;

  return (
    <>
      <Sheet
        open={insight !== undefined}
        onOpenChange={(next) => (next ? null : insights.close())}
      >
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[88dvh] w-full max-w-[430px] overflow-y-auto"
        >
          {insight && crop ? (
            <>
              <SheetHeader>
                <SheetTitle>{t(insight.titleKey)}</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-4 p-4 pt-0">
                <p className="text-body-sm leading-relaxed">{t(insight.bodyKey)}</p>

                <dl className="rounded-md bg-muted p-3.5 text-label">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t('insight.source')}</dt>
                    <dd>{t(insight.sourceKey)}</dd>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t('insight.confidenceLabel')}</dt>
                    <dd className="tabular-nums">
                      {t('insight.confidence', { percent: insight.confidence })}
                    </dd>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t('insight.knowledge')}</dt>
                    <dd className="tabular-nums">{insight.knowledgeVersion}</dd>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t('insight.validUntil')}</dt>
                    <dd>{formatDay(new Date(insight.validUntil), locale)}</dd>
                  </div>
                </dl>

                <Button
                  className="h-12 rounded-full"
                  onClick={() => insights.act(insight.id)}
                >
                  {t(insight.actionKey)}
                </Button>

                {!crop.primary ? (
                  <Button
                    variant="outline"
                    className="h-11 rounded-full"
                    onClick={() => {
                      insights.makePrimary(crop.id);
                      insights.close();
                    }}
                  >
                    {t('insight.makeMain', { crop: t(crop.nameKey) })}
                  </Button>
                ) : null}

                <button
                  type="button"
                  onClick={() => insights.dismiss(insight.id)}
                  className="rounded-full py-2 text-body-sm text-muted-foreground"
                >
                  {t('insight.dismiss')}
                </button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet
        open={insights.notificationsOpen}
        onOpenChange={(next) => (next ? insights.openNotifications() : insights.closeNotifications())}
      >
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[88dvh] w-full max-w-[430px] overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>{t('notification.title')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-2 p-4 pt-0">
            {credit.awaiting.map((request) => (
              <button
                key={request.id}
                type="button"
                onClick={() => {
                  insights.closeNotifications();
                  credit.open(request.id);
                }}
                className="flex items-start gap-3 rounded-md border border-amber-700/30 bg-amber-50 p-3.5 text-start dark:bg-amber-500/15"
              >
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-100"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-amber-900 dark:text-amber-100">
                    {t('notification.credit.title')}
                  </span>
                  <span className="mt-0.5 block text-body-sm text-amber-900/80 dark:text-amber-100/80">
                    {t('notification.credit.body', {
                      product: t(request.productKey),
                      dealer: t(request.dealerKey),
                    })}
                  </span>
                </span>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-amber-700 rtl:rotate-180 dark:text-amber-100" aria-hidden />
              </button>
            ))}

            {insights.notifications.map((entry) => {
              const entryInsight = insightById(insights.data, entry.insightId);
              if (!entryInsight) return null;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => insights.open(entry.insightId)}
                  className="flex items-start gap-3 rounded-md border border-border bg-card p-3.5 text-start"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-label font-medium text-brand">
                    {initialsOf(t(entryInsight.titleKey))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{t(entryInsight.titleKey)}</span>
                    <span className="mt-0.5 block text-caption text-muted-foreground">
                      {t('insight.evidence', {
                        source: t(entryInsight.sourceKey),
                        time: formatRelativeTime(entry.at, Date.now(), t),
                      })}
                    </span>
                  </span>
                  {!entry.read ? (
                    <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-brand" />
                  ) : null}
                </button>
              );
            })}

            {credit.awaiting.length === 0 && insights.notifications.length === 0 ? (
              <p className="py-10 text-center text-body-sm text-muted-foreground">
                {t('notification.empty.body')}
              </p>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
