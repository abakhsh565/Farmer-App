"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { createContext, memo, useContext, useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "cn";

type TickerContextValue = {
  formatter: Intl.NumberFormat;
  locale: string;
};

const DEFAULT_CURRENCY = "USD";
const DEFAULT_LOCALE = "en-US";

/* Adjusted after install: PKR mandi rates are quoted in whole rupees per 40 kg
   (Rs 8,200), and the registry default of two decimals renders them as
   Rs 8,200.00 — six characters of noise on every row. */
const defaultFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: "currency",
  currency: DEFAULT_CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const TickerContext = createContext<TickerContextValue>({
  formatter: defaultFormatter,
  locale: DEFAULT_LOCALE,
});

export const useTickerContext = () => useContext(TickerContext);

export type TickerProps = HTMLAttributes<HTMLButtonElement> & {
  currency?: string;
  locale?: string;
};

export const Ticker = memo(
  ({
    children,
    className,
    currency = DEFAULT_CURRENCY,
    locale = DEFAULT_LOCALE,
    ...props
  }: TickerProps & { children: ReactNode }) => {
    const formatter = useMemo(() => {
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: currency.toUpperCase(),
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        });
      } catch {
        return defaultFormatter;
      }
    }, [currency, locale]);

    return (
      <TickerContext.Provider value={{ formatter, locale }}>
        <button
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap align-middle",
            className
          )}
          type="button"
          {...props}
        >
          {children}
        </button>
      </TickerContext.Provider>
    );
  }
);
Ticker.displayName = "Ticker";

export type TickerIconProps = HTMLAttributes<HTMLImageElement> & {
  src?: string;
  symbol?: string;
  asChild?: boolean;
};

export const TickerIcon = memo(
  ({
    src,
    symbol,
    className,
    asChild,
    children,
    ...props
  }: TickerIconProps) => {
    if (asChild) {
      return (
        <div
          className={cn(
            "overflow-hidden rounded-full border border-border bg-muted",
            className
          )}
        >
          {children}
        </div>
      );
    }

    return (
      <Avatar className={cn("size-7 border border-border bg-muted", className)}>
        <AvatarImage src={src} {...props} />
        <AvatarFallback className="font-semibold text-muted-foreground text-sm">
          {symbol?.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
    );
  }
);
TickerIcon.displayName = "TickerIcon";

export type TickerSymbolProps = HTMLAttributes<HTMLSpanElement> & {
  symbol: string;
};

export const TickerSymbol = memo(
  ({ symbol, className, ...props }: TickerSymbolProps) => (
    <span className={cn("font-medium", className)} {...props}>
      {symbol.toUpperCase()}
    </span>
  )
);
TickerSymbol.displayName = "TickerSymbol";

export type TickerPriceProps = HTMLAttributes<HTMLSpanElement> & {
  price: number;
};

export const TickerPrice = memo(
  ({ price, className, ...props }: TickerPriceProps) => {
    const context = useTickerContext();

    const formattedPrice = useMemo(
      () => context.formatter.format(price),
      [price, context]
    );

    return (
      <span className={cn("text-muted-foreground", className)} {...props}>
        {formattedPrice}
      </span>
    );
  }
);
TickerPrice.displayName = "TickerPrice";

export type TickerPriceChangeProps = HTMLAttributes<HTMLSpanElement> & {
  change: number;
  isPercent?: boolean;
  /**
   * Direction words, supplied by the caller so they can be translated. They are
   * rendered for assistive technology only — the arrow is a rotated triangle, so
   * it carries no meaning of its own.
   */
  upLabel?: string;
  downLabel?: string;
};

/* Adjusted after install. The registry version put a `<title>` inside the SVG and
   pointed `aria-labelledby` at a *fixed* id — so with five rows on the screen,
   every arrow resolved to the first title in the document and the falling crops
   were announced as rising. A colour-and-rotation indicator is invisible to a
   screen reader, so direction is now spoken as text and the SVG is decorative. */
export const TickerPriceChange = memo(
  ({
    change,
    isPercent,
    className,
    upLabel = "up",
    downLabel = "down",
    ...props
  }: TickerPriceChangeProps) => {
    const isPositiveChange = useMemo(() => change >= 0, [change]);
    const context = useTickerContext();

    const changeFormatted = useMemo(() => {
      if (isPercent) {
        return new Intl.NumberFormat(context.locale, {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(change / 100);
      }
      return context.formatter.format(change);
    }, [change, isPercent, context]);

    return (
      <span
        className={cn(
          "flex items-center gap-0.5",
          isPositiveChange
            ? "text-green-600 dark:text-green-500"
            : "text-red-600 dark:text-red-500",
          className
        )}
        {...props}
      >
        <svg
          aria-hidden="true"
          className={isPositiveChange ? "" : "rotate-180"}
          fill="currentColor"
          height="12"
          viewBox="0 0 24 24"
          width="12"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M24 22h-24l12-20z" />
        </svg>
        <span className="sr-only">{isPositiveChange ? upLabel : downLabel}</span>
        {changeFormatted}
      </span>
    );
  }
);
TickerPriceChange.displayName = "TickerPriceChange";
