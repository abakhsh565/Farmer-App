import {
  Camera,
  ChevronLeft,
  Image as ImageIcon,
  Leaf,
  Mic,
  Send,
  ShieldAlert,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SectionLabel } from '@/components/SectionLabel';
import { LoadingState } from '@/components/States';
import { useCredit } from '@/credit/CreditProvider';
import { dealerNameKey } from '@/data/dealers';
import { useLocation } from '@/location/LocationProvider';
import { ROUNDUP } from '@/data/products';
import { useStockists } from '@/services/hooks';
import { useServices } from '@/services/registry';
import type { AiAnswer, AiCitation } from '@/services/types';
import { verdictFor, type Verdict } from '@/scan/analyze';
import { useSession } from '@/session/SessionProvider';
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

type Step = 'capture' | 'crop' | 'symptom' | 'analysing' | 'result';

/**
 * The platform's speech recogniser, which the DOM typings do not carry. Declared
 * here as the two methods this screen uses rather than pulling in a package for
 * one constructor — and read through a nullable lookup, because a browser that
 * cannot listen must not be offered a control that pretends to.
 */
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};

const speechWindow = window as Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

const recognitionCtor = () =>
  speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

const CROPS: ReadonlyArray<{ nameKey: MessageKey; price: number }> = [
  { nameKey: 'crop.cotton', price: 8200 },
  { nameKey: 'crop.wheat', price: 3900 },
  { nameKey: 'crop.maize', price: 2650 },
  { nameKey: 'crop.rice', price: 4300 },
];

/** The catalogue key is not the crop code the gateway speaks. */
const CROP_CODES: Record<string, string> = {
  'crop.cotton': 'cotton',
  'crop.wheat': 'wheat',
  'crop.maize': 'maize',
  'crop.rice': 'rice',
};

const SYMPTOMS: ReadonlyArray<MessageKey> = [
  'scan.symptom.holes',
  'scan.symptom.wilting',
  'scan.symptom.insects',
  'scan.symptom.yellow',
];

/** The design's staged confidence, shown as a match rather than a bare number. */
const MATCH = 82;


/** A follow-up the farmer typed, and what the assistant did with it. */
type Turn =
  | { id: number; from: 'farmer'; text: string }
  | { id: number; from: 'assistant'; verdict: Verdict };

/**
 * A gateway answer and a local fallback are the same three outcomes, so the
 * screen has one rendering path. A low-confidence answer is escalated rather
 * than shown as a treatment, because the gateway's confidence is about evidence,
 * not tone.
 */
function verdictFromAnswer(answer: AiAnswer): Verdict {
  if (answer.gate === 'off_domain') return { kind: 'refuse', gate: 'off_domain' };
  if (answer.gate === 'not_covered' || answer.escalate) {
    return { kind: 'escalate', gate: 'not_covered' };
  }
  return {
    kind: 'answer',
    gate: 'agriculture',
    ...(answer.text ? { text: answer.text } : {}),
    ...(answer.citations.length > 0 ? { citations: answer.citations } : {}),
    ...(answer.generation ? { generation: answer.generation } : {}),
    ...(answer.caveats.length > 0 ? { caveats: answer.caveats } : {}),
  };
}

export function ScanScreen({ onOpenDealers }: { onOpenDealers: () => void }) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const services = useServices();
  const { requestIdentity } = useSession();
  const [step, setStep] = useState<Step>('capture');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [fallback, setFallback] = useState(false);
  const nextTurnId = useRef(1);
  const [expertAsked, setExpertAsked] = useState(false);
  const [crop, setCrop] = useState<string>('crop.cotton');
  const [symptom, setSymptom] = useState<string>('scan.symptom.holes');
  const [question, setQuestion] = useState('');
  /** Photos the farmer adds to the conversation after the diagnosis. */
  const [photos, setPhotos] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  /* Object URLs for attached photos, released on unmount and only then — a
     cleanup keyed on the photo list would revoke the last one while it is still
     on screen. */
  const objectUrls = useRef<string[]>([]);
  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const voice = Boolean(recognitionCtor());

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
   * The follow-up goes to the real assistant, not to a second gate copy in the
   * screen. The crop the farmer selected is the one the answer should be about;
   * the gateway adds the authenticated farmer's crops, district and interests.
   * If the gateway is unavailable, the existing deterministic gate still answers
   * and the screen says which path produced the reply.
   */
  const askAssistant = async (text: string) => {
    if (thinking) return;
    setThinking(true);
    setFallback(false);
    const id = nextTurnId.current++;
    setTurns((current) => [...current, { id, from: 'farmer', text }]);
    setQuestion('');

    const cropCode = CROP_CODES[crop];
    try {
      const answer = await services.ai.ask(text, {
        ...(cropCode ? { cropCode } : {}),
        language: locale,
      });
      setTurns((current) => [
        ...current,
        { id: nextTurnId.current++, from: 'assistant', verdict: verdictFromAnswer(answer) },
      ]);
    } catch {
      setTurns((current) => [
        ...current,
        { id: nextTurnId.current++, from: 'assistant', verdict: verdictFor(text) },
      ]);
      setFallback(true);
    } finally {
      setThinking(false);
    }
  };

  /**
   * The camera and microphone in the design's composer are actions, not
   * decoration: the photo joins the conversation, and the mic dictates. Both are
   * real — a file the farmer picked and the platform's own speech engine — rather
   * than an icon that looks like a feature.
   */
  const attachPhoto = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);
    setPhotos((current) => [...current, url]);
  };

  const dictate = () => {
    const Recognition = recognitionCtor();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = intlLocale(locale);
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript ?? '';
      setQuestion((current) => (current ? `${current} ${said}` : said));
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    setListening(true);
  };

  if (step === 'capture') {
    return (
      <div className="flex flex-col px-4 pt-4 pb-6">
        <header className="flex items-center gap-2">
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

        <Button
          className="mt-auto h-12 w-full rounded-md"
          onClick={() => setStep(isCrop ? 'symptom' : 'analysing')}
        >
          {t('common.next')}
        </Button>
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

        {photos.map((url) => (
          <div key={url} className="flex justify-end">
            <span className="rounded-lg rounded-ee-sm bg-brand p-1.5">
              <img src={url} alt={t('scan.photoAlt')} className="size-32 rounded-md object-cover" />
            </span>
          </div>
        ))}

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
          <button
            type="button"
            className="mt-2.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1.5 text-label text-brand"
          >
            <Volume2 className="size-3.5" aria-hidden />
            {t('scan.listen')}
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

        {/* Follow-up questions, answered only inside the domain and only from
            the approved sources — or handed to a person, which is a result too. */}
        {turns.map((turn) =>
          turn.from === 'farmer' ? (
            <div key={turn.id} className="flex justify-end">
              <p className="max-w-[78%] rounded-lg rounded-ee-sm bg-brand px-3.5 py-3 text-body-sm leading-relaxed text-brand-foreground">
                {turn.text}
              </p>
            </div>
          ) : turn.verdict.kind === 'answer' ? (
            <Bubble key={turn.id}>
              {turn.verdict.generation === 'retrieval' ? (
                <p className="mb-1.5 text-caption font-medium text-brand">
                  {t('scan.answer.retrieval')}
                </p>
              ) : null}
              <p className="text-body-sm leading-relaxed">
                {turn.verdict.text ?? t('scan.answer.local')}
              </p>
              {turn.verdict.generation === 'model' ? (
                <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
                  {t('scan.answer.model')}
                </p>
              ) : null}
              {turn.verdict.citations ? (
                <AnswerSources
                  citations={turn.verdict.citations}
                  locale={locale}
                  t={t}
                />
              ) : null}
            </Bubble>
          ) : turn.verdict.kind === 'refuse' ? (
            <Bubble key={turn.id}>
              <p className="text-body font-medium">{t('scan.offDomain.title')}</p>
              <p className="mt-1 text-body-sm leading-relaxed">{t('scan.offDomain.body')}</p>
            </Bubble>
          ) : (
            <Bubble key={turn.id} className="border border-amber-700/30 bg-amber-50 dark:bg-amber-500/15">
              <p className="flex items-center gap-2 text-body font-medium text-amber-900 dark:text-amber-100">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                {t('scan.notCovered.title')}
              </p>
              <p className="mt-1 text-body-sm leading-relaxed text-amber-900/85 dark:text-amber-100/85">
                {t('scan.notCovered.body')}
              </p>
              {expertAsked ? (
                <p className="mt-2 text-label font-medium text-amber-900 dark:text-amber-100">
                  {t('scan.escalate.sent')}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => requestIdentity(() => setExpertAsked(true), 'session.why.expert')}
                  className="mt-2.5 rounded-md bg-amber-900/10 px-3 py-2 text-label font-medium text-amber-900 dark:bg-amber-100/15 dark:text-amber-100"
                >
                  {t('scan.escalate.cta')}
                </button>
              )}
            </Bubble>
          ),
        )}

        {thinking ? (
          <p role="status" className="px-1 text-caption text-muted-foreground">
            {t('scan.assistant.thinking')}
          </p>
        ) : null}
        {fallback ? (
          <p role="status" className="px-1 text-caption text-muted-foreground">
            {t('scan.assistant.fallback')}
          </p>
        ) : null}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-3"
        aria-busy={thinking}
        onSubmit={(event) => {
          event.preventDefault();
          const text = question.trim();
          if (!text || thinking) return;
          void askAssistant(text);
        }}
      >
        <label className="sr-only" htmlFor="scan-question">
          {t('scan.ask')}
        </label>
        <button
          type="button"
          aria-label={t('scan.cameraAria')}
          onClick={() => fileInput.current?.click()}
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
        >
          <Camera className="size-5" aria-hidden />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => {
            attachPhoto(event.target.files?.[0]);
            // Cleared so the same photo can be attached again after a retake.
            event.target.value = '';
          }}
        />
        <input
          id="scan-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={t('scan.ask')}
          className="h-11 min-w-0 flex-1 bg-transparent text-body placeholder:text-muted-foreground focus-visible:outline-none"
        />
        {voice ? (
          <button
            type="button"
            aria-label={t('scan.micAria')}
            aria-pressed={listening}
            onClick={dictate}
            className={`grid size-9 shrink-0 place-items-center rounded-full ${
              listening ? 'bg-brand-soft text-brand' : 'text-muted-foreground'
            }`}
          >
            <Mic className="size-5" aria-hidden />
          </button>
        ) : null}
        <Button
          type="submit"
          size="icon"
          aria-label={t('scan.sendAria')}
          disabled={thinking}
          className="size-9 shrink-0 rounded-full"
        >
          <Send className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
      </form>
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

function sourceTierKey(tier: AiCitation['evidenceTier']): MessageKey {
  if (tier === 'verified') return 'scan.sources.verified';
  if (tier === 'community') return 'scan.sources.community';
  return 'scan.sources.supplementary';
}

function sourceDate(value: string | undefined, locale: Parameters<typeof intlLocale>[0]): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * The evidence under an answer. It is deliberately a list of published entries,
 * not a sentence naming a department: a model answer can only claim the sources
 * that the gateway actually retrieved.
 */
function AnswerSources({
  citations,
  locale,
  t,
}: {
  citations: AiCitation[];
  locale: Parameters<typeof intlLocale>[0];
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  const sources = citations.filter((citation) => citation.kind === 'knowledge');
  if (sources.length === 0) return null;

  return (
    <section aria-label={t('scan.sources.title')} className="mt-3 border-t border-border/60 pt-2.5">
      <p className="text-overline text-muted-foreground uppercase">{t('scan.sources.title')}</p>
      <ul className="mt-1.5 space-y-2">
        {sources.map((citation, index) => {
          const tier = citation.evidenceTier ?? 'supplementary';
          const date = citation.updatedOn ?? citation.publishedOn;
          const dateLabel = date
            ? t(citation.updatedOn ? 'scan.sources.updated' : 'scan.sources.published', {
                date: sourceDate(date, locale) ?? date,
              })
            : citation.accessedOn
              ? t('scan.sources.accessed', {
                  date: sourceDate(citation.accessedOn, locale) ?? citation.accessedOn,
                })
              : t('scan.sources.noDate');

          return (
            <li key={`${citation.slug ?? citation.label}-${index}`} className="text-label leading-snug">
              <span className="block font-medium">{citation.label}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
                <span
                  className={`rounded-sm px-1.5 py-0.5 ${
                    tier === 'verified'
                      ? 'bg-brand-soft text-brand'
                      : tier === 'community'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-100'
                  }`}
                >
                  {t(sourceTierKey(tier))}
                </span>
                <span>{citation.source ?? t('scan.sources.unknown')}</span>
                {citation.version ? <span>v{citation.version}</span> : null}
                <span>{dateLabel}</span>
              </span>
              {citation.sourceUrl?.startsWith('https://') ? (
                <a
                  href={citation.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 inline-block text-caption font-medium text-brand underline underline-offset-2"
                >
                  {t('scan.sources.open')}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
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
