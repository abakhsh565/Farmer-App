import {
  Camera,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  Search,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { EmptyState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { useChat } from '@/chat/ChatProvider';
import { ShopDetailSheet, type ShopDetail } from '@/shop/ShopDetailSheet';
import { THREAD_META, type ChatMessage } from '@/data/chat';
import { dealerNameKey } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { initialsOf } from '@/lib/initials';
import { useSession } from '@/session/SessionProvider';
import { useShopApi } from '@/shop/ShopApiProvider';
import { ShopConnectSheet, ShopRequestSheet } from '@/shop/ShopRequestSheet';
import { PhotoBubble } from '@/chat/PhotoBubble';
import { IMAGE_TARGET_BYTES, compressImage } from '@/chat/compressImage';
import { VoiceBubble } from '@/chat/VoiceBubble';
import { VoiceComposer, useRecorderFailureText } from '@/chat/VoiceComposer';
import { useVoiceRecorder } from '@/chat/useVoiceRecorder';
import {
  MEDIA_LIMITS,
  formatDuration,
  imageMimeTypeFor,
  voiceMimeTypeFor,
  voiceRecordingSupported,
} from '@/shop/api/media';

type Props = { onBrowseDealers: () => void };

/**
 * The farmer's side of the dealer conversations.
 *
 * The conversations themselves live in `ChatProvider` — above this screen, on the
 * service layer — so a message sent here is still here after a reload, and so the
 * same conversation opens whether the farmer came from the Home card, a dealer
 * row or the list below.
 *
 * A reply to a shop needs an owner, so sending is gated. The gate carries the send
 * *and* the clearing of the box, so a farmer who signs in mid-message does not
 * come back to the same words still sitting there.
 */
export function ChatScreen({ onBrowseDealers }: Props) {
  const { t } = useLocale();
  const { requestIdentity } = useSession();
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  /*
   * The shop's own thread, when this build is connected to one. The screen asks it
   * only for the things the local store could never know: the shop's current name,
   * the offers waiting on an answer, and the notices the shop has sent.
   */
  const shop = useShopApi();
  const [sheet, setSheet] = useState<null | 'credit' | 'visit'>(null);
  /* The shop page behind the name in the header. */
  const [shopInfo, setShopInfo] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const liveDealerId = shop.activeShopId ?? shop.credential?.shopId ?? null;
  /* The microphone lives on this screen rather than in the provider: it is a
     transient control, and a recording must not survive navigating away. */
  const recorder = useVoiceRecorder();
  const recorderMessage = useRecorderFailureText(recorder.failure);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  /* The gallery is a second door on purpose: `capture` forces the camera, and a
     farmer who already has the photo should not have to retake it. */
  const galleryInput = useRef<HTMLInputElement | null>(null);

  /**
   * The shop's name, which on the live source comes from the shop, not a catalogue.
   *
   * The credential names only the shop it was minted for, so using it for every
   * conversation labelled the second shop with the first one's name — or, when the
   * thread had not answered yet, with the raw shop id. The platform's own list is
   * asked first; the credential is the fallback for its own shop alone.
   */
  const nameFor = (dealerId: string) => {
    if (!shop.configured) return lineText(dealerId, t);
    const listed = shop.shops.find((row) => row.shopId === dealerId)?.name;
    if (dealerId !== liveDealerId) return listed ?? lineText(dealerId, t);
    return (
      shop.thread?.shopName ||
      listed ||
      (dealerId === shop.credential?.shopId ? shop.credential?.shopName : null) ||
      lineText(dealerId, t)
    );
  };

  /* The data the dealer's own list holds for the shop being read, which is what the
     header's page shows. A shop the list did not describe still opens, with only
     what the conversation itself knows. */
  const activeShopDetail: ShopDetail = shop.shops.find(
    (row) => row.shopId === liveDealerId,
  ) ?? {
    name: nameFor(liveDealerId ?? ''),
    city: null,
    locationLabel: null,
    phone: shop.thread?.shopPhone ?? null,
    logoUrl: null,
    isLinked: true,
  };

  const list = useMemo(
    () =>
      chat.threadKeys.map((dealerId) => {
        const messages = chat.messages(dealerId);
        return { dealerId, messages, last: messages[messages.length - 1] };
      }),
    [chat],
  );

  /*
   * The search box filters on what the list actually shows — the shop's name and
   * the last line of the conversation. A search field that accepts typing and
   * ignores it is worse than no field at all, because the farmer concludes the
   * conversation they are looking for is gone.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(({ dealerId, last }) => {
      const name = nameFor(dealerId).toLowerCase();
      const preview = previewOf(last, t).toLowerCase();
      return name.includes(needle) || preview.includes(needle);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, query, t, shop.configured, shop.thread?.shopName, shop.credential?.shopName]);

  if (chat.status === 'loading') {
    return (
      <div className="flex flex-col px-4 pt-4">
        <h1 className="text-title">{t('chat.title')}</h1>
        <LoadingState label={t('chat.loading')} />
      </div>
    );
  }

  const openMessages = chat.openThreadKey ? chat.messages(chat.openThreadKey) : null;

  if (chat.openThreadKey !== null) {
    const dealerId = chat.openThreadKey;
    const send = () => {
      const text = draft.trim();
      if (!text) return;
      requestIdentity(() => {
        chat.send(dealerId, text);
        setDraft('');
      }, 'session.why.message');
    };

    /* The recording is taken before the identity gate opens, so the bar does not sit
       on a blob that has already been handed over if the gate is dismissed. */
    const sendVoice = () => {
      const recording = recorder.take();
      if (!recording) return;
      /* The container the shop accepts, not the codec string the recorder reports:
         `audio/webm;codecs=opus` is answered with `400 unsupported mime type`. */
      const mimeType = voiceMimeTypeFor(recording.mimeType);
      requestIdentity(() => {
        void shop.sendMedia({
          kind: 'voice',
          blob: recording.blob,
          mimeType,
          durationMs: recording.durationMs,
        });
      }, 'session.why.message');
    };

    /* A photo is prepared on this phone before it is offered to the shop: a farmer
       on 2G should learn that a 9 MB photo is too large without paying to upload it,
       and a 6 MB photo is shrunk to 400 KB so the label still reads and the send
       takes seconds. */
    const sendPhoto = (file: File) => {
      const mimeType = imageMimeTypeFor(file);
      if (!mimeType) {
        setPhotoError(t('chat.photo.unsupported'));
        return;
      }
      if (file.size > MEDIA_LIMITS.maxImageBytes) {
        setPhotoError(t('chat.photo.tooLarge'));
        return;
      }
      setPhotoError(null);
      requestIdentity(() => {
        void (async () => {
          const compressed = await compressImage(file, { mimeType });
          /* Compression is best effort. If the platform could not encode, the
             original is all there is — and it is sent only if it was small enough. */
          if (compressed.blob.size > IMAGE_TARGET_BYTES && compressed.compressed) {
            setPhotoError(t('chat.photo.tooLarge'));
            return;
          }
          void shop.sendMedia({
            kind: 'image',
            blob: compressed.blob,
            mimeType: compressed.compressed ? compressed.mimeType : mimeType,
          });
        })();
      }, 'session.why.message');
    };

    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            type="button"
            aria-label={t('common.back')}
            onClick={chat.closeThread}
            className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
          >
            <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
          </button>
          {/*
            The name is the way into the shop's page: a farmer who wants to know
            where the counter is, or which number to ring, should not have to leave
            the conversation to find out.
          */}
          <button
            type="button"
            onClick={() => setShopInfo(true)}
            className="min-w-0 flex-1 text-start"
            aria-label={t('dealers.network.open')}
          >
            <span className="block truncate text-subheading">{nameFor(dealerId)}</span>
            <span className="block text-caption text-muted-foreground">{t('chat.repliesIn')}</span>
          </button>
          {/* The chevron is the affordance: the name opens the shop's page. */}
          <ChevronRight className="size-5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
        </header>

        {shopInfo ? (
          <ShopDetailSheet shop={activeShopDetail} onClose={() => setShopInfo(false)} onChat={() => {}} />
        ) : null}

        {chat.live ? (
          <div className="space-y-3 border-b border-border px-4 py-3">
            {shop.notifications.length > 0 ? (
              <div>
                <p className="text-caption font-medium text-muted-foreground">
                  {t('shop.notifications.title')}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {shop.notifications.slice(0, 3).map((notice) => (
                    <li key={notice.id} className="rounded-md bg-muted px-3 py-2">
                      <p className="text-body-sm font-medium">{notice.title}</p>
                      {notice.body ? (
                        <p className="text-caption text-muted-foreground">{notice.body}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {shop.thread && shop.thread.offers.length > 0 ? (
              <div className="rounded-lg border border-brand/40 bg-brand-soft p-3">
                <p className="text-body-sm font-medium">
                  {t('shop.offer.title', { shop: nameFor(dealerId) })}
                </p>
                {shop.thread.offers.map((offer) => (
                  <div key={offer.id} className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-body-sm">
                      {offer.amount !== null
                        ? t('shop.offer.amount', { amount: offer.amount })
                        : (offer.note ?? '')}
                    </span>
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        className="h-9 rounded-full"
                        onClick={() => void shop.answerOffer(offer.id, true, null)}
                      >
                        {t('shop.offer.accept')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 rounded-full"
                        onClick={() => void shop.answerOffer(offer.id, false, null)}
                      >
                        {t('shop.offer.decline')}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Credit and a visit are the two things a farmer asks the shop for, and
                both are rows in the shop's contract rather than messages. */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-full"
                onClick={() => setSheet('credit')}
              >
                {t('shop.request.credit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 rounded-full"
                onClick={() => setSheet('visit')}
              >
                {t('shop.request.visit')}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {openMessages && openMessages.length > 0 ? (
            openMessages.map((message: ChatMessage) => {
              const mine = message.from === 'me';
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  {message.image ? (
                    <div
                      className={`max-w-[78%] rounded-lg px-2 py-2 ${mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'}`}
                    >
                      <span className="sr-only">
                        {mine ? t('chat.you') : nameFor(dealerId)}: {t('chat.photo.label')}
                      </span>
                      <PhotoBubble
                        image={message.image}
                        mine={mine}
                        onResolve={
                          message.image.serverId
                            ? () => shop.resolveMediaUrl(message.image?.serverId)
                            : undefined
                        }
                        onRetry={
                          message.image.localId
                            ? () => void shop.retryMedia(message.image!.localId!)
                            : undefined
                        }
                        onDiscard={
                          message.image.localId
                            ? () => shop.discardMedia(message.image!.localId!)
                            : undefined
                        }
                      />
                      {message.text ? (
                        <p className="mt-1.5 px-1 text-body-sm leading-relaxed">{message.text}</p>
                      ) : null}
                    </div>
                  ) : message.audio ? (
                    <div
                      className={`max-w-[78%] rounded-lg px-3 py-2 ${mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'}`}
                    >
                      <span className="sr-only">
                        {mine ? t('chat.you') : nameFor(dealerId)}: {t('chat.voice.label')}
                      </span>
                      <VoiceBubble
                        audio={message.audio}
                        mine={mine}
                        onResolve={
                          message.audio.serverId
                            ? () => shop.resolveMediaUrl(message.audio?.serverId)
                            : undefined
                        }
                        onRetry={
                          message.audio.localId
                            ? () => void shop.retryMedia(message.audio!.localId!)
                            : undefined
                        }
                        onDiscard={
                          message.audio.localId
                            ? () => shop.discardMedia(message.audio!.localId!)
                            : undefined
                        }
                      />
                    </div>
                  ) : (
                    <p
                      className={`max-w-[78%] rounded-lg px-3 py-2 text-body-sm leading-relaxed ${
                        mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'
                      }`}
                    >
                      {/* A thread read aloud is otherwise a run of sentences with no
                          one attached to them. */}
                      <span className="sr-only">
                        {mine ? t('chat.you') : nameFor(dealerId)}:{' '}
                      </span>
                      {message.text ?? (message.key ? t(message.key) : '')}
                    </p>
                  )}
                </div>
              );
            })
          ) : (
            /* A conversation the farmer has never written to starts empty, and
               says so instead of looking like a thread that failed to load. */
            <p className="pt-6 text-center text-body-sm text-muted-foreground">
              {t('chat.thread.empty')}
            </p>
          )}
        </div>

        {recorderMessage ? (
          <p role="status" className="mx-3 mt-2 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
            {recorderMessage}
          </p>
        ) : null}

        {photoError ? (
          <p role="status" className="mx-3 mt-2 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
            {photoError}
          </p>
        ) : null}

        {recorder.status !== 'idle' ? (
          <VoiceComposer
            status={recorder.status}
            durationMs={recorder.durationMs}
            recording={recorder.recording}
            onStop={recorder.stop}
            onCancel={recorder.cancel}
            onSend={sendVoice}
          />
        ) : (
        <form
          className="border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {/* The same composer as the assistant: one bordered pill, the media doors
              inside it on the left, send on the right. It stays the same in every
              dealer conversation, whether the shop takes media or not — only the
              doors disappear, never the shape. */}
          <div className="flex items-end gap-1 rounded-lg border border-border bg-card px-1.5 py-1.5">
            <label className="sr-only" htmlFor="chat-composer">
              {t('chat.placeholder')}
            </label>

            {chat.live && shop.mediaSupported ? (
              <>
                <input
                  ref={photoInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) sendPhoto(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => photoInput.current?.click()}
                  aria-label={t('chat.photo.send')}
                  className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
                >
                  <Camera className="size-5" aria-hidden />
                </button>

                {/* The camera opens the camera; this one opens the gallery. Both are
                    needed: a farmer photographing a leaf and a farmer sending a photo
                    the shop already sent them take different paths in. */}
                <input
                  ref={galleryInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) sendPhoto(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => galleryInput.current?.click()}
                  aria-label={t('chat.photo.pick')}
                  className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
                >
                  <ImageIcon className="size-5" aria-hidden />
                </button>
              </>
            ) : null}

            <textarea
              id="chat-composer"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={t('chat.placeholder')}
              className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-body placeholder:text-muted-foreground focus-visible:outline-none"
            />

            {chat.live && shop.mediaSupported && voiceRecordingSupported() ? (
              <button
                type="button"
                onClick={() => void recorder.start()}
                aria-label={t('chat.voice.record')}
                aria-pressed={recorder.status !== 'idle'}
                className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground"
              >
                <Mic className="size-5" aria-hidden />
              </button>
            ) : null}

            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              aria-label={t('chat.send')}
              disabled={draft.trim().length === 0}
            >
              <Send className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
          </div>
        </form>
        )}

        {sheet ? <ShopRequestSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col px-4 pt-4 pb-4">
      <h1 className="text-title">{t('chat.title')}</h1>

      {chat.online ? null : (
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
          {t('chat.offline')}
        </p>
      )}

      {/* A credential the shop has revoked is not an outage: the shop replaced it.
          Saying which is which is the difference between "try again" and "ask for
          a new invitation". */}
      {shop.configured && shop.status === 'expired' ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-caption text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
          {t('shop.expired')}
        </p>
      ) : null}

      {shop.configured && shop.status === 'error' ? (
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
          {shop.failure?.message ?? t('shop.failed')}
        </p>
      ) : null}

      <div className="relative mt-3.5">
        <Search
          className="pointer-events-none absolute start-3.5 top-1/2 size-4.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('chat.search')}
          aria-label={t('chat.search')}
          className="h-12 w-full rounded-md bg-muted ps-11 pe-3.5 text-body placeholder:text-muted-foreground"
        />
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title={t('chat.empty.title')}
          body={t('chat.empty.body')}
          action={
            <div className="flex flex-col gap-2">
              {shop.configured ? (
                <Button className="h-11 rounded-full" onClick={() => setConnecting(true)}>
                  {t('shop.connect.title')}
                </Button>
              ) : null}
              <Button variant="outline" className="h-11 rounded-full" onClick={onBrowseDealers}>
                {t('nav.dealers')}
              </Button>
            </div>
          }
        />
      ) : matches.length === 0 ? (
        /* The search found nothing — which is a different sentence from having no
           conversations at all. */
        <EmptyState
          icon={MessageCircle}
          title={t('chat.searchEmpty.title')}
          body={t('chat.searchEmpty.body', { query: query.trim() })}
        />
      ) : (
        /* Rows divided by a hairline rather than boxed into cards: the design
           reads as one list of conversations, not four unrelated objects. */
        <ul className="mt-2">
          {matches.map(({ dealerId, last }, index) => {
            const meta = THREAD_META[dealerId];
            const unreadCount = chat.unread(dealerId);
            const name = nameFor(dealerId);
            const preview = previewOf(last, t);
            const first = index === 0;

            return (
              <li key={dealerId} className={first ? '' : 'border-t border-border'}>
                <button
                  type="button"
                  onClick={() => chat.openThread(dealerId)}
                  aria-label={
                    unreadCount > 0
                      ? `${t('chat.thread.open', { name })} — ${t('chat.unread', { count: unreadCount })}`
                      : t('chat.thread.open', { name })
                  }
                  className="flex w-full items-center gap-3 py-3 text-start"
                >
                  <span
                    className={`grid size-12 shrink-0 place-items-center rounded-md text-subheading ${
                      meta?.muted ? 'bg-muted text-muted-foreground' : 'bg-brand-soft text-brand'
                    }`}
                  >
                    {initialsOf(name)}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-body font-medium">{name}</span>
                      <ShieldCheck className="size-3.5 shrink-0 text-brand" aria-hidden />
                    </span>
                    <span
                      className={`mt-0.5 block truncate text-body-sm ${
                        unreadCount > 0 ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {preview || t('chat.thread.empty')}
                    </span>
                  </span>

                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    {meta ? (
                      <span className="text-caption text-muted-foreground">{t(meta.timeKey)}</span>
                    ) : null}
                    {unreadCount > 0 ? (
                      <span className="grid size-5 place-items-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
                        {unreadCount}
                      </span>
                    ) : (
                      <CheckCheck
                        className="size-4 text-muted-foreground"
                        aria-label={t('chat.read')}
                      />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {connecting ? <ShopConnectSheet onClose={() => setConnecting(false)} /> : null}
    </div>
  );
}

/**
 * The last line a conversation shows in the list.
 *
 * A voice note has no text of its own, and an empty preview would make a conversation
 * that ends on a recording look like a conversation that ended on nothing — so it
 * says what it is and how long it runs, which is what the bubble says too.
 */
function previewOf(
  message: ChatMessage | undefined,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  if (!message) return '';
  if (message.image) return t('chat.photo.label');
  if (message.audio) {
    return `${t('chat.voice.label')} · ${formatDuration(message.audio.durationMs)}`;
  }
  return message.text ?? (message.key ? t(message.key) : '');
}

/**
 * The shop's name.
 *
 * The catalogue names the shops the app ships with; a dealer the dealer system
 * knows and the catalogue does not still gets to be listed under its own name,
 * spelled out of its id rather than shown as `dealer.someShop`.
 */
function lineText(dealerId: string, t: (key: MessageKey, values?: Record<string, string | number>) => string): string {
  const key = dealerNameKey(dealerId);
  if (key) return t(key);
  const tail = dealerId.split('.').pop() ?? dealerId;
  return tail
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}
