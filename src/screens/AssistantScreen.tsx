import {
  Camera,
  ChevronDown,
  ChevronLeft,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Mic,
  TriangleAlert,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAiCredits } from '@/aiagent/AiCreditsProvider';
import { diagnosePhoto, respond, type AgentDeps, type AgentReply } from '@/aiagent/agent';
import { append, createState, hydrate, serialise, turnId, type AssistantState } from '@/assistant/store';
import { AnswerSources } from '@/components/AnswerSources';
import { SectionLabel } from '@/components/SectionLabel';
import { Button } from '@/components/ui/button';
import { dealerNameKey } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { LOCALE_REGISTRY, type Locale } from '@/i18n/locales';
import { formatMoney, formatNumber, formatRelativeTime, intlLocale } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { verdictFor, type Verdict } from '@/scan/analyze';
import { useServices } from '@/services/registry';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import { useSpeech } from '@/speech/SpeechProvider';
import { recordingSupported, startRecording, type Recording } from '@/speech/record';
import { isRateQuotable, rateRange, type AiAnswer } from '@/services/types';

/**
 * The assistant, as a conversation.
 *
 * This is the tab that replaced the camera. Asking is what a farmer does most
 * days; photographing a leaf is what they do when something looks wrong, and that
 * flow still exists — it is reached from the Home card's *Crop check* row, and by
 * attaching a photo here.
 *
 * Three pieces of layout are product decisions rather than styling:
 *
 *  · **The header and the composer do not scroll.** The thread is the only thing
 *    that moves, so the question box is always under the thumb and the way out of
 *    the conversation is always at the top. A chat whose composer can be scrolled
 *    away is a chat that feels like a form.
 *
 *  · **The thread is saved as a document.** It goes through the same
 *    `usePersistentDocument` route as every other store, so a question survives a
 *    reload, is written to the phone before the backend, and reaches the backend
 *    through the same queue when there is one. What is stored is the sentence and
 *    its source; the rich cards are live service output and are re-made, never
 *    replayed as stale numbers.
 *
 *  · **Motion carries the liveliness, not colour.** One arrival animation, three
 *    typing dots, one listening pulse. The palette stays at the product's 5–8%
 *    brand accent, which is what keeps a conversation readable at 11px in Urdu.
 *
 * The rule under all of it is the product's: the assistant may explain, but it
 * may not invent. Weather, prices, shops and stock come from the services the rest
 * of the app reads, and every answer shows the source it was read from.
 */

/** What the screen keeps for a live turn, and cannot reconstruct after a reload. */
type Live = { kind: 'reply'; reply: AgentReply } | { kind: 'local'; verdict: Verdict };

/**
 * `onBack` rather than a tab change: this screen is opened *from* a tab and hides
 * the tab bar while it is up, so the way out has to be a named destination and not
 * the absence of one.
 */
export function AssistantScreen({ onBack }: { onBack: () => void }) {
  const { t, locale } = useLocale();
  const credits = useAiCredits();
  const services = useServices();
  const location = useLocation();
  const speech = useSpeech();
  const { account } = useSession();

  /*
   * The conversation belongs to the *account* when there is one, exactly like
   * every other document: a shared phone must not hand the next person the last
   * person's questions.
   */
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<AssistantState>({
    collection: 'assistant',
    ownerId,
    seed: createState,
    hydrate,
    serialise,
  });
  const turns = document.data.turns;

  /*
   * The live half of each reply, by turn id: the weather tiles, the shop rows,
   * the evidence list. Deliberately in memory rather than in the document — they
   * are readings with an observation time, and re-showing last week's as today's
   * answer is the confidence this app exists not to fake.
   */
  const live = useRef(new Map<string, Live>());

  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recording = useRef<Recording | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const objectUrls = useRef<string[]>([]);

  const micAvailable = recordingSupported();

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      recording.current?.stop();
      speech.stop();
    },
    // The voice is stopped once, when the screen goes away; re-running this on
    // every render of `speech` would cut a reply off mid-sentence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /*
   * The thread follows the conversation: a new answer is the thing the farmer is
   * waiting for, and making them scroll for it is the failure a chat fixes.
   */
  useEffect(() => {
    const element = thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns.length, thinking]);

  /** Everything the router may read, read from the live services at call time. */
  const deps = (): AgentDeps => ({
    ask: (question, context) => services.ai.ask(question, context),
    diagnose: (imageRef, context) => services.ai.diagnose(imageRef, context),
    weather: () =>
      services.weather.current({ lat: location.activePoint.lat, lon: location.activePoint.lon }),
    /* The origin rule is the Shop tab's: a temporary area is passed explicitly,
       and with no saved location the point in play is passed too, so a guest's
       question is never refused for having no origin. */
    dealers: (radiusKm) =>
      services.dealer.search({ radiusKm, origin: location.dealerOrigin ?? location.activePoint }),
    market: () => services.market.rates(),
    radiusKm: location.radiusKm,
    language: locale,
  });

  const push = (turn: Parameters<typeof append>[1]) => {
    document.setData((current) => append(current, turn));
  };

  /**
   * One question, one credit, charged before the request.
   *
   * A refusal is answered with the reason and the time the allowance returns, not
   * with a spinner for work that was never going to happen.
   */
  const ask = async (text: string) => {
    const question = text.trim();
    if (thinking || question.length === 0) return;
    if (!credits.spend('chat')) {
      toast.error(t(credits.refusedReason('chat') ?? 'agent.credits.exhausted'));
      return;
    }

    const asked = { id: turnId(), at: Date.now(), role: 'farmer' as const, text: question };
    push(asked);
    setInput('');
    setThinking(true);

    const reply = await respond(question, deps());

    /*
     * A failed call falls back to the offline gate rather than to nothing. The
     * deterministic rules in `scan/analyze` still refuse an off-topic question and
     * still hand an uncovered one to a person, and the screen says which of the
     * two answered — that sentence is the difference between a degraded answer
     * and a broken app.
     */
    const outcome: Live =
      reply.kind === 'failed' ? { kind: 'local', verdict: verdictFor(question) } : { kind: 'reply', reply };

    const answered = { id: turnId(), at: Date.now(), role: 'assistant' as const, ...summarise(outcome, t, locale) };
    live.current.set(answered.id, outcome);
    push(answered);
    setThinking(false);
  };

  /**
   * A photo is a diagnosis, not a chat turn, and it costs what a diagnosis costs.
   * The same service the Crop check screen uses, reached from the conversation.
   */
  const sendPhoto = async (file: File | undefined) => {
    if (!file || thinking) return;
    if (!credits.spend('scan')) {
      toast.error(t(credits.refusedReason('scan') ?? 'agent.credits.exhausted'));
      return;
    }

    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);

    const sent = {
      id: turnId(),
      at: Date.now(),
      role: 'farmer' as const,
      text: '',
      photo: file.name,
    };
    push(sent);
    setThinking(true);

    const reply = await diagnosePhoto(url, deps());
    const outcome: Live = { kind: 'reply', reply };
    const answered = { id: turnId(), at: Date.now(), role: 'assistant' as const, ...summarise(outcome, t, locale) };
    live.current.set(answered.id, outcome);
    push(answered);
    setThinking(false);
  };

  /**
   * The microphone: record, transcribe, then fill the box.
   *
   * Not the platform's recogniser. That was tried, and on this very build it was
   * the reported bug: the control said "Listening…" and nothing was ever heard,
   * because the constructor exists in the packaged Chromium without a speech
   * service behind it. Recording works everywhere the app ships, and the words are
   * made by our own Urdu endpoint.
   *
   * The box is filled rather than sent, so the farmer can see what was heard and
   * correct it before spending a credit — a misheard word must not become a
   * question they did not ask.
   */
  const toggleRecording = () => {
    if (listening) {
      recording.current?.stop();
      return;
    }

    const started = startRecording({
      onText: (said) => setInput((current) => (current.length > 0 ? `${current} ${said}` : said)),
      onFailure: (reason) =>
        toast.error(
          t(
            reason === 'denied'
              ? 'voice.micDenied'
              : reason === 'empty'
                ? 'voice.micEmpty'
                : 'voice.micFailed',
          ),
        ),
      onEnd: () => setListening(false),
    });

    recording.current = started;
    setListening(started !== null);
  };

  const startOver = () => {
    live.current.clear();
    document.setData(createState());
    speech.stop();
    setInput('');
  };

  const remainingLabel = t('agent.credits.count', {
    left: formatNumber(credits.remaining, locale),
    total: formatNumber(credits.allowance, locale),
  });

  const speak = (turn: { id: string; text: string; detail?: string }) => {
    const speakingThis = speech.speaking === turn.id;
    if (speakingThis) {
      speech.stop();
      return;
    }
    speech.speak({
      id: turn.id,
      text: [turn.text, turn.detail].filter(Boolean).join('. '),
      lang: LOCALE_REGISTRY[locale].tag,
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── header: fixed to the top of the screen, never scrolled away ─────── */}
      <header className="flex items-center gap-2 border-b border-border bg-background px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('common.back')}
          className="-ms-1 grid size-9 shrink-0 place-items-center rounded-full text-foreground"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-inverted">
          <Sparkles className="size-4 text-brand" aria-hidden />
        </span>
        <h1 className="min-w-0 flex-1 truncate text-subheading">{t('agent.title')}</h1>

        {/*
          The allowance, where a chat app puts its balance, and a panel that says
          how it is spent. The old line under the title stated a number without
          ever explaining the rule behind it, which made "97 of 100" look like a
          score; opening it is where the farmer learns that a question costs one,
          a photo costs five, and the hundred comes back at midnight.
        */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setCreditsOpen((open) => !open)}
            aria-expanded={creditsOpen}
            aria-controls="assistant-credits"
            aria-label={t('agent.credits.title')}
            className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-caption font-medium tabular-nums text-foreground"
          >
            <span>{formatNumber(credits.remaining, locale)}</span>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span className="text-muted-foreground">
              {formatNumber(credits.allowance, locale)}
            </span>
            <ChevronDown
              className={`size-3.5 text-muted-foreground motion-safe:transition-transform ${
                creditsOpen ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>

          {creditsOpen ? (
            <>
              {/* Tap-anywhere-else closes it, and it sits under the panel rather
                  than over the thread, so the thread keeps its scroll position. */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setCreditsOpen(false)}
                className="fixed inset-0 z-40 cursor-default"
              />
              <div
                id="assistant-credits"
                role="dialog"
                aria-label={t('agent.credits.title')}
                className="absolute end-0 top-11 z-50 w-64 animate-fade rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
              >
                <p className="text-label font-medium">{t('agent.credits.title')}</p>
                <p className="mt-1 text-heading tabular-nums">{remainingLabel}</p>
                <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
                  {t('agent.credits.costs', {
                    chat: credits.costOf('chat'),
                    scan: credits.costOf('scan'),
                  })}
                </p>
                <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
                  {t('agent.credits.resets', {
                    time: new Intl.DateTimeFormat(intlLocale(locale), {
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(credits.resetsAt)),
                  })}
                </p>
              </div>
            </>
          ) : null}
        </div>

        {turns.length > 0 ? (
          <button
            type="button"
            onClick={startOver}
            aria-label={t('assist.newChat')}
            className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
          >
            <RotateCcw className="size-4" aria-hidden />
          </button>
        ) : null}
      </header>

      {/* ── thread: the only part that scrolls ──────────────────────────────── */}
      <div
        ref={thread}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <div className="animate-fade pt-6">
            <p className="mx-auto grid size-14 place-items-center rounded-full bg-brand-soft">
              <Sparkles className="size-6 text-brand" aria-hidden />
            </p>
            <h2 className="mt-4 text-center text-title">{t('assist.empty.title')}</h2>
            <p className="mx-auto mt-1.5 max-w-[32ch] text-center text-body-sm text-muted-foreground">
              {t('assist.empty.body')}
            </p>

            <section className="mt-5" aria-label={t('agent.suggestions')}>
              <SectionLabel>{t('agent.suggestions')}</SectionLabel>
              <ul className="mt-2 flex flex-wrap gap-2">
                {(
                  [
                    { key: 'agent.suggest.weather', prompt: t('agent.suggest.weatherPrompt') },
                    { key: 'agent.suggest.dealers', prompt: t('agent.suggest.dealersPrompt') },
                    { key: 'agent.suggest.rate', prompt: t('agent.suggest.ratePrompt') },
                    { key: 'agent.suggest.pest', prompt: t('agent.suggest.pestPrompt') },
                  ] as ReadonlyArray<{ key: MessageKey; prompt: string }>
                ).map(({ key, prompt }) => (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => void ask(prompt)}
                      className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-2 text-body-sm font-medium leading-none text-muted-foreground"
                    >
                      <Sparkles className="size-3.5" aria-hidden />
                      {t(key)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : null}

        {turns.map((turn) =>
          turn.role === 'farmer' ? (
            <div key={turn.id} className="flex animate-rise justify-end">
              <p className="max-w-[85%] rounded-lg rounded-ee-sm bg-brand px-3.5 py-2.5 text-body-sm leading-relaxed text-brand-foreground">
                {turn.photo ? (
                  <>
                    <Camera className="me-1.5 inline size-3.5" aria-hidden />
                    {t('agent.photoSent', { name: turn.photo })}
                  </>
                ) : (
                  <>
                    <span className="sr-only">{t('agent.you')}: </span>
                    {turn.text}
                  </>
                )}
              </p>
            </div>
          ) : (
            <AssistantTurnBubble
              key={turn.id}
              turn={turn}
              outcome={live.current.get(turn.id)}
              speaking={speech.speaking === turn.id}
              onSpeak={() => speak(turn)}
            />
          ),
        )}

        {thinking ? (
          <div className="flex animate-fade gap-2">
            <AssistantFace />
            <div className="rounded-lg rounded-ss-sm bg-muted px-3.5 py-3">
              <p role="status" aria-live="polite" className="flex items-center gap-1.5">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-typing rounded-full bg-muted-foreground"
                    style={{ animationDelay: `${dot * 140}ms` }}
                  />
                ))}
                <span className="sr-only">{t('agent.thinking')}</span>
                <span className="ms-0.5 text-caption text-muted-foreground" aria-hidden>
                  {t('agent.thinking')}
                </span>
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── composer: fixed above the tab bar, never scrolled away ──────────── */}
      <form
        className="border-t border-border bg-background px-3 pb-2.5 pt-2.5"
        aria-busy={thinking}
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
      >
        <div className="flex items-end gap-1 rounded-lg border border-border bg-card px-1.5 py-1.5">
          <button
            type="button"
            onClick={() => filePicker.current?.click()}
            aria-label={t('agent.attach')}
            className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
          >
            <Camera className="size-5" aria-hidden />
          </button>
          <input
            ref={filePicker}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              void sendPhoto(event.target.files?.[0]);
              // Cleared so the same photo can be sent again after a retake.
              event.target.value = '';
            }}
          />

          <label className="sr-only" htmlFor="assistant-composer">
            {t('agent.placeholder')}
          </label>
          <textarea
            id="assistant-composer"
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask(input);
              }
            }}
            placeholder={listening ? t('assist.listening') : t('agent.placeholder')}
            className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-body placeholder:text-muted-foreground focus-visible:outline-none"
          />

          {micAvailable ? (
            <button
              type="button"
              onClick={toggleRecording}
              aria-label={t('assist.mic')}
              aria-pressed={listening}
              className={`grid size-9 shrink-0 place-items-center rounded-full ${
                listening ? 'animate-mic-pulse bg-brand-soft text-brand' : 'text-muted-foreground'
              }`}
            >
              <Mic className="size-5" aria-hidden />
            </button>
          ) : null}

          <Button
            type="submit"
            size="icon"
            className="size-9 shrink-0 rounded-full"
            aria-label={t('agent.send')}
            disabled={thinking || input.trim().length === 0}
          >
            <Send className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   The stored half of an answer
   ═══════════════════════════════════════════════════════════════════════════ */

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * What a turn keeps once the screen is gone.
 *
 * The lead sentence, one supporting line, and a label for the shape of the
 * answer. Everything a reload needs to show the conversation honestly, and
 * nothing that would let a week-old reading pretend to be a new one.
 */
function summarise(
  outcome: Live,
  t: Translate,
  locale: Locale,
): { text: string; detail?: string; kind: 'answer' | 'weather' | 'dealers' | 'market' | 'scan' | 'failed' } {
  if (outcome.kind === 'local') {
    const { verdict } = outcome;
    if (verdict.kind === 'refuse') {
      return { text: t('scan.offDomain.title'), detail: t('scan.assistant.fallback'), kind: 'failed' };
    }
    if (verdict.kind === 'escalate') {
      return { text: t('scan.notCovered.title'), detail: t('scan.assistant.fallback'), kind: 'failed' };
    }
    const labels = (verdict.citations ?? []).map((citation) => citation.label).join(' · ');
    return {
      text: verdict.text ?? t('scan.answer.local'),
      detail: [t('scan.assistant.fallback'), labels].filter(Boolean).join(' · '),
      kind: 'answer',
    };
  }

  const { reply } = outcome;

  if (reply.kind === 'failed') {
    return { text: t('agent.failed'), detail: reply.message, kind: 'failed' };
  }

  if (reply.kind === 'weather') {
    const reading = reply.reading;
    const text =
      reading.status === 'failing'
        ? t('agent.weather.unavailable')
        : t('agent.weather.lead', {
            condition: reading.data.conditionText ?? t('agent.value.unknown'),
          });
    const numbers = [
      reading.data.tempC === null
        ? null
        : t('agent.value.temp', { value: formatNumber(reading.data.tempC, locale) }),
      reading.data.humidityPct === null
        ? null
        : t('agent.value.percent', { value: formatNumber(reading.data.humidityPct, locale) }),
      reading.data.windKph === null
        ? null
        : t('agent.value.wind', { value: formatNumber(reading.data.windKph, locale) }),
      t('agent.source', {
        source: reading.sourceLabel,
        age: formatRelativeTime(reading.observedAt, Date.now(), t),
      }),
    ].filter(Boolean);

    return { text, detail: numbers.join(' · '), kind: 'weather' };
  }

  if (reply.kind === 'dealers') {
    const text = reply.failed
      ? t('agent.dealers.failed')
      : reply.dealers.length === 0
        ? t('agent.dealers.none', { km: formatNumber(reply.radiusKm, locale) })
        : t('agent.dealers.lead', {
            count: reply.dealers.length,
            km: formatNumber(reply.radiusKm, locale),
          });
    const names = reply.dealers
      .slice(0, 3)
      .map((dealer) => (dealerNameKey(dealer.id) ? t(dealerNameKey(dealer.id) as MessageKey) : dealer.name))
      .join(' · ');
    return { text, detail: [names, reply.source].filter(Boolean).join(' · '), kind: 'dealers' };
  }

  if (reply.kind === 'market') {
    return {
      text: reply.failed ? t('agent.market.failed') : t('agent.market.lead'),
      detail: reply.rates
        .slice(0, 3)
        .map((rate) => (rate.nameKey ? t(rate.nameKey) : rate.nameEn))
        .join(' · '),
      kind: 'market',
    };
  }

  if (reply.kind === 'scan') {
    return {
      text: reply.result.diagnosis ?? t('scan.notCovered.title'),
      detail: t('agent.confidence', { pct: reply.result.confidence }),
      kind: 'scan',
    };
  }

  const answer = reply.answer;
  if (answer.gate !== 'agriculture') {
    return {
      text: answer.refusalReasonKey ? t(answer.refusalReasonKey) : t('scan.notCovered.title'),
      kind: 'answer',
    };
  }

  return {
    text: answer.text ?? t('scan.answer.local'),
    detail: [t('agent.confidence', { pct: answer.confidence })]
      .concat(answer.citations.map((citation) => citation.label))
      .join(' · '),
    kind: 'answer',
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   One assistant turn
   ═══════════════════════════════════════════════════════════════════════════ */

function AssistantTurnBubble({
  turn,
  outcome,
  speaking,
  onSpeak,
}: {
  turn: { id: string; text: string; detail?: string };
  outcome: Live | undefined;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const { t } = useLocale();

  return (
    <div className="flex animate-rise gap-2">
      <AssistantFace />
      <div className="min-w-0 max-w-[86%] rounded-lg rounded-ss-sm bg-muted px-3.5 py-3">
        {outcome ? (
          <LiveReply outcome={outcome} />
        ) : (
          /* Reloaded from storage: the sentence and its source, not a replay of
             numbers that were true an hour ago. */
          <>
            <p className="whitespace-pre-line text-body-sm leading-relaxed">{turn.text}</p>
            {turn.detail ? (
              <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">{turn.detail}</p>
            ) : null}
          </>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSpeak}
            aria-label={speaking ? t('assist.stop') : t('assist.listen')}
            className="inline-flex items-center gap-1.5 rounded-full bg-background/60 px-2.5 py-1 text-caption font-medium text-brand"
          >
            {speaking ? (
              <Square className="size-3" aria-hidden />
            ) : (
              <Volume2 className="size-3.5" aria-hidden />
            )}
            {speaking ? t('assist.stop') : t('assist.listen')}
          </button>
          <span className="text-caption text-muted-foreground">{t('agent.notExpert')}</span>
        </div>
      </div>
    </div>
  );
}

function AssistantFace() {
  return (
    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-inverted">
      <Sparkles className="size-3.5 text-brand" aria-hidden />
    </span>
  );
}

/**
 * The live reply, rendered by the source that produced it.
 *
 * Every branch says where its numbers came from, because that is the promise the
 * assistant makes: it may explain, it may not invent.
 */
function LiveReply({ outcome }: { outcome: Live }) {
  const { t, locale } = useLocale();

  if (outcome.kind === 'local') {
    const verdict = outcome.verdict;
    if (verdict.kind === 'refuse') {
      return (
        <>
          <p className="text-body font-medium">{t('scan.offDomain.title')}</p>
          <p className="mt-1 text-body-sm leading-relaxed">{t('scan.offDomain.body')}</p>
          <p className="mt-2 text-caption text-muted-foreground">{t('scan.assistant.fallback')}</p>
        </>
      );
    }
    if (verdict.kind === 'escalate') {
      return (
        <>
          <p className="flex items-center gap-2 text-body font-medium text-amber-900 dark:text-amber-100">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {t('scan.notCovered.title')}
          </p>
          <p className="mt-1 text-body-sm leading-relaxed text-amber-900/85 dark:text-amber-100/85">
            {t('scan.notCovered.body')}
          </p>
          <ExpertCta />
          <p className="mt-2 text-caption text-muted-foreground">{t('scan.assistant.fallback')}</p>
        </>
      );
    }
    return (
      <>
        <p className="text-body-sm leading-relaxed">{verdict.text ?? t('scan.answer.local')}</p>
        {verdict.citations ? (
          <AnswerSources citations={verdict.citations} locale={locale} t={t} />
        ) : null}
        <p className="mt-2 text-caption text-muted-foreground">{t('scan.assistant.fallback')}</p>
      </>
    );
  }

  const reply = outcome.reply;

  if (reply.kind === 'failed') {
    return (
      <>
        <p className="flex items-center gap-1.5 text-body-sm text-amber-700 dark:text-amber-100">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {t('agent.failed')}
        </p>
        <p className="mt-1 text-caption text-muted-foreground">{reply.message}</p>
      </>
    );
  }

  if (reply.kind === 'weather') {
    const reading = reply.reading;
    const numbers: ReadonlyArray<{ key: MessageKey; value: string }> = [
      {
        key: 'agent.stat.temp',
        value:
          reading.data.tempC === null
            ? t('agent.value.unknown')
            : t('agent.value.temp', { value: formatNumber(reading.data.tempC, locale) }),
      },
      {
        key: 'agent.stat.humidity',
        value:
          reading.data.humidityPct === null
            ? t('agent.value.unknown')
            : t('agent.value.percent', { value: formatNumber(reading.data.humidityPct, locale) }),
      },
      {
        key: 'agent.stat.wind',
        value:
          reading.data.windKph === null
            ? t('agent.value.unknown')
            : t('agent.value.wind', { value: formatNumber(reading.data.windKph, locale) }),
      },
      {
        key: 'agent.stat.feels',
        value:
          reading.data.feelsLikeC === null
            ? t('agent.value.unknown')
            : t('agent.value.temp', { value: formatNumber(reading.data.feelsLikeC, locale) }),
      },
    ];

    return (
      <>
        <p className="text-body-sm">
          {reading.status === 'failing'
            ? t('agent.weather.unavailable')
            : t('agent.weather.lead', {
                condition: reading.data.conditionText ?? t('agent.value.unknown'),
              })}
        </p>
        {reading.status === 'failing' ? null : (
          <dl className="mt-2.5 grid grid-cols-2 gap-2">
            {numbers.map(({ key, value }) => (
              <div key={key} className="rounded-md bg-background/60 px-2.5 py-2">
                <dt className="text-caption text-muted-foreground">{t(key)}</dt>
                <dd className="text-body-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <Source
          label={reading.sourceLabel}
          age={formatRelativeTime(reading.observedAt, Date.now(), t)}
          stale={reading.freshness !== 'fresh'}
        />
      </>
    );
  }

  if (reply.kind === 'dealers') {
    return (
      <>
        <p className="text-body-sm">
          {reply.failed
            ? t('agent.dealers.failed')
            : reply.dealers.length === 0
              ? t('agent.dealers.none', { km: formatNumber(reply.radiusKm, locale) })
              : t('agent.dealers.lead', {
                  count: reply.dealers.length,
                  km: formatNumber(reply.radiusKm, locale),
                })}
        </p>
        {reply.dealers.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {reply.dealers.slice(0, 5).map((dealer) => {
              const key = dealerNameKey(dealer.id);
              return (
                <li key={dealer.id} className="rounded-md bg-background/60 px-2.5 py-2">
                  <p className="text-body-sm font-medium">{key ? t(key) : dealer.name}</p>
                  <p className="text-caption text-muted-foreground">
                    {[
                      t('common.km', { km: formatNumber(dealer.distanceKm, locale) }),
                      dealer.verifiedAt !== null
                        ? t('dealers.verified')
                        : t('dealer.profile.unverified'),
                      dealer.openNow === true
                        ? t('agent.dealers.open')
                        : dealer.openNow === false
                          ? t('agent.dealers.closed')
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : null}
        <Source
          label={reply.source}
          age={formatRelativeTime(reply.observedAt, Date.now(), t)}
          stale={reply.failed}
        />
      </>
    );
  }

  if (reply.kind === 'market') {
    const now = Date.now();
    return (
      <>
        <p className="text-body-sm">{reply.failed ? t('agent.market.failed') : t('agent.market.lead')}</p>
        <ul className="mt-2 space-y-1.5">
          {reply.rates.map((rate) => {
            const range = rateRange([rate]);
            const current = isRateQuotable(rate, now);
            return (
              <li
                key={`${rate.commodity}-${rate.marketName}`}
                className="rounded-md bg-background/60 px-2.5 py-2"
              >
                <p className="text-body-sm font-medium">
                  {rate.nameKey ? t(rate.nameKey) : rate.nameEn}
                </p>
                <p className="text-caption text-muted-foreground">
                  {range
                    ? t('agent.market.range', {
                        min: formatMoney(range.min, locale, t),
                        max: formatMoney(range.max, locale, t),
                        market: rate.marketName,
                      })
                    : t('agent.market.unreported', { market: rate.marketName })}
                </p>
                {current ? null : (
                  <p className="text-caption text-amber-700 dark:text-amber-100">
                    {t('agent.market.stale')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <Source label={reply.source} age={formatRelativeTime(reply.observedAt, Date.now(), t)} />
      </>
    );
  }

  if (reply.kind === 'scan') {
    const result = reply.result;
    return (
      <>
        <p className="text-body-sm font-medium">{t('agent.scan.title')}</p>
        <p className="mt-1 text-body-sm">{result.diagnosis ?? t('scan.notCovered.title')}</p>
        <p className="mt-1 text-caption text-muted-foreground">
          {t('agent.confidence', { pct: result.confidence })}
        </p>
        {result.uncertaintyKey ? (
          <p className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-caption text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
            {t(result.uncertaintyKey)}
          </p>
        ) : null}
        {result.escalate ? (
          <p className="mt-1.5 text-caption text-muted-foreground">{t('agent.escalate')}</p>
        ) : null}
      </>
    );
  }

  const answer: AiAnswer = reply.answer;

  /*
   * A refusal and a hand-off are different answers, and what separates them is
   * what the farmer can do next: one says this is not a farming question, the
   * other says nobody has published an answer yet and offers a person. They used
   * to be three branches inside the scan screen; the conversation is where an
   * uncovered question lands now, so the expert hand-off moved here with it.
   */
  if (answer.gate === 'off_domain') {
    return (
      <>
        <p className="text-body font-medium">{t('scan.offDomain.title')}</p>
        <p className="mt-1 text-body-sm leading-relaxed">{t('scan.offDomain.body')}</p>
      </>
    );
  }

  if (answer.gate === 'not_covered' || answer.escalate) {
    return (
      <>
        <p className="flex items-center gap-2 text-body font-medium text-amber-900 dark:text-amber-100">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {t('scan.notCovered.title')}
        </p>
        <p className="mt-1 text-body-sm leading-relaxed text-amber-900/85 dark:text-amber-100/85">
          {t('scan.notCovered.body')}
        </p>
        <ExpertCta />
      </>
    );
  }

  return (
    <>
      {answer.generation === 'retrieval' ? (
        <p className="mb-1.5 text-caption font-medium text-brand">{t('scan.answer.retrieval')}</p>
      ) : null}
      <p className="whitespace-pre-line text-body-sm leading-relaxed">{answer.text}</p>
      <p className="mt-2 text-caption text-muted-foreground">
        {answer.generation === 'model' ? t('scan.answer.model') : t('agent.confidence', { pct: answer.confidence })}
      </p>
      {answer.caveats.map((caveat) => (
        <p key={caveat} className="mt-1.5 text-caption text-muted-foreground">
          {caveat}
        </p>
      ))}
      <AnswerSources citations={answer.citations} locale={locale} t={t} />
      {answer.escalate ? (
        <p className="mt-2 text-caption text-muted-foreground">{t('agent.escalate')}</p>
      ) : null}
    </>
  );
}

/**
 * Asking a person, when the app has no answer.
 *
 * Accountable, so it is gated like every other accountable action: the sheet is
 * raised first, and the request is made only for a farmer who has an identity.
 */
function ExpertCta() {
  const { t } = useLocale();
  const { requestIdentity } = useSession();
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p className="mt-2 text-label font-medium text-amber-900 dark:text-amber-100">
        {t('scan.escalate.sent')}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => requestIdentity(() => setSent(true), 'session.why.expert')}
      className="mt-2.5 rounded-md bg-amber-900/10 px-3 py-2 text-label font-medium text-amber-900 dark:bg-amber-100/15 dark:text-amber-100"
    >
      {t('scan.escalate.cta')}
    </button>
  );
}

/** Where a reading came from, and how old it is. */
function Source({ label, age, stale }: { label: string; age: string; stale?: boolean }) {
  const { t } = useLocale();
  return (
    <p
      className={`mt-2 flex items-center gap-1.5 text-caption ${
        stale ? 'text-amber-700 dark:text-amber-100' : 'text-muted-foreground'
      }`}
    >
      {stale ? <TriangleAlert className="size-3 shrink-0" aria-hidden /> : null}
      {t('agent.source', { source: label, age })}
    </p>
  );
}
