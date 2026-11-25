import { Camera, ChevronLeft, Image as ImageIcon, Leaf, ShieldAlert, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAiCredits } from '@/aiagent/AiCreditsProvider';
import { SectionLabel } from '@/components/SectionLabel';
import { EmptyState, LoadingState } from '@/components/States';
import { useCredit } from '@/credit/CreditProvider';
import { dealerNameKey } from '@/data/dealers';
import { useLocation } from '@/location/LocationProvider';
import { ROUNDUP } from '@/data/products';
import { useStockists } from '@/services/hooks';
import { useSpeech } from '@/speech/SpeechProvider';
import { LOCALE_REGISTRY } from '@/i18n/locales';
import {
  Choicebox,
  ChoiceboxIndicator,
  ChoiceboxItem,
  ChoiceboxItemHeader,
  ChoiceboxItemSubtitle,
  ChoiceboxItemTitle,
} from '@/components/kibo-ui/choicebox';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatMoney, formatNumber, formatRelativeTime, intlLocale } from '@/i18n/format';

type Step = 'capture' | 'crop' | 'symptom' | 'analysing' | 'blocked' | 'result';

const CROPS: ReadonlyArray<{ nameKey: MessageKey; price: number }> = [
  { nameKey: 'crop.cotton', price: 8200 },
  { nameKey: 'crop.wheat', price: 3900 },
  { nameKey: 'crop.maize', price: 2650 },
  { nameKey: 'crop.rice', price: 4300 },
];

const SYMPTOMS: ReadonlyArray<MessageKey> = [
  'scan.symptom.holes',
  'scan.symptom.wilting',
  'scan.symptom.insects',
  'scan.symptom.yellow',
];

/** The design's staged confidence, shown as a match rather than a bare number. */
const MATCH = 82;


/**
 * The camera flow: a photo, two questions, and what to do about the plant.
 *
 * It used to hold a conversation as well — the diagnosis ended in a composer, and
 * the tab it lived in was one half of "Scan / AI". Both halves have moved: the
 * conversation is the Assistant tab, where a farmer can open it without a leaf in
 * their hand, and this screen is what it says it is. Reached from the Home card's
 * *Crop check* row, which is where a farmer already goes when something looks
 * wrong.
 *
 * What was removed is worth naming, because it was not only layout. The follow-up
 * composer, its turns, its offline fallback and the evidence list all left with
 * it; the answer cards and their sources now live in `AssistantScreen`, so there
 * is one place that renders an answer rather than two that can disagree.
 */
export function ScanScreen({
  onBack,
  onOpenDealers,
}: {
  /** Leaves the flow entirely — the pushed screen's own Back. */
  onBack: () => void;
  onOpenDealers: () => void;
}) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  /*
   * The verdict is read aloud, and it is the one sentence on this screen a farmer
   * acts on in a field. It goes through the same voice as the weather card, so the
   * pill answers with an Urdu voice or with a sentence saying why it could not.
   */
  const speech = useSpeech();
  const speechTag = LOCALE_REGISTRY.ur.tag;
  const listening = speech.speaking === 'scan-verdict';
  /*
   * The daily allowance. A photo analysis is the expensive AI action, so it is
   * charged here — before the result is produced — and a farmer without the
   * credits is told so instead of being shown a diagnosis the ledger did not
   * record. The follow-up questions below charge as conversation.
   */
  const aiCredits = useAiCredits();
  const [step, setStep] = useState<Step>('capture');
  const [crop, setCrop] = useState<string>('crop.cotton');
  const [symptom, setSymptom] = useState<string>('scan.symptom.holes');

  /* The radius the farmer chose on the location page, so "no shop within N km"
     here is about the same N km the dealer list searched. */
  const location = useLocation();

  /*
   * The shops that have the recommended product, read from the dealer service —
   * not written beside the treatment. This is what makes the price on a diagnosis
   * the same price the shop's own page shows, and what stops a recommendation
   * becoming a function of which shop happened to have stock.
   *
   * Asked for from the first render, even while the farmer is still choosing a
   * crop: a hook cannot be called conditionally, and the answer is only needed by
   * the time the result appears. It is one read of a projection that is already
   * warm by then.
   */
  const stockists = useStockists(ROUNDUP.id, location.radiusKm);

  useEffect(() => {
    if (step !== 'analysing') return;
    const timer = window.setTimeout(() => setStep('result'), 1200);
    return () => window.clearTimeout(timer);
  }, [step]);

  const back = () => {
    if (step === 'crop') setStep('capture');
    else if (step === 'symptom') setStep('crop');
    else setStep('capture');
  };

  /**
   * Leaving the questionnaire for the analysis is the moment the AI work is
   * actually requested, so it is the moment the allowance is spent. A refusal
   * lands on its own screen: the farmer is not shown a spinner for work that was
   * never going to happen.
   */
  const startAnalysis = () => {
    if (!aiCredits.spend('scan')) {
      setStep('blocked');
      return;
    }
    setStep('analysing');
  };

  if (step === 'capture') {
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
          <h1 className="text-title">{t('scan.title')}</h1>
        </header>
        <p className="mt-2 text-body-sm text-muted-foreground">{t('scan.intro')}</p>

        <button
          type="button"
          onClick={() => setStep('crop')}
          className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-dashed border-ink-300 bg-card px-4 py-10"
        >
          <span className="grid size-14 place-items-center rounded-full bg-brand-soft">
            <Camera className="size-6 text-brand" aria-hidden />
          </span>
          <span className="text-subheading">{t('scan.takePhoto')}</span>
        </button>

        <Button variant="outline" className="mt-3 h-12 w-full rounded-md" onClick={() => setStep('crop')}>
          <ImageIcon className="size-4.5" aria-hidden />
          {t('scan.gallery')}
        </Button>

        <p className="mt-3 text-caption text-muted-foreground">
          {t('agent.credits.costs', {
            chat: aiCredits.costOf('chat'),
            scan: aiCredits.costOf('scan'),
          })}
        </p>
      </div>
    );
  }

  if (step === 'crop' || step === 'symptom') {
    const isCrop = step === 'crop';
    const value = isCrop ? crop : symptom;
    const setValue = isCrop ? setCrop : setSymptom;

    return (
      <div className="flex h-full flex-col px-4 pt-4 pb-6">
        <header className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('common.back')}
            onClick={back}
            className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
          >
            <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
          </button>
          <h1 className="text-title">{t('scan.title')}</h1>
          <span className="ms-auto text-label text-muted-foreground">
            {t('scan.step', { current: isCrop ? 1 : 2, total: 2 })}
          </span>
        </header>

        <SectionLabel className="mt-4">
          {t(isCrop ? 'scan.step.crop' : 'scan.step.symptom')}
        </SectionLabel>

        <Choicebox
          value={value}
          onValueChange={(next) => {
            if (typeof next === 'string') setValue(next);
          }}
          className="mt-3"
        >
          {(isCrop
            ? CROPS.map(({ nameKey, price }) => ({
                value: nameKey,
                title: t(nameKey),
                subtitle: `${formatNumber(price, locale)} · ${t('rates.unit')}`,
              }))
            : SYMPTOMS.map((key) => ({ value: key, title: t(key), subtitle: '' }))
          ).map((option) => (
            <ChoiceboxItem key={option.value} value={option.value} className="rounded-md">
              <ChoiceboxItemHeader>
                <ChoiceboxItemTitle>{option.title}</ChoiceboxItemTitle>
                {option.subtitle ? (
                  <ChoiceboxItemSubtitle>{option.subtitle}</ChoiceboxItemSubtitle>
                ) : null}
                <ChoiceboxIndicator />
              </ChoiceboxItemHeader>
            </ChoiceboxItem>
          ))}
        </Choicebox>

        <Button className="mt-auto h-12 w-full rounded-md" onClick={() => (isCrop ? setStep('symptom') : startAnalysis())}>
          {t('common.next')}
        </Button>
      </div>
    );
  }

  if (step === 'blocked') {
    return (
      <div className="flex h-full flex-col px-4 pt-4 pb-6">
        <header className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('common.back')}
            onClick={back}
            className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
          >
            <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
          </button>
          <h1 className="text-title">{t('scan.title')}</h1>
        </header>

        <EmptyState
          icon={ShieldAlert}
          title={t(aiCredits.refusedReason('scan') ?? 'agent.credits.exhausted')}
          body={t('agent.credits.blockedBody', {
            left: formatNumber(aiCredits.remaining, locale),
            cost: aiCredits.costOf('scan'),
            time: new Intl.DateTimeFormat(intlLocale(locale), {
              hour: 'numeric',
              minute: '2-digit',
            }).format(new Date(aiCredits.resetsAt)),
          })}
          action={
            <Button variant="outline" className="h-11 rounded-full" onClick={() => setStep('capture')}>
              {t('agent.credits.backToStart')}
            </Button>
          }
        />
      </div>
    );
  }

  if (step === 'analysing') {
    return (
      <div className="flex h-full flex-col px-4 pt-4">
        <h1 className="text-title">{t('scan.title')}</h1>
        <LoadingState label={t('scan.analysing')} />
      </div>
    );
  }

  /**
   * The result is a conversation, not a report — which is what the design shows
   * and what the product needs: the farmer can ask a follow-up straight away
   * instead of being handed a verdict and a dead end.
   */
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={back}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-inverted">
          <Leaf className="size-4.5 text-brand" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-subheading">{t('scan.assistant')}</span>
          <span className="block text-caption text-brand">{t('scan.analyzed')}</span>
        </span>
      </header>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {/* The photo the farmer took, as their side of the conversation. */}
        <div className="flex justify-end">
          <span className="rounded-lg rounded-ee-sm bg-brand p-1.5">
            <span className="grid size-32 place-items-center rounded-md bg-white/20">
              <ImageIcon className="size-8 text-brand-foreground" aria-label={t('scan.photoAlt')} />
            </span>
          </span>
        </div>

        <Bubble>
          {/* Confidence is stated before the advice, and the limit of the method
              with it: a match against stored cases is not a lab result, and the
              screen says which one the farmer is reading. */}
          <p className="text-overline text-muted-foreground uppercase">
            {t('scan.confidence.title')}
          </p>
          <span className="mt-1.5 inline-flex items-center rounded-sm bg-red-50 px-2.5 py-1 text-label font-medium text-red-700 dark:bg-red-500/20 dark:text-red-100">
            {t('scan.confidence.likely')} · {t('scan.diagnosis', { percent: MATCH })}
          </span>
          <p className="mt-2 text-body-sm leading-relaxed">{t('scan.diagnosisBody')}</p>
          <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
            {t('scan.confidence.body', { percent: MATCH })}
          </p>
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            {t('scan.uncertainty')}
          </p>
        </Bubble>

        <Bubble>
          <p className="text-body-sm leading-relaxed">{t('scan.advice')}</p>
          <p
            className="mt-2 text-body-sm leading-loose text-brand"
            lang={locale === 'en' ? 'ur' : 'en'}
          >
            {t('scan.adviceOther')}
          </p>
          {/* Wired to the voice, not drawn beside it. The pill was a picture of a
              speaker for as long as it existed: it had no handler, so a press did
              nothing and the feature read as broken. */}
          <button
            type="button"
            aria-label={listening ? t('weather.stopListening') : t('scan.listen')}
            aria-pressed={listening}
            onClick={() => {
              if (listening) {
                speech.stop();
                return;
              }
              speech.speak({
                id: 'scan-verdict',
                text: `${t('scan.diagnosis', { percent: MATCH })}. ${t('scan.advice')}`,
                lang: speechTag,
              });
            }}
            className="mt-2.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1.5 text-label text-brand"
          >
            <Volume2 className="size-3.5" aria-hidden />
            {listening ? t('weather.stopListening') : t('scan.listen')}
          </button>
        </Bubble>

        {/* The one dark block: the thing to actually go and buy. It *is* the
            bubble — drawn inside the muted one it rendered as a narrow strip of
            its own label, because an inline box cannot paint a background behind
            the block children stacked inside it.

            The treatment comes from the canonical product, and the dealer rows
            under it are live listings of *that* product — not a product chosen
            because a shop had it. */}
        <Bubble className="bg-surface-inverted text-cream-50">
          <p className="text-caption font-medium tracking-[0.08em] text-brand uppercase">
            {t('scan.treatmentTitle')}
          </p>
          <p className="mt-1.5 text-subheading text-cream-50">{t(ROUNDUP.nameKey)}</p>
          <p className="mt-0.5 text-label text-cream-50/75">
            {t('scan.product.evidence', { number: ROUNDUP.registration })}
          </p>
          <p className="mt-0.5 text-caption text-cream-50/60">{t('scan.product.chain')}</p>

          {stockists.status === 'loading' ? (
            <p className="mt-2 text-label text-cream-50/80">{t('scan.product.checking')}</p>
          ) : stockists.data.length > 0 ? (
            <ul className="mt-2.5 space-y-2">
              {stockists.data.map((listing) => (
                <li key={listing.dealerId} className="text-label leading-snug text-cream-50/90">
                  {t('scan.product.live', {
                    dealer: stockistName(listing.dealerId, listing.name, t),
                    km: listing.distanceKm.toFixed(1),
                    /* A shop that did not quote a price has not quoted zero. */
                    price:
                      listing.unitPrice === null
                        ? t('scan.product.askPrice')
                        : formatMoney(listing.unitPrice, locale, t),
                  })}
                  <span className="mt-0.5 block text-caption text-cream-50/55">
                    {listing.observedAt === null
                      ? t('scan.product.unconfirmed')
                      : t('scan.product.stockTime', {
                          time: formatRelativeTime(listing.observedAt, Date.now(), t),
                        })}
                  </span>
                  {/* Stock the dealer system did not report is said to be unknown,
                      which is the third state, not "out of stock". */}
                  {listing.inStock === null ? (
                    <span className="mt-0.5 block text-caption text-cream-50/55">
                      {t('dealer.products.unknownQty')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-label text-cream-50/80">
              {stockists.status === 'error'
                ? t('scan.product.error')
                : t('scan.product.none', { radius: location.radiusKm })}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => credit.open()}
              className="flex-1 rounded-md bg-brand py-2.5 text-center text-body-sm font-medium text-brand-foreground"
            >
              {t('scan.requestCredit')}
            </button>
            {/* Named for where it goes: the dealers, not the one dealer's chat. */}
            <button
              type="button"
              onClick={onOpenDealers}
              className="flex-1 rounded-md bg-white/12 py-2.5 text-center text-body-sm font-medium text-white"
            >
              {t('scan.viewDealers')}
            </button>
          </div>
        </Bubble>

      </div>
    </div>
  );
}

/**
 * The shop's name: the catalogue's translation when it has one, and the name the
 * dealer system reports otherwise — never a bare id.
 */
function stockistName(
  dealerId: string,
  reported: string,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const key = dealerNameKey(dealerId);
  return key ? t(key) : reported;
}

/** An incoming message row: assistant avatar, then the bubble. */
function Bubble({
  children,
  className = 'bg-muted',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-inverted">
        <Leaf className="size-3.5 text-brand" aria-hidden />
      </span>
      <div className={`max-w-[85%] rounded-lg rounded-ss-sm px-3.5 py-3.5 ${className}`}>
        {children}
      </div>
    </div>
  );
}
