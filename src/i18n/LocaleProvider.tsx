import { DirectionProvider } from '@radix-ui/react-direction';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { resolveMessage, type MessageKey } from './catalog';
import { isLocale, isRtl, type Locale } from './locales';

type Values = Record<string, string | number>;

type LocaleContextValue = {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: MessageKey, values?: Values) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const STORAGE_KEY = 'agri-shop.locale';

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Validated against the registry rather than a hard-coded pair, so a locale
    // added later persists correctly without this function being found.
    if (stored && isLocale(stored)) return stored;
  } catch {
    /* private mode — fall through to the default */
  }
  return 'en';
}

/**
 * Holds the active language and, more importantly, pushes it onto the document.
 *
 * Direction is a single attribute on <html> rather than a per-screen concern:
 * every component uses logical utilities, so setting `dir` here mirrors the
 * whole product — navigation, insets, icon direction — with nothing else to
 * change. That is the whole point of keeping direction out of the screens.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(readStoredLocale);

  const dir: 'ltr' | 'rtl' = isRtl(locale) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* storage unavailable — the session still works, it just will not persist */
    }
  }, [locale, dir]);

  const t = useCallback(
    (key: MessageKey, values?: Values) => {
      // Resolution walks the locale's fallback chain and ends at English, so a
      // partially translated language degrades to readable text rather than to
      // a raw message key.
      const template = resolveMessage(locale, key);
      if (!values) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        name in values ? String(values[name]) : `{${name}}`,
      );
    },
    [locale],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir,
      setLocale,
      toggleLocale: () => setLocale((current) => (current === 'en' ? 'ur' : 'en')),
      t,
    }),
    [locale, dir, t],
  );

  /*
   * Radix keeps its own direction context and defaults to `ltr`, and it stamps an
   * explicit `dir` attribute on the elements it controls. So a component like
   * ToggleGroup stayed left-to-right inside an Urdu page: it did not mirror, and —
   * worse — its arrow keys still moved that way, which only affects keyboard and
   * screen-reader users. Setting `dir` on <html> is invisible to Radix.
   *
   * Declaring it once here is what makes "direction is a system property" true for
   * every Radix primitive, including ones added later, rather than something each
   * screen has to remember to pass.
   */
  return (
    <LocaleContext.Provider value={value}>
      <DirectionProvider dir={dir}>{children}</DirectionProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used inside a LocaleProvider');
  }
  return context;
}
