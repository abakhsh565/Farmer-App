/**
 * Shared, runtime-neutral accounting for Phase 9 ingestion runs.
 *
 * A provider record is not a successful write. The functions count what the
 * provider returned, then add only the database outcomes reported by the
 * service-only recording RPCs. Keeping this arithmetic in one place stops the
 * five adapters drifting into five different definitions of "written".
 *
 * Failure context is persisted before terminal finalization. That means a run
 * rejected by the database still retains its provider error and counters, and
 * recovery can preserve them later.
 */

export type IngestionAccount = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  rejected: number;
  failed: number;
};

export type IngestionWriteOutcome = {
  inserted: number;
  updated: number;
  unchanged: number;
  duplicates: number;
};

export type IngestionRunKind = 'climate' | 'weather' | 'soil';

export type IngestionRunState = {
  run_id: number;
  kind: IngestionRunKind;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  heartbeat_at?: string | null;
  lease_expires_at?: string | null;
  recovered_at?: string | null;
  records_fetched?: number;
  records_inserted?: number;
  records_updated?: number;
  records_skipped?: number;
  records_rejected?: number;
  records_failed?: number;
  rows_seen?: number | null;
  rows_written?: number | null;
  cells_written?: number | null;
  error: string | null;
  processing_errors?: string[];
};

export type FinalizationResult =
  | { ok: true; error: null }
  | { ok: false; error: string };

export type IngestionContextResult = {
  ok: boolean;
  error: string | null;
  state: IngestionRunState | null;
};

export type IngestionFinalizationResult = {
  ok: boolean;
  error: string | null;
  state: IngestionRunState | null;
};

export type IngestionFinishResult = {
  ok: boolean;
  stage: 'context' | 'finalization' | null;
  error: string | null;
  state: IngestionRunState | null;
  stateError: string | null;
};

export type IngestionRpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export function emptyAccount(): IngestionAccount {
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0, rejected: 0, failed: 0 };
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Parse one PostgREST result row into the four database-outcome counts. */
export function writeOutcome(data: unknown): IngestionWriteOutcome {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return {
    inserted: count(row?.records_inserted),
    updated: count(row?.records_updated),
    unchanged: count(row?.records_unchanged),
    duplicates: count(row?.records_duplicate),
  };
}

/**
 * Add a database write outcome. Unchanged and duplicate rows are skipped, not
 * written; they must never be reported as inserted or updated.
 */
export function addWriteOutcome(account: IngestionAccount, data: unknown): void {
  const outcome = writeOutcome(data);
  account.inserted += outcome.inserted;
  account.updated += outcome.updated;
  account.skipped += outcome.unchanged + outcome.duplicates;
}

/** Rows a run actually changed in the target table. */
export function rowsWritten(account: IngestionAccount): number {
  return account.inserted + account.updated;
}

/**
 * A run is partial when source records were unavailable or unusable, or when a
 * persistence attempt failed. Skipped database rows (duplicates and unchanged
 * data) do not make a completed run partial: the source was fully processed and
 * the counters show why nothing changed.
 */
export function completedStatus(
  account: IngestionAccount,
  sourceIncomplete = false,
): 'ok' | 'partial' {
  return sourceIncomplete || account.rejected > 0 || account.failed > 0 ? 'partial' : 'ok';
}

/** Add a meaningful error once, preserving first-seen order. */
export function addIngestionError(errors: string[], error: unknown): void {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const normalized = detail.trim();
  if (normalized !== '' && !errors.includes(normalized)) errors.push(normalized);
}

function rpcMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

function runStateFrom(data: unknown): IngestionRunState | null {
  const payload = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const nested = payload.state;
  const state = nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : payload;
  if (!state || typeof state !== 'object') return null;
  return state as unknown as IngestionRunState;
}

function envelope(data: unknown): Record<string, unknown> | null {
  const payload = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return payload && typeof payload === 'object' ? payload : null;
}

/**
 * Persist counters and all processing errors before terminal finalization.
 * The database merges counters upward and de-duplicates errors by value.
 */
export async function persistIngestionContext(
  label: string,
  runId: number,
  kind: IngestionRunKind,
  account: IngestionAccount,
  errors: string[],
  cellsWritten: number | null,
  rpc: IngestionRpc,
): Promise<IngestionContextResult> {
  try {
    const { data, error } = await rpc('record_ingestion_run_context', {
      p_kind: kind,
      p_run_id: runId,
      p_counters: account,
      p_error: errors[0] ?? null,
      p_errors: errors,
      p_cells_written: cellsWritten,
    });
    const result = envelope(data);
    const state = runStateFrom(data);
    if (error) {
      const detail = rpcMessage(error, 'database context write failed');
      console.error(`[${label}] run ${runId} context persistence failed: ${detail}`);
      return { ok: false, error: detail, state };
    }
    if (result?.ok !== true) {
      const detail = typeof result?.error === 'string'
        ? result.error
        : 'database did not accept the run context';
      console.error(`[${label}] run ${runId} context persistence failed: ${detail}`);
      return { ok: false, error: detail, state };
    }
    return { ok: true, error: null, state };
  } catch (error) {
    const detail = rpcMessage(error, 'database context write threw');
    console.error(`[${label}] run ${runId} context persistence failed: ${detail}`);
    return { ok: false, error: detail, state: null };
  }
}

/** Apply terminal status through the atomic database finalization RPC. */
export async function finalizeIngestionRunRpc(
  label: string,
  runId: number,
  kind: IngestionRunKind,
  status: 'ok' | 'partial' | 'failed',
  account: IngestionAccount,
  errors: string[],
  cellsWritten: number | null,
  rpc: IngestionRpc,
): Promise<IngestionFinalizationResult> {
  try {
    const { data, error } = await rpc('finalize_ingestion_run', {
      p_kind: kind,
      p_run_id: runId,
      p_status: status,
      p_error: errors[0] ?? null,
      p_errors: errors,
      p_counters: account,
      p_cells_written: cellsWritten,
    });
    const result = envelope(data);
    const state = runStateFrom(data);
    if (error) {
      const detail = rpcMessage(error, 'database finalization failed');
      console.error(`[${label}] run ${runId} finalization failed: ${detail}`);
      return { ok: false, error: detail, state };
    }
    if (result?.ok !== true) {
      const detail = typeof result?.error === 'string'
        ? result.error
        : 'database did not accept the terminal status';
      console.error(`[${label}] run ${runId} finalization failed: ${detail}`);
      return { ok: false, error: detail, state };
    }
    return { ok: true, error: null, state };
  } catch (error) {
    const detail = rpcMessage(error, 'database finalization threw');
    console.error(`[${label}] run ${runId} finalization failed: ${detail}`);
    return { ok: false, error: detail, state: null };
  }
}

/** Read the actual persisted row, including after a failed finalization. */
export async function readIngestionRunState(
  label: string,
  runId: number,
  kind: IngestionRunKind,
  rpc: IngestionRpc,
): Promise<{ state: IngestionRunState | null; error: string | null }> {
  try {
    const { data, error } = await rpc('get_ingestion_run_state', {
      p_kind: kind,
      p_run_id: runId,
    });
    if (error) {
      const detail = rpcMessage(error, 'database state read failed');
      console.error(`[${label}] run ${runId} state read failed: ${detail}`);
      return { state: null, error: detail };
    }
    return { state: runStateFrom(data), error: null };
  } catch (error) {
    const detail = rpcMessage(error, 'database state read threw');
    console.error(`[${label}] run ${runId} state read failed: ${detail}`);
    return { state: null, error: detail };
  }
}

/**
 * Persist context first, then finalize. A context write failure stops the
 * sequence: the run stays recoverable rather than being terminally successful
 * without its processing history.
 */
export async function finishIngestionRun(
  label: string,
  runId: number,
  kind: IngestionRunKind,
  status: 'ok' | 'partial' | 'failed',
  account: IngestionAccount,
  errors: string[],
  cellsWritten: number | null,
  rpc: IngestionRpc,
): Promise<IngestionFinishResult> {
  const context = await persistIngestionContext(
    label, runId, kind, account, errors, cellsWritten, rpc,
  );
  if (!context.ok) {
    const actual = context.state
      ? { state: context.state, error: null }
      : await readIngestionRunState(label, runId, kind, rpc);
    return {
      ok: false,
      stage: 'context',
      error: context.error,
      state: actual.state,
      stateError: actual.error,
    };
  }

  const finalized = await finalizeIngestionRunRpc(
    label, runId, kind, status, account, errors, cellsWritten, rpc,
  );
  if (!finalized.ok) {
    const actual = await readIngestionRunState(label, runId, kind, rpc);
    return {
      ok: false,
      stage: 'finalization',
      error: finalized.error,
      state: actual.state ?? finalized.state,
      stateError: actual.error,
    };
  }

  return {
    ok: true,
    stage: null,
    error: null,
    state: finalized.state,
    stateError: null,
  };
}

/**
 * Build the consistent failure payload for all five adapters. The original
 * processing error stays in `error` and every distinct failure is retained in
 * `processing_errors`; the finalization/context failure is separate.
 */
export function ingestionFailurePayload(
  runId: number,
  account: IngestionAccount,
  errors: string[],
  finished: IngestionFinishResult,
): Record<string, unknown> {
  return {
    ok: false,
    error: errors[0] ?? (finished.stage === 'context'
      ? 'Ingestion context could not be persisted.'
      : 'Ingestion completed but the run status could not be persisted.'),
    run_id: runId,
    ...(finished.stage === 'finalization'
      ? { run_finalization_error: finished.error }
      : { run_context_error: finished.error }),
    processing_errors: errors,
    accounting: account,
    persisted_run: finished.state,
    ...(finished.stateError ? { run_state_error: finished.stateError } : {}),
  };
}

/**
 * Persist a terminal run state and make a database failure visible to the
 * caller. The update callback is deliberately injected so the five adapters can
 * share the checked error handling without sharing a concrete client type.
 *
 * This low-level helper remains for direct-update tests and non-RPC adapters;
 * the five ingestion adapters use finishIngestionRun.
 */
export async function finalizeIngestionRun(
  label: string,
  runId: number,
  patch: Record<string, unknown>,
  update: (
    patch: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string } | null }>,
): Promise<FinalizationResult> {
  try {
    const { error } = await update(patch);
    if (error) {
      const detail = error.message || 'database update failed';
      console.error(`[${label}] run ${runId} finalization failed: ${detail}`);
      return { ok: false, error: detail };
    }
    return { ok: true, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'database update threw';
    console.error(`[${label}] run ${runId} finalization failed: ${detail}`);
    return { ok: false, error: detail };
  }
}
