import { BadgeCheck, ChevronRight, MapPin, MessageCircle, Phone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import type { ShopSummary } from './api/types';

/**
 * The shop, as the dealer's platform describes it.
 *
 * This is the page behind the name in a conversation's header. Everything on it is
 * a field the dealer's own `farmer_api_shops` returned — name, place, phone, logo,
 * whether this farmer is linked — and a field that came back empty is left out
 * rather than filled with a placeholder, so nothing here is invented.
 */
export type ShopDetail = Pick<
  ShopSummary,
  'name' | 'city' | 'locationLabel' | 'phone' | 'logoUrl' | 'isLinked'
>;

export function ShopDetailSheet({
  shop,
  onClose,
  onChat,
  onOpenDealer,
}: {
  shop: ShopDetail;
  onClose: () => void;
  onChat: () => void;
  /*
   * The way on to the shop's full page. The sheet is a summary — a name, a place,
   * a number and one action — and the page behind it is where the listings, the
   * hours and the visit request live. Without this the only door out of the sheet
   * was the conversation, so a farmer who tapped the name to learn *about* the
   * shop was handed a message box instead.
   */
  onOpenDealer?: () => void;
}) {
  const { t } = useLocale();
  const place = [shop.locationLabel, shop.city].filter(Boolean).join(' · ');
  const initials = shop.name.slice(0, 2).toUpperCase();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={shop.name}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
    >
      <div className="w-full max-w-lg rounded-t-2xl bg-card px-4 pb-6 pt-4">
        <div className="flex items-start gap-3">
          {/* The logo, the name and the connection badge are one target: tapping
              any of them opens the shop's page, not the conversation. */}
          <button
            type="button"
            onClick={onOpenDealer}
            disabled={!onOpenDealer}
            aria-label={onOpenDealer ? t('dealer.detail.title') : undefined}
            className="flex min-w-0 flex-1 items-start gap-3 text-start disabled:cursor-default"
          >
            {shop.logoUrl ? (
              <img src={shop.logoUrl} alt="" className="size-12 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-soft text-subheading text-brand">
                {initials}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-subheading">{shop.name}</span>
              {shop.isLinked ? (
                <span className="mt-0.5 flex items-center gap-1 text-caption text-brand">
                  <BadgeCheck className="size-3.5" aria-hidden />
                  {t('dealers.network.connected')}
                </span>
              ) : (
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  {t('dealers.network.listed')}
                </span>
              )}
              {shop.phone ? (
                <span className="mt-0.5 block truncate text-caption tabular-nums text-muted-foreground">
                  {shop.phone}
                </span>
              ) : null}
            </span>
            {onOpenDealer ? (
              <ChevronRight className="mt-1 size-5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
            ) : null}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="-me-1 grid size-9 shrink-0 place-items-center rounded-full"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <dl className="mt-4 space-y-2.5">
          {place ? (
            <div className="flex items-center gap-2 text-body-sm">
              <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{place}</span>
            </div>
          ) : null}
          {shop.phone ? (
            <div className="flex items-center gap-2 text-body-sm">
              <Phone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <a href={`tel:${shop.phone}`} className="min-w-0 truncate">
                {shop.phone}
              </a>
            </div>
          ) : null}
        </dl>

        <Button
          className="mt-5 h-11 w-full rounded-full"
          onClick={() => {
            onClose();
            onChat();
          }}
        >
          <MessageCircle className="size-4" aria-hidden />
          {t('chat.title')}
        </Button>
      </div>
    </div>
  );
}
