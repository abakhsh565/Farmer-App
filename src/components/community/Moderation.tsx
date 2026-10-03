import { Ban, Flag, MoreHorizontal, ShieldCheck, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useCommunity } from '@/community/CommunityProvider';
import { AUTHORS, ME, type AuthorId } from '@/data/community';
import {
  ENFORCEMENT,
  REPORT_REASONS,
  RULES,
  TERMS,
  type ReportReasonId,
} from '@/data/community-rules';
import { useLocale } from '@/i18n/LocaleProvider';

/**
 * Reporting, blocking, deleting, and the rules that explain all three.
 *
 * The moderation the farmer can reach is deliberately small: say what is wrong,
 * stop seeing somebody, or take back your own words. Everything else — the
 * ladder of consequences in `community-rules.ts` — happens to them, not to the
 * content, and is described in the rules sheet rather than implemented here,
 * because a feed that lets a farmer punish another farmer is a feed that decides
 * who is right by who is louder.
 */

type Step = 'actions' | 'report' | 'confirm';

export function PostOptions({
  postId,
  commentId,
  author,
  target,
  reported,
}: {
  postId: string;
  /** Absent when these are a post's own options. */
  commentId?: string;
  author: AuthorId;
  target: 'post' | 'comment';
  reported?: ReportReasonId;
}) {
  const { t } = useLocale();
  const { remove, report, block, unblock, blocked: blockedAuthors } = useCommunity();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('actions');
  const [reason, setReason] = useState<ReportReasonId | null>(null);

  const mine = author === ME;
  const name = t(AUTHORS[author].nameKey);
  const blocked = blockedAuthors.includes(author);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setStep('actions');
      setReason(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={target === 'post' ? t('community.menu.aria') : t('community.menu.comment')}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground"
        >
          <MoreHorizontal className="size-4.5" aria-hidden />
        </button>
      </SheetTrigger>

      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>
            {step === 'actions'
              ? name
              : step === 'report'
                ? t('community.report.title')
                : t('community.delete.title')}
          </SheetTitle>
        </SheetHeader>

        {step === 'actions' ? (
          <div className="flex flex-col gap-1 p-4 pt-0">
            {reported ? (
              /* Reporting twice is not an action, it is a repeat — so the row
                 becomes what happened to the first one. */
              <p className="flex items-center gap-2 rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" aria-hidden />
                {t('community.report.sent')}
              </p>
            ) : null}

            {!mine ? (
              <>
                <Action icon={Flag} label={t('community.action.report')} onClick={() => setStep('report')} />
                <Action
                  icon={Ban}
                  label={
                    blocked
                      ? t('community.action.unblock', { name })
                      : t('community.action.block', { name })
                  }
                  onClick={() => {
                    if (blocked) unblock(author);
                    else block(author);
                    close(false);
                  }}
                />
              </>
            ) : null}

            {mine ? (
              <Action
                icon={Trash2}
                label={t('community.action.delete')}
                tone="text-destructive"
                onClick={() => setStep('confirm')}
              />
            ) : null}
          </div>
        ) : null}

        {step === 'report' ? (
          <div className="flex flex-col gap-4 p-4 pt-0">
            <p className="text-body-sm text-muted-foreground">{t('community.report.body')}</p>

            <RadioGroup
              value={reason ?? ''}
              onValueChange={(next) => setReason(next as ReportReasonId)}
              className="gap-1"
            >
              {REPORT_REASONS.map((entry) => (
                <Label
                  key={entry.id}
                  htmlFor={`report-${postId}-${entry.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-body font-normal hover:bg-muted"
                >
                  <RadioGroupItem value={entry.id} id={`report-${postId}-${entry.id}`} />
                  {t(entry.labelKey)}
                </Label>
              ))}
            </RadioGroup>

            <Button
              className="h-11 w-full rounded-md"
              disabled={!reason}
              onClick={() => {
                if (!reason) return;
                report(postId, commentId ?? null, reason);
                close(false);
                toast.success(t('community.report.sent'));
              }}
            >
              {t('community.report.send')}
            </Button>
          </div>
        ) : null}

        {step === 'confirm' ? (
          <div className="flex flex-col gap-4 p-4 pt-0">
            <p className="text-body-sm text-muted-foreground">{t('community.delete.body')}</p>
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1 rounded-md" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                className="h-11 flex-1 rounded-md"
                onClick={() => {
                  remove(postId, commentId);
                  close(false);
                  toast.success(t('community.deleted'));
                }}
              >
                {t('community.delete.confirm')}
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  tone = 'text-foreground',
}: {
  icon: typeof Flag;
  label: string;
  onClick: () => void;
  tone?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-md px-3.5 py-3 text-start text-body hover:bg-muted ${tone}`}
    >
      <Icon className="size-4.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

/**
 * The rules, the consequences, and the terms — the education half of moderation,
 * and the part a farmer can read *before* they break something. Every list is
 * rendered from `community-rules.ts`, so a rule that is not there cannot be
 * promised on screen.
 */
export function GuidelinesSheet({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-h-[85dvh] w-full max-w-[430px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('community.guidelines.title')}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-4 pt-0">
          <p className="text-body-sm text-muted-foreground">{t('community.guidelines.intro')}</p>

          <section>
            <h3 className="text-overline text-muted-foreground uppercase">
              {t('community.rules.title')}
            </h3>
            <ol className="mt-2 space-y-3">
              {RULES.map((rule, index) => (
                <li key={rule.id} className="flex gap-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-caption text-brand">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{t(rule.titleKey)}</span>
                    <span className="mt-0.5 block text-body-sm text-muted-foreground">
                      {t(rule.bodyKey)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <h3 className="text-overline text-muted-foreground uppercase">
              {t('community.enforce.title')}
            </h3>
            <ul className="mt-2 space-y-2">
              {ENFORCEMENT.map((key) => (
                <li
                  key={key}
                  className="rounded-md bg-muted px-3 py-2.5 text-body-sm text-muted-foreground"
                >
                  {t(key)}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-overline text-muted-foreground uppercase">
              {t('community.terms.title')}
            </h3>
            <ul className="mt-2 space-y-2">
              {TERMS.map((key) => (
                <li key={key} className="text-body-sm text-muted-foreground">
                  {t(key)}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
