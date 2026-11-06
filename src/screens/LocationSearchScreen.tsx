import { Check, ChevronLeft, MapPin, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { MAX_RADIUS_KM, RADIUS_OPTIONS } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import { searchPlaces, type PlaceSuggestion } from '@/services/geocode';

/**
 * Finding your area by name, and deciding how far "near me" reaches.
 *
 * The field is the instrument, not a map: a farmer who knows they are in Kot Ladha
 * does not need to pan a basemap and drop a pin within a few hundred metres — they
 * need to type the name they would say out loud. So the search is one field over
 * real place names from the geocoder.
 *
 * Choosing and saving are two acts, on purpose. Picking a place used to save it
 * immediately, which made the distance control impossible to offer: the farmer had
 * to have already committed before they could say how far to look. Now a tap
 * chooses the place, the panel underneath shows the search area it produces, and
 * "Save location" is the one write. Adjusting the radius before saving changes the
 * circle in front of them rather than an invisible number on another screen.
 *
 * The save itself asks nothing of the farmer first. A location is not published or
 * sent to anybody, so it is kept on the phone when there is no account and handed
 * to the account when there is one. Install the app and use it.
 *
 * The radius is shared with the Dealer/Shop screen — this page writes the same
 * `location.radiusKm` the list searches with, so the circle drawn here is the
 * circle those results actually cover.
 */

/**
 * How long typing must pause before the geocoder is asked.
 *
 * Nominatim's usage policy allows roughly one request a second, so a request per
 * keystroke is not an option — and on a slow connection it is also what makes a
 * search box feel broken.
 */
const SETTLE_MS = 350;

/**
 * The geocoder's own minimum. Below it a request would match half of Pakistan, so
 * the screen says what it needs rather than spending the request to learn that.
 */
const MIN_QUERY = 3;

/** The smallest radius the slider offers, with 100 km as the product's ceiling. */
const MIN_RADIUS_KM = 5;

export function LocationSearchScreen({ onBack }: { onBack: () => void }) {
  const { t, locale } = useLocale();
  const location = useLocation();

  const [text, setText] = useState('');
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Chosen, not yet saved — the one write happens on the button below. */
  const [picked, setPicked] = useState<PlaceSuggestion | null>(null);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY || picked !== null) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    /*
     * The request is not aborted when the next letter arrives. `searchPlaces`
     * de-duplicates identical in-flight queries across the whole app, so
     * aborting here could cancel a request another caller is waiting on — and
     * the answer is cached, so the cost of letting it finish is one cheap
     * response that the next search may well use. Late results are ignored
     * instead, which is the part that actually matters.
     */
    /*
     * Asked in the farmer's own language first, with a second behind it.
     * Nominatim answers in the district's own script when it is given no
     * preference — correct, and unreadable next to an English dealer list. An
     * English interface asks for English first and Urdu behind it; asking for
     * "en,en" would be a preference with nothing behind it at all.
     */
    const language = locale === 'en' ? 'en,ur' : `${locale},en`;

    const timer = setTimeout(() => {
      void searchPlaces(trimmed, { language }).then((found) => {
        if (cancelled) return;
        setResults(found);
        setSearching(false);
      });
    }, SETTLE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, locale, picked]);

  /**
   * Picking is not saving.
   *
   * It puts the place into the panel above the radius control, so the farmer can
   * see the circle it produces and change the distance before anything is kept.
   */
  const pick = (place: PlaceSuggestion) => setPicked(place);

  const save = () => {
    if (picked === null) return;

    void (async () => {
      setSaving(true);
      try {
        await location.save({
          label: picked.label,
          lat: picked.lat,
          lon: picked.lon,
          source: 'search',
          radiusKm: location.radiusKm,
        });
        /*
         * The place is the farmer's now, so any temporary search area is released
         * — otherwise the app goes on calling their own saved location
         * "temporary", which is the contradiction the rule exists to prevent.
         */
        location.clearTemporary();
        toast.success(t('location.savedToast'));
        onBack();
      } catch (failure) {
        toast.error(
          t('location.saveFailed', {
            reason: failure instanceof Error ? failure.message : '',
          }),
        );
      } finally {
        setSaving(false);
      }
    })();
  };

  const trimmed = text.trim();
  const showPanel = picked !== null || trimmed.length >= MIN_QUERY;

  return (
    <div className="flex min-h-full flex-col px-4 pt-4 pb-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <h1 className="text-title">{t('location.title')}</h1>
      </header>

      <div className="relative mt-3">
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
            /* Editing the words means the chosen place is no longer what the
               field says, so the choice is released rather than silently kept. */
            if (picked !== null) setPicked(null);
          }}
          placeholder={t('location.searchPlaceholder')}
          aria-label={t('location.searchPlaceholder')}
          className="h-12 w-full rounded-md border border-border bg-muted ps-10 pe-3.5 text-body placeholder:text-muted-foreground"
        />
      </div>

      {trimmed.length < MIN_QUERY && picked === null ? (
        <p className="mt-3 text-body-sm text-muted-foreground">{t('location.searchHint')}</p>
      ) : searching && picked === null ? (
        <LoadingState label={t('location.searching')} />
      ) : null}

      {picked === null && trimmed.length >= MIN_QUERY && !searching ? (
        results.length === 0 ? (
          <p className="mt-3 text-body-sm text-muted-foreground">
            {t('location.noMatches', { query: trimmed })}
          </p>
        ) : (
          <>
            <p className="mt-3 text-body-sm text-muted-foreground">{t('location.tapToPick')}</p>
            <ul className="mt-2 space-y-2" aria-label={t('location.searchResults')}>
              {results.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    onClick={() => pick(place)}
                    className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card p-3 text-start text-body motion-safe:transition-transform motion-safe:active:scale-95"
                  >
                    <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate">{place.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      {picked !== null ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-brand/40 bg-brand-soft p-3">
          <div className="min-w-0">
            <p className="text-caption text-brand">{t('location.chosenPlace')}</p>
            <p className="truncate text-body font-medium">{picked.label}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPicked(null);
              setText('');
            }}
            className="shrink-0 rounded-full bg-card px-3 py-1.5 text-caption font-medium"
          >
            {t('location.changePlace')}
          </button>
        </div>
      ) : null}

      {showPanel ? (
        <section
          className="mt-3 rounded-lg border border-border bg-green-50 p-3 dark:bg-green-700/10"
          aria-label={t('location.searchArea', { km: location.radiusKm })}
        >
          <RadiusPreview radiusKm={location.radiusKm} />

          <p className="mt-2 text-center">
            <span className="rounded-full bg-card px-3 py-1 text-caption font-medium">
              {t('location.searchArea', { km: location.radiusKm })}
            </span>
          </p>

          <div className="mt-3 rounded-lg border border-border bg-card p-3.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-subheading">{t('location.distanceLimit')}</p>
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-caption font-medium text-green-700 dark:bg-green-700/30 dark:text-green-100">
                {t('dealer.search.radiusValue', { km: location.radiusKm })}
              </span>
            </div>

            <input
              type="range"
              min={MIN_RADIUS_KM}
              max={MAX_RADIUS_KM}
              step={1}
              value={location.radiusKm}
              onChange={(event) => location.setRadiusKm(Number(event.target.value))}
              aria-label={t('location.distanceLimit')}
              aria-valuetext={t('dealer.search.radiusValue', { km: location.radiusKm })}
              className="mt-3 h-2 w-full accent-brand"
            />

            <div className="mt-1 flex items-center justify-between text-caption text-muted-foreground">
              <span>{t('dealer.search.radiusValue', { km: MIN_RADIUS_KM })}</span>
              <span>{t('location.radiusMax', { km: MAX_RADIUS_KM })}</span>
            </div>

            <p className="mt-3 text-overline uppercase text-muted-foreground">
              {t('dealer.search.radius')}
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {RADIUS_OPTIONS.map((km) => {
                const active = km === location.radiusKm;
                return (
                  <li key={km}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => location.setRadiusKm(km)}
                      className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {active ? <Check className="size-3.5" aria-hidden /> : null}
                      {t('dealer.search.radiusValue', { km })}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      <div className="mt-auto" />

      {/* The one write on the page. It is anchored to the bottom so a farmer who
          has just moved the slider does not have to scroll to find it. */}
      <div className="sticky bottom-0 -mx-4 mt-5 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
        <Button
          className="h-12 w-full rounded-full"
          onClick={save}
          disabled={picked === null || saving}
        >
          {saving ? t('location.saving') : t('location.saveCta')}
        </Button>
      </div>
    </div>
  );
}

/* ── the search area, drawn ──────────────────────────────────────────────── */

/**
 * A schematic, not a basemap.
 *
 * It answers one question — "how big is the circle I just chose?" — and it has to
 * answer it with no tiles, no key and no network, on a phone in a field. The rings
 * are drawn from the same radius the dealer search uses, so the picture cannot say
 * 20 km while the list searches 5.
 */
function RadiusPreview({ radiusKm }: { radiusKm: number }) {
  const { t } = useLocale();
  const radius = 26 + (Math.min(radiusKm, MAX_RADIUS_KM) / MAX_RADIUS_KM) * 66;

  return (
    <svg
      viewBox="0 0 320 200"
      className="w-full"
      role="img"
      aria-label={t('location.searchArea', { km: radiusKm })}
    >
      {[40, 80, 120, 160, 200, 240, 280].map((x) => (
        <line
          key={`x${x}`}
          x1={x}
          y1="0"
          x2={x}
          y2="200"
          className="stroke-green-300/40"
          strokeWidth="0.75"
        />
      ))}
      {[40, 80, 120, 160].map((y) => (
        <line
          key={`y${y}`}
          x1="0"
          y1={y}
          x2="320"
          y2={y}
          className="stroke-green-300/40"
          strokeWidth="0.75"
        />
      ))}

      {/* The ceiling, so a small circle reads as a choice rather than a limit. */}
      <circle
        cx="160"
        cy="100"
        r="92"
        className="fill-none stroke-green-500/30"
        strokeDasharray="5 7"
        strokeWidth="1"
      />
      <circle
        cx="160"
        cy="100"
        r={radius}
        className="fill-green-400/20 stroke-green-600/60"
        strokeWidth="1.5"
      />

      <circle
        cx="160"
        cy="100"
        r="13"
        className="fill-card stroke-green-600/40"
        strokeWidth="1.5"
      />
      <path
        d="M160 88c-6.1 0-11 4.9-11 11 0 7.6 11 16 11 16s11-8.4 11-16c0-6.1-4.9-11-11-11z"
        className="fill-green-600"
      />
      <circle cx="160" cy="98" r="3.4" className="fill-card" />
    </svg>
  );
}
