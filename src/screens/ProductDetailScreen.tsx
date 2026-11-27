import { ChevronLeft, MessageCircle, ShieldCheck, Store, TriangleAlert } from 'lucide-react';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { dealerNameKey } from '@/data/dealers';
import { catalogueEntry } from '@/data/products';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { useDealer, useDealerProducts, useStockists } from '@/services/hooks';
import { useShopApi } from '@/shop/ShopApiProvider';

type Props = {
  canonicalProductId: string;
  /** The listing the farmer came from, when they arrived through a shop. */
  dealerId: string | null;
  onBack: () => void;
  onOpenDealer: (dealerId: string) => void;
  onOpenChat: (dealerId: string) => void;
};

/**
 * One product, in full.
 *
 * The page is split along the line the PRD draws through every agricultural input:
 *
 *   the *knowledge* half — what this product is, what it is registered for, the
 *   safety line that must not be separated from it — comes from the canonical
 *   catalogue, and is the same for every shop;
 *
 *   the *inventory* half — who has it, at what price, confirmed when — comes from
 *   the dealer projection, and is different per shop.
 *
 * They are shown together because a farmer needs both to decide, and kept apart
 * in the layout because they have different owners. That is also why the price
 * quoted here is the listing's own price: the page never averages shops into a
 * single number, which would be a figure no shop is offering.
 *
 * When the catalogue has no entry for a product a shop is selling, the page still
 * works — pack, registration, price and stock are all real — and says that the
 * approved-use description is not available rather than filling the gap with
 * something plausible. That is the same rule as an unsupported crop.
 */
export function ProductDetailScreen({
  canonicalProductId,
  dealerId,
  onBack,
  onOpenDealer,
  onOpenChat,
}: Props) {
  const { t, locale } = useLocale();
  const location = useLocation();
  const entry = catalogueEntry(canonicalProductId);
  /* The dealer platform's own record, for the number a stockist row shows. */
  const shopApi = useShopApi();
  const phoneFor = (id: string) => shopApi.shops.find((shop) => shop.shopId === id)?.phone ?? null;

  const listing = useDealerProducts(dealerId);
  const mine = listing.data.find((product) => product.canonicalProductId === canonicalProductId);
  /*
   * The shop this listing came from, read from the same projection as every other
   * shop read. The stockist rows cannot supply the name on their own: when no
   * *other* shop in range carries the product those rows are empty, and the page
   * was printing "you opened this from" above nothing.
   */
  const openedFrom = useDealer(
    dealerId ?? '',
    location.dealerOrigin ?? location.activePoint,
  );
  /*
   * The same origin as every other shop read. Without it a guest's product page
   * asked the database where they were, was told nothing, and showed no shops at
   * all — including the shop whose listing the farmer had just tapped.
   */
  const stockists = useStockists(
    canonicalProductId,
    location.radiusKm,
    location.dealerOrigin ?? location.activePoint,
  );

  const name = entry
    ? t(entry.nameKey)
    : (mine?.name ?? t('product.detail.unnamed'));
  const dealerName = (id: string, fallback: string) => {
    const key = dealerNameKey(id);
    return key ? t(key) : fallback;
  };

  const back = (
    <header className="flex items-center gap-2 px-4 pt-4">
      <button
        type="button"
        aria-label={t('common.back')}
        onClick={onBack}
        className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
      >
        <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
      </button>
      <h1 className="text-title">{t('product.detail.title')}</h1>
    </header>
  );

  const others = stockists.data.filter((row) => row.dealerId !== dealerId);

  return (
    <div className="flex flex-col pb-6">
      {back}

      <section className="mt-3 px-4">
        <h2 className="text-subheading">{name}</h2>
        <p className="mt-0.5 text-label text-muted-foreground">
          {[mine?.brand ?? entry?.manufacturer, mine?.packSize, entry ? t(entry.categoryKey) : null]
            .filter(Boolean)
            .join(' · ')}
        </p>

        {mine?.unitPrice !== null && mine?.unitPrice !== undefined ? (
          <p className="mt-2 text-title tabular-nums">{formatMoney(mine.unitPrice, locale, t)}</p>
        ) : (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('scan.product.askPrice')}</p>
        )}

        <p
          className={`mt-1 text-caption ${
            mine?.inStock === false ? 'text-amber-700 dark:text-amber-100' : 'text-muted-foreground'
          }`}
        >
          {mine === undefined
            ? t('product.detail.noListing')
            : mine.inStock === true && mine.availableQty !== null
              ? t('dealer.products.inStock', { qty: mine.availableQty })
              : mine.inStock === false
                ? t('dealer.products.outOfStock')
                : t('dealer.products.unknownQty')}
        </p>
      </section>

      {/* What it is. Knowledge half. */}
      <section className="mt-4 px-4">
        <SectionLabel>{t('product.detail.about')}</SectionLabel>
        {entry ? (
          <>
            <p className="mt-2 text-body-sm leading-relaxed">{t(entry.descriptionKey)}</p>
            <p className="mt-2 text-body-sm leading-relaxed text-muted-foreground">
              {t(entry.useKey)}
            </p>
          </>
        ) : (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('product.detail.noKnowledge')}</p>
        )}
      </section>

      {entry ? (
        <section className="mt-4 px-4">
          <div className="rounded-lg border border-amber-700/30 bg-amber-50 p-3.5 dark:bg-amber-500/15">
            <p className="flex items-center gap-2 text-body-sm font-medium text-amber-900 dark:text-amber-100">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {t('product.detail.safety')}
            </p>
            <p className="mt-1 text-body-sm leading-relaxed text-amber-900/85 dark:text-amber-100/85">
              {t(entry.safetyKey)}
            </p>
          </div>
        </section>
      ) : null}

      {/* The facts a farmer or an inspector would ask for. */}
      <section className="mt-4 px-4">
        <SectionLabel>{t('product.detail.facts')}</SectionLabel>
        <dl className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
          {([
            {
              key: 'product.detail.registration' as MessageKey,
              value: mine?.registrationNo ?? entry?.registration ?? null,
            },
            {
              key: 'product.detail.manufacturer' as MessageKey,
              value: mine?.brand ?? entry?.manufacturer ?? null,
            },
            { key: 'product.detail.ingredient' as MessageKey, value: entry?.activeIngredient ?? null },
            {
              key: 'product.detail.category' as MessageKey,
              value: entry ? t(entry.categoryKey) : (mine?.category ?? null),
            },
            { key: 'product.detail.pack' as MessageKey, value: mine?.packSize ?? null },
          ] as ReadonlyArray<{ key: MessageKey; value: string | null }>)
            .filter((row) => row.value !== null && row.value !== '')
            .map((row) => (
              <div key={row.key} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                <dt className="text-caption text-muted-foreground">{t(row.key)}</dt>
                <dd className="text-end text-body-sm font-medium">{row.value}</dd>
              </div>
            ))}
        </dl>
        <p className="mt-2 text-caption text-muted-foreground">{t('product.detail.registrationNote')}</p>
      </section>

      {/* Who has it. Inventory half — every row is one shop's own listing. */}
      <section className="mt-4 px-4">
        <SectionLabel>{t('product.detail.shops')}</SectionLabel>

        {stockists.status === 'loading' && others.length === 0 ? (
          <LoadingState label={t('rates.loading')} />
        ) : null}

        {stockists.status === 'error' ? (
          <ErrorState
            title={t('product.detail.shops')}
            body={stockists.error ?? t('otp.network')}
            onRetry={stockists.retry}
            retryLabel={t('common.tryAgain')}
          />
        ) : null}

        {mine !== undefined && dealerId !== null ? (
          <div className="mt-2 rounded-lg border border-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Store className="size-3.5" aria-hidden />
              {t('product.detail.youOpened')}
            </p>
            <p className="mt-1 text-body font-medium">
              {dealerName(
                dealerId,
                openedFrom.data?.name ??
                  stockists.data.find((row) => row.dealerId === dealerId)?.name ??
                  '',
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-full"
                onClick={() => onOpenDealer(dealerId)}
              >
                {t('product.detail.viewShop')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-full"
                onClick={() => onOpenChat(dealerId)}
              >
                <MessageCircle className="size-3.5" aria-hidden />
                {t('product.detail.message')}
              </Button>
            </div>
          </div>
        ) : null}

        {others.length > 0 ? (
          <>
            <p className="mt-3 text-caption text-muted-foreground">
              {t('product.detail.otherShops', {
                km: formatNumber(location.radiusKm, locale),
              })}
            </p>
            <ul className="mt-1.5 space-y-2">
              {others.map((row) => (
                <li key={row.dealerId}>
                  <button
                    type="button"
                    onClick={() => onOpenDealer(row.dealerId)}
                    className="flex w-full items-start justify-between gap-3 rounded-md border border-border bg-card p-3 text-start"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body font-medium">
                        {dealerName(row.dealerId, row.name)}
                      </span>
                      {phoneFor(row.dealerId) ? (
                        <span
                          dir="ltr"
                          className="mt-0.5 block truncate text-caption tabular-nums text-muted-foreground"
                        >
                          {phoneFor(row.dealerId)}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block text-caption text-muted-foreground">
                        {t('common.km', { km: formatNumber(row.distanceKm, locale) })}
                        {' · '}
                        {row.inStock === false
                          ? t('dealer.products.outOfStock')
                          : row.inStock === null
                            ? t('dealer.products.unknownQty')
                            : t('product.detail.inStockShort')}
                      </span>
                      {row.observedAt !== null ? (
                        <span className="mt-0.5 block text-caption text-muted-foreground">
                          {t('dealer.products.updated', {
                            age: formatRelativeTime(row.observedAt, Date.now(), t),
                          })}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-label tabular-nums">
                      {row.unitPrice === null
                        ? t('scan.product.askPrice')
                        : formatMoney(row.unitPrice, locale, t)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {stockists.status === 'ready' && others.length === 0 && mine === undefined ? (
          <EmptyState
            title={t('product.detail.noShopsTitle')}
            body={t('product.detail.noShopsBody', {
              km: formatNumber(location.radiusKm, locale),
            })}
          />
        ) : null}

        <p className="mt-2 flex items-start gap-1.5 text-caption text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('product.detail.disclaimer')}
        </p>
      </section>
    </div>
  );
}
