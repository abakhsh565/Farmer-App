/**
 * Soil ingestion: ISRIC SoilGrids 250 m priors into `soil_observations`.
 *
 * SoilGrids is keyless and licensed CC BY 4.0. It is a *model*, not a soil test:
 * the stored row keeps the provider's uncertainty and the API URL, and the UI
 * must not present it as field truth. The query uses the district's exact
 * headquarters coordinate because SoilGrids can return NoData at a rounded
 * coordinate that falls on a boundary; the row is then stored at a two-decimal
 * cell (~1.1 km), deliberately coarser than a farm.
 *
 * Routes, after the function name:
 *
 *   POST /soil-ingest  { district }       → one active district
 *   POST /soil-ingest  { all: true }      → all active districts
 *   GET  /soil-ingest?district=layyah     → same, for a scheduler
 *   GET  /soil-ingest?all=true            → same, for a scheduler
 *
 * The provider is asked for seven standard properties at six standard depths in
 * one request per point. Missing values stay NULL; no property is filled with a
 * regional average or a zero.
 */

import { adminClient, clean, fail, json, preflight, readJson, requireIngestAuth } from '../_shared/server.ts';
import {
  addIngestionError,
  addWriteOutcome,
  completedStatus,
  emptyAccount,
  finishIngestionRun,
  ingestionFailurePayload,
  rowsWritten,
  type IngestionRpc,
} from '../_shared/ingestion-accounting.ts';

const VENDOR = 'https://rest.isric.org/soilgrids/v2.0/properties/query';
const SOURCE_CODE = 'soilgrids';
const CELL_DECIMALS = 2;
const ALL_DISTRICT_CONCURRENCY = 6;
const ALL_DISTRICT_TIMEOUT_MS = 25000;

const PROPERTIES = ['clay', 'sand', 'silt', 'phh2o', 'soc', 'cec', 'bdod'] as const;
const DEPTHS = ['0-5cm', '5-15cm', '15-30cm', '30-60cm', '60-100cm', '100-200cm'];

type Property = (typeof PROPERTIES)[number];
type District = { code: string; hq_lat: number; hq_lon: number };

type SoilValue = { mean?: unknown; uncertainty?: unknown };
type Layer = {
  name?: unknown;
  unit_measure?: { d_factor?: unknown; mapped_units?: unknown; target_units?: unknown };
  depths?: Array<{
    range?: { top_depth?: unknown; bottom_depth?: unknown };
    values?: SoilValue;
  }>;
};

type SoilRow = {
  source_code: string;
  lat_cell: number;
  lon_cell: number;
  depth_top_cm: number;
  depth_bottom_cm: number;
  clay_pct: number | null;
  sand_pct: number | null;
  silt_pct: number | null;
  ph: number | null;
  soc_g_kg: number | null;
  cec_cmol_kg: number | null;
  bulk_density_g_cm3: number | null;
  uncertainty: Record<string, unknown>;
  source_url: string;
  raw: Record<string, unknown>;
  fetched_at: string;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scaled(value: unknown, factor: number, decimals: number): number | null {
  const raw = num(value);
  if (raw === null || factor <= 0) return null;
  return Number((raw / factor).toFixed(decimals));
}

type SoilColumn = keyof Pick<SoilRow, 'clay_pct' | 'sand_pct' | 'silt_pct' | 'ph' | 'soc_g_kg' | 'cec_cmol_kg' | 'bulk_density_g_cm3'>;

const COLUMN_BY_PROPERTY: Record<Property, SoilColumn> = {
  clay: 'clay_pct',
  sand: 'sand_pct',
  silt: 'silt_pct',
  phh2o: 'ph',
  soc: 'soc_g_kg',
  cec: 'cec_cmol_kg',
  bdod: 'bulk_density_g_cm3',
};

function targetColumn(name: Property): SoilColumn {
  return COLUMN_BY_PROPERTY[name];
}

function decimalsFor(name: Property): number {
  return name === 'phh2o' ? 1 : 2;
}

async function fetchSoil(
  lat: number,
  lon: number,
  timeoutMs = 45000,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  for (const property of PROPERTIES) params.append('property', property);
  for (const depth of DEPTHS) params.append('depth', depth);
  params.append('value', 'mean');
  params.append('value', 'uncertainty');

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${VENDOR}?${params.toString()}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = (await response.json().catch(() => null)) as
        | { properties?: { layers?: unknown }; detail?: unknown }
        | null;
      if (!response.ok) throw new Error(`SoilGrids answered ${response.status}.`);
      if (!payload?.properties || !Array.isArray(payload.properties.layers)) {
        throw new Error('SoilGrids returned no property layers.');
      }
      return payload as Record<string, unknown>;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('SoilGrids request failed');
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw lastError ?? new Error('SoilGrids request failed');
}

/** Bounded concurrency: six slow provider calls must not create a 60-second queue. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function soilRows(
  payload: Record<string, unknown>,
  district: District,
  sourceUrl: string,
): { rows: SoilRow[]; missingProperties: string[]; rejected: number } {
  const layers = ((payload.properties as { layers?: unknown }).layers ?? []) as Layer[];
  const byDepth = new Map<string, SoilRow>();
  const missingProperties: string[] = [];
  let rejected = 0;
  const fetchedAt = new Date().toISOString();
  const latCell = Number(district.hq_lat.toFixed(CELL_DECIMALS));
  const lonCell = Number(district.hq_lon.toFixed(CELL_DECIMALS));

  for (const layer of layers) {
    const name = typeof layer.name === 'string' ? layer.name as Property : null;
    if (!name || !PROPERTIES.includes(name)) continue;
    const factor = num(layer.unit_measure?.d_factor) ?? 1;
    const mappedUnit = typeof layer.unit_measure?.mapped_units === 'string'
      ? layer.unit_measure.mapped_units
      : null;
    const targetUnit = typeof layer.unit_measure?.target_units === 'string'
      ? layer.unit_measure.target_units
      : null;
    const depths = Array.isArray(layer.depths) ? layer.depths : [];

    let found = false;
    for (const depth of depths) {
      const top = num(depth.range?.top_depth);
      const bottom = num(depth.range?.bottom_depth);
      if (top === null || bottom === null || bottom <= top) {
        rejected += 1;
        continue;
      }
      const rawMean = num(depth.values?.mean);
      const rawUncertainty = num(depth.values?.uncertainty);
      if (rawMean === null) continue;
      found = true;

      const key = `${top}-${bottom}`;
      const row = byDepth.get(key) ?? {
        source_code: SOURCE_CODE,
        lat_cell: latCell,
        lon_cell: lonCell,
        depth_top_cm: top,
        depth_bottom_cm: bottom,
        clay_pct: null,
        sand_pct: null,
        silt_pct: null,
        ph: null,
        soc_g_kg: null,
        cec_cmol_kg: null,
        bulk_density_g_cm3: null,
        uncertainty: {},
        source_url: sourceUrl,
        raw: payload,
        fetched_at: fetchedAt,
      };
      const column = targetColumn(name);
      row[column] = scaled(rawMean, factor, decimalsFor(name)) as never;
      row.uncertainty[name] = {
        mean_raw: rawMean,
        uncertainty_raw: rawUncertainty,
        d_factor: factor,
        source_unit: mappedUnit,
        target_unit: targetUnit,
      };
      byDepth.set(key, row);
    }
    if (!found) missingProperties.push(name);
  }

  return {
    rows: [...byDepth.values()].sort((a, b) => a.depth_top_cm - b.depth_top_cm),
    missingProperties,
    rejected,
  };
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  const auth = requireIngestAuth(req);
  if (auth) return auth;

  try {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? ((await readJson<Record<string, unknown>>(req)) ?? {}) : {};
    const wantsAll = body.all === true || body.all === 'true' || url.searchParams.get('all') === 'true';
    const code = clean(body.district ?? url.searchParams.get('district'), 40)?.toLowerCase();

    const client = adminClient();
    const rpc: IngestionRpc = (name, args) => client.rpc(name, args);
    const { error: recoveryError } = await client.rpc('recover_abandoned_ingestion_runs', {
      p_limit: 10,
    });
    if (recoveryError) {
      console.error(`[soil-ingest] abandoned-run recovery failed: ${recoveryError.message}`);
    }
    let query = client
      .from('districts')
      .select('code,hq_lat,hq_lon')
      .eq('is_active', true);
    if (!wantsAll) {
      if (!code) return fail('district is required (or all=true).');
      query = query.eq('code', code);
    }
    const { data, error } = await query.order('code');
    if (error) return fail(error.message, 502);
    const districts = (data ?? []) as District[];
    if (districts.length === 0) return fail(`Unknown active district '${code ?? ''}'.`, 404);

    const { data: runRow, error: runError } = await client
      .from('soil_ingestion_runs')
      .insert({
        source_code: SOURCE_CODE,
        status: 'running',
        cells_requested: districts.length,
      })
      .select('id')
      .single();
    const runId = Number((runRow as { id?: number } | null)?.id);
    if (runError || !Number.isInteger(runId)) {
      return json({
        ok: false,
        error: 'Could not create the soil ingestion run.',
        detail: runError?.message ?? 'run id was not returned',
      }, 502);
    }

    const account = emptyAccount();
    let written = 0;
    let failed = 0;
    let sourceIncomplete = false;
    const details: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    const heartbeat = async () => {
      const { data, error } = await client.rpc('touch_ingestion_run', {
        p_kind: 'soil',
        p_run_id: runId,
      });
      if (error || data === false) {
        throw new Error(
          `Run lease renewal failed: ${error?.message ?? 'run is no longer running'}`,
        );
      }
    };

    try {
      await heartbeat();
      await mapLimit(districts, ALL_DISTRICT_CONCURRENCY, async (district) => {
      const params = new URLSearchParams({
        lat: String(district.hq_lat),
        lon: String(district.hq_lon),
      });
      for (const property of PROPERTIES) params.append('property', property);
      for (const depth of DEPTHS) params.append('depth', depth);
      params.append('value', 'mean');
      params.append('value', 'uncertainty');
      const sourceUrl = `${VENDOR}?${params.toString()}`;

      try {
        const payload = await fetchSoil(
          district.hq_lat,
          district.hq_lon,
          wantsAll ? ALL_DISTRICT_TIMEOUT_MS : 45000,
        );
        const parsed = soilRows(payload, district, sourceUrl);
        account.fetched += parsed.rows.length;
        account.rejected += parsed.rejected;
        if (parsed.rows.length === 0) {
          throw new Error('SoilGrids returned no usable depth values.');
        }
        try {
          const { data, error: writeError } = await client.rpc('record_soil_observations', {
            p_rows: parsed.rows,
          });
          if (writeError) throw new Error(writeError.message);
          addWriteOutcome(account, data);
        } catch (error) {
          account.failed += parsed.rows.length;
          throw error;
        }
        written += 1;
        if (parsed.missingProperties.length > 0) sourceIncomplete = true;
        details.push({
          district: district.code,
          depths: parsed.rows.length,
          missing_properties: parsed.missingProperties,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'ingestion failed';
        addIngestionError(errors, detail);
        failed += 1;
        details.push({ district: district.code, error: detail });
      }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'soil ingestion failed';
      addIngestionError(errors, detail);
      const finished = await finishIngestionRun(
        'soil-ingest', runId, 'soil', 'failed', account, errors, written, rpc,
      );
      if (!finished.ok) {
        return json(ingestionFailurePayload(runId, account, errors, finished), 500);
      }
      return fail(detail, 500);
    }

    const status = failed === 0
      ? completedStatus(account, sourceIncomplete)
      : written > 0 ? 'partial' : 'failed';
    const finished = await finishIngestionRun(
      'soil-ingest', runId, 'soil', status, account, errors, written, rpc,
    );
    if (!finished.ok) {
      return json(ingestionFailurePayload(runId, account, errors, finished), 500);
    }

    return json({
      ok: status === 'ok',
      status,
      source: SOURCE_CODE,
      cellsRequested: districts.length,
      cellsWritten: written,
      failed,
      recordsWritten: rowsWritten(account),
      accounting: account,
      run_id: runId,
      processing_errors: errors,
      details,
      attribution: 'ISRIC SoilGrids 250m, CC BY 4.0; modelled priors, not a soil test.',
    }, status === 'ok' ? 200 : status === 'partial' ? 207 : 502);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});
