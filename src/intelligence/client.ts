/**
 * The client side of the intelligence foundation.
 *
 * It is deliberately thin: the database owns the rules, the weights and the
 * ranking, and this module only carries typed calls across the wire. Anything
 * computed here would be a second implementation of the algorithm, which is the
 * failure this whole layer exists to prevent.
 *
 * Every function returns a value or `null`/`false` — never a throw. A farmer on
 * a village connection must not lose a screen because a ranking call timed out,
 * and a build with no backend must still run.
 */

import { getSupabaseClient, type SupabaseLike } from '@/services/supabaseClient';
import {
  flushQueue,
  type EventContext,
  type IntelligenceEvent,
  type StorageLike,
} from './events';
import {
  parseInterestSetting,
  parseInterestSettings,
  type InterestSetting,
} from './interests';
import {
  parseRankedRecommendations,
  type RankedRecommendation,
} from './feed';
import { parseAlerts, type AlertRow } from './alerts';
import {
  parseAlertPreferences,
  type AlertPreferences,
  type AlertPreferencesInput,
} from './alertPreferences';
import type { ServerCropContext } from './cropContext';

export type SupabaseConfig = {
  configured: boolean;
  url: string | null;
  anonKey: string | null;
};

export type FeedbackVerdict = 'helpful' | 'not_relevant' | 'acted' | 'dismissed' | 'saved';

export type FeedbackInput = {
  key: string;
  verdict: FeedbackVerdict;
  recommendationId?: string | null;
  insightRef?: string | null;
  reason?: string | null;
  context?: EventContext;
};

export type { RankedRecommendation } from './feed';

export type IntelligenceGateway = {
  sendEvent: (event: IntelligenceEvent) => Promise<boolean>;
  sendFeedback: (input: FeedbackInput) => Promise<boolean>;
  readContext: () => Promise<Record<string, unknown> | null>;
  prepareRecommendations: (crops: readonly ServerCropContext[]) => Promise<boolean>;
  /** Null is a failed read; an empty array is a genuinely empty feed. */
  readRankedFeed: (limit?: number) => Promise<RankedRecommendation[] | null>;
  prepareAlerts: () => Promise<boolean>;
  /** Null is a failed read; an empty array is a genuinely empty alert list. */
  readAlerts: (limit?: number) => Promise<AlertRow[] | null>;
  markAlertRead: (notificationId: string) => Promise<boolean>;
  dismissAlert: (notificationId: string) => Promise<boolean>;
  readAllAlerts: () => Promise<number>;
  readAlertPreferences: () => Promise<AlertPreferences | null>;
  saveAlertPreferences: (input: AlertPreferencesInput) => Promise<AlertPreferences | null>;
  /** Full list; null is a failure, [] is genuinely empty. */
  readInterestSettings: () => Promise<InterestSetting[] | null>;
  setInterestPin: (topic: string, pinned: boolean) => Promise<InterestSetting | null>;
  dismissInterest: (topic: string) => Promise<boolean>;
};

type RpcClient = Pick<SupabaseLike, 'rpc'>;

/**
 * Maps the device event onto the RPC's parameters.
 *
 * Note what is absent: no farmer id. The server derives the owner from the
 * session, so a modified client cannot write behaviour into somebody else's
 * profile, and this function has no way to try.
 */
function eventArgs(event: IntelligenceEvent): Record<string, unknown> {
  return {
    p_event_key: event.key,
    p_signal_type: event.type,
    p_source: event.source,
    p_subject: event.subject ?? null,
    p_crop_code: event.cropCode ?? null,
    p_strength: 'moderate',
    p_weight_hint: null,
    p_context: {
      ...(event.context ?? {}),
      ...(event.stage ? { stage: event.stage } : {}),
    },
    p_occurred_at: new Date(event.at).toISOString(),
  };
}

export function gatewayFor(client: RpcClient): IntelligenceGateway {
  return {
    async sendEvent(event) {
      const { error } = await client.rpc('record_behaviour_event', eventArgs(event));
      return error === null;
    },

    async sendFeedback(input) {
      const { error } = await client.rpc('record_intelligence_feedback', {
        p_idempotency_key: input.key,
        p_verdict: input.verdict,
        p_recommendation_id: input.recommendationId ?? null,
        p_insight_ref: input.insightRef ?? null,
        p_reason: input.reason ?? null,
        p_context: input.context ?? {},
      });
      return error === null;
    },

    async readContext() {
      const { data, error } = await client.rpc('farmer_intelligence_context', {});
      if (error || data === null || typeof data !== 'object') return null;
      return data as Record<string, unknown>;
    },

    async readInterestSettings() {
      const { data, error } = await client.rpc('farmer_interest_settings', {});
      if (error || !Array.isArray(data)) return null;
      return parseInterestSettings(data);
    },

    async setInterestPin(topic, pinned) {
      const { data, error } = await client.rpc('set_farmer_interest_pin', {
        p_topic: topic,
        p_pinned: pinned,
      });
      if (error || data === null || typeof data !== 'object') return null;
      return parseInterestSetting(data);
    },

    async dismissInterest(topic) {
      const { data, error } = await client.rpc('dismiss_farmer_interest', {
        p_topic: topic,
      });
      if (error) return false;
      return data === true;
    },

    async prepareRecommendations(crops) {
      const { error } = await client.rpc('prepare_my_recommendations', {
        p_crops: crops,
      });
      return error === null;
    },

    async readRankedFeed(limit = 20) {
      const { data, error } = await client.rpc('intelligence_recommendation_feed', {
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) return null;
      return parseRankedRecommendations(data);
    },

    async prepareAlerts() {
      const { error } = await client.rpc('prepare_my_alerts', {});
      return error === null;
    },

    async readAlerts(limit = 20) {
      const { data, error } = await client.rpc('intelligence_alert_feed', { p_limit: limit });
      if (error || !Array.isArray(data)) return null;
      return parseAlerts(data);
    },

    async markAlertRead(notificationId) {
      const { data, error } = await client.rpc('mark_alert_read', {
        p_notification_id: notificationId,
      });
      return error === null && data === true;
    },

    async dismissAlert(notificationId) {
      const { data, error } = await client.rpc('dismiss_alert', {
        p_notification_id: notificationId,
      });
      return error === null && data === true;
    },

    async readAllAlerts() {
      const { data, error } = await client.rpc('mark_all_alerts_read', {});
      if (error || typeof data !== 'number' || !Number.isFinite(data)) return 0;
      return data;
    },

    async readAlertPreferences() {
      const { data, error } = await client.rpc('farmer_alert_preferences', {});
      if (error || data === null || typeof data !== 'object') return null;
      return parseAlertPreferences(data);
    },

    async saveAlertPreferences(input) {
      const { data, error } = await client.rpc('set_farmer_alert_preferences', {
        p_in_app: input.inApp,
        p_push: input.push,
        p_categories: input.categories,
        p_consent_version: input.consentVersion,
      });
      if (error || data === null || typeof data !== 'object') return null;
      return parseAlertPreferences(data);
    },
  };
}

/** The gateway, or null when this build has no backend. */
export async function getIntelligenceGateway(
  config: SupabaseConfig,
): Promise<IntelligenceGateway | null> {
  const client = await getSupabaseClient(config);
  return client ? gatewayFor(client) : null;
}

/** Drains the outbox through a gateway. Returns how much reached the server. */
export async function flushEvents(
  storage: StorageLike,
  gateway: IntelligenceGateway,
): Promise<{ sent: number; remaining: number }> {
  return flushQueue(storage, (event) => gateway.sendEvent(event));
}
