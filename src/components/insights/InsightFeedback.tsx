import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';
import { useRecommendationFeedback } from '@/intelligence/useRecommendationFeedback';

/**
 * Two deliberate answers, not a rating widget. It is rendered only when the
 * provider found one unambiguous server recommendation behind this insight; a
 * local-only card keeps its existing actions and sends nothing.
 */
export function InsightFeedback({
  insightId,
  insightKind,
  recommendationId,
  compact = false,
}: {
  insightId: string;
  insightKind: string;
  recommendationId: string;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const feedback = useRecommendationFeedback({
    recommendationId,
    insightRef: insightId,
    context: { screen: 'home', topic: insightKind },
  });

  const disabled = feedback.pending !== null || feedback.submitted !== null;

  return (
    <div className={compact ? 'mt-2' : 'rounded-md border border-border bg-muted/40 p-3.5'}>
      <p className={compact ? 'text-label text-muted-foreground' : 'text-body-sm font-medium'}>
        {t('insight.feedback.prompt')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={feedback.submitted === 'helpful'}
          disabled={disabled}
          onClick={() => void feedback.submit('helpful')}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-label disabled:opacity-50"
        >
          <ThumbsUp className="size-4" aria-hidden />
          <span>{t('insight.feedback.helpful')}</span>
        </button>
        <button
          type="button"
          aria-pressed={feedback.submitted === 'not_relevant'}
          disabled={disabled}
          onClick={() => void feedback.submit('not_relevant')}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-label disabled:opacity-50"
        >
          <ThumbsDown className="size-4" aria-hidden />
          <span>{t('insight.feedback.notRelevant')}</span>
        </button>
      </div>
      {feedback.submitted ? (
        <p role="status" className="mt-2 text-label text-brand">
          {t('insight.feedback.thanks')}
        </p>
      ) : null}
      {feedback.failed ? (
        <p role="alert" className="mt-2 text-label text-red-700 dark:text-red-100">
          {t('insight.feedback.failed')}
        </p>
      ) : null}
    </div>
  );
}
