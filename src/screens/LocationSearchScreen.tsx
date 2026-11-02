import { ChevronLeft, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LoadingState } from '@/components/States';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import { searchPlaces, type PlaceSuggestion } from '@/services/geocode';

/**
 * Finding your area by name.
 *
 * This replaced a page built around a map. The map was the wrong instrument for
 * the job: a farmer who knows they are in Kot Ladha does not need to pan a
 * basemap and place a pin within a few hundred metres — they need to type the
 * name of the place they would say out loud. So there is one field, one list, and
 * no second step: tapping the place *is* the save.
 *
 * The save-on-tap is deliberate rather than a shortcut. There was a Save button,
 * and a farmer who tapped a place and then missed the button had done nothing —
 * the place they had just found, named and chosen was thrown away because of a
 * second control they had no reason to expect. Choosing from a list of real place
 * names is the decision; there is nothing further to confirm.
 *
 * And it asks nothing of the farmer first. Tapping a place used to open a sign-in
 * sheet, which made the app's most immediately useful act — telling it where you
 * are, so the shops it lists are the ones near you — the one thing you could not
 * do until you had an account. A location is not published or sent to anybody, so
 * it is kept on the phone when there is no account and handed to the account when
 * there is one. Install the app and use it.
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

export function LocationSearchScreen({ onBack }: { onBack: () => void }) {
  const { t, locale } = useLocale();
  const location = useLocation();

  const [text, setText] = useState('');
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY) {
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
  }, [text, locale]);

  /**
   * The tap is the save.
   *
   * The radius is carried across unchanged: the farmer is choosing *where*, and
   * a location write that silently reset how far they look would undo a choice
   * they made on another screen.
   */
  const choose = (place: PlaceSuggestion) => {
    void (async () => {
      setSaving(true);
      try {
        await location.save({
          label: place.label,
          lat: place.lat,
          lon: place.lon,
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
          onChange={(event) => setText(event.target.value)}
          placeholder={t('location.searchPlaceholder')}
          aria-label={t('location.searchPlaceholder')}
          className="h-12 w-full rounded-md bg-muted ps-10 pe-3.5 text-body placeholder:text-muted-foreground"
        />
      </div>

      {trimmed.length < MIN_QUERY ? (
        <p className="mt-3 text-body-sm text-muted-foreground">{t('location.searchHint')}</p>
      ) : searching ? (
        <LoadingState label={t('location.searching')} />
      ) : results.length === 0 ? (
        <p className="mt-3 text-body-sm text-muted-foreground">
          {t('location.noMatches', { query: trimmed })}
        </p>
      ) : (
        <>
          <p className="mt-3 text-body-sm text-muted-foreground">{t('location.tapToSave')}</p>
          <ul className="mt-2 space-y-2" aria-label={t('location.searchResults')}>
            {results.map((place) => (
              <li key={place.id}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => choose(place)}
                  className="w-full rounded-md border border-border bg-card p-3 text-start text-body disabled:opacity-60"
                >
                  {place.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
