import { CheckCheck, ChevronLeft, MessageCircle, Search, Send, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState, LoadingState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { useChat } from '@/chat/ChatProvider';
import { THREAD_META, type ChatMessage } from '@/data/chat';
import { dealerNameKey } from '@/data/dealers';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { initialsOf } from '@/lib/initials';
import { useSession } from '@/session/SessionProvider';

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
      const name = lineText(dealerId, t).toLowerCase();
      const preview = (bodyText(last) || (last?.key ? t(last.key) : '')).toLowerCase();
      return name.includes(needle) || preview.includes(needle);
    });
  }, [list, query, t]);

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
          <span className="min-w-0">
            <span className="block truncate text-subheading">{lineText(dealerId, t)}</span>
            <span className="block text-caption text-muted-foreground">{t('chat.repliesIn')}</span>
          </span>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {openMessages && openMessages.length > 0 ? (
            openMessages.map((message: ChatMessage) => {
              const mine = message.from === 'me';
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <p
                    className={`max-w-[78%] rounded-lg px-3 py-2 text-body-sm leading-relaxed ${
                      mine ? 'bg-brand text-brand-foreground' : 'bg-muted text-foreground'
                    }`}
                  >
                    {/* A thread read aloud is otherwise a run of sentences with no
                        one attached to them. */}
                    <span className="sr-only">
                      {mine ? t('chat.you') : lineText(dealerId, t)}:{' '}
                    </span>
                    {message.text ?? (message.key ? t(message.key) : '')}
                  </p>
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

        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label className="sr-only" htmlFor="chat-composer">
            {t('chat.placeholder')}
          </label>
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
            className="max-h-28 min-h-11 flex-1 resize-none rounded-md bg-muted px-3.5 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button type="submit" size="icon" className="size-11 shrink-0 rounded-full" aria-label={t('chat.send')}>
            <Send className="size-4 rtl:rotate-180" aria-hidden />
          </Button>
        </form>
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
            <Button variant="outline" className="h-11 rounded-full" onClick={onBrowseDealers}>
              {t('nav.dealers')}
            </Button>
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
            const name = lineText(dealerId, t);
            const preview = last ? (bodyText(last) || (last.key ? t(last.key) : '')) : '';
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
    </div>
  );
}

/** A message's own text, whether the farmer typed it or the catalogue carries it. */
function bodyText(message: ChatMessage | undefined): string {
  if (!message) return '';
  return message.text ?? '';
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
