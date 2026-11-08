import { useState } from 'react';
import {
  Bug,
  ChevronLeft,
  CloudSun,
  Pin,
  PinOff,
  SlidersHorizontal,
  Sparkles,
  Sprout,
  Trash2,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/i18n/LocaleProvider';
import {
  groupInterestSettings,
  interestLabel,
  interestSourceKey,
  type InterestSetting,
} from '@/intelligence/interests';
import { useInterestSettings } from '@/intelligence/useInterestSettings';
import { useSession } from '@/session/SessionProvider';
import { useOnline } from '@/services/persistence';

/**
 * Advice preferences: the farmer's view of what shapes their recommendations.
 *
 * This is a settings screen, not a scoring dashboard. It shows subjects and
 * provenance, never weights, confidence values, UUIDs or formula names. Every
 * write is confirmed by the server before the row changes; offline keeps the last
 * real list for reading and disables the controls rather than pretending.
 */
export function InterestsScreen({ onBack }: { onBack: () => void }) {
  const { t } = useLocale();
  const { account, prompt } = useSession();
  const online = useOnline();
  const interests = useInterestSettings({
    accountId: account?.id ?? null,
    enabled: Boolean(account),
    online,
  });
  const [confirming, setConfirming] = useState<InterestSetting | null>(null);

  const groups = groupInterestSettings(interests.settings);
  const hasRows = interests.settings.length > 0;

  const togglePin = async (row: InterestSetting) => {
    const accepted = await interests.setPinned(row.topic, !row.pinned);
    if (accepted) {
      toast.success(t(row.pinned ? 'interests.unkept' : 'interests.kept'));
    } else {
      toast.error(t('interests.saveFailed'));
    }
  };

  const confirmRemove = async () => {
    if (!confirming) return;
    const accepted = await interests.remove(confirming.topic);
    setConfirming(null);
    if (accepted) toast.success(t('interests.removed'));
    else toast.error(t('interests.saveFailed'));
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-8">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <h1 className="text-heading">{t('interests.title')}</h1>
      </div>

      <p className="mt-3 max-w-[48ch] text-body-sm leading-relaxed text-muted-foreground">
        {t('interests.intro')}
      </p>

      {!account ? (
        <EmptyState
          icon={SlidersHorizontal}
          title={t('interests.signIn')}
          body={t('interests.signInBody')}
          action={
            <button
              type="button"
              onClick={() => prompt('session.why.interests')}
              className="h-11 rounded-full bg-primary px-5 text-body text-primary-foreground"
            >
              {t('profile.account.signIn')}
            </button>
          }
        />
      ) : null}

      {account && interests.status === 'loading' && !hasRows ? (
        <LoadingState label={t('interests.loading')} />
      ) : null}

      {account && interests.status === 'error' && !hasRows ? (
        <ErrorState
          title={t('interests.errorTitle')}
          body={t('interests.errorBody')}
          onRetry={interests.refresh}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}

      {account && interests.status === 'offline' && !hasRows ? (
        <EmptyState
          icon={CloudSun}
          title={t('interests.offlineTitle')}
          body={t('interests.offlineBody')}
        />
      ) : null}

      {account && interests.status === 'ready' && !hasRows ? (
        <EmptyState
          icon={Sparkles}
          title={t('interests.emptyTitle')}
          body={t('interests.emptyBody')}
        />
      ) : null}

      {account && interests.status === 'offline' && hasRows ? (
        <p
          role="status"
          className="mt-4 rounded-md border border-amber-300/60 bg-amber-50 px-3.5 py-3 text-body-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
        >
          {t('interests.offlineBody')}
        </p>
      ) : null}

      {account && interests.saveFailed ? (
        <p role="alert" className="mt-4 text-body-sm text-red-700 dark:text-red-100">
          {t('interests.saveFailed')}
        </p>
      ) : null}

      {account && hasRows ? (
        <div className="mt-4 flex flex-col gap-5">
          <Group
            id="pinned"
            title={t('interests.pinnedSection')}
            hint={t('interests.pinnedHint')}
            rows={groups.pinned}
            online={online}
            pendingTopic={interests.pendingTopic}
            onPin={togglePin}
            onRemove={setConfirming}
          />
          <Group
            id="chosen"
            title={t('interests.chosenSection')}
            rows={groups.chosen}
            online={online}
            pendingTopic={interests.pendingTopic}
            onPin={togglePin}
            onRemove={setConfirming}
          />
          <Group
            id="learned"
            title={t('interests.learnedSection')}
            hint={t('interests.learnedHint')}
            rows={groups.learned}
            online={online}
            pendingTopic={interests.pendingTopic}
            onPin={togglePin}
            onRemove={setConfirming}
          />
        </div>
      ) : null}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('interests.removeTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-body-sm leading-relaxed text-muted-foreground">
            {t('interests.removeBody')}
          </p>
          {confirming ? (
            <p className="text-body">{interestLabel(confirming.topic, t)}</p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="h-11 rounded-full border border-border px-4 text-body"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void confirmRemove()}
              className="h-11 rounded-full bg-destructive px-4 text-body text-white"
            >
              {t('interests.removeConfirm')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Group({
  id,
  title,
  hint,
  rows,
  online,
  pendingTopic,
  onPin,
  onRemove,
}: {
  id: string;
  title: string;
  hint?: string;
  rows: InterestSetting[];
  online: boolean;
  pendingTopic: string | null;
  onPin: (row: InterestSetting) => void;
  onRemove: (row: InterestSetting) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby={`interest-group-${id}`}>
      <h2 id={`interest-group-${id}`} className="text-subheading">
        {title}
      </h2>
      {hint ? (
        <p className="mt-1 text-label leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      <ul className="mt-2 overflow-hidden rounded-md border border-border bg-card">
        {rows.map((row) => (
          <InterestRow
            key={row.topic}
            row={row}
            online={online}
            pending={pendingTopic === row.topic}
            onPin={() => void onPin(row)}
            onRemove={() => onRemove(row)}
          />
        ))}
      </ul>
    </section>
  );
}

function InterestRow({
  row,
  online,
  pending,
  onPin,
  onRemove,
}: {
  row: InterestSetting;
  online: boolean;
  pending: boolean;
  onPin: () => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const label = interestLabel(row.topic, t);
  const Icon = iconFor(row.topic);
  const disabled = !online || pending;

  return (
    <li className="flex items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <Icon className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body">{label}</p>
        <p className="mt-0.5 text-label text-muted-foreground">{t(interestSourceKey(row))}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-pressed={row.pinned}
          aria-label={`${t(row.pinned ? 'interests.stopKeeping' : 'interests.keep')}: ${label}`}
          disabled={disabled}
          onClick={onPin}
          className="grid size-11 place-items-center rounded-full text-brand disabled:opacity-40"
        >
          {row.pinned ? (
            <PinOff className="size-4" aria-hidden />
          ) : (
            <Pin className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label={`${t('interests.remove')}: ${label}`}
          disabled={disabled}
          onClick={onRemove}
          className="grid size-11 place-items-center rounded-full text-muted-foreground disabled:opacity-40"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}

function iconFor(topic: string): LucideIcon {
  if (topic.startsWith('crop:')) return Sprout;
  if (topic === 'topic:pest') return Bug;
  if (topic === 'topic:weather') return CloudSun;
  if (topic === 'topic:market') return TrendingUp;
  return Sparkles;
}
