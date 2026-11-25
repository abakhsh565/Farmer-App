/**
 * The evidence under an assistant answer.
 *
 * A list of published entries, not a sentence naming a department: a model answer
 * can only claim the sources the gateway actually retrieved, and the tier of each
 * source is what tells a farmer whether they are reading a regulator's threshold
 * or an editorial note.
 *
 * It lived inside the scan screen while the scan screen held the follow-up
 * conversation. The conversation moved to the assistant tab, and the evidence
 * moved with it — because an answer that loses its sources on the way to a nicer
 * composer is a worse answer, not a tidier one.
 */
import type { AiCitation } from '@/services/types';
import type { MessageKey } from '@/i18n/catalog';
import { intlLocale } from '@/i18n/format';

function tierKey(tier: AiCitation['evidenceTier']): MessageKey {
  if (tier === 'verified') return 'scan.sources.verified';
  if (tier === 'community') return 'scan.sources.community';
  return 'scan.sources.supplementary';
}

function sourceDate(
  value: string | undefined,
  locale: Parameters<typeof intlLocale>[0],
): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function AnswerSources({
  citations,
  locale,
  t,
}: {
  citations: AiCitation[];
  locale: Parameters<typeof intlLocale>[0];
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  const sources = citations.filter((citation) => citation.kind === 'knowledge');
  if (sources.length === 0) return null;

  return (
    <section aria-label={t('scan.sources.title')} className="mt-3 border-t border-border/60 pt-2.5">
      <p className="text-overline text-muted-foreground uppercase">{t('scan.sources.title')}</p>
      <ul className="mt-1.5 space-y-2">
        {sources.map((citation, index) => {
          const tier = citation.evidenceTier ?? 'supplementary';
          const date = citation.updatedOn ?? citation.publishedOn;
          const dateLabel = date
            ? t(citation.updatedOn ? 'scan.sources.updated' : 'scan.sources.published', {
                date: sourceDate(date, locale) ?? date,
              })
            : citation.accessedOn
              ? t('scan.sources.accessed', {
                  date: sourceDate(citation.accessedOn, locale) ?? citation.accessedOn,
                })
              : t('scan.sources.noDate');

          return (
            <li key={`${citation.slug ?? citation.label}-${index}`} className="text-label leading-snug">
              <span className="block font-medium">{citation.label}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
                <span
                  className={`rounded-sm px-1.5 py-0.5 ${
                    tier === 'verified'
                      ? 'bg-brand-soft text-brand'
                      : tier === 'community'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-100'
                  }`}
                >
                  {t(tierKey(tier))}
                </span>
                <span>{citation.source ?? t('scan.sources.unknown')}</span>
                {citation.version ? <span>v{citation.version}</span> : null}
                <span>{dateLabel}</span>
              </span>
              {citation.sourceUrl?.startsWith('https://') ? (
                <a
                  href={citation.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 inline-block text-caption font-medium text-brand underline underline-offset-2"
                >
                  {t('scan.sources.open')}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
