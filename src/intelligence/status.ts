import type { MessageKey } from '@/i18n/catalog';
import type { PersonalizationStatus } from './usePersonalizedFeed';

/**
 * One notice for the one recommendation card.
 *
 * Local saved advice is never covered by a status line: if there is something
 * real to read, the notice would be noise. The order also keeps "offline" from
 * being misreported as an empty feed, and a failed personalization call from
 * being presented as "no advice today".
 */
export function personalizationNotice(params: {
  account: boolean;
  online: boolean;
  status: PersonalizationStatus;
  hasLocalAdvice: boolean;
  hasServerAdvice: boolean;
  hasCrops: boolean;
}): MessageKey | null {
  const { account, online, status, hasLocalAdvice, hasServerAdvice, hasCrops } = params;
  if (!account || hasServerAdvice || hasLocalAdvice) return null;
  if (status === 'loading') return 'insight.loading';
  if (status === 'error') return 'insight.error';
  if (!online) return 'insight.offline';
  if (!hasCrops) return 'insight.empty';
  if (status === 'fallback') return 'insight.empty';
  return null;
}
