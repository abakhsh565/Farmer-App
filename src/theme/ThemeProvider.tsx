import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'agri-shop.theme';

export const THEME_ATTRIBUTE_CLASS = 'dark';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private mode — fall through to the default */
  }
  return 'light';
}

/**
 * Light and dark, applied as one class on <html>.
 *
 * Every component in the product reads semantic tokens, so this is the only
 * place the theme is decided — there is no `dark:` variant in our own code
 * outside the tokens themselves, and no screen knows which theme is active.
 *
 * The default is **light, explicitly, rather than the operating system's
 * preference**. This is a decision, not an oversight: a farmer judging leaf
 * colour against a photo, or reading a mandi price, needs the canvas to be the
 * same at 6am and at 9pm, and on a phone whose dark mode was switched on months
 * ago and forgotten. A stored choice always wins over the default.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.classList.toggle(THEME_ATTRIBUTE_CLASS, theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable — the session still works, it just will not persist */
    }
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((current) => (current === 'light' ? 'dark' : 'light')),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return context;
}
