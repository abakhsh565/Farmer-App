/**
 * Phase 9 ingestion lifecycle guard.
 *
 * The five ingestion adapters share one lifecycle: create a run, renew its
 * lease, persist counters and every provider error as context, then finalize.
 * A regression here does not crash the app — it silently reports a successful
 * run that lost its failure, or a failed run with no accounting. Behaviour tests
 * pin the shared helper; the targeted source contracts below pin the wiring the
 * helper cannot enforce by itself.
 *
 * Static assertions are deliberately narrow and named after the defect they
 * prevent. They read the adapter and migration sources from this repository, so
 * they run in the same offline CI job as the rest of the unit suite.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyAccount,
  finishIngestionRun,
  ingestionFailurePayload,
  type IngestionAccount,
  type IngestionRunState,
} from '../../supabase/functions/_shared/ingestion-accounting';

// Vitest runs from the repository root; the guard is also invoked by name in CI.
const FUNCTIONS_DIR = join(process.cwd(), 'supabase', 'functions');
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

const sourceCache = new Map<string, string>();

function read(relativePath: string): string {
  const cached = sourceCache.get(relativePath);
  if (cached !== undefined) return cached;
  const text = readFileSync(relativePath, 'utf8');
  sourceCache.set(relativePath, text);
  return text;
}

function adapter(name: string): string {
  return read(join(FUNCTIONS_DIR, name, 'index.ts'));
}

function migration(file: string): string {
  return read(join(MIGRATIONS_DIR, file));
}

/**
 * Extract one SQL function definition. The marker includes `function public.`
 * so calls such as `public.get_ingestion_run_state(...)` do not match.
 */
function sqlFunction(source: string, name: string): string {
  const marker = `function public.${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing SQL function public.${name}`);
  const next = source.indexOf('create or replace function', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

type Adapter = {
  name: string;
  runKind: 'climate' | 'weather' | 'soil';
};

const ADAPTERS: Adapter[] = [
  { name: 'climate-ingest', runKind: 'climate' },
  { name: 'forecast-ingest', runKind: 'climate' },
  { name: 'historical-forecast-ingest', runKind: 'climate' },
  { name: 'weather-ingest', runKind: 'weather' },
  { name: 'soil-ingest', runKind: 'soil' },
];

/** Each terminal call plus everything the adapter does in response to it. */
function lifecycleBlocks(source: string): string[] {
  const marker = 'const finished = await finishIngestionRun(';
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at < 0) break;
    starts.push(at);
    from = at + marker.length;
  }
  return starts.map((start, index) =>
    source.slice(start, index + 1 < starts.length ? starts[index + 1] : source.length),
  );
}

function runState(overrides: Partial<IngestionRunState> = {}): IngestionRunState {
  return {
    run_id: 1,
    kind: 'climate',
    status: 'running',
    error: null,
    processing_errors: [],
    ...overrides,
  };
}

describe('ingestion adapter lifecycle wiring', () => {
  it.each(ADAPTERS)('$name routes every terminal write through the shared helper', ({ name, runKind }) => {
    const source = adapter(name);

    expect(source).toContain("from '../_shared/ingestion-accounting.ts';");
    expect(source).toMatch(/\bfinishIngestionRun,/);
    expect(source).toMatch(/\bingestionFailurePayload,/);
    // The low-level helpers must not be re-wired round the guarded sequence.
    expect(source).not.toMatch(/\bfinalizeIngestionRun\(/);
    expect(source).not.toMatch(/persistIngestionContext|finalizeIngestionRunRpc/);

    // No adapter may write terminal state itself; the RPC owns merging.
    expect(source).not.toMatch(
      /\.from\(\s*['"](?:climate|weather|soil)_ingestion_runs['"]\s*\)\s*\.update\(/,
    );

    expect(
      source.match(new RegExp(`finishIngestionRun\\(\\s*'${name}',\\s*runId,\\s*'${runKind}',`, 'g'))?.length ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it.each(ADAPTERS)('$name fails closed when context or finalization is rejected', ({ name }) => {
    const blocks = lifecycleBlocks(adapter(name));
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    blocks.forEach((block, index) => {
      const call = block.slice(0, block.indexOf(');') + 2);
      expect(call, `${name} call ${index + 1} must pass the account`).toContain('account');
      expect(call, `${name} call ${index + 1} must pass the error list`).toContain('errors');

      expect(block, `${name} call ${index + 1} must check the result`).toContain('if (!finished.ok)');
      expect(block, `${name} call ${index + 1} must return the accounted failure`).toMatch(
        /return json\(\s*ingestionFailurePayload\(runId, account, errors, finished\),\s*500,?\s*\)/,
      );
    });
  });

  it.each(ADAPTERS)('$name reports accounting instead of an unqualified success', ({ name }) => {
    const source = adapter(name);
    expect(source.match(/accounting: account/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(source).not.toMatch(/return json\(\s*\{\s*ok: true\s*\}\s*\)/);
  });

  it.each(ADAPTERS)('$name recovers abandoned runs and renews its own lease', ({ name, runKind }) => {
    const source = adapter(name);

    expect(source).toMatch(
      /client\.rpc\('recover_abandoned_ingestion_runs',\s*\{\s*p_limit:\s*10,?\s*\}\)/,
    );
    expect(source).toMatch(/if \(recoveryError\)\s*\{\s*console\.error\(/);

    expect(source).toMatch(
      new RegExp(
        `client\\.rpc\\('touch_ingestion_run',\\s*\\{\\s*p_kind: '${runKind}',\\s*p_run_id: runId,?\\s*\\}\\)`,
      ),
    );
    // touch_ingestion_run returns false for a run another writer finalized.
    expect(source).toMatch(/if \(error \|\| data === false\)/);
    expect(source).toContain('Run lease renewal failed');
  });

  it.each(ADAPTERS)('$name records the provider error before a failed terminal status', ({ name }) => {
    const source = adapter(name);
    expect(source).toMatch(/addIngestionError\(errors, /);
    expect(source).toMatch(/finishIngestionRun\([\s\S]{0,300}?'failed'/);
  });

  it('keeps an archive run partial when only some runs failed, even if every row was unchanged', () => {
    // Regression: a repeated archive import stores no changed rows, so a status
    // derived from written rows alone used to report `ok` while a vendor run had
    // genuinely failed.
    const source = adapter('historical-forecast-ingest');
    expect(source).toMatch(
      /failed === 0[\s\S]{0,160}?failed < runs\.length \? 'partial' : 'failed'/,
    );
    expect(source).toMatch(/status === 'partial' \? 207/);
  });
});

describe('ingestion run migration invariants', () => {
  const context = migration('20261104003500_ingestion_run_context.sql');
  const leases = migration('20261104003300_ingestion_run_leases.sql');
  const role = migration('20261104003400_ingestion_run_lease_role.sql');
  const accounting = migration('20261104003000_ingestion_run_accounting.sql');

  it('persists counters and processing errors without finalizing the run', () => {
    const body = sqlFunction(context, 'record_ingestion_run_context');

    expect(body).toContain('processing_errors = v_errors');
    expect(body).toContain('merge_ingestion_errors(');
    expect(body).toMatch(/records_fetched = greatest\(records_fetched/);
    expect(body).toContain('for update');
    // A context write that also finalized would make the failure branch moot.
    expect(body).not.toMatch(/\bset\s+status\s*=/);
    expect(body).not.toContain('finished_at');
  });

  it('finalizes atomically while merging, never replacing, the error history', () => {
    const body = sqlFunction(context, 'finalize_ingestion_run');

    expect(body).toContain('status = p_status');
    expect(body).toContain('finished_at = now()');
    expect(body).toContain('processing_errors = v_errors');
    expect(body).toContain('merge_ingestion_errors(');
    expect(body).toContain('get diagnostics v_updated = row_count');
    expect(body).toContain("if v_updated = 0 then");
    expect(body).toContain("'run is no longer running'");
  });

  it('recovers only expired leases and preserves every recorded error', () => {
    const body = sqlFunction(context, 'recover_abandoned_ingestion_runs');

    expect(body).toContain('lease_expires_at < now()');
    expect(body).not.toMatch(/lease_expires_at\s*<=/);
    expect(body).toContain('for update skip locked');
    expect(body).toContain("status = 'failed'");
    expect(body).toContain('recovered_at = now()');
    expect(body).toContain('processing_errors = public.merge_ingestion_errors(');
    // Recovery must never invent target data or a successful status.
    expect(body).not.toMatch(/status\s*=\s*'ok'/);
    expect(body).not.toMatch(
      /insert into public\.(climate_observations|climate_forecasts|weather_readings|soil_observations)/i,
    );
  });

  it('renews leases only for running rows and authorizes the JWT service role', () => {
    const body = sqlFunction(role, 'touch_ingestion_run');

    expect(body).toContain("lease_expires_at = now() + interval '15 minutes'");
    expect(body).toContain("where id = p_run_id and status = 'running'");
    expect(body).toContain('v_updated > 0');
    // Regression: `current_user` is the SECURITY DEFINER owner, not the caller.
    expect(body).toContain("current_setting('request.jwt.claims', true)");
    expect(body).toContain("v_role <> 'service_role'");
    expect(body).toContain("has_capability('admin')");
  });

  it('keeps every recording RPC idempotent and classifies the database outcome', () => {
    for (const fn of [
      'record_climate_forecasts',
      'record_climate_observations',
      'record_weather_readings',
      'record_soil_observations',
    ]) {
      const body = sqlFunction(accounting, fn);
      expect(body, fn).toContain('on conflict');
      expect(body, fn).toContain('is distinct from');
      expect(body, fn).toContain('(xmax = 0) as inserted');
      expect(body, fn).toContain('records_unchanged');
    }
  });

  it('exposes the lifecycle RPCs to the service role only', () => {
    for (const fn of [
      'get_ingestion_run_state',
      'record_ingestion_run_context',
      'finalize_ingestion_run',
      'recover_abandoned_ingestion_runs',
    ]) {
      const body = sqlFunction(context, fn);
      expect(body, fn).toMatch(
        /revoke execute on function public\.[a-z_]+\([^)]*\)[\s\S]{0,160}?from public, anon, authenticated;/,
      );
      expect(body, fn).toMatch(
        /grant execute on function public\.[a-z_]+\([^)]*\)[\s\S]{0,160}?to service_role;/,
      );
      expect(body, fn).toContain('security definer');
    }
  });

  it('ships the lease and role migrations after the accounting columns', () => {
    expect(leases).toContain('lease_expires_at');
    expect(role).toContain("current_setting('request.jwt.claims', true)");
    expect(accounting).toContain('records_failed');
  });
});

describe('terminal lifecycle behaviour', () => {
  it('persists context before requesting a terminal status', async () => {
    const calls: string[] = [];
    const state = runState({ status: 'ok', finished_at: '2026-11-05T00:00:00.000Z' });

    const result = await finishIngestionRun(
      'weather-ingest',
      103,
      'weather',
      'ok',
      emptyAccount(),
      [],
      1,
      async (name) => {
        calls.push(name);
        return { data: { ok: true, state }, error: null };
      },
    );

    expect(calls).toEqual(['record_ingestion_run_context', 'finalize_ingestion_run']);
    expect(result).toMatchObject({ ok: true, stage: null, error: null });
  });

  it('cannot report success when context persistence is rejected, and never finalizes', async () => {
    const calls: string[] = [];
    const account: IngestionAccount = { ...emptyAccount(), fetched: 3, inserted: 3 };

    const result = await finishIngestionRun(
      'climate-ingest',
      101,
      'climate',
      'ok',
      account,
      [],
      null,
      async (name) => {
        calls.push(name);
        if (name === 'record_ingestion_run_context') {
          return { data: { ok: false, error: 'run is no longer running', state: null }, error: null };
        }
        if (name === 'get_ingestion_run_state') {
          return { data: null, error: null };
        }
        throw new Error(`finalization must not run: ${name}`);
      },
    );

    expect(calls[0]).toBe('record_ingestion_run_context');
    expect(calls).not.toContain('finalize_ingestion_run');
    expect(result).toMatchObject({ ok: false, stage: 'context', error: 'run is no longer running' });
    expect(ingestionFailurePayload(101, account, [], result)).toMatchObject({
      ok: false,
      run_context_error: 'run is no longer running',
      accounting: account,
    });
  });

  it('keeps provider errors and accounting when finalization is rejected', async () => {
    const errors = ['SoilGrids answered 503.', 'persistence failed'];
    const account: IngestionAccount = { ...emptyAccount(), fetched: 4, inserted: 2, failed: 2 };
    const persisted = runState({
      run_id: 102,
      kind: 'soil',
      status: 'running',
      error: errors[0],
      processing_errors: errors,
    });

    const result = await finishIngestionRun(
      'soil-ingest',
      102,
      'soil',
      'failed',
      account,
      errors,
      0,
      async (name) => {
        if (name === 'record_ingestion_run_context') {
          return { data: { ok: true, state: persisted }, error: null };
        }
        if (name === 'finalize_ingestion_run') {
          return { data: { ok: false, error: 'permission denied', state: persisted }, error: null };
        }
        if (name === 'get_ingestion_run_state') {
          return { data: persisted, error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    );

    expect(result).toMatchObject({ ok: false, stage: 'finalization', error: 'permission denied' });
    expect(ingestionFailurePayload(102, account, errors, result)).toMatchObject({
      ok: false,
      error: 'SoilGrids answered 503.',
      run_id: 102,
      run_finalization_error: 'permission denied',
      processing_errors: errors,
      accounting: account,
      persisted_run: persisted,
    });
  });
});
