import {
  Camera,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  Search,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { PendingRecording } from '@/chat/useVoiceRecorder';
import { deliveryOf, type MessageDelivery } from '@/chat/messageStatus';
import {
  MEDIA_LIMITS,
  formatDuration,
  imageMimeTypeFor,
  voiceMimeTypeFor,
  voiceRecordingSupported,
} from '@/shop/api/media';

type Props = {
  onBrowseDealers: () => void;
  /** Opens a shop's own page, which is what its name in the thread header means. */
  onOpenDealer?: (dealerId: string) => void;
};

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
export function ChatScreen({ onBrowseDealers, onOpenDealer }: Props) {
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
  /*
   * The name behind a conversation.
   *
   * A conversation is a shop the dealer network knows, and the network is the only
   * source that answers for every one of them. The header used to fall through to
   * the raw id, and then to the nearby-dealer directory — which is scoped to where
   * the farmer is standing, so a conversation with a dealer in another city lost
   * its name when the farmer moved. The thread, the platform's own shop list and
   * the credential are all account facts and all available anywhere.
   */
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
  /* Why the last line typed here did not reach the shop. Kept until a send works,
     because the draft is kept too: the farmer should not have to remember it. */
  const [sendError, setSendError] = useState<string | null>(null);
  /* The message whose details are being looked at, if any. */
  const [messageInfo, setMessageInfo] = useState<ChatMessage | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  /* The gallery is a second door on purpose: `capture` forces the camera, and a
     farmer who already has the photo should not have to retake it. */
  const galleryInput = useRef<HTMLInputElement | null>(null);

  /**
   * One recording, handed to the shop.
   *
   * Kept above the thread's render for one reason: the send arrow on the recording
   * bar has to be able to stop the microphone and upload in the same press, and the
   * recording only exists once `MediaRecorder` fires `onstop`. The effect below is
   * that hand-off; this function is what both paths (preview's send, and the arrow)
   * call, so the two can never drift apart in container choice or duration.
   */
  const sendRecording = useCallback(
    (recording: PendingRecording) => {
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
    },
    [requestIdentity, shop],
  );

  /*
   * A recording the farmer ended with the send arrow.
   *
   * The arrow stops the recorder; the blob is only complete when `onstop` has run.
   * Waiting for `preview` here is that moment, and the flag makes sure a recording
   * that merely reached the cap (or was played back) is never sent on its own.
   *
   * A failed or empty stop returns to `idle` instead, and the flag is cleared in the
   * same breath so the next recording starts with a clean slate.
   */
  const sendAfterStop = useRef(false);
  useEffect(() => {
    if (!sendAfterStop.current) return;
    if (recorder.status === 'preview' && recorder.recording) {
      sendAfterStop.current = false;
      const recording = recorder.take();
      if (recording) sendRecording(recording);
      return;
    }
    if (recorder.status === 'idle') sendAfterStop.current = false;
  }, [recorder, sendRecording]);

  /**
   * The shop's name, which on the live source comes from the shop, not a catalogue.
   *
   * The credential names only the shop it was minted for, so using it for every
   * conversation labelled the second shop with the first one's name — or, when the
   * thread had not answered yet, with the raw shop id. The platform's own list is
   * asked first; the credential is the fallback for its own shop alone.
   */
  const nameFor = (dealerId: string) => {
    const fromConversation = chat.conversations.find((row) => row.dealerId === dealerId)?.name;
    if (fromConversation) return fromConversation;
    const listed = shop.shops.find((row) => row.shopId === dealerId)?.name;
    if (listed) return listed;
    if (dealerId === liveDealerId) {
      const fromThread = shop.threads[dealerId]?.shopName ?? shop.thread?.shopName;
      if (fromThread) return fromThread;
    }
    if (dealerId === shop.credential?.shopId && shop.credential?.shopName) {
      return shop.credential.shopName;
    }
    return lineText(dealerId, t);
  };

  /* The data the dealer's own list holds for the shop being read, which is what the
     header's page shows. A shop the list did not describe still opens, with only
     what the conversation itself knows. */
  /*
   * A reply that arrives while its conversation is open is already read.
   *
   * Opening a thread marks its notices read once, but the shop's reply arrives
   * afterwards, and a badge counting a message the farmer is looking at would be
   * wrong. This runs whenever the outbox changes, and clears only the open
   * conversation.
   */
  const pendingNotices = shop.notifications.length;
  useEffect(() => {
    if (!chat.live || chat.openThreadKey === null) return;
    shop.markNotificationsRead(chat.openThreadKey);
    /* Keyed on the count, not on the shop object or the array: those are replaced on
       every refresh, and an effect that ran on each one would keep asking to mark
       the same notices read. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.live, chat.openThreadKey, pendingNotices]);

  const activeConversation = chat.conversations.find((row) => row.dealerId === liveDealerId);
  const activeShopDetail: ShopDetail = shop.shops.find(
    (row) => row.shopId === liveDealerId,
  ) ?? {
    name: activeConversation?.name ?? nameFor(liveDealerId ?? ''),
    city: null,
    locationLabel: null,
    phone: activeConversation?.phone ?? shop.thread?.shopPhone ?? null,
    logoUrl: null,
    isLinked: true,
  };

  const list = chat.conversations;

  /*
   * The search box filters on what the list actually shows — the shop's name, its
   * number and the last line of the conversation. A search field that accepts
   * typing and ignores it is worse than no field at all, because the farmer
   * concludes the conversation they are looking for is gone.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(({ dealerId, name, phone, lastMessage }) => {
      const label = (name || nameFor(dealerId)).toLowerCase();
      const preview = previewOf(lastMessage, t).toLowerCase();
      const number = (phone ?? '').replace(/\s+/g, '');
      return (
        label.includes(needle) ||
        preview.includes(needle) ||
        (number.length > 0 && number.includes(needle.replace(/\s+/g, '')))
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, query, t, shop.configured, shop.shops, shop.credential?.shopName]);

  /*
   * The thread follows its newest line.
   *
   * Opening a conversation and receiving a reply should both leave the farmer at
   * the bottom of it — the place a message arrives. Without this the view stayed
   * where the previous conversation was scrolled, so a new message could land
   * above the fold and the thread looked like it had lost its content.
   */
  const threadScroll = useRef<HTMLDivElement | null>(null);
  const openMessageCount = chat.openThreadKey ? chat.messages(chat.openThreadKey).length : 0;
  useEffect(() => {
    const node = threadScroll.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat.openThreadKey, openMessageCount]);

  /**
   * Opens one conversation, at the shop network first.
   *
   * The list is a list of shops, and the shop backend keeps one thread per shop. A
   * row that only changed the screen would show the previous dealer's history and
   * send the next line to the previous dealer — the failure this screen used to
   * have when its rows bypassed `App.openThread`.
   */
  const openConversation = (dealerId: string) => {
    if (chat.live && dealerId !== liveDealerId) {
      void shop.openShopConversation(dealerId);
    }
    chat.openThread(dealerId);
  };

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
    /*
     * A line of text, handed to the shop.
     *
     * The box used to be cleared the moment the send was *started*, so a refusal —
     * or a conversation the shop backend had never opened — looked like a message
     * that had gone. It is cleared only after the shop accepted the line, and a
     * refusal leaves the words in place with the reason above the composer.
     */
    const deliver = async (text: string) => {
      const accepted = chat.live ? await shop.send(text, dealerId) : chat.send(dealerId, text);
      if (!accepted) {
        setSendError(shop.failure?.message ?? t('chat.send.failed'));
        return;
      }
      setSendError(null);
      setDraft('');
    };

    const send = () => {
      const text = draft.trim();
      if (!text) return;
      requestIdentity(() => {
        void deliver(text);
      }, 'session.why.message');
    };

    /* The recording is taken before the identity gate opens, so the bar does not sit
       on a blob that has already been handed over if the gate is dismissed. */
    const sendVoice = () => {
      const recording = recorder.take();
      if (!recording) return;
      sendRecording(recording);
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
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
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
            {activeShopDetail.phone ? (
              <span
                dir="ltr"
                className="block truncate text-caption tabular-nums text-muted-foreground"
              >
                {activeShopDetail.phone}
              </span>
            ) : (
              <span className="block truncate text-caption text-muted-foreground">
                {t('chat.repliesIn')}
              </span>
            )}
          </button>
          {/* The chevron is the affordance: the name opens the shop's page. */}
          <ChevronRight className="size-5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
        </header>

        {shopInfo ? (
          <ShopDetailSheet
            shop={activeShopDetail}
            onClose={() => setShopInfo(false)}
            onChat={() => {}}
            onOpenDealer={
              onOpenDealer
                ? () => {
                    setShopInfo(false);
                    onOpenDealer(dealerId);
                  }
                : undefined
            }
          />
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

        <div ref={threadScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {openMessages && openMessages.length > 0 ? (
            openMessages.map((message: ChatMessage) => {
              const mine = message.from === 'me';
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  {/* The bubble and its line of time/status are one column, so a
                      double tick sits under the message it belongs to rather than
                      floating at the edge of the screen. */}
                  <div className={`flex min-w-0 max-w-[78%] flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
                  {message.image ? (
                    <div
                      className={`max-w-full rounded-lg px-2 py-2 ${mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'}`}
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
                      className={`max-w-full rounded-lg px-3 py-2 ${mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'}`}
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
                      className={`max-w-full rounded-lg px-3 py-2 text-body-sm leading-relaxed ${
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
                  <MessageMeta
                    message={message}
                    mine={mine}
                    onOpen={() => setMessageInfo(message)}
                  />
                  </div>
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

        {sendError ? (
          <p role="alert" className="mx-3 mt-2 rounded-md bg-amber-50 px-3 py-2 text-caption text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
            {sendError}
          </p>
        ) : null}

        {recorder.status !== 'idle' ? (
          <VoiceComposer
            status={recorder.status}
            durationMs={recorder.durationMs}
            recording={recorder.recording}
            onSendNow={() => {
              sendAfterStop.current = true;
              recorder.stop();
            }}
            onCancel={recorder.cancel}
            onSend={sendVoice}
          />
        ) : (
        <form
          className="shrink-0 border-t border-border p-3"
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

            {/*
              The media doors are always here.

              They used to be hidden until a connected shop's own capability answer
              came back — so a conversation opened from the Shop tab, which is not a
              connected shop, showed a bare text box: not the composer the farmer
              uses everywhere else in the app. The shape is now the assistant's, in
              every conversation; whether this shop can take a photo is checked when
              one is actually sent, and said then.
            */}
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

            {voiceRecordingSupported() ? (
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

        {messageInfo ? (
          <MessageInfoSheet
            message={messageInfo}
            shopName={nameFor(dealerId)}
            onClose={() => setMessageInfo(null)}
          />
        ) : null}

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
          {matches.map((conversation, index) => {
            const { dealerId, phone, lastMessage, unread: unreadCount, lastAt } = conversation;
            const meta = THREAD_META[dealerId];
            const name = conversation.name || nameFor(dealerId);
            const preview = previewOf(lastMessage, t);
            const stamp = listStamp(lastAt, t) ?? (meta ? t(meta.timeKey) : null);
            const state = lastMessage ? deliveryOf(lastMessage) : null;
            const first = index === 0;

            return (
              <li key={dealerId} className={first ? '' : 'border-t border-border'}>
                <button
                  type="button"
                  onClick={() => openConversation(dealerId)}
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
                    {/* The number the counter is reached on, from the shop's own
                        record. It is how a farmer tells two branches of one business
                        apart in a list of conversations. */}
                    {phone ? (
                      <span className="mt-0.5 block truncate text-caption tabular-nums text-muted-foreground">
                        {phone}
                      </span>
                    ) : null}
                    <span
                      className={`mt-0.5 block truncate text-body-sm ${
                        unreadCount > 0 ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {preview || t('chat.thread.empty')}
                    </span>
                  </span>

                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    {stamp ? (
                      <span className="text-caption text-muted-foreground">{stamp}</span>
                    ) : null}
                    {unreadCount > 0 ? (
                      <span className="grid size-5 place-items-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
                        {unreadCount}
                      </span>
                    ) : lastMessage?.from === 'me' ? (
                      /* The tick belongs to the farmer's own last line; a
                         conversation the shop spoke last has nothing to acknowledge. */
                      <MessageTicks state={state} />
                    ) : null}
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
  message: ChatMessage | null | undefined,
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
 * The time a conversation shows in the list.
 *
 * The shop's `created_at`, not a typed placeholder: today shows a clock, yesterday
 * says so, the last week shows the weekday and anything older shows the date. A
 * conversation with no messages has no time to show, which is the truth.
 */
function listStamp(
  value: string | null,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t('chat.time.yesterday');

  if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }

  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** The shop's own clock for a message, or `null` when it did not send one. */
function clockOf(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The tick beside an outgoing message.
 *
 * `delivered` is drawn as the double tick the farmer already knows, but it is not
 * a guess: a bubble exists only because the shop's thread returned that row. Blue
 * is reserved for a read receipt the shop actually published — this backend does
 * not publish one for the farmer's messages, so blue is absent rather than faked.
 */
function MessageTicks({ state }: { state: MessageDelivery | null }) {
  const { t } = useLocale();
  if (!state) return null;
  if (state === 'sending') {
    return <Clock className="size-3.5 text-muted-foreground" aria-label={t('chat.message.sending')} />;
  }
  if (state === 'failed') {
    return <CircleAlert className="size-3.5 text-destructive" aria-label={t('chat.message.failed')} />;
  }
  if (state === 'read') {
    return <CheckCheck className="size-3.5 text-sky-500" aria-label={t('chat.message.read')} />;
  }
  return <CheckCheck className="size-3.5 text-muted-foreground" aria-label={t('chat.message.delivered')} />;
}

/**
 * Time and delivery state under a bubble, and the door to the details.
 *
 * Pressing it is the app's version of WhatsApp's "message info": one panel that
 * says what the shop's record actually contains, including the fact that it does
 * not report reads, instead of a second legend the farmer has to learn.
 */
function MessageMeta({
  message,
  mine,
  onOpen,
}: {
  message: ChatMessage;
  mine: boolean;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const state = deliveryOf(message);
  const time = clockOf(message.sentAt);
  if (!mine && !time) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('chat.message.info')}
      className="flex items-center gap-1 rounded-full px-1 text-caption text-muted-foreground"
    >
      {time ? <span className="tabular-nums">{time}</span> : null}
      {!time && state === 'sending' ? <span>{t('chat.message.sending')}</span> : null}
      <MessageTicks state={state} />
    </button>
  );
}

/** What is known about one message, said plainly. */
function MessageInfoSheet({
  message,
  shopName,
  onClose,
}: {
  message: ChatMessage;
  shopName: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const state = deliveryOf(message);
  const sent = clockOf(message.sentAt);
  const delivered = clockOf(message.deliveredAt);
  const read = clockOf(message.readAt);
  const status =
    state === 'read'
      ? t('chat.message.read')
      : state === 'failed'
        ? t('chat.message.failed')
        : state === 'sending'
          ? t('chat.message.sending')
          : state === 'delivered'
            ? t('chat.message.delivered')
            : t('chat.message.sent');

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 px-4 pb-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.message.info')}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[430px] rounded-xl bg-card p-4 shadow-lg"
      >
        <p className="text-subheading">{t('chat.message.info')}</p>
        <dl className="mt-3 space-y-2 text-body-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('chat.message.status')}</dt>
            <dd className="text-end">{status}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{t('chat.message.sentAt')}</dt>
            <dd className="tabular-nums">{sent ?? '—'}</dd>
          </div>
          {message.from === 'me' ? (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{t('chat.message.deliveredAt')}</dt>
                <dd className="text-end">
                  {delivered ??
                    (state === 'delivered' || state === 'read'
                      ? t('chat.message.stored', { shop: shopName })
                      : '—')}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{t('chat.message.readAt')}</dt>
                <dd className="text-end">{read ?? t('chat.message.readUnknown')}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <Button variant="outline" className="mt-4 h-10 w-full rounded-full" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </div>
  );
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
