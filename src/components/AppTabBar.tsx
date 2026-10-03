import { House, MessageCircle, ScanLine, Store, Users } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';

export type TabKey = 'home' | 'dealers' | 'scan' | 'chat' | 'community';

const TABS: ReadonlyArray<{ key: TabKey; labelKey: MessageKey; Icon: typeof House }> = [
  { key: 'home', labelKey: 'nav.home', Icon: House },
  { key: 'dealers', labelKey: 'nav.dealers', Icon: Store },
  { key: 'scan', labelKey: 'nav.scan', Icon: ScanLine },
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

          if (key === 'scan') {
            return (
              <li key={key} className="flex justify-center">
                <button
                  type="button"
                  onClick={() => onChange(key)}
                  aria-label={t('nav.scanAria')}
                  aria-current={active ? 'page' : undefined}
                  className="-mt-6 grid size-14 place-items-center rounded-full bg-brand text-brand-foreground shadow-[0_8px_20px_-6px_rgba(23,22,18,0.5)] ring-4 ring-background"
                >
                  <Icon className="size-6" />
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
                <Icon className="size-5" />
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
