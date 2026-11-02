import { ChevronLeft, ChevronRight, Info, TriangleAlert, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ORDERS, orderById, type Order } from '@/data/orders';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { formatDay, formatMoney, formatRelativeTime } from '@/i18n/format';
import { useSession } from '@/session/SessionProvider';
import { useCredit } from './CreditProvider';
import {
  MAX_CREDIT_SHOPS,
  changedFields,
  currentTerms,
  isActive,
  shopsHoldingCredit,
  totalOf,
  type Agreement,
  type CreditEvent,
  type CreditRequest,
  type CreditStatus,
} from './store';

/**
 * The farmer's side of merchant credit: what is owed, what is waiting on them,
 * and the exact terms they are agreeing to.
 *
 * Three rules shape every screen here. *Nothing is hidden* — amount, any fee, the
 * repayment promise and what happens on rejection are on the request before it is
 * sent, and on the offer before it is accepted. *A change is a new document* — a
 * counteroffer is shown as "what changed" beside the previous version, never as
 * the same request silently rewritten. *The farmer cannot approve themselves* —
 * accepting moves the request to final approval and stops; only the shop owner's
 * side commits, which is why the committing buttons live under a bar labelled as
 * a demo of the shop owner's app rather than anywhere near the farmer's actions.
 */

type View =
  | { kind: 'summary' }
  | { kind: 'request' }
  | { kind: 'detail'; id: string }
  | { kind: 'shop'; dealerKey: MessageKey };

/** One creditor, as the summary lists them: what is owed there and what for. */
type ShopSummary = {
  dealerKey: MessageKey;
  outstanding: number;
  paidPercent: number;
  products: MessageKey[];
};

export function CreditCenter({
  open,
  focusRequestId,
  onOpenChange,
}: {
  open: boolean;
  focusRequestId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const [view, setView] = useState<View>({ kind: 'summary' });

  /* Opened by an alert (a counteroffer waiting, the Scan result) → the detail it
     points at; opened from the Home card → the summary. */
  useEffect(() => {
    if (!open) return;
    setView(focusRequestId ? { kind: 'detail', id: focusRequestId } : { kind: 'summary' });
  }, [open, focusRequestId]);

  const active = credit.data.requests.filter((request) => isActive(request.status));
  const history = credit.data.requests.filter((request) => !isActive(request.status));
  const awaiting = active.filter((request) => request.status === 'awaiting_farmer_decision');
  const inProgress = active.filter((request) => request.status !== 'awaiting_farmer_decision');

  const openBalance = credit.data.agreements.reduce(
    (sum, agreement) => (agreement.closedAt === null ? sum + credit.outstandingOf(agreement) : sum),
    0,
  );

  /*
   * Credit is held per *shop*, so the summary lists creditors, not purchases: one
   * row per shop, with everything bought there behind it. A shop's purchases are
   * summarised rather than listed — the row answers "who do I owe, and how much"
   * first, and what it was for is one tap away.
   */
  const shops: ShopSummary[] = shopsHoldingCredit(credit.data).map((dealerKey) => {
    const agreements = credit.data.agreements.filter(
      (agreement) =>
        agreement.closedAt === null &&
        credit.requestById(agreement.requestId)?.dealerKey === dealerKey,
    );
    const totals = agreements.reduce(
      (sum, agreement) => {
        const request = credit.requestById(agreement.requestId);
        const terms = request?.terms.find((version) => version.version === agreement.termsVersion);
        return {
          paid: sum.paid + agreement.paid,
          total: sum.total + (terms ? terms.amount + terms.fee : 0),
        };
      },
      { paid: 0, total: 0 },
    );
    return {
      dealerKey,
      outstanding: agreements.reduce((sum, agreement) => sum + credit.outstandingOf(agreement), 0),
      paidPercent: totals.total > 0 ? Math.round((totals.paid / totals.total) * 100) : 0,
      products: agreements
        .map((agreement) => credit.requestById(agreement.requestId)?.productKey)
        .filter((key): key is MessageKey => key !== undefined),
    };
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-h-[88dvh] w-full max-w-[430px] overflow-y-auto">
        <SheetHeader className="flex-row items-center gap-2 space-y-0">
          {view.kind !== 'summary' ? (
            <button
              type="button"
              aria-label={t('common.back')}
              onClick={() => setView({ kind: 'summary' })}
              className="-ms-2 grid size-8 shrink-0 place-items-center rounded-full"
            >
              <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
            </button>
          ) : null}
          <SheetTitle>
            {view.kind === 'summary'
              ? t('credit.center.title')
              : view.kind === 'request'
                ? t('credit.form.title')
                : view.kind === 'shop'
                  ? t(view.dealerKey)
                  : t('credit.detail.title')}
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-4 pt-0">
          {view.kind === 'summary' ? (
            <>
              <section className="rounded-lg bg-surface-inverted p-4 text-cream-50">
                <p className="text-overline text-brand uppercase">{t('credit.balance.title')}</p>
                <p className="mt-1 font-serif text-figure lining-nums tabular-nums">
                  {formatMoney(openBalance, locale, t)}
                </p>
                <p className="mt-1 text-label text-cream-50/70">
                  {t('credit.balance.note', { count: credit.data.agreements.length })}
                </p>
              </section>

              {awaiting.length > 0 ? (
                <section>
                  <SectionLabel>{t('credit.section.awaiting')}</SectionLabel>
                  <ul className="mt-2 space-y-2">
                    {awaiting.map((request) => (
                      <RequestRow
                        key={request.id}
                        request={request}
                        onOpen={() => setView({ kind: 'detail', id: request.id })}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {inProgress.length > 0 ? (
                <section>
                  <SectionLabel>{t('credit.section.active')}</SectionLabel>
                  <ul className="mt-2 space-y-2">
                    {inProgress.map((request) => (
                      <RequestRow
                        key={request.id}
                        request={request}
                        onOpen={() => setView({ kind: 'detail', id: request.id })}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {shops.length > 0 ? (
                <section>
                  <SectionLabel>{t('credit.shops.title')}</SectionLabel>
                  <p className="mt-1 text-caption text-muted-foreground">
                    {t('credit.shops.limit', { count: MAX_CREDIT_SHOPS })}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {shops.map((shop) => (
                      <ShopRow
                        key={shop.dealerKey}
                        shop={shop}
                        onOpen={() => setView({ kind: 'shop', dealerKey: shop.dealerKey })}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {history.length > 0 ? (
                <section>
                  <SectionLabel>{t('credit.section.history')}</SectionLabel>
                  <ul className="mt-2 space-y-2">
                    {history.map((request) => (
                      <RequestRow
                        key={request.id}
                        request={request}
                        onOpen={() => setView({ kind: 'detail', id: request.id })}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              <Button className="h-12 rounded-full" onClick={() => setView({ kind: 'request' })}>
                {t('credit.request')}
              </Button>
            </>
          ) : null}

          {view.kind === 'request' ? <RequestForm onDone={(id) => setView({ kind: 'detail', id })} /> : null}

          {view.kind === 'detail' ? <RequestDetail id={view.id} /> : null}

          {view.kind === 'shop' ? (
            <ShopDetail
              dealerKey={view.dealerKey}
              onOpen={(id) => setView({ kind: 'detail', id })}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── rows ────────────────────────────────────────────────────────────────── */

function RequestRow({ request, onOpen }: { request: CreditRequest; onOpen: () => void }) {
  const { t, locale } = useLocale();
  const terms = currentTerms(request);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-md border border-border bg-card p-3.5 text-start"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-body font-medium">{t(request.productKey)}</span>
          <StatusChip status={request.status} />
        </span>
        <span className="mt-1.5 block text-label text-muted-foreground">
          {t('credit.request.terms', {
            amount: formatMoney(totalOf(terms), locale, t),
            dealer: t(request.dealerKey),
          })}
        </span>
      </button>
    </li>
  );
}

function StatusChip({ status }: { status: CreditStatus }) {
  const { t } = useLocale();
  const tone: Record<CreditStatus, string> = {
    requested: 'bg-muted text-muted-foreground',
    reviewing: 'bg-muted text-muted-foreground',
    awaiting_farmer_decision: 'bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
    awaiting_final_approval: 'bg-brand-soft text-brand',
    accepted: 'bg-brand-soft text-brand',
    rejected: 'bg-muted text-muted-foreground',
    cancelled: 'bg-muted text-muted-foreground',
    expired: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-caption font-medium ${tone[status]}`}>
      {t(`credit.status.${status}` as MessageKey)}
    </span>
  );
}

/**
 * One creditor, in the summary.
 *
 * The row leads with what is owed there, because that is the question a farmer
 * opens this screen with; the products are stated underneath so the row is not
 * anonymous, and the whole of it is one tap from the shop's own page. A shop
 * holding two agreements is still one row — the limit this list shows is a count
 * of shops, not of debts.
 */
function ShopRow({ shop, onOpen }: { shop: ShopSummary; onOpen: () => void }) {
  const { t, locale } = useLocale();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-md border border-border bg-card p-3.5 text-start"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-body font-medium">{t(shop.dealerKey)}</span>
          <span className="shrink-0 text-body tabular-nums">
            {formatMoney(shop.outstanding, locale, t)}
          </span>
        </span>
        <span className="mt-1 block truncate text-caption text-muted-foreground">
          {t('credit.shop.products')} · {shop.products.map((key) => t(key)).join(' · ')}
        </span>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full bg-brand"
            style={{ width: `${shop.paidPercent}%` }}
          />
        </span>
        <span className="mt-1 flex items-center justify-between gap-2 text-caption text-muted-foreground">
          <span>{t('credit.card.paid', { percent: shop.paidPercent })}</span>
          <ChevronRight className="size-4 shrink-0 text-brand rtl:rotate-180" aria-hidden />
        </span>
      </button>
    </li>
  );
}

/**
 * One shop's page: everything this farmer has with this shop, and nothing else.
 *
 * What was bought, what is left to repay on each purchase, what has been paid,
 * and how it ended — the same records the request detail shows, grouped by the
 * creditor rather than by the purchase, which is the way a farmer carries credit
 * in their head.
 */
function ShopDetail({
  dealerKey,
  onOpen,
}: {
  dealerKey: MessageKey;
  onOpen: (id: string) => void;
}) {
  const { t, locale } = useLocale();
  const credit = useCredit();

  const agreements = credit.data.agreements.filter(
    (agreement) => credit.requestById(agreement.requestId)?.dealerKey === dealerKey,
  );
  const open = agreements.filter((agreement) => agreement.closedAt === null);
  const outstanding = open.reduce((sum, agreement) => sum + credit.outstandingOf(agreement), 0);
  const payments = agreements
    .flatMap((agreement) => agreement.payments)
    .sort((a, b) => b.at - a.at);
  const settled = credit.data.requests.filter(
    (request) => request.dealerKey === dealerKey && !isActive(request.status),
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg bg-surface-inverted p-4 text-cream-50">
        <p className="text-overline text-brand uppercase">{t('credit.agreement.outstanding')}</p>
        <p className="mt-1 font-serif text-figure lining-nums tabular-nums">
          {formatMoney(outstanding, locale, t)}
        </p>
      </section>

      {open.length > 0 ? (
        <section>
          <SectionLabel>{t('credit.shop.products')}</SectionLabel>
          <ul className="mt-2 space-y-2">
            {open.map((agreement) => {
              const request = credit.requestById(agreement.requestId);
              if (!request) return null;
              const terms = request.terms.find(
                (version) => version.version === agreement.termsVersion,
              );
              return (
                <li key={agreement.requestId}>
                  <button
                    type="button"
                    onClick={() => onOpen(request.id)}
                    className="w-full rounded-md border border-border bg-card p-3.5 text-start"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-medium">
                        {t(request.productKey)}
                      </span>
                      <span className="shrink-0 text-label tabular-nums">
                        {formatMoney(credit.outstandingOf(agreement), locale, t)}
                      </span>
                    </span>
                    <span className="mt-1 block text-caption text-muted-foreground">
                      {terms ? t(terms.dueKey) : ''}
                      {terms
                        ? ` · ${formatMoney(agreement.paid, locale, t)} ${t('credit.agreement.paid')}`
                        : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionLabel>{t('credit.agreement.payments')}</SectionLabel>
        {payments.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">
            {t('credit.agreement.noPayments')}
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex items-baseline justify-between gap-2 text-body-sm"
              >
                <span className="text-muted-foreground">
                  {t(payment.noteKey)} · {formatDay(new Date(payment.at), locale)}
                </span>
                <span className="tabular-nums">{formatMoney(payment.amount, locale, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {settled.length > 0 ? (
        <section>
          <SectionLabel>{t('credit.shop.history')}</SectionLabel>
          <ul className="mt-2 space-y-2">
            {settled.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                onOpen={() => onOpen(request.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ── the request form ────────────────────────────────────────────────────── */

const DUE_OPTIONS: ReadonlyArray<{ key: MessageKey }> = [
  { key: 'credit.due.afterHarvest' },
  { key: 'credit.due.december' },
  { key: 'credit.due.oneMonth' },
];

/** The first order the form starts on; `ORDERS` is non-empty by construction. */
const FIRST_ORDER = ORDERS[0] as Order;

function RequestForm({ onDone }: { onDone: (id: string) => void }) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const { requestIdentity } = useSession();

  const [orderId, setOrderId] = useState(FIRST_ORDER.id);
  const [amount, setAmount] = useState(String(FIRST_ORDER.amount));
  const [dueKey, setDueKey] = useState<MessageKey>('credit.due.afterHarvest');
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const order = orderById(orderId);

  const pick = (next: (typeof ORDERS)[number]) => {
    setOrderId(next.id);
    setAmount(String(next.amount));
    setError(null);
  };

  /*
   * Validation first, identity second, and the same send runs after sign-in.
   * Asking for an account on an incomplete request would be asking before the
   * farmer has anything to record.
   */
  const send = () => {
    if (!order) return;
    if (!consented) {
      setError('credit.error.consent');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('credit.error.amount');
      return;
    }
    requestIdentity(() => runSend(order, parsed), 'session.why.credit');
  };

  const runSend = (target: Order, parsed: number) => {
    const result = credit.submitRequest({
      orderId: target.id,
      dealerKey: target.dealerKey,
      productKey: target.productKey,
      amount: parsed,
      dueKey,
      consented: true,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(t('credit.form.sent'));
    onDone(result.requestId ?? `credit-${target.id}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-sm text-muted-foreground">{t('credit.form.note')}</p>

      <section>
        <SectionLabel>{t('credit.form.order')}</SectionLabel>
        <ul className="mt-2 space-y-2">
          {ORDERS.map((entry) => {
            const selected = entry.id === orderId;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(entry)}
                  className={`w-full rounded-md border p-3.5 text-start ${
                    selected ? 'border-brand bg-brand-soft' : 'border-border bg-card'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-body font-medium">{t(entry.productKey)}</span>
                    <span className="shrink-0 text-label tabular-nums">
                      {formatMoney(entry.amount, locale, t)}
                    </span>
                  </span>
                  <span className="mt-1 block text-label text-muted-foreground">
                    {t('credit.request.terms', {
                      amount: t('common.km', { km: entry.km }),
                      dealer: t(entry.dealerKey),
                    })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div>
        <Label htmlFor="credit-amount" className="text-label text-muted-foreground">
          {t('credit.form.amount')}
        </Label>
        <Input
          id="credit-amount"
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            if (error) setError(null);
          }}
          className="mt-1.5 h-11 tabular-nums"
        />
      </div>

      <section>
        <SectionLabel>{t('credit.form.due')}</SectionLabel>
        <ul className="mt-2 flex flex-wrap gap-2">
          {DUE_OPTIONS.map(({ key }) => {
            const selected = key === dueKey;
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setDueKey(key)}
                  className={`rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
                    selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {t(key)}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <Consent
        checked={consented}
        onChange={(next) => {
          setConsented(next);
          if (error) setError(null);
        }}
        version={1}
        bodyKey="credit.consent"
        amount={formatMoney(Number(amount) || 0, locale, t)}
        due={t(dueKey)}
      />

      {error ? <ErrorLine error={error} /> : null}

      <Button className="h-12 rounded-full" onClick={send}>
        {t('credit.submit')}
      </Button>
    </div>
  );
}

/* ── one request, end to end ─────────────────────────────────────────────── */

function RequestDetail({ id }: { id: string }) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const { requestIdentity } = useSession();
  const [confirmReject, setConfirmReject] = useState(false);

  const request = credit.requestById(id);
  if (!request) {
    return <p className="text-body-sm text-muted-foreground">{t('credit.error.missing')}</p>;
  }

  const terms = currentTerms(request);
  const previous = request.terms.length > 1 ? request.terms[request.terms.length - 2] : null;
  const agreement = credit.agreementFor(request.id);
  const now = Date.now();

  const answer = (decision: 'accept' | 'reject') => {
    requestIdentity(
      () => {
        const result = credit.farmerAnswer(request.id, decision);
        if (!result.ok) {
          toast.error(t(result.error));
          return;
        }
        toast.success(t(decision === 'accept' ? 'credit.answered.accept' : 'credit.answered.reject'));
        setConfirmReject(false);
      },
      'session.why.credit',
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-subheading">{t(request.productKey)}</p>
            <p className="mt-0.5 text-label text-muted-foreground">
              {t('credit.request.by', { dealer: t(request.dealerKey) })}
            </p>
          </div>
          <StatusChip status={request.status} />
        </div>

        <dl className="mt-3 space-y-1.5 text-label">
          <Line label={t('credit.terms.amount')} value={formatMoney(terms.amount, locale, t)} />
          <Line
            label={t('credit.terms.fee')}
            value={
              terms.fee > 0
                ? t('credit.terms.feeValue', {
                    amount: formatMoney(terms.fee, locale, t),
                    note: terms.feeNoteKey ? t(terms.feeNoteKey) : '',
                  })
                : t('credit.terms.feeNone')
            }
          />
          <Line label={t('credit.terms.due')} value={t(terms.dueKey)} />
          <Line
            label={t('credit.terms.total')}
            value={formatMoney(totalOf(terms), locale, t)}
            strong
          />
          <Line
            label={t('credit.terms.version')}
            value={t('credit.terms.versionValue', {
              version: terms.version,
              source: t(terms.source === 'farmer' ? 'credit.source.farmer' : 'credit.source.shopOwner'),
            })}
          />
        </dl>
      </section>

      {request.status === 'awaiting_farmer_decision' && previous ? (
        <section className="rounded-lg border border-amber-700/30 bg-amber-50 p-4 dark:bg-amber-500/15">
          <p className="text-body font-medium text-amber-900 dark:text-amber-100">
            {t('credit.changed.title')}
          </p>
          <ul className="mt-1.5 space-y-1 text-body-sm text-amber-900 dark:text-amber-100">
            {changedFields(previous, terms).map((field) => (
              <li key={field}>
                {field === 'amount'
                  ? t('credit.changed.amount', {
                      from: formatMoney(previous.amount, locale, t),
                      to: formatMoney(terms.amount, locale, t),
                    })
                  : field === 'fee'
                    ? t('credit.changed.fee', {
                        from: formatMoney(previous.fee, locale, t),
                        to: formatMoney(terms.fee, locale, t),
                      })
                    : t('credit.changed.due')}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-body-sm text-amber-900/80 dark:text-amber-100/80">
            {t('credit.changed.body', { version: terms.version })}
          </p>
        </section>
      ) : null}

      {request.status === 'awaiting_farmer_decision' ? (
        <div className="flex flex-col gap-2">
          <Button className="h-12 rounded-full" onClick={() => answer('accept')}>
            {t('credit.accept', { version: terms.version })}
          </Button>
          {confirmReject ? (
            <div className="rounded-md border border-border p-3">
              <p className="text-body-sm text-muted-foreground">{t('credit.reject.body')}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 flex-1 rounded-md"
                  onClick={() => setConfirmReject(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  className="h-11 flex-1 rounded-md"
                  onClick={() => answer('reject')}
                >
                  {t('credit.reject.confirm')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="h-11 rounded-full"
              onClick={() => setConfirmReject(true)}
            >
              {t('credit.reject')}
            </Button>
          )}
        </div>
      ) : null}

      {(request.status === 'requested' || request.status === 'reviewing') ? (
        <>
          <WaitingNote status={request.status} />
          <Button
            variant="outline"
            className="h-11 rounded-full text-destructive"
            onClick={() =>
              requestIdentity(() => {
                const result = credit.cancelRequest(request.id);
                if (!result.ok) toast.error(t(result.error));
              }, 'session.why.credit')
            }
          >
            {t('credit.cancel')}
          </Button>
        </>
      ) : null}

      {request.status === 'awaiting_final_approval' ? <WaitingNote status={request.status} /> : null}

      {request.status === 'rejected' ? (
        <p className="rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
          {t('credit.rejected.body', {
            reason: t(
              (request.events.find((entry) => entry.reasonKey)?.reasonKey ??
                'credit.reason.notAgreed') as MessageKey,
            ),
          })}
        </p>
      ) : null}

      {request.status === 'cancelled' || request.status === 'expired' ? (
        <p className="rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
          {t(`credit.wait.${request.status}` as MessageKey)}
        </p>
      ) : null}

      {agreement ? <AgreementBlock request={request} agreement={agreement} /> : null}

      <Timeline request={request} now={now} />

      <DemoBar request={request} agreement={agreement} />
    </div>
  );
}

function WaitingNote({ status }: { status: CreditStatus }) {
  const { t } = useLocale();
  return (
    <p className="flex gap-2 rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
      <Info className="size-4 shrink-0" aria-hidden />
      {t(`credit.wait.${status}` as MessageKey)}
    </p>
  );
}

function AgreementBlock({ request, agreement }: { request: CreditRequest; agreement: Agreement }) {
  const { t, locale } = useLocale();
  const credit = useCredit();
  const consent = request.consents
    .slice()
    .reverse()
    .find((entry) => entry.termsVersion === agreement.termsVersion);
  const outstanding = credit.outstandingOf(agreement);
  const terms = request.terms.find((entry) => entry.version === agreement.termsVersion);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <p className="text-overline text-muted-foreground uppercase">
        {t('credit.agreement.title', { version: agreement.termsVersion })}
      </p>
      <p className="mt-1.5 text-body-sm text-muted-foreground">
        {t('credit.agreement.consent', {
          date: formatDay(new Date(consent?.at ?? agreement.farmerConsentAt), locale),
          approved: formatDay(new Date(agreement.shopOwnerApprovedAt), locale),
        })}
      </p>

      <dl className="mt-3 space-y-1.5 text-label">
        <Line
          label={t('credit.agreement.paid')}
          value={formatMoney(agreement.paid, locale, t)}
        />
        <Line
          label={t('credit.agreement.outstanding')}
          value={terms ? formatMoney(outstanding, locale, t) : '—'}
          strong
        />
      </dl>

      <p className="mt-3 text-label text-muted-foreground">{t('credit.agreement.payments')}</p>
      {agreement.payments.length === 0 ? (
        <p className="mt-1 text-body-sm text-muted-foreground">{t('credit.agreement.noPayments')}</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {agreement.payments.map((payment) => (
            <li key={payment.id} className="flex items-baseline justify-between gap-2 text-body-sm">
              <span className="text-muted-foreground">{t(payment.noteKey)}</span>
              <span className="tabular-nums">{formatMoney(payment.amount, locale, t)}</span>
            </li>
          ))}
        </ul>
      )}

      {agreement.closedAt !== null ? (
        <p className="mt-2 text-label text-brand">{t('credit.agreement.closed')}</p>
      ) : null}
    </section>
  );
}

function Timeline({ request, now }: { request: CreditRequest; now: number }) {
  const { t } = useLocale();
  const actor: Record<CreditEvent['actor'], MessageKey> = {
    farmer: 'credit.actor.farmer',
    shop_owner: 'credit.actor.shopOwner',
    system: 'credit.actor.system',
  };

  return (
    <section>
      <SectionLabel>{t('credit.timeline.title')}</SectionLabel>
      <ol className="mt-2 space-y-2">
        {request.events.map((entry) => (
          <li key={entry.id} className="flex gap-2.5">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
            <span className="min-w-0 flex-1">
              <span className="block text-body-sm">{t(`credit.event.${entry.type}` as MessageKey)}</span>
              <span className="mt-0.5 block text-caption text-muted-foreground">
                {t(actor[entry.actor])} · {formatRelativeTime(entry.at, now, t)}
                {entry.reasonKey ? ` · ${t(entry.reasonKey)}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The shop owner's side, refused to the farmer's side and said so out loud.
 *
 * It exists because the dealer system is not part of this build, and a workflow
 * that cannot move cannot be reviewed. It is visually separated, labelled as a
 * demo, and its buttons call the `simulate` half of the provider — the farmer's
 * own code path has no access to these transitions at all.
 */
function DemoBar({ request, agreement }: { request: CreditRequest; agreement?: Agreement }) {
  const { t } = useLocale();
  const credit = useCredit();
  const simulate = credit.simulate;

  const actions: Array<{ key: MessageKey; run: () => void }> = [];
  if (request.status === 'requested') {
    actions.push({ key: 'credit.demo.start', run: () => simulate.startReview(request.id) });
    actions.push({ key: 'credit.demo.accept', run: () => simulate.acceptDirectly(request.id) });
  }
  if (request.status === 'reviewing') {
    actions.push({ key: 'credit.demo.accept', run: () => simulate.acceptDirectly(request.id) });
    actions.push({
      key: 'credit.demo.counter',
      run: () =>
        simulate.counter(request.id, {
          amount: currentTerms(request).amount + 400,
          dueKey: 'credit.due.december',
          fee: 300,
        }),
    });
  }
  if (request.status === 'awaiting_final_approval') {
    actions.push({ key: 'credit.demo.approve', run: () => simulate.final(request.id, 'approve') });
    actions.push({ key: 'credit.demo.reject', run: () => simulate.final(request.id, 'reject') });
  }
  if (agreement && agreement.closedAt === null) {
    actions.push({ key: 'credit.demo.payment', run: () => simulate.payment(request.id, 2_000) });
  }

  if (actions.length === 0) return null;

  return (
    <section className="rounded-lg border border-dashed border-ink-300 p-3.5">
      <p className="flex items-center gap-2 text-label font-medium text-muted-foreground">
        <Wrench className="size-3.5" aria-hidden />
        {t('credit.demo.title')}
      </p>
      <p className="mt-1 text-caption text-muted-foreground">{t('credit.demo.note')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.key}
            variant="outline"
            size="sm"
            className="h-9 rounded-full"
            onClick={action.run}
          >
            <span className="text-body-sm">{t(action.key)}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

/* ── small shared pieces ─────────────────────────────────────────────────── */

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-end tabular-nums ${strong ? 'text-body font-medium' : ''}`}>{value}</dd>
    </div>
  );
}

function Consent({
  checked,
  onChange,
  version,
  bodyKey,
  amount,
  due,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  version: number;
  bodyKey: MessageKey;
  amount: string;
  due: string;
}) {
  const { t, locale } = useLocale();
  return (
    <label className="flex gap-3 rounded-md border border-border bg-card p-3.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-brand"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-body-sm leading-relaxed">{t(bodyKey, { amount, due })}</span>
        <span className="mt-1 block text-caption text-muted-foreground">
          {t('credit.consent.version', {
            version,
            date: formatDay(new Date(), locale),
          })}
        </span>
      </span>
    </label>
  );
}

function ErrorLine({ error }: { error: MessageKey }) {
  const { t } = useLocale();
  return (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      {t(error)}
    </p>
  );
}
