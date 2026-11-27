import {
  ChevronLeft,
  Clock,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { closingHour, dealerNameKey, tagLabel } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatDay, formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { useDealer, useDealerProducts } from '@/services/hooks';
import { useSession } from '@/session/SessionProvider';
import { useVisits } from '@/visits/VisitProvider';
import { ShopQrCard } from '@/shop/ShopQrCard';
import { useShopApi } from '@/shop/ShopApiProvider';
import { distanceKmBetween } from '@/shop/geo';

type Props = {
  dealerId: string;
  onBack: () => void;
  onOpenChat: (dealerId: string) => void;
  onOpenProduct: (target: { canonicalProductId: string; dealerId: string }) => void;
};

/**
 * A dealer's own page.
 *
 * The shop list answers "who is near me"; this answers "who is this, and what do
 * they actually have". Everything on it comes from the dealer projection — the
 * address, the phone, the description of the business, the opening hours and the
 * listings — because the shop-side system owns those facts and the app must not
 * be the place a real business's details are invented.
 *
 * Three honesty rules are carried over from the list rather than re-decided here:
 *
 *  · An unverified shop wears no badge, and the page says plainly that its
 *    business details have not been checked — which is different from saying the
 *    shop is bad.
 *  · Stock is three-state. `0` is confirmed none, `null` is "the shop did not
 *    report", and the page keeps them apart because a farmer deciding whether to
 *    travel is making a decision about the difference.
 *  · A listing whose projection is stale says so once, at the top of the list,
 *    rather than dressing every row as if it were this morning's count.
 */
export function DealerDetailScreen({ dealerId, onBack, onOpenChat, onOpenProduct }: Props) {
  const { t, locale } = useLocale();
  const location = useLocation();
  /* The area the list was drawn around, so this page resolves the shop from the
     same circle the farmer tapped it in. */
  const dealer = useDealer(dealerId, location.dealerOrigin ?? location.activePoint);
  const products = useDealerProducts(dealerId);
  const visits = useVisits();
  const { requestIdentity } = useSession();
  /*
   * When this page is the shop the farmer is actually connected to, a visit ask is
   * a row in that shop's own backend, not a request in this phone's local book.
   * One conversation, one record: the owner reads it in the app he already uses.
   */
  const shop = useShopApi();
  /*
   * The same shop as the dealer platform lists it. The marketplace projection is
   * built from listings, so a shop that has published nothing has no row there —
   * and the conversation's header can still name it. This is the record behind
   * that page, and it is what makes the page open instead of saying "not found".
   */
  const connectedShop = shop.shops.find((row) => row.shopId === dealerId) ?? null;

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
      <h1 className="text-title">{t('dealer.detail.title')}</h1>
    </header>
  );

  if (dealer.status === 'loading') {
    return (
      <div className="flex flex-col">
        {back}
        <LoadingState label={t('rates.loading')} />
      </div>
    );
  }

  if (dealer.status === 'error') {
    return (
      <div className="flex flex-col">
        {back}
        <ErrorState
          title={t('dealer.detail.title')}
          body={dealer.error ?? t('otp.network')}
          onRetry={dealer.retry}
          retryLabel={t('common.tryAgain')}
        />
      </div>
    );
  }

  const entry = dealer.data;
  if (!entry) {
    if (!connectedShop) {
      return (
        <div className="flex flex-col">
          {back}
          <EmptyState
            title={t('dealer.detail.missingTitle')}
            body={t('dealer.detail.missingBody')}
          />
        </div>
      );
    }

    /*
     * A shop the dealer platform knows but the marketplace has no listing for.
     * The page still has to be a page: who it is, where it is, the number to ring
     * and the way into its conversation. It says nothing about stock, because the
     * shop has not published any — an invented shelf would be worse than a blank
     * one.
     */
    const km =
      connectedShop.latitude !== null && connectedShop.longitude !== null
        ? Number(
            distanceKmBetween(location.activePoint, {
              lat: connectedShop.latitude,
              lon: connectedShop.longitude,
            }).toFixed(1),
          )
        : null;
    const place = [connectedShop.locationLabel, connectedShop.city].filter(Boolean).join(' · ');

    return (
      <div className="flex flex-col pb-6">
        {back}
        <section className="mt-3 px-4">
          <div className="flex items-center gap-3">
            {connectedShop.logoUrl ? (
              <img
                src={connectedShop.logoUrl}
                alt=""
                className="size-12 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-soft text-subheading text-brand">
                {connectedShop.name.slice(0, 2).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-subheading">{connectedShop.name}</h2>
              <p className="mt-0.5 flex items-center gap-1 text-caption text-brand">
                <ShieldCheck className="size-3.5" aria-hidden />
                {t('dealers.network.connected')}
              </p>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {place ? (
              <p className="flex items-start gap-2 text-body-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{place}</span>
              </p>
            ) : null}
            {connectedShop.phone ? (
              <a
                href={`tel:${connectedShop.phone.replace(/\s/g, '')}`}
                className="flex items-center gap-2 text-body-sm font-medium text-brand"
              >
                <Phone className="size-4 shrink-0" aria-hidden />
                <span dir="ltr">{connectedShop.phone}</span>
              </a>
            ) : null}
            {km !== null ? (
              <p className="flex items-center gap-2 text-body-sm text-muted-foreground">
                <MapPin className="size-4 shrink-0" aria-hidden />
                <span>{t('common.km', { km: formatNumber(km, locale) })}</span>
              </p>
            ) : null}
          </div>

          <p className="mt-2.5 rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
            {t('dealer.products.none')}
          </p>
        </section>

        <div className="mt-3 px-4">
          <Button
            className="h-11 w-full rounded-full"
            onClick={() => onOpenChat(connectedShop.shopId)}
          >
            <MessageCircle className="size-4" aria-hidden />
            {t('dealers.chatAria', { name: connectedShop.name })}
          </Button>
        </div>
      </div>
    );
  }

  const nameKey = dealerNameKey(entry.id);
  const name = nameKey ? t(nameKey) : entry.name;
  const verified = entry.verifiedAt !== null;
  const hour = closingHour(entry.id);
  /* The directory's projection has no number in it, so the shop platform's own
     record fills the line when this page was reached from a conversation. */
  const phone = entry.phone ?? connectedShop?.phone ?? null;

  const reasons: MessageKey[] = [];
  if (verified) reasons.push('dealer.reason.verified');
  if (entry.tags.length > 0) reasons.push('dealer.reason.stock');
  if (entry.isYourDealer) reasons.push('dealer.reason.relationship');
  if (entry.distanceKm <= 2) reasons.push('dealer.reason.distance');

  const visit = visits.forDealer(entry.id);
  const canAsk = visit === undefined || visit.status === 'rejected';

  const connectedToShop = shop.configured && shop.credential?.shopId === entry.id;

  const askForVisit = () =>
    requestIdentity(() => {
      if (connectedToShop) {
        void shop.askVisit(null, null).then((ok) => {
          if (ok) toast.success(t('shop.request.sent'));
          else toast.error(t('shop.failed'));
        });
        return;
      }

      const result = visits.requestVisit(entry.id);
      if (!result.ok) toast.error(t(result.error));
      else toast.success(t('visit.request.sent'));
    }, 'session.why.visit');

  return (
    <div className="flex flex-col pb-6">
      {back}

      {/* Identity, verification and how far away it is — the three things a
          farmer checks before reading anything else. */}
      <section className="mt-3 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-subheading">{name}</h2>
          {verified ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand">
              <ShieldCheck className="size-3" aria-hidden />
              {t('dealers.verified')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-caption text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              {t('dealer.profile.unverified')}
            </span>
          )}
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-muted-foreground">
          <span>{t('common.km', { km: formatNumber(entry.distanceKm, locale) })}</span>
          {entry.establishedYear !== undefined && entry.establishedYear !== null ? (
            <>
              <span>·</span>
              <span>{t('dealer.detail.since', { year: entry.establishedYear })}</span>
            </>
          ) : null}
          {entry.openNow === true && hour !== null ? (
            <>
              <span>·</span>
              <span className="text-brand">{t('dealers.openTill', { time: `${hour}:00` })}</span>
            </>
          ) : entry.openNow === false && hour !== null ? (
            <>
              <span>·</span>
              <span>{t('dealers.closedOpens', { time: `${hour}:00` })}</span>
            </>
          ) : null}
        </p>

        {verified && entry.verifiedAt !== null ? (
          <p className="mt-1 text-caption text-muted-foreground">
            {t('dealer.profile.verifiedOn', {
              date: formatDay(new Date(entry.verifiedAt), locale),
            })}
          </p>
        ) : null}

        <p className="mt-2.5 rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
          {t('dealer.profile.checked')}
        </p>
      </section>

      {/* The business itself: what it says about its own shop, where it is and
          how to reach it. Each line is omitted when the source did not supply it. */}
      {entry.about || entry.address || phone ? (
        <section className="mt-4 px-4">
          {/*
            The shop's own join code. It renders only for the shop that owns the
            page — the issuing function refuses everyone else and the card stays
            absent rather than showing an empty box to a farmer browsing.
          */}
          <ShopQrCard dealerId={dealerId} />

          <SectionLabel>{t('dealer.detail.about')}</SectionLabel>
          {entry.about ? (
            <p className="mt-2 text-body-sm leading-relaxed">{entry.about}</p>
          ) : null}

          <div className="mt-2.5 space-y-2">
            {entry.address ? (
              <p className="flex items-start gap-2 text-body-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{entry.address}</span>
              </p>
            ) : null}
            {phone ? (
              <a
                href={`tel:${phone.replace(/\s/g, '')}`}
                className="flex items-center gap-2 text-body-sm font-medium text-brand"
              >
                <Phone className="size-4 shrink-0" aria-hidden />
                <span dir="ltr">{phone}</span>
              </a>
            ) : null}
            {entry.openingHours ? (
              <p className="flex items-center gap-2 text-body-sm text-muted-foreground">
                <Clock className="size-4 shrink-0" aria-hidden />
                <span>{t('dealer.detail.hours', { hours: entry.openingHours })}</span>
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="mt-4 px-4">
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

      {entry.tags.length > 0 ? (
        <section className="mt-4 px-4">
          <SectionLabel>{t('dealer.detail.specialities')}</SectionLabel>
          <ul className="mt-2 flex flex-wrap gap-2">
            {entry.tags.map((tag) => {
              const key = tagLabel(tag);
              return (
                <li
                  key={tag}
                  className="rounded-full bg-muted px-2.5 py-1.5 text-caption text-muted-foreground"
                >
                  {key ? t(key) : tag}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Every listing the shop has sent. Each row opens the product's own page,
          where the same price is shown beside the other shops that stock it. */}
      <section className="mt-4 px-4">
        <SectionLabel>{t('dealer.products.title')}</SectionLabel>

        {products.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}

        {products.status === 'ready' && products.data.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('dealer.products.none')}</p>
        ) : null}

        <ul className="mt-2 space-y-2">
          {products.data.map((product) => {
            const openable = product.canonicalProductId !== null;
            return (
              <li key={product.id}>
                <button
                  type="button"
                  disabled={!openable}
                  onClick={() =>
                    openable
                      ? onOpenProduct({
                          canonicalProductId: product.canonicalProductId as string,
                          dealerId: entry.id,
                        })
                      : undefined
                  }
                  className={`flex w-full items-start justify-between gap-3 rounded-md border border-border bg-card p-3 text-start ${
                    openable ? '' : 'opacity-70'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium">{product.name}</span>
                    <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                      {[product.brand, product.packSize, product.registrationNo]
                        .filter(Boolean)
                        .join(' · ')}
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
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {product.unitPrice !== null ? (
                      <span className="text-label tabular-nums">
                        {formatMoney(product.unitPrice, locale, t)}
                      </span>
                    ) : (
                      <span className="text-caption text-muted-foreground">
                        {t('scan.product.askPrice')}
                      </span>
                    )}
                    {openable ? (
                      <span className="text-caption text-brand">{t('dealer.detail.viewProduct')}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
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

      {/* A field visit is a service request, not a chat message and not credit:
          the shop reviews it and answers, and the farmer always sees the state. */}
      <section className="mt-4 px-4">
        <div className="rounded-lg border border-border bg-card p-3.5">
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
                <Button variant="outline" className="mt-2.5 h-11 w-full rounded-full" onClick={askForVisit}>
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
        </div>
      </section>

      <div className="mt-3 px-4">
        <Button
          variant="outline"
          className="h-11 w-full rounded-full"
          onClick={() => onOpenChat(entry.id)}
        >
          <MessageCircle className="size-4" aria-hidden />
          {t('dealers.chatAria', { name })}
        </Button>
      </div>
    </div>
  );
}
