import {
  BookmarkPlus,
  Check,
  MessageCircle,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sprout,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import {
  AREAS,
  MAX_RADIUS_KM,
  PROFILE_AREA,
  RADIUS_OPTIONS,
  areaNameKey,
  areaPoint,
  closingHour,
  dealerNameKey,
  tagLabel,
  type AreaId,
  type DealerTag,
} from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatDay, formatHour, formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { useSession } from '@/session/SessionProvider';
import { useDealerProducts, useDealerSearch } from '@/services/hooks';
import type { DealerProduct, DealerSummary } from '@/services/types';
import { useVisits } from '@/visits/VisitProvider';

/**
 * Dealer discovery, under the rules the PRD locks: a radius the farmer chooses
 * (up to 100 km), a temporary search area that never touches the profile
 * location, and a list that explains itself — why each shop is here, and what
 * "verified" actually checked.
 *
 * Every number on this screen is now computed from the dealer service. The list,
 * the distances and the stock states used to be written down by hand in a fixture,
 * which made the temporary-area rule untestable and let the screen show a shop
 * 1.8 km away without anything having measured it. The service measures; this
 * screen orders, labels and explains.
 *
 * Two honesty rules are visible in the row itself. A shop the source has not
 * verified does not wear the badge. A shop whose stock list has gone stale says so
 * on the row, because "we last heard from them two days ago" is information a
 * farmer uses, and hiding it makes the availability claim a guess.
 */

type FilterId = 'all' | 'open' | DealerTag;

const FILTERS: ReadonlyArray<{ id: FilterId; labelKey: MessageKey }> = [
  { id: 'all', labelKey: 'dealers.filter.all' },
  { id: 'open', labelKey: 'dealers.filter.openNow' },
  { id: 'cotton', labelKey: 'crop.cotton' },
  { id: 'fertilizer', labelKey: 'dealers.filter.fertilizer' },
  { id: 'pesticide', labelKey: 'dealers.filter.pesticide' },
  { id: 'seed', labelKey: 'dealers.filter.seed' },
];

export function DealersScreen({
  onOpenChat,
  onOpenSearch,
  onOpenLocationSearch,
}: {
  onOpenChat: (dealerKey: string) => void;
  /** Opens the search page — shops and stock, one keyword. */
  onOpenSearch: () => void;
  /** Opens the page where the farmer finds their area by name. */
  onOpenLocationSearch: () => void;
}) {
  const { t, locale } = useLocale();
  const [filter, setFilter] = useState<FilterId>('all');
  /** null means the profile location; anything else is a search that stays temporary. */
  const [areaId, setAreaId] = useState<AreaId | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);

  /*
   * Where the search is about lives above the screen, in the location store, and
   * not in local state. Two reasons, both about the rule: a point the farmer chose
   * has to be the same point the weather, the assistant and the next screen read —
   * and a temporary area must not be something this screen can quietly keep as a
   * local variable that then looks like the farmer's location.
   */
  const location = useLocation();

  const searchedArea = areaId ?? PROFILE_AREA;
  /*
   * The origin a search passes.
   *
   * A temporary area always supplies one. When there is a saved location and no
   * temporary area, none is passed at all and the *server* falls back to the
   * signed-in farmer's saved location — so the two can never disagree. When there
   * is no saved location yet (a guest, or a new account), the point in play is
   * passed explicitly, because a guest searching is allowed and an account without
   * a location still needs a first screen that answers.
   */
  const searchOrigin =
    location.searchOrigin ??
    (location.hasSaved
      ? undefined
      : { lat: location.activePoint.lat, lon: location.activePoint.lon });

  /*
   * The tags go to the service rather than being filtered here: which shop carries
   * fertilizer is the dealer system's answer, not this screen's opinion.
   */
  /* No free text here any more: the list is browsed by radius and tag, and any
     word the farmer types goes to the search page, where it can answer about
     stock as well as about shops. */
  const search = useDealerSearch({
    radiusKm: location.radiusKm,
    origin: searchOrigin,
    tags: filter === 'all' || filter === 'open' ? undefined : [filter],
  });

  /**
   * Choosing a place to look is temporary by construction — it writes to the
   * session's search area and nothing else. Keeping it on the account is a
   * separate act with its own control, below.
   */
  const applyArea = (next: AreaId | null) => {
    setAreaId(next);
    if (next === null) {
      location.clearTemporary();
      return;
    }
    const point = areaPoint(next);
    location.setTemporary({
      label: t(areaNameKey(next)),
      lat: point.lat,
      lon: point.lon,
      source: 'search',
    });
  };

  /**
   * The explicit save.
   *
   * Gated on identity, which is the PRD's rule rather than a convenience: reading
   * is free, and keeping something is the accountable act. The point survives the
   * gate because the pending action *is* the save — a farmer who picks a place,
   * taps Save and is asked to sign in does not have to pick it again.
   */
  const saveLocation = () => {
    const point = location.temporary;
    if (!point) return;

    /*
     * No identity gate. Choosing where you are is not said *to* anyone — see
     * LocationProvider — so it is written to the account when there is one and to
     * the phone when there is not, and neither path needs the farmer to sign up
     * first.
     */
    void (async () => {
      try {
        await location.save({
          label: point.label,
          lat: point.lat,
          lon: point.lon,
          source: point.source,
          radiusKm: location.radiusKm,
        });
        /*
         * The temporary area is released once it is the saved location: keeping
         * it would leave the app reporting "temporary" about the very place it now
         * owns, and the two labels would contradict each other.
         */
        location.clearTemporary();
        setAreaId(null);
        toast.success(t('location.savedToast'));
      } catch (failure) {
        toast.error(
          t('location.saveFailed', {
            reason: failure instanceof Error ? failure.message : '',
          }),
        );
      }
    })();
  };

  const rows =
    filter === 'open'
      ? search.data.filter((dealer) => dealer.openNow === true)
      : search.data;

  const dealer = profileId ? rows.find((entry) => entry.id === profileId) : undefined;
  const dealerName = (entry: DealerSummary) => {
    const key = dealerNameKey(entry.id);
    return key ? t(key) : entry.name;
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title">{t('dealers.title')}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            One control, not two. The map button is gone: a farmer who can name
            their area needs a field to type it in, not a basemap to pan — and
            where they are is a filter on this list, so it is reached from the
            filter rather than from a second button beside it.
          */}
          <SearchSettingsSheet
            radius={location.radiusKm}
            areaId={areaId}
            onChangeRadius={location.setRadiusKm}
            onChangeArea={applyArea}
            onOpenLocationSearch={onOpenLocationSearch}
          />
        </div>
      </header>

      {/*
        The farmer's location, and the only control that may change what the
        account says. A temporary area is labelled as temporary in the same
        breath as the saved place it is *not* replacing, because the forbidden
        behaviour is a search that quietly becomes the profile.
      */}
      <section
        aria-label={t('location.current')}
        className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
      >
        <div className="min-w-0">
          <p className="text-label text-muted-foreground">{t('location.current')}</p>
          <p className="truncate text-body font-medium">
            {location.placeLabel || t('location.none')}
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {location.isTemporary
              ? t('location.temporaryHint', {
                  place: location.placeLabel,
                  saved: location.saved?.label ?? t('location.none'),
                })
            : location.hasSaved
              ? t(location.savedOnDevice ? 'location.savedHintDevice' : 'location.savedHint')
              : t('location.defaultHint')}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {location.isTemporary ? (
            <Button
              size="sm"
              className="h-9 rounded-full"
              disabled={location.saving}
              onClick={saveLocation}
            >
              <BookmarkPlus className="size-4" aria-hidden />
              {location.saving ? t('location.saving') : t('location.save')}
            </Button>
          ) : null}
          {location.isTemporary && location.hasSaved ? (
            <button
              type="button"
              onClick={location.clearTemporary}
              className="rounded-full py-1 text-caption text-muted-foreground"
            >
              {t('location.useSaved')}
            </button>
          ) : null}
        </div>
      </section>

      {/*
        Opens the search page rather than filtering this list in place. Filtering
        here could only ever match a shop's *name*, so a farmer who searched
        "urea" got an empty list and reasonably concluded that nobody stocked it —
        the product half of the question had nowhere to be answered.
      */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="mt-3 flex h-12 w-full items-center gap-2.5 rounded-md bg-muted px-3.5 text-start text-body text-muted-foreground"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        {t('dealers.search')}
      </button>

      <ul className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map(({ id, labelKey }) => {
          const active = id === filter;
          return (
            <li key={id} className="shrink-0">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(id)}
                className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-body-sm font-medium leading-none ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {active ? <Check className="size-3.5" aria-hidden /> : null}
                {t(labelKey)}
              </button>
            </li>
          );
        })}
      </ul>

      {search.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}

      {search.status === 'error' ? (
        <ErrorState
          title={t('dealer.search.settings')}
          body={search.error ?? t('otp.network')}
          onRetry={search.retry}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}

      {search.status === 'ready' ? (
        <>
          <SectionLabel className="mt-3.5">
            {t('dealer.search.count', { count: rows.length, km: location.radiusKm })}
          </SectionLabel>

          {rows.length === 0 ? (
            <EmptyState
              title={t('dealers.empty.title')}
              body={t('dealers.empty.body', {
                km: location.radiusKm,
                place: location.placeLabel || t(areaNameKey(searchedArea)),
              })}
              action={
                location.radiusKm < MAX_RADIUS_KM ? (
                  <Button
                    variant="outline"
                    className="h-11 rounded-full"
                    onClick={() => location.setRadiusKm(MAX_RADIUS_KM)}
                  >
                    {t('dealer.search.max', { km: MAX_RADIUS_KM })}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          <ul className="mt-2 space-y-2.5">
            {rows.map((entry) => {
              const name = dealerName(entry);
              const verified = entry.verifiedAt !== null;
              const hour = closingHour(entry.id);
              return (
                <li
                  key={entry.id}
                  className={`flex items-center gap-3 rounded-lg border border-border bg-card p-3 ${
                    entry.isAcceptingRequests ? '' : 'opacity-60'
                  }`}
                >
                  <span
                    className={`grid size-12 shrink-0 place-items-center rounded-md text-subheading ${
                      verified ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {initialsOf(name)}
                  </span>

                  {/* The row body opens the profile; the chat button stays its own
                      control, so a tap on either does exactly one thing. */}
                  <button
                    type="button"
                    onClick={() => setProfileId(entry.id)}
                    className="min-w-0 flex-1 text-start"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-body font-medium">{name}</span>
                      {verified ? (
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
                        entry.openNow === true && hour !== null
                          ? t('dealers.openTill', { time: formatHour(hour, t) })
                          : entry.openNow === false && hour !== null
                            ? t('dealers.closedOpens', { time: formatHour(hour, t) })
                            : (entry.openingHours ?? null),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>

                    {entry.tags.length > 0 ? (
                      <span className="mt-1.5 inline-flex items-center gap-1 rounded-sm bg-amber-50 px-2 py-1 text-caption text-amber-700 dark:bg-amber-500/20 dark:text-amber-100">
                        <Check className="size-3 shrink-0" aria-hidden />
                        {t('dealers.carries', {
                          tag: tagLabel(entry.tags[0] ?? '')
                            ? t(tagLabel(entry.tags[0] ?? '') as MessageKey)
                            : (entry.tags[0] ?? ''),
                        })}
                      </span>
                    ) : null}

                    {entry.syncState !== 'fresh' ? (
                      <span className="mt-1.5 flex items-center gap-1 text-caption text-amber-700 dark:text-amber-100">
                        <TriangleAlert className="size-3 shrink-0" aria-hidden />
                        {entry.syncedAt !== null
                          ? t(
                              entry.syncState === 'unreachable'
                                ? 'dealer.sync.unreachable'
                                : 'dealer.sync.stale',
                              { age: formatRelativeTime(entry.syncedAt, Date.now(), t) },
                            )
                          : t('dealer.sync.stale', { age: '—' })}
                      </span>
                    ) : null}
                  </button>

                  {entry.isAcceptingRequests ? (
                    <button
                      type="button"
                      onClick={() => onOpenChat(entry.id)}
                      aria-label={t('dealers.chatAria', { name })}
                      className={`grid size-11 shrink-0 place-items-center rounded-full ${
                        entry.isYourDealer ? 'bg-brand text-brand-foreground' : 'bg-muted'
                      }`}
                    >
                      <MessageCircle className="size-5" aria-hidden />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <Sheet open={dealer !== undefined} onOpenChange={(next) => (next ? null : setProfileId(null))}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[88dvh] w-full max-w-[430px] overflow-y-auto"
        >
          {dealer ? (
            <>
              <SheetHeader>
                <SheetTitle>{dealerName(dealer)}</SheetTitle>
              </SheetHeader>
              <DealerProfile
                dealer={dealer}
                onChat={(key) => {
                  setProfileId(null);
                  onOpenChat(key);
                }}
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── search settings: radius and the temporary area ──────────────────────── */

function SearchSettingsSheet({
  radius,
  areaId,
  onChangeRadius,
  onChangeArea,
  onOpenLocationSearch,
}: {
  radius: number;
  areaId: AreaId | null;
  onChangeRadius: (next: number) => void;
  onChangeArea: (next: AreaId | null) => void;
  onOpenLocationSearch: () => void;
}) {
  const { t } = useLocale();
  /* Read from the location store rather than a constant: "my profile location"
     has to name the place the account actually holds, or it names a place the
     farmer never chose. */
  const location = useLocation();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t('dealer.search.settings')}
          className="grid size-10 place-items-center rounded-full bg-muted"
        >
          <SlidersHorizontal className="size-5" aria-hidden />
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t('dealer.search.settings')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 p-4 pt-0">
          {/*
            Where the farmer is, first — it is the filter that changes every
            other number in this sheet, and the one they came here to set.
            Tapping it opens a page to type the name of the place; the place
            they tap there is saved straight away and this sheet is gone by the
            time they are back, because the whole screen returns with the list.
          */}
          <section>
            <SectionLabel>{t('location.current')}</SectionLabel>
            {/*
              The label names the action and the row shows the current value —
              a button whose only name was the place already set would read as a
              statement rather than as something that opens a search.
            */}
            <button
              type="button"
              aria-label={t('location.title')}
              onClick={onOpenLocationSearch}
              className="mt-2 flex h-11 w-full items-center gap-2.5 rounded-md bg-muted px-3.5 text-start text-body"
            >
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{location.placeLabel || t('location.none')}</span>
            </button>
            <p className="mt-2 text-caption text-muted-foreground">
              {t('location.searchBarHint')}
            </p>
          </section>

          <section>
            <SectionLabel>{t('dealer.search.radius')}</SectionLabel>
            <ul className="mt-2 flex flex-wrap gap-2">
              {RADIUS_OPTIONS.map((km) => {
                const active = km === radius;
                return (
                  <li key={km}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => onChangeRadius(km)}
                      className={`rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
                        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {t('dealer.search.radiusValue', { km })}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-caption text-muted-foreground">
              {t('dealer.search.max', { km: MAX_RADIUS_KM })}
            </p>
          </section>

          <section>
            <SectionLabel>{t('dealer.search.area')}</SectionLabel>
            <ul className="mt-2 space-y-1.5">
              <li>
                <button
                  type="button"
                  aria-pressed={areaId === null}
                  onClick={() => onChangeArea(null)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-start text-body ${
                    areaId === null ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Sprout className="size-4 shrink-0" aria-hidden />
                  {t('dealer.search.profile')}
                  {location.saved ? ` · ${location.saved.label}` : ` · ${t('location.none')}`}
                </button>
              </li>
              {AREAS.map((entry) => {
                const active = areaId === entry.id;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => onChangeArea(entry.id)}
                      className={`w-full rounded-md px-3 py-2.5 text-start text-body ${
                        active ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {t(entry.nameKey)}
                    </button>
                  </li>
                );
              })}
            </ul>
            {areaId ? (
              <p className="mt-2 text-body-sm text-muted-foreground">
                {t('dealer.search.temp', {
                  place: location.saved?.label ?? t('location.none'),
                })}
              </p>
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── the dealer profile, including the field-visit request ───────────────── */

function DealerProfile({
  dealer,
  onChat,
}: {
  dealer: DealerSummary;
  onChat: (dealerKey: string) => void;
}) {
  const { t, locale } = useLocale();
  const visits = useVisits();
  const { requestIdentity } = useSession();
  const products = useDealerProducts(dealer.id);

  const nameKey = dealerNameKey(dealer.id);
  const name = nameKey ? t(nameKey) : dealer.name;
  const verified = dealer.verifiedAt !== null;

  /* Only reasons the data supports are shown. A "nearest" line on a shop that is
     not the nearest would be decoration, and decoration is what the trust rules
     forbid. */
  const reasons: MessageKey[] = [];
  if (verified) reasons.push('dealer.reason.verified');
  if (dealer.tags.length > 0) reasons.push('dealer.reason.stock');
  if (dealer.isYourDealer) reasons.push('dealer.reason.relationship');
  if (dealer.distanceKm <= 2) reasons.push('dealer.reason.distance');

  const visit = visits.forDealer(dealer.id);
  /*
   * Whether the button comes back is the whole difference between a refusal and a
   * dead end. The store treats a refusal as final but re-askable — asking again
   * is a *new* request, not an edit of the old one — so the control has to come
   * back with it. Reading the latest request regardless of status and hiding the
   * button whenever one existed made a refusal permanent: the farmer saw "you can
   * ask again later" and had no way to act on it, and no later was ever offered.
   *
   * So the button is offered unless there is still something to wait for. An
   * accepted visit needs no second request; a refusal is over and may be
   * repeated.
   */
  const canAsk = visit === undefined || visit.status === 'rejected';

  const askForVisit = () =>
    requestIdentity(() => {
      const result = visits.requestVisit(dealer.id);
      if (!result.ok) toast.error(t(result.error));
      else toast.success(t('visit.request.sent'));
    }, 'session.why.visit');

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-muted-foreground">
        {verified ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-brand">
              <ShieldCheck className="size-3" aria-hidden />
              {t('dealers.verified')}
            </span>
            <span>
              {t('dealer.profile.verifiedOn', {
                date: formatDay(new Date(dealer.verifiedAt ?? Date.now()), locale),
              })}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {t('dealer.profile.unverified')}
          </span>
        )}
        <span>·</span>
        <span>{t('common.km', { km: formatNumber(dealer.distanceKm, locale) })}</span>
        {dealer.openNow === true && closingHour(dealer.id) !== null ? (
          <>
            <span>·</span>
            <span>{t('dealers.openTill', { time: formatHour(closingHour(dealer.id) as number, t) })}</span>
          </>
        ) : null}
        {dealer.openNow === false && closingHour(dealer.id) !== null ? (
          <>
            <span>·</span>
            <span>
              {t('dealers.closedOpens', { time: formatHour(closingHour(dealer.id) as number, t) })}
            </span>
          </>
        ) : null}
      </div>

      <p className="rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
        {t('dealer.profile.checked')}
      </p>

      <section>
        <SectionLabel>{t('dealer.profile.reasons')}</SectionLabel>
        <ul className="mt-2 flex flex-wrap gap-2">
          {reasons.map((key) => (
            <li
              key={key}
              className="rounded-full bg-brand-soft px-2.5 py-1.5 text-caption font-medium text-brand"
            >
              {t(key)}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-caption text-muted-foreground">{t('dealer.profile.rankNote')}</p>
      </section>

      {/*
        What the shop actually has, from the dealer system. The three availability
        states are kept apart on purpose: `0` means confirmed none, `null` means the
        shop never said, and a farmer deciding whether to walk there needs to know
        which of those they are looking at.
      */}
      <section>
        <SectionLabel>{t('dealer.products.title')}</SectionLabel>
        {products.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}
        {products.status === 'ready' && products.data.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('dealer.products.none')}</p>
        ) : null}
        <ul className="mt-2 space-y-2">
          {products.data.map((product: DealerProduct) => (
            <li
              key={product.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3"
            >
              <span className="min-w-0">
                <span className="block truncate text-body font-medium">{product.name}</span>
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                  {product.brand ? `${product.brand} · ` : ''}
                  {product.packSize ?? ''}
                </span>
                <span
                  className={`mt-1 block text-caption ${
                    product.inStock === false
                      ? 'text-amber-700 dark:text-amber-100'
                      : 'text-muted-foreground'
                  }`}
                >
                  {product.inStock === true && product.availableQty !== null
                    ? t('dealer.products.inStock', { qty: product.availableQty })
                    : product.inStock === false
                      ? t('dealer.products.outOfStock')
                      : t('dealer.products.unknownQty')}
                </span>
              </span>
              {product.unitPrice !== null ? (
                <span className="shrink-0 text-label tabular-nums">
                  {formatMoney(product.unitPrice, locale, t)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {products.sourced ? (
          <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
            {products.sourced.status === 'failing' ? (
              <TriangleAlert className="size-3.5 shrink-0 text-amber-700" aria-hidden />
            ) : null}
            {products.sourced.status === 'failing'
              ? (products.sourced.error ?? t('dealer.sync.unreachable', { age: '—' }))
              : t('dealer.products.updated', {
                  age: formatRelativeTime(products.sourced.observedAt, Date.now(), t),
                })}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-card p-3.5">
        <p className="text-body font-medium">{t('dealer.profile.visit')}</p>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('dealer.profile.visitNote')}</p>

        {visit ? (
          <div className="mt-2.5">
            <p className="flex items-center gap-2 text-label">
              {visit.status === 'pending' ? (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-100">
                  {t('visit.status.pending')}
                </span>
              ) : visit.status === 'accepted' ? (
                <span className="rounded-full bg-brand-soft px-2.5 py-1 font-medium text-brand">
                  {t('visit.status.accepted')}
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
                  {t('visit.status.rejected')}
                </span>
              )}
            </p>
            {visit.status === 'accepted' ? (
              <p className="mt-1.5 text-body-sm text-muted-foreground">{t('visit.accepted.body')}</p>
            ) : null}
            {visit.status === 'rejected' ? (
              <p className="mt-1.5 text-body-sm text-muted-foreground">{t('visit.rejected.body')}</p>
            ) : null}
            {canAsk ? (
              <Button
                variant="outline"
                className="mt-2.5 h-11 w-full rounded-full"
                onClick={askForVisit}
              >
                {t('dealer.profile.visit')}
              </Button>
            ) : null}
          </div>
        ) : (
          <Button className="mt-2.5 h-11 w-full rounded-full" onClick={askForVisit}>
            {t('dealer.profile.visit')}
          </Button>
        )}

        {visit?.status === 'pending' ? (
          <div className="mt-3 rounded-md border border-dashed border-ink-300 p-2.5">
            <p className="text-caption text-muted-foreground">{t('visit.demo.title')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-full"
                onClick={() => visits.simulate.decide(visit.id, 'accepted')}
              >
                <span className="text-body-sm">{t('visit.demo.accept')}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-full"
                onClick={() => visits.simulate.decide(visit.id, 'rejected')}
              >
                <span className="text-body-sm">{t('visit.demo.reject')}</span>
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <Button
        variant="outline"
        className="h-11 w-full rounded-full"
        onClick={() => onChat(dealer.id)}
      >
        <MessageCircle className="size-4" aria-hidden />
        {t('dealers.chatAria', { name })}
      </Button>
    </div>
  );
}
