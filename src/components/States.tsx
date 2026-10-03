import { Inbox, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * The three states every data-backed screen needs, in one place so they cannot
 * drift apart. Presentational only — the caller supplies translated copy.
 *
 * Each one says what happened, why, and what to do next, which is the pattern
 * the rest of the product follows.
 */

export function LoadingState({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 px-8 py-14 text-center"
    >
      <LoaderCircle aria-hidden className="size-5 animate-spin text-muted-foreground" />
      <p className="text-body-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  body: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-8 py-14 text-center">
      <Icon aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-subheading">{title}</p>
      <p className="max-w-[34ch] text-body-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  onRetry,
  retryLabel,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  retryLabel: string;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-8 py-14 text-center">
      <TriangleAlert aria-hidden className="size-5 text-amber-700 dark:text-amber-100" />
      <p className="text-subheading">{title}</p>
      <p className="max-w-[34ch] text-body-sm text-muted-foreground">{body}</p>
      {onRetry ? (
        <Button variant="outline" className="mt-2 h-11" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
