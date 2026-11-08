import { describe, expect, it, vi } from 'vitest';
import {
  addIngestionError,
  addWriteOutcome,
  completedStatus,
  emptyAccount,
  finalizeIngestionRun,
  finishIngestionRun,
  ingestionFailurePayload,
  persistIngestionContext,
  rowsWritten,
  writeOutcome,
  type IngestionAccount,
  type IngestionRunState,
} from '../../supabase/functions/_shared/ingestion-accounting';

function account(overrides: Partial<IngestionAccount> = {}): IngestionAccount {
  return { ...emptyAccount(), ...overrides };
}

function runState(overrides: Partial<IngestionRunState> = {}): IngestionRunState {
  return {
    run_id: 21,
    kind: 'climate',
    status: 'running',
    error: null,
    processing_errors: [],
    ...overrides,
  };
}

describe('ingestion accounting', () => {
  it('separates inserts and updates from the rows the provider returned', () => {
    const a = account({ fetched: 8 });
    addWriteOutcome(a, {
      records_inserted: 5,
      records_updated: 2,
      records_unchanged: 1,
      records_duplicate: 0,
    });
    expect(a).toMatchObject({ fetched: 8, inserted: 5, updated: 2, skipped: 1 });
    expect(rowsWritten(a)).toBe(7);
  });

  it('finishes a repeated unchanged run as ok, not partial', () => {
    const first = account({ fetched: 7 });
    addWriteOutcome(first, {
      records_inserted: 7, records_updated: 0, records_unchanged: 0, records_duplicate: 0,
    });
    const second = account({ fetched: 7 });
    addWriteOutcome(second, {
      records_inserted: 0, records_updated: 0, records_unchanged: 7, records_duplicate: 0,
    });
    expect(first.inserted).toBe(7);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(7);
    expect(rowsWritten(second)).toBe(0);
    expect(completedStatus(second)).toBe('ok');
    expect(completedStatus(second, true)).toBe('partial');
  });

  it('counts a changed existing row as an update', () => {
    const a = account({ fetched: 1 });
    addWriteOutcome(a, {
      records_inserted: 0, records_updated: 1, records_unchanged: 0, records_duplicate: 0,
    });
    expect(a.updated).toBe(1);
    expect(rowsWritten(a)).toBe(1);
    expect(completedStatus(a)).toBe('ok');
  });

  it('counts invalid records as rejected and unavailable source records as incomplete', () => {
    const a = account({ fetched: 5, rejected: 2 });
    expect(completedStatus(a)).toBe('partial');
    expect(completedStatus(account({ fetched: 5 }), true)).toBe('partial');
    expect(a.inserted).toBe(0);
    expect(rowsWritten(a)).toBe(0);
  });

  it('counts a persistence failure without calling it a write', () => {
    const a = account({ fetched: 4, inserted: 2, failed: 2 });
    expect(rowsWritten(a)).toBe(2);
    expect(completedStatus(a)).toBe('partial');
  });

  it('represents a complete provider failure without invented rows', () => {
    const a = emptyAccount();
    expect(a).toEqual({ fetched: 0, inserted: 0, updated: 0, skipped: 0, rejected: 0, failed: 0 });
    expect(rowsWritten(a)).toBe(0);
    // A provider failure is finalized as `failed` by the adapter; this helper
    // only describes an account with no persistence or source gaps.
    expect(completedStatus(a)).toBe('ok');
  });

  it('parses the first row of a set-returning RPC and ignores missing fields', () => {
    expect(writeOutcome([{ records_inserted: 3 }])).toMatchObject({ inserted: 3, updated: 0 });
    expect(writeOutcome(null)).toEqual({ inserted: 0, updated: 0, unchanged: 0, duplicates: 0 });
    expect(writeOutcome({ records_inserted: 1.9, records_updated: -2 })).toMatchObject({
      inserted: 1,
      updated: 0,
    });
  });
});

describe('durable run context', () => {
  it('persists context before finalization and sends the full error list', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const contextState = runState({
      records_fetched: 35,
      records_updated: 2,
      records_skipped: 33,
      error: 'first provider failure',
      processing_errors: ['first provider failure', 'second provider failure'],
    });
    const finalizedState = runState({
      ...contextState,
      status: 'partial',
      finished_at: '2026-11-05T00:00:00.000Z',
    });
    const rpc = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'record_ingestion_run_context') {
        return { data: { ok: true, state: contextState }, error: null };
      }
      if (name === 'finalize_ingestion_run') {
        return { data: { ok: true, state: finalizedState }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    };

    const result = await finishIngestionRun(
      'test-ingest',
      21,
      'climate',
      'partial',
      account({ fetched: 35, updated: 2, skipped: 33 }),
      ['first provider failure', 'second provider failure'],
      null,
      rpc,
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.name)).toEqual([
      'record_ingestion_run_context',
      'finalize_ingestion_run',
    ]);
    expect(calls[0]?.args).toMatchObject({
      p_kind: 'climate',
      p_run_id: 21,
      p_error: 'first provider failure',
      p_errors: ['first provider failure', 'second provider failure'],
    });
    expect(calls[1]?.args).toMatchObject({
      p_status: 'partial',
      p_errors: ['first provider failure', 'second provider failure'],
    });
  });

  it('stops before finalization when context persistence fails', async () => {
    const calls: string[] = [];
    const rpc = async (name: string) => {
      calls.push(name);
      return { data: null, error: { message: 'context write denied' } };
    };

    const result = await finishIngestionRun(
      'test-ingest',
      22,
      'climate',
      'partial',
      account({ fetched: 4, inserted: 1 }),
      ['provider returned 422'],
      null,
      rpc,
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'context',
      error: 'context write denied',
    });
    expect(calls).toEqual(['record_ingestion_run_context', 'get_ingestion_run_state']);
    expect(ingestionFailurePayload(22, account({ fetched: 4, inserted: 1 }), ['provider returned 422'], result))
      .toMatchObject({
        error: 'provider returned 422',
        run_context_error: 'context write denied',
        processing_errors: ['provider returned 422'],
      });
  });

  it('returns the original provider error beside a finalization failure', async () => {
    const running = runState({
      error: 'Open-Meteo archive answered 400: run unavailable; persistence failed',
      processing_errors: [
        'Open-Meteo archive answered 400: run unavailable',
        'persistence failed',
      ],
      records_fetched: 35,
      records_updated: 2,
      records_skipped: 33,
    });
    const rpc = async (name: string) => {
      if (name === 'record_ingestion_run_context') {
        return { data: { ok: true, state: running }, error: null };
      }
      if (name === 'finalize_ingestion_run') {
        return { data: { ok: false, error: 'permission denied', state: running }, error: null };
      }
      if (name === 'get_ingestion_run_state') {
        return { data: running, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    };

    const errors = [
      'Open-Meteo archive answered 400: run unavailable',
      'persistence failed',
    ];
    const result = await finishIngestionRun(
      'historical-forecast-ingest',
      23,
      'climate',
      'partial',
      account({ fetched: 35, updated: 2, skipped: 33 }),
      errors,
      null,
      rpc,
    );
    const payload = ingestionFailurePayload(
      23, account({ fetched: 35, updated: 2, skipped: 33 }), errors, result,
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'finalization',
      error: 'permission denied',
      state: running,
    });
    expect(payload).toMatchObject({
      ok: false,
      error: 'Open-Meteo archive answered 400: run unavailable',
      run_id: 23,
      run_finalization_error: 'permission denied',
      processing_errors: errors,
      persisted_run: running,
    });
    expect(payload.accounting).toMatchObject({ fetched: 35, updated: 2, skipped: 33 });
  });

  it('reads the actual persisted state when finalization transport fails', async () => {
    const persisted = runState({
      status: 'running',
      error: 'provider failed',
      processing_errors: ['provider failed'],
    });
    const rpc = async (name: string) => {
      if (name === 'record_ingestion_run_context') {
        return { data: { ok: true, state: persisted }, error: null };
      }
      if (name === 'finalize_ingestion_run') {
        throw new Error('network unavailable');
      }
      if (name === 'get_ingestion_run_state') {
        return { data: persisted, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    };

    const result = await finishIngestionRun(
      'climate-ingest',
      24,
      'climate',
      'failed',
      account(),
      ['provider failed'],
      null,
      rpc,
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'finalization',
      error: 'network unavailable',
      state: persisted,
    });
  });

  it('keeps multiple distinct errors and de-duplicates repeated ones', async () => {
    const errors: string[] = [];
    addIngestionError(errors, 'provider timeout');
    addIngestionError(errors, 'provider timeout');
    addIngestionError(errors, new Error('persistence failed'));
    addIngestionError(errors, '');

    let sent: Record<string, unknown> | null = null;
    await persistIngestionContext(
      'test-ingest',
      25,
      'weather',
      account({ fetched: 2 }),
      errors,
      1,
      async (_name, args) => {
        sent = args;
        return { data: { ok: true, state: runState({ kind: 'weather' }) }, error: null };
      },
    );

    expect(errors).toEqual(['provider timeout', 'persistence failed']);
    expect(sent).toMatchObject({
      p_error: 'provider timeout',
      p_errors: ['provider timeout', 'persistence failed'],
      p_cells_written: 1,
    });
  });

  it('does not claim success when the context RPC returns ok:false', async () => {
    const result = await finishIngestionRun(
      'test-ingest',
      26,
      'soil',
      'ok',
      account(),
      [],
      0,
      async (name) => {
        if (name === 'record_ingestion_run_context') {
          return {
            data: { ok: false, error: 'run is no longer running', state: runState({ kind: 'soil' }) },
            error: null,
          };
        }
        throw new Error('finalize must not run');
      },
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'context',
      error: 'run is no longer running',
    });
    expect(ingestionFailurePayload(26, account(), [], result)).toMatchObject({
      error: 'Ingestion context could not be persisted.',
      run_context_error: 'run is no longer running',
    });
  });
});

describe('run finalization', () => {
  it('passes the terminal patch to the database update', async () => {
    let seen: Record<string, unknown> | null = null;
    const result = await finalizeIngestionRun('test-ingest', 7, { status: 'ok' }, async (patch) => {
      seen = patch;
      return { error: null };
    });
    expect(result).toEqual({ ok: true, error: null });
    expect(seen).toEqual({ status: 'ok' });
  });

  it('returns an explicit failure when the status update is rejected', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await finalizeIngestionRun(
      'test-ingest',
      8,
      { status: 'failed' },
      async () => ({ error: { message: 'permission denied' } }),
    );
    expect(result).toEqual({ ok: false, error: 'permission denied' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('run 8 finalization failed'),
    );
    log.mockRestore();
  });

  it('returns an explicit failure when the status update throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await finalizeIngestionRun('test-ingest', 9, {}, async () => {
      throw new Error('network unavailable');
    });
    expect(result).toEqual({ ok: false, error: 'network unavailable' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('run 9 finalization failed'),
    );
    log.mockRestore();
  });
});
