import { ChevronLeft, MessageCircle, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, LoadingState } from '@/components/States';
import { dealerNameKey } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatMoney, formatNumber, formatRelativeTime } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { useDealerSearch, useProductSearch } from '@/services/hooks';
import type { DealerSummary, DealerProduct, ProductHit } from '@/services/types';

/**
 * One search box for shops and for stock.
 *
 * A farmer typing "urea" is not asking the same question as a farmer typing
 * "Green Agro". The first wants to know who has it and at what price; the second
 * wants a shop. The dealer list could only answer the second, so searching for a
 * product there quietly answered nothing — the list filtered by shop name and the
 * farmer concluded nobody stocks urea.
 *
 * So the page has two answers and one keyword. While the farmer is still typing it
 * offers *suggestions* — a few shops and a few products, both real — so a search
 * can be started from what is actually nearby rather than from a guessed spelling.
 * Once a keyword is confirmed the two tabs appear, and switching between them
 * keeps the keyword, because losing what you typed when you look at the other
 * answer is the most irritating thing a search box can do.
 *
 * The suggestions are not a curated list. They are the nearest shops and the
 * listings those shops actually sent, read from the same dealer service the rest
 * of the app reads, so a suggestion cannot name a shop that has stopped trading or
 * a product nobody nearby carries.
 */

/** How many suggestions each type offers before the farmer types anything. */
const SUGGESTION_COUNT = 4;

/**
 * How long typing must pause before the service is asked.
 *
 * Product search composes several reads per query, so asking on every keystroke
 * would be a burst of requests per word — and on a cheap phone on a slow
 * connection those requests are what makes the box feel broken. The rows already
 * on screen stay while the next answer is in flight.
 */
const SETTLE_MS = 300;

/**
 * A value that only updates once it has held still.
 *
 * Deliberately not debounced with a leading edge: the farmer sees every character
 * they type — only the *question* waits.
 */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}

export function SearchScreen({
  onBack,
  onOpenChat,
}: {
  onBack: () => void;
  onOpenChat: (dealerId: string) => void;
}) {
  const { t, locale } = useLocale();
  const location = useLocation();

  /** What the farmer is typing — never delayed, so the field never lags. */
  const [text, setText] = useState('');
  /** The keyword they confirmed, or null while they are still choosing one. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [tab, setTab] = useState<'dealers' | 'products'>('dealers');

  const settled = useSettled(text, SETTLE_MS);

  /*
   * One keyword drives both reads: what has been typed while suggesting, and what
   * was confirmed once the tabs are up. That is what makes switching tabs keep the
   * keyword — not a copy of the string per tab, but a single source for both.
   */
  const keyword = submitted ?? settled;

  /*
   * The same origin rule as the dealer list: a temporary area is passed
   * explicitly, a saved location is resolved by the server, and an account with
   * neither is given the point already in play. A search must not be the one
   * screen that decides the farmer's area differently.
   */
  const origin =
    location.searchOrigin ??
    (location.hasSaved
      ? undefined
      : { lat: location.activePoint.lat, lon: location.activePoint.lon });

  const dealers = useDealerSearch({ radiusKm: location.radiusKm, origin, query: keyword });
  const products = useProductSearch({ radiusKm: location.radiusKm, origin, query: keyword });

  const dealerLabel = (id: string, fallback: string) => {
    const key = dealerNameKey(id);
    return key ? t(key) : fallback;
  };

  const confirming = submitted === null;

  const confirm = (term: string, focus: 'dealers' | 'products' = 'dealers') => {
    const trimmed = term.trim();
    if (trimmed.length === 0) return;
    setSubmitted(trimmed);
    setText(trimmed);
    setTab(focus);
  };

  const dealerRows = dealers.data;
  const productRows = products.data;

  return (
    <div className="flex flex-col px-4 pt-4 pb-6">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <h1 className="sr-only">{t('search.title')}</h1>

        {/* A form, so the keyboard's own "search" key confirms the keyword. */}
        <form
          className="relative flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            confirm(text, tab);
          }}
        >
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              /* Editing the keyword means the results on screen are no longer
                 about what is in the box, so the page returns to suggesting
                 rather than showing an answer to a question nobody asked. */
              if (submitted !== null) setSubmitted(null);
            }}
            placeholder={t('dealers.search')}
            aria-label={t('search.title')}
            className="h-12 w-full rounded-md bg-muted ps-10 pe-10 text-body placeholder:text-muted-foreground"
          />
          {text.length > 0 ? (
            <button
              type="button"
              aria-label={t('search.clear')}
              onClick={() => {
                setText('');
                setSubmitted(null);
              }}
              className="absolute end-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </form>
      </header>

      {confirming ? (
        <>
          {text.trim().length === 0 ? (
            <p className="mt-3 text-body-sm text-muted-foreground">{t('search.hint')}</p>
          ) : null}

          <SectionLabel className="mt-4">
            {text.trim().length === 0 ? t('search.suggestedDealers') : t('search.suggested')}
          </SectionLabel>
          <SuggestionList
            label={text.trim().length === 0 ? null : t('search.suggestedDealers')}
            loading={dealers.status === 'loading'}
            empty={t('search.noDealers', { query: text.trim() })}
            rows={dealerRows}
            render={(entry) => (
              <button
                type="button"
                onClick={() => confirm(dealerLabel(entry.id, entry.name))}
                className="w-full rounded-md border border-border bg-card p-3 text-start"
              >
                <span className="block truncate text-body font-medium">
                  {dealerLabel(entry.id, entry.name)}
                </span>
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                  {t('common.km', { km: formatNumber(entry.distanceKm, locale) })}
                </span>
              </button>
            )}
          />

          <SectionLabel className="mt-4">
            {text.trim().length === 0 ? t('search.suggestedProducts') : t('search.suggested')}
          </SectionLabel>
          <ul className="mt-2 space-y-2" aria-label={t('search.suggestedProducts')}>
            {products.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}
            {products.status === 'ready' && productRows.length === 0 ? (
              <li className="text-body-sm text-muted-foreground">
                {t('search.noProducts', { query: text.trim() })}
              </li>
            ) : null}
            {productRows.slice(0, SUGGESTION_COUNT).map((hit) => (
              <li key={`${hit.dealerId}-${hit.product.id}`}>
                <button
                  type="button"
                  onClick={() => confirm(hit.product.name, 'products')}
                  className="w-full rounded-md border border-border bg-card p-3 text-start"
                >
                  <span className="block truncate text-body font-medium">{hit.product.name}</span>
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                    {t('search.product.shop', {
                      shop: dealerLabel(hit.dealerId, hit.dealerName),
                      km: t('common.km', { km: formatNumber(hit.distanceKm, locale) }),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <ul className="mt-3 flex gap-2">
            {(['dealers', 'products'] as const).map((id) => {
              const active = id === tab;
              const count = id === 'dealers' ? dealerRows.length : productRows.length;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTab(id)}
                    className={`rounded-full px-4 py-2 text-body-sm font-medium leading-none ${
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {id === 'dealers' ? t('search.tabDealers') : t('search.tabProducts')}
                    {` · ${count}`}
                  </button>
                </li>
              );
            })}
          </ul>

          {tab === 'dealers' ? (
            <>
              {dealers.status === 'loading' ? <LoadingState label={t('rates.loading')} /> : null}
              {dealers.status === 'ready' && dealerRows.length === 0 ? (
                <EmptyState
                  title={t('dealers.empty.title')}
                  body={t('search.noDealers', { query: submitted })}
                />
              ) : null}
              <ul className="mt-3 space-y-2" aria-label={t('search.tabDealers')}>
                {dealerRows.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-body font-medium">
                        {dealerLabel(entry.id, entry.name)}
                      </span>
                      <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                        {entry.distanceKm} km
                        {entry.openingHours ? ` · ${entry.openingHours}` : ''}
                      </span>
                      {entry.syncState !== 'fresh' && entry.syncedAt !== null ? (
                        <span className="mt-1 flex items-center gap-1.5 text-caption text-amber-700 dark:text-amber-100">
                          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                          {t('dealer.sync.stale', {
                            age: formatRelativeTime(entry.syncedAt, Date.now(), t),
                          })}
                        </span>
                      ) : null}
                    </span>
                    <ChatButton
                      label={t('dealers.chatAria', { name: dealerLabel(entry.id, entry.name) })}
                      onClick={() => onOpenChat(entry.id)}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ProductResults
              hits={productRows}
              loading={products.status === 'loading'}
              empty={t('search.noProducts', { query: submitted })}
              sourceLabel={products.sourced?.sourceLabel ?? null}
              dealerLabel={dealerLabel}
              onOpenChat={onOpenChat}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ── the suggestion list, shared by both types ───────────────────────────── */

function SuggestionList({
  label,
  loading,
  empty,
  rows,
  render,
}: {
  label: string | null;
  loading: boolean;
  empty: string;
  rows: readonly DealerSummary[];
  render: (entry: DealerSummary) => ReactNode;
}) {
  return (
    <div className="mt-2">
      {label ? <p className="text-caption text-muted-foreground">{label}</p> : null}
      {loading && rows.length === 0 ? <LoadingState label="…" /> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{empty}</p>
      ) : null}
      <ul className="mt-1 space-y-2">
        {rows.slice(0, SUGGESTION_COUNT).map((entry) => (
          <li key={entry.id}>{render(entry)}</li>
        ))}
      </ul>
    </div>
  );
}

function ChatButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-9 shrink-0 place-items-center rounded-full bg-muted"
    >
      <MessageCircle className="size-4" aria-hidden />
    </button>
  );
}

/* ── products ────────────────────────────────────────────────────────────── */

/**
 * The product half of the results.
 *
 * Each row is one listing at one shop, with that shop's own price and stock, so
 * two shops carrying the same product are two rows a farmer can compare instead
 * of one row quoting a price neither of them gave. Where a price was not quoted it
 * says "price on asking" rather than leaving a blank that reads as free.
 */
function ProductResults({
  hits,
  loading,
  empty,
  sourceLabel,
  dealerLabel,
  onOpenChat,
}: {
  hits: readonly ProductHit[];
  loading: boolean;
  empty: string;
  sourceLabel: string | null;
  dealerLabel: (id: string, fallback: string) => string;
  onOpenChat: (dealerId: string) => void;
}) {
  const { t, locale } = useLocale();

  const stockLine = (product: DealerProduct) =>
    product.inStock === true && product.availableQty !== null
      ? t('dealer.products.inStock', { qty: product.availableQty })
      : product.inStock === false
        ? t('dealer.products.outOfStock')
        : t('dealer.products.unknownQty');

  return (
    <>
      {loading ? <LoadingState label={t('rates.loading')} /> : null}
      {!loading && hits.length === 0 ? (
        <EmptyState title={t('dealers.empty.title')} body={empty} />
      ) : null}

      <ul className="mt-3 space-y-2" aria-label={t('search.tabProducts')}>
        {hits.map((hit) => (
          <li
            key={`${hit.dealerId}-${hit.product.id}`}
            className="flex items-start justify-between gap-3 rounded-md border border-border bg-card p-3"
          >
            <span className="min-w-0">
              <span className="block truncate text-body font-medium">{hit.product.name}</span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                {hit.product.brand ? `${hit.product.brand} · ` : ''}
                {hit.product.packSize ?? ''}
              </span>
              <span
                className={`mt-1 block text-caption ${
                  hit.product.inStock === false
                    ? 'text-amber-700 dark:text-amber-100'
                    : 'text-muted-foreground'
                }`}
              >
                {stockLine(hit.product)}
              </span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                {t('search.product.shop', {
                  shop: dealerLabel(hit.dealerId, hit.dealerName),
                  km: t('common.km', { km: formatNumber(hit.distanceKm, locale) }),
                })}
              </span>
            </span>

            <span className="flex shrink-0 flex-col items-end gap-1.5">
              {hit.product.unitPrice !== null ? (
                <span className="text-label tabular-nums">
                  {formatMoney(hit.product.unitPrice, locale, t)}
                </span>
              ) : (
                <span className="text-caption text-muted-foreground">
                  {t('scan.product.askPrice')}
                </span>
              )}
              <ChatButton
                label={t('dealers.chatAria', {
                  name: dealerLabel(hit.dealerId, hit.dealerName),
                })}
                onClick={() => onOpenChat(hit.dealerId)}
              />
            </span>
          </li>
        ))}
      </ul>

      {/*
        Provenance, always. Product search reads the nearest shops rather than the
        whole radius, and a farmer is entitled to know that the answer covered part
        of the area — the alternative is a partial answer presented as a complete
        one, which is the failure this whole layer exists to prevent.
      */}
      {sourceLabel ? (
        <p className="mt-2 text-caption text-muted-foreground">{sourceLabel}</p>
      ) : null}
    </>
  );
}
