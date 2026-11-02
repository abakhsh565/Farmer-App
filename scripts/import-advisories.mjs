#!/usr/bin/env node
/**
 * Official advisories, imported from a CSV.
 *
 * WHY THIS EXISTS
 *
 * Research found no permitted machine-readable feed for Punjab crop advisories:
 * `agripunjab.gov.pk/crop_advisory` is a page, not an API. So the automated
 * function (`supabase/functions/advisory-ingest`) *attempts* a fetch and records
 * the failure, and the durable path is this one — a human takes the published
 * advisory document, types it into a CSV, and imports it with its source URL
 * attached. That is slower and it is honest: every row in `agri_advisories` can
 * be traced to the page it came from, which a scraper could not promise and a
 * fabricated feed would not even try to.
 *
 * WHEN A REAL FEED APPEARS
 *
 * Set `ADVISORY_FEED_URL` on the Edge Function, and this script becomes the
 * fallback rather than the only route. The table and the columns are the same
 * either way, so nothing downstream changes.
 *
 * WHAT IT REFUSES
 *
 *  · A row with no title or no summary — an advisory nobody can read is not data.
 *  · A crop code that is not in `crop_catalog`, counted and reported rather than
 *    silently coerced, because a typo would otherwise scope the advisory wrongly.
 *  · A `valid_until` before its `published_at`, which the table's check
 *    constraint rejects anyway; caught here so the whole batch is not rolled back
 *    by one bad line.
 *
 * WHAT IT NEVER DOES
 *
 * It never invents a row to fill the file, and it never reports success for a
 * batch it did not write. Every run is recorded in `advisory_import_runs` — the
 * rows seen, written and rejected, and the reason for any failure — so an empty
 * advisory list is always answerable with "because nobody imported anything yet"
 * rather than a shrug.
 *
 * RUN
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npm run import:advisories -- data/advisories-dgkhan.csv
 *
 * Flags:
 *   --dry-run          validate and report, write nothing (not even a run row)
 *   --source=<code>    the intel_sources code to attribute rows to
 *                      (default `punjab_advisory`)
 *
 * CSV columns (header row required, order irrelevant):
 *   title        required
 *   summary      required
 *   crop_code    optional — must exist in crop_catalog, e.g. `cotton`
 *   topic        optional — pest | disease | weed | water | weather_damage |
 *                sowing | other. Anything else becomes `other`.
 *   district     optional — free text, e.g. `Layyah`
 *   area_label   optional — what the advisory is scoped to; defaults to the
 *                district, then to `Punjab`
 *   published_at optional — ISO or YYYY-MM-DD; defaults to now
 *   valid_until  optional — ISO or YYYY-MM-DD
 *   source_url   optional but strongly encouraged — the page it came from
 *   source_ref   optional — the document's own number or id
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The closed set `agri_advisories.topic` accepts. Anything else is `other`. */
const TOPICS = new Set(['pest', 'disease', 'weed', 'water', 'weather_damage', 'sowing', 'other']);

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
  // `\ufefftitle` and every row is "missing column title".
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

function isoStamp(value, fallback) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return fallback;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
 * not use and why. Rejections are returned rather than thrown: a batch of forty
 * advisories should not be lost to one mistyped crop code.
 */
function normalise(rows, knownCrops, now, verifyCrops = true) {
  const header = rows[0].map((name) => name.trim().toLowerCase());
  const at = (cells, name) => {
    const index = header.indexOf(name);
    return index === -1 ? '' : (cells[index] ?? '');
  };

  const accepted = [];
  const rejected = [];

  for (let line = 1; line < rows.length; line += 1) {
    const cells = rows[line];
    const title = at(cells, 'title').trim();
    const summary = at(cells, 'summary').trim();
    if (title === '' || summary === '') {
      rejected.push({ line: line + 1, reason: 'missing title or summary' });
      continue;
    }

    const rawCrop = at(cells, 'crop_code').trim().toLowerCase();
    if (verifyCrops && rawCrop !== '' && !knownCrops.has(rawCrop)) {
      rejected.push({ line: line + 1, reason: `unknown crop_code '${rawCrop}'` });
      continue;
    }

    const published = isoStamp(at(cells, 'published_at'), now);
    if (published === null) {
      rejected.push({ line: line + 1, reason: 'published_at is not a date' });
      continue;
    }
    const validUntil = isoStamp(at(cells, 'valid_until'), null);
    if (validUntil === null && at(cells, 'valid_until').trim() !== '') {
      rejected.push({ line: line + 1, reason: 'valid_until is not a date' });
      continue;
    }
    if (validUntil !== null && Date.parse(validUntil) <= Date.parse(published)) {
      rejected.push({ line: line + 1, reason: 'valid_until is not after published_at' });
      continue;
    }

    const district = at(cells, 'district').trim() || null;
    const topicRaw = at(cells, 'topic').trim().toLowerCase();
    /* The row exactly as it arrived, kept beside the parsed one: a topic coerced
       to `other` or a summary cut at the column's limit is then debuggable, and
       the original was never lost. */
    const raw = Object.fromEntries(
      header.map((name, index) => [name, (cells[index] ?? '').trim()]),
    );
    accepted.push({
      raw,
      title: title.slice(0, 200),
      summary: summary.slice(0, 4000),
      crop_code: rawCrop === '' ? null : rawCrop,
      topic: TOPICS.has(topicRaw) ? topicRaw : 'other',
      district,
      area_label: at(cells, 'area_label').trim() || district || 'Punjab',
      published_at: published,
      valid_until: validUntil,
      source_url: at(cells, 'source_url').trim() || null,
      source_ref: at(cells, 'source_ref').trim() || null,
    });
  }

  return { header, accepted, rejected };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sourceArg = args.find((arg) => arg.startsWith('--source='));
  const sourceCode = sourceArg ? sourceArg.slice('--source='.length).trim() : 'punjab_advisory';
  const fileArg = args.find((arg) => !arg.startsWith('--'));

  const envValues = {
    ...readEnvFile(join(ROOT, '.env')),
    ...readEnvFile(join(ROOT, '.env.local')),
  };
  const url = setting(envValues, 'VITE_SUPABASE_URL');
  const key = setting(envValues, 'SUPABASE_SERVICE_ROLE_KEY');

  if (!fileArg) {
    console.error('No CSV given. Usage: npm run import:advisories -- path/to/advisories.csv');
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
  const knownCrops = new Set();
  let runId = null;

  if (!dryRun) {
    const crops = await api(url, key, '/rest/v1/crop_catalog?select=code');
    if (!crops.ok) {
      console.error(`Could not read crop_catalog (HTTP ${crops.status}). Nothing was imported.`);
      return 1;
    }
    for (const row of crops.body ?? []) knownCrops.add(row.code);

    const run = await api(url, key, '/rest/v1/advisory_import_runs', {
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

  const { header, accepted, rejected } = normalise(rows, knownCrops, now, !dryRun);
  console.log(`${csvPath}`);
  console.log(`columns: ${header.join(', ')}`);
  console.log(`rows: ${rows.length - 1} → accepted ${accepted.length}, rejected ${rejected.length}`);
  for (const entry of rejected) console.log(`  line ${entry.line}: ${entry.reason}`);

  if (dryRun) {
    // Said out loud, because a dry run that silently skipped a real check would be
    // a green light it has not earned.
    console.log('Crop codes were not checked against crop_catalog (dry run, no backend read).');
    console.log('Dry run: nothing was written, and no run was recorded.');
    return rejected.length > 0 ? 1 : 0;
  }

  let written = 0;
  let failure = null;
  if (accepted.length > 0) {
    const insert = await api(url, key, '/rest/v1/agri_advisories', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(
        accepted.map((row) => ({ ...row, source_code: sourceCode })),
      ),
    });
    if (insert.ok) written = accepted.length;
    else failure = `insert answered HTTP ${insert.status}: ${JSON.stringify(insert.body).slice(0, 300)}`;
  }

  if (runId !== null && runId !== undefined) {
    await api(url, key, `/rest/v1/advisory_import_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        finished_at: new Date().toISOString(),
        status: failure ? 'failed' : rejected.length > 0 ? 'partial' : 'ok',
        rows_seen: rows.length - 1,
        rows_written: written,
        rows_rejected: rejected.length,
        error: failure,
      }),
    });
  }

  if (failure) {
    console.error(`Import failed: ${failure}`);
    console.error(`${written} row(s) written of ${accepted.length} accepted.`);
    return 1;
  }

  console.log(`Imported ${written} advisory row(s) from ${sourceCode}.`);
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
