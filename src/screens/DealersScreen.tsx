import {
  BookmarkPlus,
  Check,
  Map,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import {
  MAX_RADIUS_KM,
  PROFILE_AREA,
  RADIUS_OPTIONS,
  areaNameKey,
  closingHour,
  dealerNameKey,
  tagLabel,
  type DealerTag,
} from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatHour, formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { useDealerSearch, useProductSearch } from '@/services/hooks';
import { useShopApi } from '@/shop/ShopApiProvider';
import { distanceKmBetween } from '@/shop/geo';
import { ShopConnectSheet } from '@/shop/ShopRequestSheet';
import type { DealerSummary } from '@/services/types';

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
  onOpenShopChat,
  onOpenSearch,
  onOpenLocationSearch,
  onOpenDealer,
  onOpenProduct,
  section,
  onSectionChange,
}: {
  onOpenChat: (dealerKey: string) => void;
  /** Opens the conversation with one shop on the dealer's own platform. */
  onOpenShopChat: (shopId: string) => void;
  /** Opens the search page — shops and stock, one keyword. */
  onOpenSearch: () => void;
  /** Opens the page where the farmer finds their area by name. */
  onOpenLocationSearch: () => void;
  /** Opens a shop's own page. */
  onOpenDealer: (dealerId: string) => void;
  /** Opens one product's page, from the listing the farmer tapped. */
  onOpenProduct: (target: { canonicalProductId: string; dealerId: string }) => void;
  /** Which half of the shop is showing, when the app keeps it. */
  section?: 'products' | 'dealers';
  onSectionChange?: (next: 'products' | 'dealers') => void;
}) {
  const { t, locale } = useLocale();
  const [filter, setFilter] = useState<FilterId>('all');
  /**
   * Two answers in one shop: the shelf (products) and the shops (dealers).
   *
   * The app can own this instead of the screen. A product page is a pushed screen,
   * so this list is unmounted while the product is open — and coming back from a
   * product opened in the shelf used to land the farmer on the dealer list, because
   * the section had reset to its default while they were away.
   */
  const [ownSection, setOwnSection] = useState<'products' | 'dealers'>('dealers');
  /*
   * Adding a dealer by code is still here, beside the heading, but it is no longer
   * the way in: the list above is discovered by the farmer's area and radius, and
   * a shop code is what someone uses when they already know which counter they
   * want. Two ways to reach a shop, one of which requires nothing.
   */
  const [connectOpen, setConnectOpen] = useState(false);
  const shopSection = section ?? ownSection;
  const setShopSection = onSectionChange ?? setOwnSection;

  /*
   * Where the search is about lives above the screen, in the location store, and
   * not in local state. Two reasons, both about the rule: a point the farmer chose
   * has to be the same point the weather, the assistant and the next screen read —
   * and a temporary area must not be something this screen can quietly keep as a
   * local variable that then looks like the farmer's location.
   */
  const location = useLocation();
  /* The dealer's own platform, which is where a shop actually exists. */
  const shopApi = useShopApi();
  /* The shop being opened, so its row can say so while the platform answers. */
  const [shopBusy, setShopBusy] = useState<string | null>(null);

  /*
   * The dealer platform's shops, each with how far it is from the farmer.
   *
   * The coordinates come from the shop's own record, so this list works from the
   * shop's position rather than from a product listing: a counter two kilometres
   * away is at the top even when it has published nothing for sale.
   */
  const shopRows = useMemo(() => {
    const origin = location.activePoint;
    return shopApi.shops
      .map((shop) => ({
        ...shop,
        km:
          shop.latitude !== null && shop.longitude !== null
            ? Number(
                distanceKmBetween(origin, { lat: shop.latitude, lon: shop.longitude }).toFixed(1),
              )
            : null,
      }))
      .sort((a, b) => (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY));
  }, [shopApi.shops, location.activePoint]);

  /*
   * The chosen radius governs the whole screen, including the shops the dealer
   * platform lists. Those rows used to be shown above the radius result no matter
   * where they were — a shop 400 km away sat directly over "nothing within 25 km".
   * Inside the radius they are results; outside it they are suggestions, named as
   * such.
   */
  const shopsInRange = shopRows.filter((shop) => shop.km !== null && shop.km <= location.radiusKm);
  const shopsBeyondRange = shopRows.filter(
    (shop) => shop.km === null || shop.km > location.radiusKm,
  );

  const openShop = async (shopId: string) => {
    setShopBusy(shopId);
    try {
      await shopApi.openShopConversation(shopId);
      onOpenShopChat(shopId);
    } finally {
      setShopBusy(null);
    }
  };

  /** One dealer-platform shop. Rendered in the results or in the suggestions. */
  const shopRow = (shop: (typeof shopRows)[number]) => (
    <li key={shop.shopId}>
      {/*
        The whole row opens the conversation with *that* shop, and the opening is a
        call to the dealer's platform rather than a jump into this phone's own chat
        store — otherwise a shop the farmer just found would receive nothing they
        typed.
      */}
      <button
        type="button"
        disabled={shopBusy !== null}
        onClick={() => void openShop(shop.shopId)}
        aria-label={t('dealers.network.open')}
        className="flex w-full items-center gap-3 rounded-xl bg-card p-3.5 text-start disabled:opacity-60"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium">{shop.name}</p>
          <p className="mt-0.5 truncate text-caption text-muted-foreground">
            {shopBusy === shop.shopId
              ? t('chat.loading')
              : [
                  shop.km !== null ? t('common.km', { km: shop.km }) : null,
                  shop.isLinked
                    ? t('dealers.network.connected')
                    : (shop.locationLabel ?? shop.city ?? t('dealers.network.listed')),
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
          <MessageCircle className="size-4" aria-hidden />
        </span>
      </button>
    </li>
  );

  const searchedArea = PROFILE_AREA;
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
  /*
   * The point in play, always. The shop backend can resolve an account's saved
   * location by itself, but the marketplace cannot — it measures distance from the
   * coordinates it is given — so the app states where the farmer is rather than
   * leaving a provider to guess. Both are the same point; only one is explicit.
   */
  const searchOrigin = location.dealerOrigin ?? location.activePoint;

  /*
   * The tags go to the service rather than being filtered here: which shop carries
   * fertilizer is the dealer system's answer, not this screen's opinion.
   */
  /* No free text here any more: the list is browsed by radius and tag, and any
     word the farmer types goes to the search page, where it can answer about
     stock as well as about shops. */
  /* Nothing is asked before the saved location has answered: a request fired at
     the default point and replaced a moment later is the flicker this whole
     lifecycle exists to remove. */
  const locationReady = location.status !== 'restoring';

  const search = useDealerSearch(
    {
      radiusKm: location.radiusKm,
      origin: searchOrigin,
      tags: filter === 'all' || filter === 'open' ? undefined : [filter],
    },
    locationReady,
  );

  /*
   * The product half of the shop. No keyword: this tab is the shelf itself —
   * every listing the shops near the farmer have actually sent, with that
   * shop's own price and stock. A keyword belongs on the search page, one tap
   * away, which answers about shops and stock together.
   */
  const products = useProductSearch(
    {
      radiusKm: location.radiusKm,
      origin: searchOrigin,
      query: '',
    },
    locationReady,
  );

  const rows =
    filter === 'open'
      ? search.data.filter((dealer) => dealer.openNow === true)
      : search.data;

  /*
   * The nearest shops when the chosen radius has none.
   *
   * The default radius is small and most places have no dealer inside it, so the
   * honest answer to "within 10 km" used to be an empty screen — which a farmer
   * reads as "this app is broken", not as "widen the search". The wider query only
   * runs when the chosen one came back empty, and its rows are labelled with the
   * radius that produced them, so the screen never says "within 10 km" above a shop
   * 70 km away.
   */
  const wider = useDealerSearch(
    { radiusKm: MAX_RADIUS_KM, origin: searchOrigin, tags: filter === 'all' || filter === 'open' ? undefined : [filter] },
    locationReady && search.status === 'ready' && rows.length === 0 && location.radiusKm < MAX_RADIUS_KM,
  );
  const widerRows =
    filter === 'open' ? wider.data.filter((dealer) => dealer.openNow === true) : wider.data;
  const showsWider = rows.length === 0 && widerRows.length > 0;
  const listRows = showsWider ? widerRows : rows;
  const listKm = showsWider ? MAX_RADIUS_KM : location.radiusKm;

  /*
   * A provider that reported its own failure is not an empty area. The list says
   * "could not be loaded" and offers a retry, because "no dealer is within 43 km"
   * is a statement about the farmer's town and this is a statement about a call.
   */
  const searchFailed = search.status === 'ready' && search.sourced?.status === 'failing';
  const productsFailed = products.status === 'ready' && products.sourced?.status === 'failing';

  const dealerName = (entry: DealerSummary) => {
    const key = dealerNameKey(entry.id);
    return key ? t(key) : entry.name;
  };

  /** The same naming rule for a row that only carries a dealer id. */
  const dealerLabel = (id: string, fallback: string) => {
    const key = dealerNameKey(id);
    return key ? t(key) : fallback;
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title">{t('dealers.title')}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            The manual way in, exactly where a farmer looks for "add": on the
            heading's trailing edge. It opens the same sheet as before, so a shop
            code the farmer was given still works — the difference is that it is no
            longer the only door.
          */}
          <button
            type="button"
            aria-label={t('shop.connect.title')}
            onClick={() => setConnectOpen(true)}
            className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand"
          >
            <Plus className="size-5" aria-hidden />
          </button>
          <SearchSettingsSheet
            radius={location.radiusKm}
            onChangeRadius={location.setRadiusKm}
            onOpenLocationSearch={onOpenLocationSearch}
          />
        </div>
      </header>

      {/*
        The location card that used to sit here is gone. It repeated, above every
        list, a place the farmer had just chosen, and it pushed the two things the
        screen is for — the shelf and the shops — below the fold on a phone. The
        same facts live in the sheet this header opens, where the area is actually
        changed; nothing was removed from what the app can do.
      */}
      {/*
        The shop's two halves, directly under the place they are measured from.
        The shelf is what a farmer came to price; the list is where they walk to.
        Both keep the same radius and area, so switching cannot quietly change
        the ground either one covers.
      */}
      <div
        role="tablist"
        aria-label={t('shop.tabsAria')}
        className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-muted p-1"
      >
        {(['products', 'dealers'] as const).map((id) => {
          const active = shopSection === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setShopSection(id)}
              className={`h-10 rounded-full text-body-sm font-medium leading-none ${
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              {id === 'products' ? t('shop.tabProducts') : t('shop.tabDealers')}
            </button>
          );
        })}
      </div>

      {shopSection === 'dealers' ? (
        <>
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

      {/*
        The shops the dealer platform itself lists, above the radius result.

        The list below is built from *listings*, so a shop that has joined the
        dealer app but has published no product is invisible there even though it
        exists and can be messaged. Those shops are exactly what `farmer_api_shops`
        answers, and showing them here is the difference between "no shop exists"
        and "no shop has priced anything yet".
      */}
      {shopsInRange.length > 0 || shopsBeyondRange.length > 0 ? (
        <section className="mt-4" aria-label={t('dealers.network')}>
          {shopsInRange.length > 0 ? (
            <>
              <SectionLabel>{t('dealers.network')}</SectionLabel>
              <ul className="mt-2 space-y-2">{shopsInRange.map(shopRow)}</ul>
            </>
          ) : null}

          {shopsBeyondRange.length > 0 ? (
            <>
              <SectionLabel className="mt-4">
                {t('dealers.network.outside', { km: location.radiusKm })}
              </SectionLabel>
              <ul className="mt-2 space-y-2">{shopsBeyondRange.map(shopRow)}</ul>
            </>
          ) : null}
        </section>
      ) : null}

      {search.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}

      {search.status === 'error' ? (
        <ErrorState
          title={t('dealer.search.settings')}
          body={search.error ?? t('otp.network')}
          onRetry={search.retry}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}

      {searchFailed ? (
        <ErrorState
          title={t('dealer.search.settings')}
          body={search.sourced?.error ?? t('otp.network')}
          onRetry={search.retry}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}

      {search.status === 'ready' && !searchFailed ? (
        <>
          {showsWider ? (
            <p className="mt-3 text-label text-muted-foreground">
              {t('dealers.empty.body', {
                km: location.radiusKm,
                place: location.placeLabel || t(areaNameKey(searchedArea)),
              })}
            </p>
          ) : null}

          <SectionLabel className="mt-3.5">
            {t('dealer.search.count', { count: listRows.length, km: listKm })}
          </SectionLabel>

          {listRows.length === 0 ? (
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
            {listRows.map((entry) => {
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
                    onClick={() => onOpenDealer(entry.id)}
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
        </>
      ) : null}

      {shopSection === 'products' ? (
        <>
          {products.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}

          {products.status === 'error' ? (
            <ErrorState
              title={t('shop.tabProducts')}
              body={products.error ?? t('otp.network')}
              onRetry={products.retry}
              retryLabel={t('common.tryAgain')}
            />
          ) : null}

          {productsFailed ? (
            <ErrorState
              title={t('shop.tabProducts')}
              body={products.sourced?.error ?? t('otp.network')}
              onRetry={products.retry}
              retryLabel={t('common.tryAgain')}
            />
          ) : null}

          {products.status === 'ready' && !productsFailed ? (
            <>
              <SectionLabel className="mt-3.5">
                {t('shop.products.count', {
                  count: products.data.length,
                  km: location.radiusKm,
                })}
              </SectionLabel>

              {products.data.length === 0 ? (
                <EmptyState
                  title={t('shop.products.emptyTitle')}
                  body={t('shop.products.emptyBody', { km: location.radiusKm })}
                />
              ) : null}

              <ul className="mt-2 space-y-2.5">
                {products.data.map((hit) => {
                  const name = dealerLabel(hit.dealerId, hit.dealerName);
                  return (
                    <li
                      key={`${hit.dealerId}-${hit.product.id}`}
                      className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">
                          <button type="button" disabled={hit.product.canonicalProductId === null} onClick={() => onOpenProduct({ canonicalProductId: hit.product.canonicalProductId as string, dealerId: hit.dealerId })} className="block max-w-full truncate text-start">{hit.product.name}</button>
                        </span>
                        <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                          {hit.product.brand ? `${hit.product.brand} · ` : ''}
                          {hit.product.packSize ?? ''}
                        </span>
                        <span
                          className={`mt-1 block text-caption ${
                            hit.product.inStock === false
                              ? 'text-amber-700 dark:text-amber-100'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {hit.product.inStock === true && hit.product.availableQty !== null
                            ? t('dealer.products.inStock', { qty: hit.product.availableQty })
                            : hit.product.inStock === false
                              ? t('dealer.products.outOfStock')
                              : t('dealer.products.unknownQty')}
                        </span>
                        <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                          {t('search.product.shop', {
                            shop: name,
                            km: t('common.km', {
                              km: formatNumber(hit.distanceKm, locale),
                            }),
                          })}
                        </span>
                      </span>

                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        {hit.product.unitPrice !== null ? (
                          <span className="text-label tabular-nums">
                            {formatMoney(hit.product.unitPrice, locale, t)}
                          </span>
                        ) : (
                          <span className="text-caption text-muted-foreground">
                            {t('scan.product.askPrice')}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenChat(hit.dealerId)}
                          aria-label={t('dealers.chatAria', { name })}
                          className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"
                        >
                          <MessageCircle className="size-4" aria-hidden />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>

              {products.sourced?.sourceLabel ? (
                <p className="mt-2 text-caption text-muted-foreground">
                  {products.sourced.sourceLabel}
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {/* The manual door, opened from the + beside the heading. */}
      {connectOpen ? <ShopConnectSheet onClose={() => setConnectOpen(false)} /> : null}
    </div>
  );
}

/* ── search settings: the place, and how far to look ─────────────────────── */

function SearchSettingsSheet({
  radius,
  onChangeRadius,
  onOpenLocationSearch,
}: {
  radius: number;
  onChangeRadius: (next: number) => void;
  onOpenLocationSearch: () => void;
}) {
  const { t } = useLocale();
  const location = useLocation();

  /**
   * The explicit save, moved here with the card it used to live in.
   *
   * No identity gate: choosing where you are is not said *to* anyone — see
   * LocationProvider — so it is written to the account when there is one and to
   * the phone when there is not, and neither path needs the farmer to sign up
   * first. The temporary area is released once it is the saved location, because
   * keeping it would leave the app reporting "temporary" about the very place it
   * now owns.
   */
  const saveLocation = () => {
    const point = location.temporary;
    if (!point) return;

    void (async () => {
      try {
        await location.save({
          label: point.label,
          lat: point.lat,
          lon: point.lon,
          source: point.source,
          radiusKm: location.radiusKm,
        });
        location.clearTemporary();
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

  /*
   * Two facts, in the order a farmer thinks about them: where the app is reading
   * from, then the circle drawn around it.
   *
   * The four hard-coded towns that used to be listed here looked like a choice
   * but were not one: they could only ever be the same four places, while the
   * search page can find any village in the country. So the row states the place
   * and "Change" opens the page that can actually change it — one destination,
   * not a second list that competes with it.
   */
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t('dealer.search.settings')}
          className="grid size-10 place-items-center rounded-full bg-muted"
        >
          {/* The farm-map glyph, with the verified badge from the same art: the
              two facts this sheet owns are the area and the shops confirmed in
              it. Composed from two icons rather than shipped as an image, so it
              inherits the theme's colour in both themes. */}
          <span className="relative grid size-5 place-items-center">
            <Map className="size-5" aria-hidden />
            <ShieldCheck
              className="absolute -bottom-1 -end-1 size-3.5 rounded-full bg-muted"
              aria-hidden
            />
          </span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t('dealer.search.settings')}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-5 p-4 pt-0">
          <section>
            <p className="text-label text-muted-foreground">{t('location.current')}</p>
            <div className="mt-1 flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 truncate text-body font-medium">
                {location.placeLabel || t('location.none')}
              </p>
              <button
                type="button"
                onClick={onOpenLocationSearch}
                className="shrink-0 rounded-full py-0.5 text-label font-medium text-brand motion-safe:transition-transform motion-safe:active:scale-95"
              >
                {t('location.changePlace')}
              </button>
            </div>

            {/*
              The sentence the shop header used to carry, kept where the place is
              changed. It is the app being honest about whose the place is: a guest's
              is on the phone, a signed-in farmer's is on the account, and a search
              in a temporary area is not either of those until it is saved.
            */}
            <p className="mt-1.5 text-caption text-muted-foreground">
              {location.isTemporary
                ? t('location.temporaryHint', {
                    place: location.placeLabel,
                    saved: location.saved?.label ?? t('location.none'),
                  })
                : location.hasSaved
                  ? t(location.savedOnDevice ? 'location.savedHintDevice' : 'location.savedHint')
                  : t('location.defaultHint')}
            </p>

            {location.isTemporary ? (
              <div className="mt-2 flex items-center gap-3">
                <Button
                  size="sm"
                  className="h-9 rounded-full"
                  disabled={location.saving}
                  onClick={saveLocation}
                >
                  <BookmarkPlus className="size-4" aria-hidden />
                  {location.saving ? t('location.saving') : t('location.save')}
                </Button>
                {location.hasSaved ? (
                  <button
                    type="button"
                    onClick={location.clearTemporary}
                    className="rounded-full py-1 text-caption text-muted-foreground"
                  >
                    {t('location.useSaved')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section>
            <p className="text-label text-muted-foreground">{t('dealer.search.currentRadius')}</p>
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
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {t('dealer.search.radiusValue', { km })}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

