import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, Check, MapPin, MessageCircle, Sprout } from 'lucide-react';
import { LOCALE_REGISTRY, type Locale } from '@/i18n/locales';
import { useLocale } from '@/i18n/LocaleProvider';
import { useLocation } from '@/location/LocationProvider';
import { useInsights } from '@/insights/InsightProvider';
import { LocationSearchScreen } from '@/screens/LocationSearchScreen';
import type { MessageKey } from '@/i18n/catalog';

/**
 * What a farmer sees the very first time the app opens.
 *
 * Four steps, in the order the brief sets them out: splash → walkthrough →
 * crops → location → the app itself in Guest Mode. The last two are skippable,
 * and that is the whole point of them being steps rather than a gate: a farmer
 * can reach Home without granting a location permission or naming a crop,
 * because both are things they can do later from inside the app.
 *
 * Language is deliberately *not* one of the steps. It is a control pinned above
 * them — see `LanguageBar` — because asking a farmer to choose a language and
 * then showing them four more screens is one decision spread over two places.
 *
 * Completing the flow is recorded on the *device*, not the account. The app is
 * useful before anyone signs in — that is the product's rule, not a shortcut —
 * so an onboarding flag that needed an account could never be written.
 */

const COMPLETE_KEY = 'agri-shop.onboarding.v1';

/**
 * How long the splash holds before the flow moves on by itself.
 *
 * Long enough to register the mark, short enough not to be a delay — and it is
 * a ceiling, not a sentence: tapping the splash skips it entirely.
 */
const SPLASH_MS = 1400;

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(COMPLETE_KEY) === 'done';
  } catch {
    /*
     * Storage unavailable — private mode, or a full quota. Reported as *complete*
     * deliberately, so the failure is to skip the intro rather than to show it.
     *
     * The two mistakes are not symmetrical. A farmer whose storage is blocked is
     * almost always someone already using the app, and dropping them back to the
     * language picker mid-use reads as the app having forgotten them. A genuinely
     * first-run farmer who loses the intro still lands in an app that works, and
     * can replay it from Profile. So the flow is a convenience, and it fails open.
     */
    return true;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(COMPLETE_KEY, 'done');
  } catch {
    /* nothing to do — it simply shows again next launch */
  }
}

/** For the profile's "show me the intro again" affordance. */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(COMPLETE_KEY);
  } catch {
    /* see above */
  }
}

/**
 * The words for this flow, kept beside it.
 *
 * Onboarding copy is the most-churned text in a product and it is read before
 * the farmer has agreed to anything, so it is not folded into the main catalog
 * where a half-translated regional locale would make the first screen the one
 * that looks unfinished. English is the backstop for every language.
 */
const COPY = {
  tagline: { en: 'Your farming companion', ur: 'آپ کا کاشتکاری ساتھی' },
  loading: { en: 'Loading', ur: 'لوڈ ہو رہا ہے' },
  language: { en: 'Language', ur: 'زبان' },
  continue: { en: 'Continue', ur: 'آگے بڑھیں' },
  skip: { en: 'Skip', ur: 'چھوڑ دیں' },
  skipForNow: { en: 'Skip for now', ur: 'ابھی کے لیے چھوڑ دیں' },
  back: { en: 'Back', ur: 'واپس' },
  done: { en: 'Start using the app', ur: 'ایپ استعمال کریں' },

  slide1Title: { en: 'Everything you need, in your hand', ur: 'سب کچھ آپ کے ہاتھ میں' },
  slide1Body: {
    en: 'Weather, spray timing, mandi rates and advice for the crops you actually grow — in your language.',
    ur: 'موسم، چھڑکاؤ کا وقت، منڈی کے بھاؤ اور آپ کی فصلوں کے لیے مشورہ — آپ کی زبان میں۔',
  },
  slide2Title: { en: 'Show a leaf, get the answer', ur: 'پتہ دکھائیں، جواب پائیں' },
  slide2Body: {
    en: 'Photograph a sick plant. The app identifies the problem and the right treatment for it.',
    ur: 'بیمار پودے کی تصویر لیں۔ ایپ مسئلہ اور اس کا درست علاج بتاتی ہے۔',
  },
  slide3Title: { en: 'Depend on your neighbourhood', ur: 'اپنے محلے پر بھروسا کریں' },
  slide3Body: {
    en: 'Local recommendations, other farmers saying what worked, and verified shops near you with stock and prices.',
    ur: 'مقامی مشورے، دوسرے کسانوں کے تجربات، اور نزدیکی تصدیق شدہ دکانیں — اسٹاک اور قیمتوں کے ساتھ۔',
  },

  locationTitle: { en: 'Where is your farm?', ur: 'آپ کا کھیت کہاں ہے؟' },
  locationBody: {
    en: 'Used for weather, nearby shops and local advice. Nothing is shared with anyone.',
    ur: 'موسم، قریبی دکانیں اور مقامی مشوروں کے لیے۔ یہ کسی کے ساتھ شیئر نہیں ہوتا۔',
  },
  detect: { en: 'Use my current location', ur: 'میری موجودہ جگہ استعمال کریں' },
  searchPlace: { en: 'Search for your village or city', ur: 'اپنا گاؤں یا شہر تلاش کریں' },
  locating: { en: 'Finding you…', ur: 'تلاش جاری ہے…' },
  located: { en: 'Location set', ur: 'جگہ محفوظ ہو گئی' },
  locationDenied: {
    en: 'Could not get your location. Search for it instead.',
    ur: 'آپ کی جگہ نہیں مل سکی۔ اسے تلاش کریں۔',
  },

  cropsTitle: { en: 'What do you grow?', ur: 'آپ کیا اگاتے ہیں؟' },
  cropsBody: {
    en: 'Pick one or more. This is what makes the advice on your home screen about your own field.',
    ur: 'ایک یا زیادہ منتخب کریں۔ اسی سے آپ کے ہوم اسکرین کا مشورہ آپ کے کھیت کے بارے میں ہوتا ہے۔',
  },
  cropsSelected: { en: 'selected', ur: 'منتخب' },
} as const;

type CopyKey = keyof typeof COPY;

/**
 * A string from a two-language entry.
 *
 * Urdu is the default reading of this flow, so anything that is not explicitly
 * English resolves to Urdu — the same rule the picker's pre-selection uses.
 */
function inLocale(entry: { en: string; ur: string }, locale: Locale): string {
  return locale === 'en' ? entry.en : entry.ur;
}

/**
 * The crops worth offering first, and the stage they start at.
 *
 * Sowing is the honest starting stage for a crop the farmer has just told us
 * about and nothing more: it is the earliest claim the app can make without
 * inventing a stage, and `stageConfirmed` stays false so the app says the stage
 * is assumed until the farmer confirms otherwise.
 */
export const CROP_CHOICES: { key: MessageKey; stage: MessageKey }[] = [
  { key: 'crop.cotton', stage: 'crop.stage.sowing' },
  { key: 'crop.wheat', stage: 'crop.stage.sowing' },
  { key: 'crop.maize', stage: 'crop.stage.sowing' },
  { key: 'crop.rice', stage: 'crop.stage.sowing' },
];

/**
 * The languages the onboarding control offers.
 *
 * Punjabi, Saraiki, Sindhi and Pashto stay registered in `locales.ts` — their
 * direction, script and fallback chains are all correct — but they are not
 * offered here yet, because their onboarding copy is not reviewed. Offering a
 * language the screen itself would fall back to Urdu for is worse than not
 * offering it.
 */
const ONBOARDING_LANGUAGES: readonly Locale[] = ['en', 'ur'];

const SLIDES: { title: CopyKey; body: CopyKey; Icon: typeof Sprout }[] = [
  { title: 'slide1Title', body: 'slide1Body', Icon: Sprout },
  { title: 'slide2Title', body: 'slide2Body', Icon: Camera },
  { title: 'slide3Title', body: 'slide3Body', Icon: MessageCircle },
];

type Step = 'splash' | 'slides' | 'crops' | 'location';

export function OnboardingFlow({ onDone }: { onDone: () => void }) {
  const { setLocale } = useLocale();
  const location = useLocation();
  const insights = useInsights();

  const [step, setStep] = useState<Step>('splash');
  const [slide, setSlide] = useState(0);
  const [picked, setPicked] = useState<Locale>('ur');
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [selected, setSelected] = useState<MessageKey[]>([]);

  /**
   * The step's own language, which is not yet the app's language.
   *
   * The language step exists to be read *before* it is applied, so the copy
   * follows what is highlighted rather than what is currently active — otherwise
   * the screen asks "choose your language" in a language the farmer may not read.
   */
  const copy = useCallback((key: CopyKey): string => inLocale(COPY[key], picked), [picked]);

  // The splash is a beat, not a step the farmer has to dismiss. Long enough to
  // register the mark, short enough not to be a delay — and it gives the locale
  // and location providers their first frame before any screen asks them anything.
  useEffect(() => {
    if (step !== 'splash') return;
    const id = window.setTimeout(() => setStep('slides'), SPLASH_MS);
    return () => window.clearTimeout(id);
  }, [step]);

  const finish = useCallback(() => {
    markOnboardingComplete();
    onDone();
  }, [onDone]);

  const detect = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocationFailed(true);
      return;
    }
    setLocating(true);
    setLocationFailed(false);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        /*
         * Held as a *temporary* area, not a saved one. A saved location is an
         * account's record; a guest has none, and the provider's contract is
         * that a temporary area drives the same screens and is handed to the
         * account if one is ever made. Writing it as saved here would be the
         * app claiming an account that does not exist.
         */
        location.setTemporary({
          label: '',
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          source: 'gps',
        });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setLocationFailed(true);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  }, [location]);

  const toggleCrop = useCallback((key: MessageKey) => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }, []);

  /**
   * Records the chosen crops. It deliberately does *not* finish the flow: the
   * location step comes after this one, so finishing here would skip a question
   * the farmer has not been asked yet.
   */
  const commitCrops = useCallback(() => {
    for (const key of selected) {
      const choice = CROP_CHOICES.find((crop) => crop.key === key);
      if (choice) insights.addCrop({ nameKey: choice.key, stageKey: choice.stage });
    }
  }, [selected, insights]);

  const hasLocation = location.temporary !== null || location.saved !== null;

  const dots = useMemo(
    () => SLIDES.map((_, index) => index === slide),
    [slide],
  );

  if (searching) {
    return (
      <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-background text-foreground">
        <LocationSearchScreen onBack={() => setSearching(false)} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-background text-foreground">
      {step === 'splash' ? (
        <Splash
          // The language the *next* screen will offer, so the splash and the
          // picker agree: a fresh device shows Urdu here and has Urdu
          // pre-selected there, rather than contradicting itself for a beat.
          locale={picked}
          label={copy('continue')}
          onContinue={() => setStep('slides')}
        />
      ) : null}

      {step !== 'splash' ? (
        <div className="flex flex-1 flex-col px-6 pb-8 pt-6">
          {/*
            Pinned above the step, not part of it. Choosing a language applies
            immediately, so the crop names and the location copy that follow are
            already in the farmer's own language rather than catching up later.
          */}
          <LanguageBar
            label={copy('language')}
            picked={picked}
            onPick={(next) => {
              setPicked(next);
              setLocale(next);
            }}
          />

          <div className="flex flex-1 flex-col">
            {step === 'slides' ? (
              <SlideStep copy={copy} slide={slide} dots={dots} />
            ) : null}

            {step === 'crops' ? (
              <CropStep copy={copy} selected={selected} onToggle={toggleCrop} />
            ) : null}

            {step === 'location' ? (
              <LocationStep
                copy={copy}
                locating={locating}
                failed={locationFailed}
                hasLocation={hasLocation}
                label={location.placeLabel}
                onDetect={detect}
                onSearch={() => setSearching(true)}
              />
            ) : null}
          </div>

          <div className="mt-6 flex flex-col gap-3">
            {step === 'slides' ? (
              <>
                <PrimaryButton
                  label={copy('continue')}
                  onClick={() =>
                    slide < SLIDES.length - 1 ? setSlide(slide + 1) : setStep('crops')
                  }
                />
                <GhostButton label={copy('skip')} onClick={() => setStep('crops')} />
              </>
            ) : null}

            {/*
              Both optional steps use the same shape: Continue when something was
              given, "Skip for now" when nothing was. Skipping is a real answer
              here — Home works without a location or a crop — so it is offered as
              the primary action rather than buried.
            */}
            {step === 'crops' ? (
              <>
                <PrimaryButton
                  label={selected.length > 0 ? copy('continue') : copy('skipForNow')}
                  onClick={() => {
                    commitCrops();
                    setStep('location');
                  }}
                />
              </>
            ) : null}

            {step === 'location' ? (
              <>
                <PrimaryButton
                  label={hasLocation ? copy('continue') : copy('skipForNow')}
                  onClick={finish}
                />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The mark, drawn rather than shipped as an image.
 *
 * There is no logo file in the repository, and inventing a raster one would put
 * a binary in the tree that nothing can review or recolour. A small SVG uses the
 * theme's own colour and stays sharp at any density.
 *
 * Two things are deliberate. It shows a spinner, because the brief asks for a
 * splash that says it is *loading* — and something that says nothing while the
 * bundle and the first location read are still landing reads as a frozen app on
 * a slow phone. And it can be tapped through: the timer is a courtesy for a
 * farmer who is happy to wait, never a wait imposed on one who is not.
 */
function Splash({
  locale,
  label,
  onContinue,
}: {
  locale: Locale;
  label: string;
  onContinue: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onContinue}
      aria-label={label}
      className="flex flex-1 flex-col items-center justify-center gap-6 px-8"
    >
      <div className="flex size-24 items-center justify-center rounded-3xl bg-primary text-primary-foreground">
        <Sprout aria-hidden className="size-12" strokeWidth={1.6} />
      </div>

      <div className="text-center">
        <p className="font-serif text-3xl font-semibold tracking-tight">AgriShop</p>
        <p className="mt-2 text-sm text-muted-foreground">{inLocale(COPY.tagline, locale)}</p>
      </div>

      {/*
        The spinner carries no words of its own — the tagline above already says
        what is happening — but it announces itself, so a screen reader hears that
        the app is working rather than meeting a silent screen.
      */}
      <span
        role="status"
        aria-label={inLocale(COPY.loading, locale)}
        className="mt-2 size-5 animate-spin rounded-full border-2 border-muted border-t-primary"
      />
    </button>
  );
}

/**
 * The language control, fixed at the top of every step after the splash.
 *
 * A two-way switch rather than a list, and it sits above the content rather
 * than being a screen of its own: the farmer picks a language and immediately
 * sees the copy below it change, which is the only way to be sure the choice
 * was understood. Each name is written in its own script, so the option is
 * readable to someone who cannot read the other one.
 */
function LanguageBar({
  label,
  picked,
  onPick,
}: {
  label: string;
  picked: Locale;
  onPick: (locale: Locale) => void;
}) {
  return (
    <div className="flex shrink-0 justify-end pb-4">
      <div
        role="group"
        aria-label={label}
        className="flex items-center gap-1 rounded-full border border-border bg-card p-1"
      >
        {ONBOARDING_LANGUAGES.map((code) => {
          const meta = LOCALE_REGISTRY[code];
          const active = code === picked;
          return (
            <button
              key={code}
              type="button"
              onClick={() => onPick(code)}
              aria-pressed={active}
              // Typed in its own script, so `dir` belongs to the option rather
              // than to the page: the Urdu name reads right-to-left even while
              // the surrounding control is laid out left-to-right.
              dir={meta.dir}
              className={[
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              ].join(' ')}
            >
              {meta.nativeName}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SlideStep({
  copy,
  slide,
  dots,
}: {
  copy: (key: CopyKey) => string;
  slide: number;
  dots: boolean[];
}) {
  const current = SLIDES[slide];
  // The step index is clamped by the button that advances it, so an absent slide
  // means the walkthrough is done — rendering nothing is correct, and indexing
  // past the end must not be papered over with a non-null assertion.
  if (!current) return null;
  const Icon = current.Icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="flex size-20 items-center justify-center rounded-3xl bg-secondary text-secondary-foreground">
        <Icon aria-hidden className="size-9" strokeWidth={1.6} />
      </div>
      <h2 className="mt-6 font-serif text-2xl font-semibold">{copy(current.title)}</h2>
      <p className="mt-3 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">
        {copy(current.body)}
      </p>
      <ul className="mt-8 flex items-center gap-2" aria-label={`${slide + 1} / ${SLIDES.length}`}>
        {dots.map((active, index) => (
          <li
            key={index}
            className={[
              'size-2 rounded-full transition-colors',
              active ? 'w-6 bg-primary' : 'bg-border',
            ].join(' ')}
          />
        ))}
      </ul>
    </div>
  );
}

function LocationStep({
  copy,
  locating,
  failed,
  hasLocation,
  label,
  onDetect,
  onSearch,
}: {
  copy: (key: CopyKey) => string;
  locating: boolean;
  failed: boolean;
  hasLocation: boolean;
  label: string;
  onDetect: () => void;
  onSearch: () => void;
}) {
  return (
    <div className="flex flex-col">
      <h1 className="font-serif text-2xl font-semibold">{copy('locationTitle')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{copy('locationBody')}</p>

      {/*
        A refused permission and an unavailable location are the same sentence on
        purpose — the farmer's next action is identical (search for it), and two
        different explanations would only ask them to diagnose the browser.
      */}
      {failed ? (
        <p className="mt-6 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {copy('locationDenied')}
        </p>
      ) : null}

      {hasLocation ? (
        <p className="mt-6 flex items-center gap-2 rounded-2xl bg-muted/50 px-4 py-3 text-sm">
          <MapPin aria-hidden className="size-4 shrink-0 text-primary" />
          <span>{label || copy('located')}</span>
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={onDetect}
          disabled={locating}
          className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          <MapPin aria-hidden className="size-4" />
          {locating ? copy('locating') : copy('detect')}
        </button>
        <button
          type="button"
          onClick={onSearch}
          className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm font-medium"
        >
          {copy('searchPlace')}
        </button>
      </div>
    </div>
  );
}

function CropStep({
  copy,
  selected,
  onToggle,
}: {
  copy: (key: CopyKey) => string;
  selected: MessageKey[];
  onToggle: (key: MessageKey) => void;
}) {
  // Crop names are read from the catalog, not from this file: they are the same
  // strings the crop strip and the insight sheets show, and a second spelling
  // here is exactly the drift the catalog exists to prevent.
  const { t } = useLocale();
  return (
    <div className="flex flex-col">
      <h1 className="font-serif text-2xl font-semibold">{copy('cropsTitle')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{copy('cropsBody')}</p>

      <ul className="mt-6 flex flex-col gap-2">
        {CROP_CHOICES.map((crop) => {
          const active = selected.includes(crop.key);
          return (
            <li key={crop.key}>
              <button
                type="button"
                onClick={() => onToggle(crop.key)}
                aria-pressed={active}
                className={[
                  'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-start transition-colors',
                  active ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/40',
                ].join(' ')}
              >
                <span className="text-base font-medium">{t(crop.key)}</span>
                {active ? (
                  <Check aria-hidden className="size-5 shrink-0 text-primary" strokeWidth={2.2} />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
    >
      {label}
    </button>
  );
}

function GhostButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl px-4 py-3 text-sm font-medium text-muted-foreground"
    >
      {label}
    </button>
  );
}
