import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldReportValue } from '@/intel/report';

/**
 * Sending a report, tested where it can fail.
 *
 * Two things are asserted that a happy-path test would miss: the payload carries
 * no reporter id — the author comes from the session, and a client that tried to
 * name one would be the bug — and a failed send says it failed. A build with no
 * backend answering "sent" is the one outcome that would let a farmer believe a
 * warning went out that never did.
 */

type RpcResult = { data: unknown; error: { message: string } | null };

const rpc = vi.fn<(fn: string, args?: Record<string, unknown>) => Promise<RpcResult>>();
let configured = true;

vi.mock('./supabaseClient', async () => {
  const actual = await vi.importActual<typeof import('./supabaseClient')>('./supabaseClient');
  return {
    ...actual,
    getSupabaseClient: async () =>
      configured ? { rpc, auth: {} } : null,
  };
});

const { submitFieldReport } = await import('./intelReports');

const VALUE: FieldReportValue = {
  cropCode: 'cotton',
  topic: 'pest',
  title: 'Pink bollworm in bolls',
  body: 'Found larvae in about a tenth of the bolls this morning.',
  lat: 30.97,
  lon: 70.94,
  areaLabel: 'Layyah, Chak 42',
  district: 'layyah',
  idempotencyKey: 'fr-abc123-20261014',
};

beforeEach(() => {
  rpc.mockReset();
  configured = true;
});

describe('sending a field report', () => {
  it('calls the one intake function with the farmer’s words and no author', async () => {
    rpc.mockResolvedValue({ data: { id: 'report-1' }, error: null });

    await expect(submitFieldReport(VALUE)).resolves.toEqual({ ok: true, id: 'report-1' });

    expect(rpc).toHaveBeenCalledWith('submit_crop_report', {
      p_crop_code: 'cotton',
      p_topic: 'pest',
      p_title: 'Pink bollworm in bolls',
      p_body: 'Found larvae in about a tenth of the bolls this morning.',
      p_lat: 30.97,
      p_lon: 70.94,
      p_area_label: 'Layyah, Chak 42',
      p_district: 'layyah',
      p_observed_at: null,
      p_idempotency_key: 'fr-abc123-20261014',
    });

    // The whole point of migration 0027: there is no `p_reporter_id` to get wrong.
    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(Object.keys(args)).not.toContain('p_reporter_id');
  });

  it('accepts the row whether PostgREST sends an object or an array', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'report-2' }], error: null });
    await expect(submitFieldReport(VALUE)).resolves.toEqual({ ok: true, id: 'report-2' });
  });

  it('carries the server’s own refusal, rather than replacing it', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Reporting requires an identified farmer.' },
    });

    const result = await submitFieldReport(VALUE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toBe('Reporting requires an identified farmer.');
  });

  it('says nothing was sent when the backend is not configured', async () => {
    configured = false;
    const result = await submitFieldReport(VALUE);
    expect(result).toEqual({ ok: false, error: 'report.error.offline', detail: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('treats an empty answer as a failure, not as a submission', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const result = await submitFieldReport(VALUE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('report.error.generic');
  });
});
