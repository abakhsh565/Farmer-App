import { House, MessageCircle, Sparkles, Store, Users } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';

export type TabKey = 'home' | 'dealers' | 'assistant' | 'chat' | 'community';

/**
 * The five things a farmer does daily.
 *
 * The middle slot is the assistant, and it used to be the camera. The reason is
 * usage rather than taste: a farmer asks what the rate is, whether it will rain,
 * or what is on a leaf far more often than they photograph one — and the camera
 * was reachable from three places already (the Home card's *Crop check* row, a
 * photo attached in a conversation, and the scan flow itself), so it did not need
 * a tab to be found. A conversation cannot be reached from anywhere else, which
 * is exactly what a tab is for.
 *
 * It keeps the raised-circle treatment the camera had, because that is the one
 * action the bar is asked for most and the shape says so without a label shouting
 * it.
 */
const TABS: ReadonlyArray<{ key: TabKey; labelKey: MessageKey; Icon: typeof House }> = [
  { key: 'home', labelKey: 'nav.home', Icon: House },
  { key: 'dealers', labelKey: 'nav.shop', Icon: Store },
  { key: 'assistant', labelKey: 'nav.assistant', Icon: Sparkles },
  { key: 'chat', labelKey: 'nav.chat', Icon: MessageCircle },
  { key: 'community', labelKey: 'nav.community', Icon: Users },
];

export function AppTabBar({
  value,
  onChange,
}: {
  value: TabKey;
  onChange: (key: TabKey) => void;
}) {
  const { t } = useLocale();

  return (
    <nav
      aria-label={t('nav.main')}
      className="relative border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-5">
        {TABS.map(({ key, labelKey, Icon }) => {
          const active = key === value;
          const label = t(labelKey);

          if (key === 'assistant') {
            return (
              <li key={key} className="flex justify-center">
                <button
                  type="button"
                  onClick={() => onChange(key)}
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  className={`-mt-6 grid size-14 place-items-center rounded-full text-brand-foreground shadow-[0_8px_20px_-6px_rgba(23,22,18,0.5)] ring-4 ring-background ${
                    active ? 'bg-brand' : 'bg-brand/85'
                  }`}
                >
                  <Icon className="size-6" aria-hidden />
                </button>
              </li>
            );
          }

          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onChange(key)}
                aria-current={active ? 'page' : undefined}
                className={`flex h-16 w-full flex-col items-center justify-center gap-1 text-caption font-medium ${
                  active ? 'text-brand' : 'text-muted-foreground'
                }`}
              >
                <Icon className="size-5" aria-hidden />
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
