/**
 * Sending a field report.
 *
 * One entry point, one named function, and no reporter id in the payload: the
 * database takes the author from the caller's own session
 * (`current_party_id()`), so a report cannot be filed as somebody else even by a
 * client that tries. The client sends only what the farmer wrote and the
 * approximate point it was written from.
 *
 * Nothing is invented on failure. A build with no backend configured answers
 * "not sent", not "sent" — a farmer who believes a neighbour was warned when
 * nothing reached the server is worse off than one who is told to try again.
 */

import type { MessageKey } from '@/i18n/catalog';
import type { FieldReportValue } from '@/intel/report';
import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

export type SubmitReportResult =
  | { ok: true; id: string }
  /** `detail` is the server's own sentence when it refused — not a guess at one. */
  | { ok: false; error: MessageKey; detail: string | null };

/**
 * Files the report.
 *
 * The RPC is idempotent on (reporter, idempotency key), so calling this twice for
 * one draft — a double tap, a retry after a dropped connection — returns the same
 * report rather than a duplicate.
 */
export async function submitFieldReport(value: FieldReportValue): Promise<SubmitReportResult> {
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) {
    return { ok: false, error: 'report.error.offline', detail: null };
  }

  const { data, error } = await client.rpc('submit_crop_report', {
    p_crop_code: value.cropCode,
    p_topic: value.topic,
    p_title: value.title,
    p_body: value.body,
    p_lat: value.lat,
    p_lon: value.lon,
    p_area_label: value.areaLabel,
    p_district: value.district,
    p_observed_at: null,
    p_idempotency_key: value.idempotencyKey,
  });

  if (error) {
    return { ok: false, error: 'report.error.generic', detail: error.message };
  }

  /*
   * The function returns the row it inserted. PostgREST hands back an object for
   * a composite return type and an array for a set-returning one, and this app
   * has both shapes in the chain — so both are accepted rather than the code
   * betting on which the deployed version is.
   */
  const row = Array.isArray(data) ? (data[0] as { id?: string } | undefined) : (data as { id?: string } | null);
  if (!row?.id) {
    return { ok: false, error: 'report.error.generic', detail: null };
  }

  return { ok: true, id: row.id };
}
