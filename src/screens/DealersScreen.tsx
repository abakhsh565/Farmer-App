import {
  BookmarkPlus,
  Check,
  Map as MapIcon,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
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
  dealerNameKey,
  tagLabel,
  type DealerTag,
} from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatMoney, formatNumber } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { useDealerSearch, useProductSearch } from '@/services/hooks';
import { useShopApi } from '@/shop/ShopApiProvider';
import { distanceKmBetween } from '@/shop/geo';
import { ShopConnectSheet } from '@/shop/ShopRequestSheet';

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

/**
 * One shop, whichever source described it.
 *
 * The screen has two answers about the same shops: the dealer platform's list
 * (a name, a number, a pin, whether this farmer is linked) and the marketplace's
 * discovery read (verification, tags, opening hours, distance). Rendering them as
 * two lists printed the same shop twice with different facts. This is the merge:
 * one row per shop id, each field taken from whichever source actually has it.
 */
type ShopRow = {
  id: string;
  name: string;
  km: number | null;
  phone: string | null;
  logoUrl: string | null;
  isLinked: boolean;
  verifiedAt: number | null;
  openNow: boolean | null;
  place: string | null;
  tags: string[];
  acceptsRequests: boolean;
};

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

  const openShop = async (shopId: string) => {
    setShopBusy(shopId);
    try {
      await shopApi.openShopConversation(shopId);
      onOpenShopChat(shopId);
    } finally {
      setShopBusy(null);
    }
  };

  /**
   * One shop, once.
   *
   * The same row design on both tabs and in both lists: the shop's own mark (or
   * its initials where it has none), its name, the number the counter is reached
   * on, how far it is and what it carries. The row opens the shop's page; the round
   * button beside it opens the conversation. Two separate lists used to print the
   * same shop twice, each with half of these facts.
   */
  const shopRow = (shop: ShopRow) => (
    <li key={shop.id}>
      <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3">
        {shop.logoUrl ? (
          <img
            src={shop.logoUrl}
            alt=""
            className="size-12 shrink-0 rounded-xl object-cover"
          />
        ) : (
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand-soft text-subheading text-brand">
            {initialsOf(shop.name)}
          </span>
        )}

        <button
          type="button"
          onClick={() => onOpenDealer(shop.id)}
          className="min-w-0 flex-1 text-start"
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-body font-medium">{shop.name}</span>
            {shop.verifiedAt !== null ? (
              <ShieldCheck className="size-3.5 shrink-0 text-brand" aria-hidden />
            ) : null}
          </span>

          {shop.phone ? (
            <span
              dir="ltr"
              className="mt-0.5 block truncate text-caption tabular-nums text-muted-foreground"
            >
              {shop.phone}
            </span>
          ) : null}

          <span className="mt-0.5 block truncate text-caption text-muted-foreground">
            {shopBusy === shop.id
              ? t('chat.loading')
              : [
                  shop.km !== null ? t('common.km', { km: shop.km }) : null,
                  shop.isLinked
                    ? t('dealers.network.connected')
                    : (shop.place ?? t('dealers.network.listed')),
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </span>

          {shop.tags.length > 0 ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-sm bg-amber-50 px-2 py-1 text-caption text-amber-700 dark:bg-amber-500/20 dark:text-amber-100">
              <Check className="size-3 shrink-0" aria-hidden />
              {t('dealers.carries', {
                tag: tagLabel(shop.tags[0] ?? '')
                  ? t(tagLabel(shop.tags[0] ?? '') as MessageKey)
                  : (shop.tags[0] ?? ''),
              })}
            </span>
          ) : null}
        </button>

        {shop.acceptsRequests ? (
          <button
            type="button"
            disabled={shopBusy !== null}
            onClick={() => void openShop(shop.id)}
            aria-label={t('dealers.chatAria', { name: shop.name })}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-muted disabled:opacity-60"
          >
            <MessageCircle className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>
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
      /*
       * One read covers both halves of the screen.
       *
       * The list used to ask once for the chosen radius and again for the wider
       * "nearest outside it" answer, which doubled every poll and could print the
       * two from different moments. The server already reports each shop's own
       * distance, so a single read at the maximum reach answers both questions at
       * once — and the in-radius filter below uses that distance, not a guess.
       */
      radiusKm: MAX_RADIUS_KM,
      origin: searchOrigin,
      tags: filter === 'all' || filter === 'open' ? undefined : [filter],
    },
    locationReady,
  );

  /**
   * Every shop the screen can name, merged from both sources by shop id.
   *
   * The dealer platform is authoritative for identity and contact details (name,
   * number, logo, pin, whether this farmer is linked); the marketplace is
   * authoritative for what the shop published (verification, tags, opening hours,
   * whether it takes requests). A shop that exists only in one source stays in the
   * list — that is the difference between "no shop exists" and "no shop has priced
   * anything yet" — but no shop is ever printed twice.
   */
  const shops = useMemo<ShopRow[]>(() => {
    const origin = location.activePoint;
    const merged = new Map<string, ShopRow>();

    for (const shop of shopApi.shops) {
      merged.set(shop.shopId, {
        id: shop.shopId,
        name: shop.name,
        km:
          shop.latitude !== null && shop.longitude !== null
            ? Number(
                distanceKmBetween(origin, { lat: shop.latitude, lon: shop.longitude }).toFixed(1),
              )
            : null,
        phone: shop.phone,
        logoUrl: shop.logoUrl,
        isLinked: shop.isLinked,
        verifiedAt: null,
        openNow: null,
        place: shop.locationLabel ?? shop.city,
        tags: [],
        acceptsRequests: true,
      });
    }

    for (const entry of search.data) {
      const existing = merged.get(entry.id);
      const key = dealerNameKey(entry.id);
      merged.set(entry.id, {
        id: entry.id,
        name: existing?.name || (key ? t(key) : entry.name),
        km: existing?.km ?? entry.distanceKm,
        phone: existing?.phone ?? entry.phone ?? null,
        logoUrl: existing?.logoUrl ?? null,
        isLinked: existing?.isLinked ?? entry.isYourDealer ?? false,
        verifiedAt: entry.verifiedAt,
        openNow: entry.openNow ?? null,
        place: existing?.place ?? entry.address ?? null,
        tags: [...entry.tags],
        acceptsRequests: entry.isAcceptingRequests,
      });
    }

    return [...merged.values()].sort(
      (a, b) => (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY),
    );
  }, [shopApi.shops, search.data, location.activePoint, t]);

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
    /* Only the visible half of the screen spends a request per second. */
    locationReady && shopSection === 'products',
  );

  /*
   * The chosen filter, applied once to the merged list. A shop known only to the
   * platform has published no tags, so it cannot claim to stock a category; it is
   * left out of a category filter rather than shown without evidence.
   */
  const filteredShops = shops.filter((shop) => {
    if (filter === 'open') return shop.openNow === true;
    if (filter === 'all') return true;
    return shop.tags.includes(filter);
  });

  /* Inside the radius the farmer chose — the only rows that may be called results. */
  const rows = filteredShops.filter(
    (shop) => shop.km !== null && shop.km <= location.radiusKm,
  );

  /*
   * The nearest shops when the chosen radius has none.
   *
   * The default radius is small and most places have no dealer inside it, so the
   * honest answer to "within 10 km" used to be an empty screen — which a farmer
   * reads as "this app is broken", not as "widen the search". These rows come from
   * the same merged list as the results and are labelled with the reach that
   * produced them, so the screen never says "within 10 km" above a shop 70 km away.
   */
  const widerRows = filteredShops.filter(
    (shop) => shop.km !== null && shop.km > location.radiusKm && shop.km <= MAX_RADIUS_KM,
  );
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

  /** The same naming rule for a row that only carries a dealer id. */
  const dealerLabel = (id: string, fallback: string) => {
    const key = dealerNameKey(id);
    return key ? t(key) : fallback;
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-title">{t('dealers.title')}</h1>
          {/*
            A quiet truth, not decoration: this list re-reads at least once a second
            while it is on screen. Saying so is what stops a farmer pulling to
            refresh a screen that is already current.
          */}
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
            {t('dealers.live')}
          </span>
        </div>
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

      {!searchFailed ? (
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

          <ul className="mt-2 space-y-2.5">{listRows.map(shopRow)}</ul>
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
            <MapIcon className="size-5" aria-hidden />
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

