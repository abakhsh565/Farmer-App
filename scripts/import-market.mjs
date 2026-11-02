#!/usr/bin/env node
/**
 * Mandi rates, imported from a CSV.
 *
 * WHY THIS EXISTS
 *
 * Step 1 of the Crop Intelligence build asks for market prices, and research
 * found no public AMIS Punjab API: `amis.pk` publishes pages, and the source
 * registry already carries `amis_punjab` with `status = 'needs_permission'` and
 * `access_method = 'dashboard_doc'`. So the honest route is the one the spec
 * names — a human reads the published rates once a week and types them into a
 * CSV, and this script writes them as *observations attributed to their source*.
 *
 * Nothing here scrapes. When AMIS registration exists, `supabase/functions/
 * market-ingest` takes over the automated path and this script becomes the
 * fallback rather than the only route. The table and columns are the same either
 * way, so nothing downstream changes.
 *
 * WHAT THE TABLE ALREADY GUARANTEES
 *
 * `market_observations` (migration 0011) is the normalised store: one row per
 * source × commodity × market × day, a `raw` copy of what was received, and a
 * `run_id` for tracing a bad batch. `market_ingestion_runs` is where every
 * attempt is recorded — seen, written, rejected, and why. This script only
 * supplies the rows; the honesty rules belong to the schema.
 *
 * WHAT IT REFUSES (the schema's rules, restated where a person can fix them
 * before a whole batch is rolled back for one bad line)
 *
 *   · A commodity code that is not in `market_commodities`, counted and reported
 *     rather than silently dropped — a typo would otherwise make a market vanish.
 *   · A row with no price at all. Three price columns are nullable because "not
 *     reported" must stay distinguishable from a real figure, but a row with all
 *     three empty is not an observation.
 *   · A minimum greater than a maximum, which the table's check constraint
 *     rejects anyway.
 *   · An `observed_on` that is not a date. The market's date, never the input
 *     date — guessing a date is guessing a price.
 *
 * WHAT IT NEVER DOES
 *
 * It never turns a missing price into `0`, and it never reports success for a
 * batch it did not write. Every run is recorded in `market_ingestion_runs`, so an
 * empty rate list is always answerable with "because nobody imported last week"
 * rather than a shrug.
 *
 * RUN
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npm run import:market -- data/market-dgkhan.csv
 *
 * Flags:
 *   --dry-run          validate and report, write nothing (not even a run row)
 *   --source=<code>    the market_sources code to attribute rows to
 *                      (default `amis_punjab`)
 *
 * CSV columns (header row required, order irrelevant):
 *   commodity_code  required — must exist in market_commodities, e.g. `cotton`
 *   market_name     required — the mandi, e.g. `Layyah`
 *   observed_on     required — the market's own date, ISO or YYYY-MM-DD
 *   min_price       one of these three is required (PKR, per `unit`)
 *   max_price
 *   modal_price
 *   district        optional — free text, e.g. `Layyah`
 *   unit            optional — defaults to `40kg`
 *   arrivals_tonnes optional
 *   source_ref      optional — the document's own number or id
 *   source_url      optional but strongly encouraged — the page it came from
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** Process environment wins over the file, exactly as Vite resolves it. */
function setting(fileValues, key) {
  return (process.env[key] ?? fileValues[key] ?? '').trim();
}

/**
 * A CSV parser good enough for a document someone typed into a spreadsheet:
 * quoted fields, doubled quotes inside them, embedded newlines, CRLF or LF.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // A leading BOM is what Excel writes; without stripping it the first header is
  // `\ufeffcommodity_code` and every row is "missing column commodity_code".
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field !== '' || row.length > 0) endRow();

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

/** The market's own calendar date, or null. Never a guess from a fetch time. */
function observedOn(value, fallback) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return fallback;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/**
 * A price the sheet reported, or null.
 *
 * Blank, `-`, `n/a` and `NA` all mean "not reported" — the nulls the column is
 * built for. Anything else that is not a non-negative number is a mistake and
 * becomes a rejection rather than a silently dropped cell.
 */
function price(value) {
  const trimmed = (value ?? '').trim().replace(/[,\s]/g, '');
  if (trimmed === '') return { ok: true, value: null };
  if (/^(n\/?a|nil|-|--)$/i.test(trimmed)) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

async function api(url, key, path, init) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * Turns the parsed table into rows the table will accept, counting what it could
 * not use and why. Rejections are returned rather than thrown: a week of rates
 * should not be lost to one mistyped commodity.
 */
function normalise(rows, knownCommodities, now, verifyCommodities = true) {
  const header = rows[0].map((name) => name.trim().toLowerCase());
  const at = (cells, name) => {
    const index = header.indexOf(name);
    return index === -1 ? '' : (cells[index] ?? '');
  };

  const accepted = [];
  const rejected = [];

  for (let line = 1; line < rows.length; line += 1) {
    const cells = rows[line];
    const commodity = at(cells, 'commodity_code').trim().toLowerCase();
    const market = at(cells, 'market_name').trim();

    if (commodity === '') {
      rejected.push({ line: line + 1, reason: 'missing commodity_code' });
      continue;
    }
    if (verifyCommodities && !knownCommodities.has(commodity)) {
      rejected.push({ line: line + 1, reason: `unknown commodity_code '${commodity}'` });
      continue;
    }
    if (market === '') {
      rejected.push({ line: line + 1, reason: 'missing market_name' });
      continue;
    }

    const date = observedOn(at(cells, 'observed_on'), now);
    if (date === null) {
      rejected.push({ line: line + 1, reason: 'observed_on is not a date' });
      continue;
    }

    const min = price(at(cells, 'min_price'));
    const max = price(at(cells, 'max_price'));
    const modal = price(at(cells, 'modal_price'));
    if (!min.ok || !max.ok || !modal.ok) {
      rejected.push({ line: line + 1, reason: 'a price is not a non-negative number' });
      continue;
    }

    if (min.value === null && max.value === null && modal.value === null) {
      rejected.push({ line: line + 1, reason: 'no price reported (all three columns empty)' });
      continue;
    }
    if (min.value !== null && max.value !== null && min.value > max.value) {
      rejected.push({ line: line + 1, reason: 'min_price is greater than max_price' });
      continue;
    }

    const arrivals = price(at(cells, 'arrivals_tonnes'));

    accepted.push({
      commodity_code: commodity,
      market_name: market.slice(0, 120),
      district: at(cells, 'district').trim() || null,
      observed_on: date,
      min_price: min.value,
      max_price: max.value,
      modal_price: modal.value,
      unit: at(cells, 'unit').trim() || '40kg',
      arrivals_tonnes: arrivals.ok ? arrivals.value : null,
      // The row exactly as received, so a normalisation mistake stays debuggable.
      raw: {
        commodity_code: commodity,
        market_name: market,
        observed_on: at(cells, 'observed_on').trim(),
        min_price: at(cells, 'min_price').trim(),
        max_price: at(cells, 'max_price').trim(),
        modal_price: at(cells, 'modal_price').trim(),
        district: at(cells, 'district').trim(),
        unit: at(cells, 'unit').trim(),
        source_ref: at(cells, 'source_ref').trim() || null,
        source_url: at(cells, 'source_url').trim() || null,
      },
    });
  }

  return { header, accepted, rejected };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sourceArg = args.find((arg) => arg.startsWith('--source='));
  const sourceCode = sourceArg ? sourceArg.slice('--source='.length).trim() : 'amis_punjab';
  const fileArg = args.find((arg) => !arg.startsWith('--'));

  const envValues = {
    ...readEnvFile(join(ROOT, '.env')),
    ...readEnvFile(join(ROOT, '.env.local')),
  };
  const url = setting(envValues, 'VITE_SUPABASE_URL');
  const key = setting(envValues, 'SUPABASE_SERVICE_ROLE_KEY');

  if (!fileArg) {
    console.error('No CSV given. Usage: npm run import:market -- path/to/market.csv');
    return 2;
  }
  if (!dryRun && (!url || !key)) {
    console.error(
      'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
        'The service-role key is an admin credential: pass it in the environment, never in a file.\n' +
        'Nothing was imported.',
    );
    return 2;
  }

  const csvPath = resolve(process.cwd(), fileArg);
  let text;
  try {
    text = readFileSync(csvPath, 'utf8');
  } catch {
    console.error(`Could not read ${csvPath}. Nothing was imported.`);
    return 2;
  }

  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error(`${csvPath} has no data rows. Nothing was imported.`);
    return 2;
  }

  const now = new Date().toISOString();
  const knownCommodities = new Set();
  let runId = null;

  if (!dryRun) {
    const commodities = await api(url, key, '/rest/v1/market_commodities?select=code');
    if (!commodities.ok) {
      console.error(`Could not read market_commodities (HTTP ${commodities.status}). Nothing was imported.`);
      return 1;
    }
    for (const row of commodities.body ?? []) knownCommodities.add(row.code);

    const run = await api(url, key, '/rest/v1/market_ingestion_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        source_code: sourceCode,
        started_at: now,
        status: 'running',
      }),
    });
    if (!run.ok) {
      console.error(`Could not record the import run (HTTP ${run.status}). Nothing was imported.`);
      return 1;
    }
    runId = Array.isArray(run.body) ? run.body[0]?.id : run.body?.id;
  }

  const { header, accepted, rejected } = normalise(rows, knownCommodities, now, !dryRun);
  console.log(`${csvPath}`);
  console.log(`columns: ${header.join(', ')}`);
  console.log(`rows: ${rows.length - 1} → accepted ${accepted.length}, rejected ${rejected.length}`);
  for (const entry of rejected) console.log(`  line ${entry.line}: ${entry.reason}`);

  const reasons = rejected.reduce((tally, entry) => {
    tally[entry.reason] = (tally[entry.reason] ?? 0) + 1;
    return tally;
  }, {});

  if (dryRun) {
    console.log('Commodity codes were not checked against market_commodities (dry run, no backend read).');
    console.log('Dry run: nothing was written, and no run was recorded.');
    return rejected.length > 0 ? 1 : 0;
  }

  let written = 0;
  let failure = null;
  if (accepted.length > 0) {
    const insert = await api(
      url,
      key,
      '/rest/v1/market_observations?on_conflict=source_code,commodity_code,market_name,observed_on',
      {
        method: 'POST',
        // Re-importing a week is an update, not a duplicate: same key, new figure.
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(
          accepted.map((row) => ({ ...row, source_code: sourceCode, run_id: runId })),
        ),
      },
    );
    if (insert.ok) written = accepted.length;
    else failure = `insert answered HTTP ${insert.status}: ${JSON.stringify(insert.body).slice(0, 300)}`;
  }

  if (runId !== null && runId !== undefined) {
    await api(url, key, `/rest/v1/market_ingestion_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        finished_at: new Date().toISOString(),
        status: failure ? 'failed' : rejected.length > 0 ? 'partial' : 'ok',
        rows_seen: rows.length - 1,
        rows_written: written,
        rows_rejected: rejected.length,
        rejection_reasons: reasons,
        error: failure,
      }),
    });
  }

  if (failure) {
    console.error(`Import failed: ${failure}`);
    console.error(`${written} row(s) written of ${accepted.length} accepted.`);
    return 1;
  }

  console.log(`Imported ${written} market rate row(s) from ${sourceCode}.`);
  return rejected.length > 0 ? 1 : 0;
}

/*
 * `process.exitCode`, not `process.exit()`: calling exit() while the fetch
 * sockets are still open aborts the process on Node 24/Windows (a libuv
 * assertion), which turns *every* run that talked to the backend into exit code
 * 127 — a successful import reported as a failure, and a partial one's exit 1
 * hidden behind it. Setting the code and letting Node drain its handles exits
 * with the real one.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
