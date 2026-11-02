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
  /**
   * The same string in a language the screen is not showing.
   *
   * It exists for the read-aloud controls, which speak Urdu whatever the
   * interface is set to: the words the voice needs are in a *specific* language
   * rather than in the active one, and a caller that had to reach into the
   * catalog for them would be the first screen in the app to bypass the locale
   * provider.
   */
  tIn: (locale: Locale, key: MessageKey, values?: Values) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const STORAGE_KEY = 'agri-shop.locale';

/**
 * One lookup and one substitution, shared by `t` and `tIn` so the two cannot
 * drift — a key resolved in another language has to fill its placeholders by
 * exactly the same rule as one resolved in this one.
 */
function message(locale: Locale, key: MessageKey, values?: Values): string {
  // Resolution walks the locale's fallback chain and ends at English, so a
  // partially translated language degrades to readable text rather than to
  // a raw message key.
  const template = resolveMessage(locale, key);
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

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

  const t = useCallback((key: MessageKey, values?: Values) => message(locale, key, values), [locale]);

  /* Stable: looking a string up in a fixed language does not depend on which one
     the screen happens to be showing. */
  const tIn = useCallback(
    (target: Locale, key: MessageKey, values?: Values) => message(target, key, values),
    [],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir,
      setLocale,
      toggleLocale: () => setLocale((current) => (current === 'en' ? 'ur' : 'en')),
      t,
      tIn,
    }),
    [locale, dir, t, tIn],
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
