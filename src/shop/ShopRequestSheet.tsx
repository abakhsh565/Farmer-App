import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import { useSession } from '@/session/SessionProvider';
import { useShopApi } from './ShopApiProvider';
import { normaliseShopCode } from './api/deepLink';

/**
 * Asking the shop for something.
 *
 * Credit and a field visit are two rows in the same contract and two answers to the
 * same question — "can I get this from you?" — so they are one sheet with a mode
 * rather than two dialogs that drift apart. The shop's thread records both as
 * events, which is why neither is sent as a chat message: a request beside a request
 * is a message the owner has to interpret.
 *
 * Nothing is sent until the shop accepts it, and the sheet stays open until then.
 */

type Mode = 'credit' | 'visit';

type Props = {
  mode: Mode;
  onClose: () => void;
};

export function ShopRequestSheet({ mode, onClose }: Props) {
  const { t } = useLocale();
  const shop = useShopApi();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [purpose, setPurpose] = useState('');
  const [window, setWindow] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    setSending(true);
    try {
      const ok =
        mode === 'credit'
          ? await (async () => {
              const value = Number(amount.replace(/[^0-9.]/g, ''));
              if (!Number.isFinite(value) || value <= 0) {
                toast.error(t('shop.request.badAmount'));
                return false;
              }
              return shop.askCredit(value, note.trim() || null);
            })()
          : await shop.askVisit(purpose.trim() || null, window.trim() || null);

      if (ok) {
        toast.success(t('shop.request.sent'));
        onClose();
      } else {
        toast.error(t('shop.failed'));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 px-4 pb-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'credit' ? t('shop.request.credit') : t('shop.request.visit')}
        className="w-full max-w-[430px] rounded-xl bg-card p-4 shadow-lg"
      >
        <p className="text-subheading">
          {mode === 'credit' ? t('shop.request.credit') : t('shop.request.visit')}
        </p>

        {mode === 'credit' ? (
          <div className="mt-3 space-y-2">
            <label className="block text-caption text-muted-foreground" htmlFor="shop-amount">
              {t('shop.request.amount')}
            </label>
            <input
              id="shop-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="h-11 w-full rounded-md bg-muted px-3.5 text-body"
            />
            <label className="block text-caption text-muted-foreground" htmlFor="shop-note">
              {t('shop.request.note')}
            </label>
            <input
              id="shop-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="h-11 w-full rounded-md bg-muted px-3.5 text-body"
            />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <label className="block text-caption text-muted-foreground" htmlFor="shop-purpose">
              {t('shop.request.purpose')}
            </label>
            <input
              id="shop-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              className="h-11 w-full rounded-md bg-muted px-3.5 text-body"
            />
            <label className="block text-caption text-muted-foreground" htmlFor="shop-window">
              {t('shop.request.window')}
            </label>
            <input
              id="shop-window"
              value={window}
              onChange={(event) => setWindow(event.target.value)}
              className="h-11 w-full rounded-md bg-muted px-3.5 text-body"
            />
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="h-11 flex-1 rounded-full" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="h-11 flex-1 rounded-full" onClick={() => void submit()} disabled={sending}>
            {t('shop.request.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Connecting to a shop by its code, inside the app.
 *
 * The deep link is the fast path; this is the fallback for the farmer who has the
 * code in front of them and no camera pointed at it — the same six characters, typed.
 */
export function ShopConnectSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const shop = useShopApi();
  /* The shop identifies a farmer by his phone number, so a connect has to be
     attributable before it is sent — the same rule every other attributed action
     in the app follows. */
  const { account, requestIdentity } = useSession();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  /*
   * A join that waited for sign-in, resumed once the account is actually there.
   *
   * The sheet cannot hand the join to `requestIdentity` and let it run on its own:
   * the callback it stores was created before sign-in, so the shop client inside it
   * still sees "no account" and the join is refused with a generic failure. Waiting
   * for `account` and submitting from the render that has it is what makes the
   * code typed before signing in still work afterwards.
   */
  const [pendingJoin, setPendingJoin] = useState(false);

  const submit = async () => {
    const normalised = normaliseShopCode(code);
    if (!normalised) {
      toast.error(t('shop.connect.invalid'));
      return;
    }

    setSending(true);
    try {
      if (await shop.joinWithCode(normalised)) {
        toast.success(t('shop.join.joined', { shop: shop.credential?.shopName ?? '' }));
        onClose();
      } else {
        toast.error(t('shop.connect.failed'));
      }
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!pendingJoin || !account) return;
    setPendingJoin(false);
    void submit();
    /* `submit` is deliberately not a dependency: this effect exists to run it from
       the render that has the account, and re-running on every render would send
       the join twice. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoin, account]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 px-4 pb-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shop.connect.title')}
        className="w-full max-w-[430px] rounded-xl bg-card p-4 shadow-lg"
      >
        <p className="text-subheading">{t('shop.connect.title')}</p>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('shop.connect.body')}</p>

        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t('shop.connect.placeholder')}
          aria-label={t('shop.connect.placeholder')}
          autoCapitalize="characters"
          className="mt-3 h-11 w-full rounded-md bg-muted px-3.5 text-body tracking-widest"
        />

        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="h-11 flex-1 rounded-full" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="h-11 flex-1 rounded-full"
            onClick={() => {
              if (!account) {
                requestIdentity(() => setPendingJoin(true), 'session.why.message');
                return;
              }
              void submit();
            }}
            disabled={sending}
          >
            {t('shop.connect.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
