#!/usr/bin/env node
/**
 * Forecast bias model: train on archived ECMWF IFS runs, evaluate against NASA
 * POWER, and write a versioned artifact.
 *
 * WHAT THIS IS
 *
 * A real, reproducible calibration of an operational weather forecast. For a
 * district point it asks: given the ECMWF IFS daily maximum/minimum issued on a
 * particular day, how much does that value differ from NASA POWER's independent
 * daily reanalysis, and can a small linear correction reduce the error on a
 * chronological holdout that the model never saw?
 *
 * It is not a crop model, a pest model or a claim of field accuracy. NASA POWER
 * is a 0.5-degree reanalysis product, not a weather station, and ECMWF IFS is a
 * global model. The only claim this script can support is the measured
 * forecast-to-reanalysis error on the held-out dates. The artifact records that
 * limitation.
 *
 * DATA
 *
 *   Forecast: Open-Meteo Single Runs API, ECMWF IFS archived run (00 UTC).
 *             https://single-runs-api.open-meteo.com/v1/forecast
 *   Reference: NASA POWER daily point API.
 *             https://power.larc.nasa.gov/api/temporal/daily/point
 *
 * Both are keyless. Open-Meteo's free tier is non-commercial; its data is
 * CC BY 4.0. NASA POWER asks for attribution. No paid provider is used.
 *
 * SPLIT
 *
 * Runs are split chronologically by issue date: the first 70% train, the last
 * 30% test. All seven forecast days from one run stay on the same side, so the
 * test set does not contain a neighbouring day from a training run.
 *
 * MODEL
 *
 * observed = b0 + b1*raw + b2*lead_day + b3*sin(month) + b4*cos(month)
 *
 * The coefficients are fitted by ridge-regularised least squares. The model is
 * useful only if the holdout mean absolute error is lower than the raw
 * forecast's. The artifact contains both numbers; nothing is rounded into a
 * claim of success.
 *
 * RUN
 *
 *   node scripts/train-forecast-bias.mjs
 *
 * Optional:
 *   --district=layyah --start=2025-01-04 --end=2025-10-25 --step-days=7
 *   --out=models/forecast-bias-layyah.json
 *
 * The script never writes to the database. The generated seed SQL is reviewed
 * and applied as a migration, so a model cannot appear in production merely
 * because a script ran on a laptop.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DISTRICTS = {
  layyah: { code: 'layyah', lat: 30.9648, lon: 70.9399 },
};

const TARGETS = {
  tmax: {
    key: 'forecast_tmax_c',
    forecastField: 'temperature_2m_max',
    observationField: 'T2M_MAX',
  },
  tmin: {
    key: 'forecast_tmin_c',
    forecastField: 'temperature_2m_min',
    observationField: 'T2M_MIN',
  },
};

function args() {
  const parsed = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    parsed[key] = value ?? true;
  }
  return parsed;
}

function isoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : null;
}

function addDays(day, amount) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function fetchJson(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`${label} answered ${response.status}`);
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${label} answered ${response.status}: ${text.slice(0, 240)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

function weeklyRuns(start, end, stepDays) {
  const runs = [];
  for (let day = start; day <= end; day = addDays(day, stepDays)) runs.push(day);
  return runs;
}

async function fetchForecastRun(district, run) {
  const url = new URL('https://single-runs-api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(district.lat));
  url.searchParams.set('longitude', String(district.lon));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('models', 'ecmwf_ifs');
  url.searchParams.set('run', `${run}T00:00`);
  url.searchParams.set('forecast_days', '7');
  const body = await fetchJson(url.toString(), `Open-Meteo ${run}`);
  const daily = body?.daily;
  if (!daily || !Array.isArray(daily.time)) {
    throw new Error(`Open-Meteo ${run} returned no daily series.`);
  }
  return (daily.time ?? []).map((day, index) => ({
    run,
    forecast_on: isoDay(day),
    lead_day: daysBetween(run, day),
    tmax_raw: num(daily.temperature_2m_max?.[index]),
    tmin_raw: num(daily.temperature_2m_min?.[index]),
    precip_raw: num(daily.precipitation_sum?.[index]),
  })).filter((row) => row.forecast_on && row.lead_day >= 0);
}

function chunkYears(start, end) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const yearEnd = `${cursor.slice(0, 4)}-12-31`;
    const chunkEnd = yearEnd < end ? yearEnd : end;
    chunks.push([cursor, chunkEnd]);
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

async function fetchPower(district, start, end) {
  const observations = new Map();
  for (const [from, to] of chunkYears(start, end)) {
    const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
    url.searchParams.set('parameters', 'T2M_MAX,T2M_MIN,PRECTOTCORR');
    url.searchParams.set('community', 'AG');
    url.searchParams.set('longitude', String(district.lon));
    url.searchParams.set('latitude', String(district.lat));
    url.searchParams.set('start', from.replace(/-/g, ''));
    url.searchParams.set('end', to.replace(/-/g, ''));
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('time-standard', 'UTC');
    const body = await fetchJson(url.toString(), `NASA POWER ${from}..${to}`);
    const parameters = body?.properties?.parameter;
    if (!parameters) throw new Error(`NASA POWER ${from}..${to} returned no parameters.`);
    const tmax = parameters.T2M_MAX ?? {};
    const tmin = parameters.T2M_MIN ?? {};
    for (const day of Object.keys(tmax)) {
      const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      observations.set(date, {
        T2M_MAX: num(tmax[day]) === null || tmax[day] <= -999 ? null : num(tmax[day]),
        T2M_MIN: num(tmin[day]) === null || tmin[day] <= -999 ? null : num(tmin[day]),
      });
    }
  }
  return observations;
}

function features(sample, target) {
  const raw = target === 'tmax' ? sample.tmax_raw : sample.tmin_raw;
  const date = new Date(`${sample.forecast_on}T00:00:00Z`);
  const month = date.getUTCMonth() + 1;
  return [
    1,
    raw,
    sample.lead_day,
    Math.sin((2 * Math.PI * (month - 1)) / 12),
    Math.cos((2 * Math.PI * (month - 1)) / 12),
  ];
}

function solve(matrix, vector) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      throw new Error('Model matrix is singular.');
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function fit(samples, target) {
  const rows = samples.map((sample) => features(sample, target));
  const y = samples.map((sample) =>
    target === 'tmax' ? sample.observed_tmax : sample.observed_tmin,
  );
  const n = rows[0].length;
  const xtx = Array.from({ length: n }, () => Array(n).fill(0));
  const xty = Array(n).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    for (let a = 0; a < n; a += 1) {
      xty[a] += rows[i][a] * y[i];
      for (let b = 0; b < n; b += 1) xtx[a][b] += rows[i][a] * rows[i][b];
    }
  }
  // Small ridge term; the intercept is not penalised.
  for (let a = 1; a < n; a += 1) xtx[a][a] += 1e-8;
  return solve(xtx, xty);
}

function predict(coefficients, sample, target) {
  return features(sample, target).reduce(
    (sum, value, index) => sum + value * coefficients[index],
    0,
  );
}

function metrics(samples, target, coefficients = null) {
  const errors = samples.map((sample) => {
    const observed = target === 'tmax' ? sample.observed_tmax : sample.observed_tmin;
    const predicted = coefficients
      ? predict(coefficients, sample, target)
      : target === 'tmax'
        ? sample.tmax_raw
        : sample.tmin_raw;
    return predicted - observed;
  });
  const abs = errors.map((error) => Math.abs(error));
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    rows: samples.length,
    mae: Number(mean(abs).toFixed(3)),
    rmse: Number(Math.sqrt(mean(errors.map((error) => error * error))).toFixed(3)),
    bias: Number(mean(errors).toFixed(3)),
  };
}

function confidence(improvementPct, testRows) {
  // Operational confidence, not a statistical probability. It rewards a larger
  // gain and a larger holdout, and never exceeds 0.95.
  const gain = Math.max(0, improvementPct / 100);
  return Number(
    Math.min(0.95, 0.5 + 0.45 * Math.min(1, gain / 0.15) * Math.min(1, testRows / 120)).toFixed(2),
  );
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function seedSql(artifact) {
  const models = Object.values(artifact.models).map((model) => {
    const coefficients = {
      intercept: model.coefficients[0],
      raw: model.coefficients[1],
      lead_day: model.coefficients[2],
      month_sin: model.coefficients[3],
      month_cos: model.coefficients[4],
    };
    return `-- ${model.target}: ${model.metrics.improvement_pct}% holdout MAE improvement
insert into public.ml_models (
  model_code, version, target, algorithm, status, provider_code, district_code,
  feature_schema_version, feature_names, coefficients, metrics, provenance,
  confidence, train_rows, test_rows, training_start, training_end, trained_at
) values (
  ${sqlString(artifact.model_code)}, ${artifact.version}, ${sqlString(model.target)},
  'ridge_linear_bias_correction', 'shadow', 'open_meteo', ${sqlString(artifact.district)},
  1, array['intercept','raw','lead_day','month_sin','month_cos'],
  ${sqlJson(coefficients)}, ${sqlJson(model.metrics)}, ${sqlJson(artifact.provenance)},
  ${model.confidence}, ${model.train_rows}, ${model.test_rows},
  ${sqlString(artifact.training_start)}::date, ${sqlString(artifact.training_end)}::date,
  ${sqlString(artifact.trained_at)}::timestamptz
) on conflict (model_code, version, target, provider_code, district_code) do nothing;
`;
  });

  const runs = Object.values(artifact.models).map((model) => `insert into public.ml_training_runs (
  model_code, target, provider_code, district_code, started_at, finished_at, status,
  train_rows, test_rows, metrics, artifact, source_urls
) values (
  ${sqlString(artifact.model_code)}, ${sqlString(model.target)}, 'open_meteo', ${sqlString(artifact.district)},
  ${sqlString(artifact.started_at)}::timestamptz, ${sqlString(artifact.finished_at)}::timestamptz,
  'ok', ${model.train_rows}, ${model.test_rows}, ${sqlJson(model.metrics)},
  ${sqlJson({ coefficients: model.coefficients, feature_names: artifact.feature_names })},
  array[${artifact.sources.map(sqlString).join(', ')}]
);
`).join('\n');

  return `-- Generated from models/${artifact.artifact_file}.
-- This migration registers the artifacts as shadow models. Activation is a
-- separate admin/service operation and is refused unless the holdout beats the
-- raw forecast with at least 30 test rows.
${models.join('\n')}
${runs}`;
}

async function main() {
  const options = args();
  const districtCode = options.district ?? 'layyah';
  const district = DISTRICTS[districtCode];
  if (!district) throw new Error(`Unknown district '${districtCode}'.`);

  const start = options.start ?? '2025-01-04';
  const end = options.end ?? '2026-10-24';
  const stepDays = Number(options['step-days'] ?? 7);
  if (!Number.isInteger(stepDays) || stepDays < 1 || stepDays > 30) {
    throw new Error('step-days must be an integer between 1 and 30.');
  }

  console.log(`district ${district.code} (${district.lat}, ${district.lon})`);
  console.log(`runs ${start}..${end} every ${stepDays} days`);

  const runs = weeklyRuns(start, end, stepDays);
  const forecast = [];
  let unavailable = 0;
  for (let index = 0; index < runs.length; index += 4) {
    const batch = runs.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (run) => {
      try {
        return await fetchForecastRun(district, run);
      } catch (error) {
        unavailable += 1;
        console.warn(`skip ${run}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    for (const rows of results) forecast.push(...rows);
    process.stdout.write(`\rfetched ${index + batch.length}/${runs.length} runs`);
  }
  process.stdout.write('\n');

  if (forecast.length === 0) throw new Error('No archived forecast rows were available.');

  const observations = await fetchPower(district, start, end);
  const samples = forecast.map((row) => {
    const observed = observations.get(row.forecast_on);
    return {
      ...row,
      observed_tmax: observed?.T2M_MAX ?? null,
      observed_tmin: observed?.T2M_MIN ?? null,
    };
  });

  const complete = samples.filter(
    (row) => row.tmax_raw !== null && row.observed_tmax !== null
      && row.tmin_raw !== null && row.observed_tmin !== null,
  );
  if (complete.length < 80) {
    throw new Error(`Only ${complete.length} complete forecast/observation rows; refusing to train.`);
  }

  const runDates = [...new Set(complete.map((row) => row.run))].sort();
  const splitAt = Math.floor(runDates.length * 0.7);
  const trainRuns = new Set(runDates.slice(0, splitAt));
  const testRuns = new Set(runDates.slice(splitAt));
  const train = complete.filter((row) => trainRuns.has(row.run));
  const test = complete.filter((row) => testRuns.has(row.run));
  if (train.length < 50 || test.length < 30) {
    throw new Error(`Chronological split produced train=${train.length}, test=${test.length}.`);
  }

  const models = {};
  for (const [target, definition] of Object.entries(TARGETS)) {
    const coefficients = fit(train, target);
    const rawTrain = metrics(train, target);
    const rawTest = metrics(test, target);
    const modelTrain = metrics(train, target, coefficients);
    const modelTest = metrics(test, target, coefficients);
    const improvement = rawTest.mae > 0
      ? Number((((rawTest.mae - modelTest.mae) / rawTest.mae) * 100).toFixed(2))
      : 0;

    models[target] = {
      target: definition.key,
      coefficients,
      train_rows: train.length,
      test_rows: test.length,
      metrics: {
        test_rows: test.length,
        train_rows: train.length,
        raw_mae: rawTest.mae,
        calibrated_mae: modelTest.mae,
        improvement_pct: improvement,
        raw_rmse: rawTest.rmse,
        calibrated_rmse: modelTest.rmse,
        raw_bias: rawTest.bias,
        calibrated_bias: modelTest.bias,
        train_raw_mae: rawTrain.mae,
        train_calibrated_mae: modelTrain.mae,
        test_start: [...testRuns].sort()[0],
        test_end: [...testRuns].sort().at(-1),
        train_start: [...trainRuns].sort()[0],
        train_end: [...trainRuns].sort().at(-1),
        reference: 'NASA POWER daily reanalysis (0.5 degree)',
        forecast: 'ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API',
        caveat: 'Model-to-model comparison; not a station-observation validation.',
      },
      confidence: confidence(improvement, test.length),
    };
  }

  const trainedAt = new Date().toISOString();
  const artifact = {
    artifact_file: `forecast-bias-${district.code}.json`,
    model_code: `ecmwf_ifs_forecast_bias_${district.code}`,
    version: 1,
    district: district.code,
    coordinates: { lat: district.lat, lon: district.lon },
    algorithm: 'ridge_linear_bias_correction',
    feature_names: ['intercept', 'raw', 'lead_day', 'month_sin', 'month_cos'],
    training_start: [...trainRuns].sort()[0],
    training_end: [...testRuns].sort().at(-1),
    started_at: trainedAt,
    finished_at: new Date().toISOString(),
    trained_at: trainedAt,
    samples: {
      forecast_rows: samples.length,
      complete_rows: complete.length,
      unavailable_runs: unavailable,
      train_rows: train.length,
      test_rows: test.length,
    },
    sources: [
      'https://single-runs-api.open-meteo.com/v1/forecast',
      'https://power.larc.nasa.gov/api/temporal/daily/point',
      'https://open-meteo.com/en/docs/single-runs-api',
      'https://power.larc.nasa.gov/docs/services/api/temporal/daily/',
    ],
    provenance: {
      forecast_provider: 'open_meteo',
      forecast_model: 'ecmwf_ifs',
      forecast_run: '00 UTC archived run',
      reference_provider: 'nasa_power',
      reference_product: 'MERRA-2 daily reanalysis, 0.5 degree',
      license: 'Open-Meteo CC BY 4.0 (free tier non-commercial); NASA POWER open data with attribution',
      limitation: 'Reanalysis reference and global forecast grid; not a field or station measurement. Do not present holdout metrics as field accuracy.',
    },
    models,
  };

  const outPath = resolve(
    process.cwd(),
    options.out ?? `models/forecast-bias-${district.code}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const seedPath = resolve(
    process.cwd(),
    options['seed-out'] ?? `models/forecast-bias-${district.code}-seed.sql`,
  );
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, seedSql(artifact));

  console.log(`\nwrote ${outPath}`);
  console.log(`wrote ${seedPath}`);
  for (const model of Object.values(models)) {
    const m = model.metrics;
    console.log(
      `${model.target}: raw MAE ${m.raw_mae} -> calibrated ${m.calibrated_mae} ` +
      `(${m.improvement_pct}% on ${m.test_rows} holdout rows), confidence ${model.confidence}`,
    );
  }

  if (Object.values(models).some((model) => model.metrics.improvement_pct <= 0)) {
    console.log('At least one target did not beat the raw baseline; keep it shadow.');
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Training failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
