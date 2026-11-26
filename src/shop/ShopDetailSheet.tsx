import { BadgeCheck, MapPin, MessageCircle, Phone, X } from 'lucide-react';

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
}: {
  shop: ShopDetail;
  onClose: () => void;
  onChat: () => void;
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
          {shop.logoUrl ? (
            <img src={shop.logoUrl} alt="" className="size-12 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-soft text-subheading text-brand">
              {initials}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-subheading">{shop.name}</p>
            {shop.isLinked ? (
              <p className="mt-0.5 flex items-center gap-1 text-caption text-brand">
                <BadgeCheck className="size-3.5" aria-hidden />
                {t('dealers.network.connected')}
              </p>
            ) : (
              <p className="mt-0.5 text-caption text-muted-foreground">{t('dealers.network.listed')}</p>
            )}
          </div>
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
