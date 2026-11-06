import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Phase 7 model is a small linear calibration, but the claim it supports is
 * narrow: one district, one forecast provider, a chronological holdout. That
 * narrowness is easy to lose in a later edit — a coefficient changed in the SQL
 * but not the artifact, a holdout number rounded up, a model silently marked
 * active. This test reads the tracked artifact and the migration that registers
 * it, so drift is a failing test rather than a discovery in production.
 *
 * It deliberately does not test accuracy. Accuracy is a measurement recorded in
 * the artifact; re-deriving it here would only test this file.
 */

const ROOT = process.cwd();
const ARTIFACT_PATH = join(ROOT, 'models', 'forecast-bias-layyah.json');
const SEED_PATH = join(ROOT, 'models', 'forecast-bias-layyah-seed.sql');
const MIGRATION_PATH = join(
  ROOT,
  'supabase',
  'migrations',
  '20261104002300_forecast_bias_model.sql',
);

type ModelMetrics = {
  test_rows: number;
  train_rows: number;
  raw_mae: number;
  calibrated_mae: number;
  improvement_pct: number;
  raw_rmse: number;
  calibrated_rmse: number;
  test_start: string;
  test_end: string;
  train_start: string;
  train_end: string;
  caveat: string;
};

type ArtifactModel = {
  target: string;
  coefficients: number[];
  train_rows: number;
  test_rows: number;
  metrics: ModelMetrics;
  confidence: number;
};

type Artifact = {
  artifact_file: string;
  model_code: string;
  version: number;
  district: string;
  coordinates: { lat: number; lon: number };
  algorithm: string;
  feature_names: string[];
  training_start: string;
  training_end: string;
  trained_at: string;
  samples: Record<string, number>;
  sources: string[];
  provenance: Record<string, string>;
  models: Record<string, ArtifactModel>;
};

const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
const seedSql = readFileSync(SEED_PATH, 'utf8');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const models = Object.values(artifact.models);

describe('forecast bias artifact', () => {
  it('describes the same model the migration registers', () => {
    expect(artifact.model_code).toBe('ecmwf_ifs_forecast_bias_layyah');
    expect(artifact.version).toBe(1);
    expect(artifact.algorithm).toBe('ridge_linear_bias_correction');
    expect(artifact.feature_names).toEqual([
      'intercept',
      'raw',
      'lead_day',
      'month_sin',
      'month_cos',
    ]);
    expect(models.map((model) => model.target).sort()).toEqual([
      'forecast_tmax_c',
      'forecast_tmin_c',
    ]);
  });

  it('is scoped to Layyah and one forecast provider', () => {
    expect(artifact.district).toBe('layyah');
    expect(artifact.provenance.forecast_provider).toBe('open_meteo');
    expect(artifact.provenance.forecast_model).toBe('ecmwf_ifs');
    // A second district would need its own training run, not this artifact.
    expect(Object.keys(artifact.models)).toHaveLength(2);
    expect(JSON.stringify(artifact)).not.toMatch(/dera_ghazi_khan|bahawalpur|multan/i);
  });

  it('keeps a chronological holdout large enough to mean anything', () => {
    for (const model of models) {
      expect(model.coefficients).toHaveLength(artifact.feature_names.length);
      expect(model.coefficients.every((value) => Number.isFinite(value))).toBe(true);
      expect(model.metrics.test_rows).toBeGreaterThanOrEqual(30);
      expect(model.metrics.train_rows).toBeGreaterThan(model.metrics.test_rows);
      expect(Date.parse(model.metrics.test_start)).toBeGreaterThan(
        Date.parse(model.metrics.train_end),
      );
      expect(model.metrics.test_end >= model.metrics.test_start).toBe(true);
    }
  });

  it('reports a holdout gain without turning it into field accuracy', () => {
    for (const model of models) {
      expect(model.metrics.improvement_pct).toBeGreaterThan(0);
      expect(model.metrics.calibrated_mae).toBeLessThan(model.metrics.raw_mae);
      expect(model.metrics.calibrated_rmse).toBeLessThan(model.metrics.raw_rmse);
      expect(model.metrics.caveat).toMatch(/not a station-observation validation/i);
    }
    expect(artifact.provenance.limitation).toMatch(/not a field or station measurement/i);
    expect(artifact.provenance.license).toMatch(/non-commercial/i);
  });

  it('is registered as shadow, with the activation gate intact', () => {
    expect(migrationSql).toContain("'ecmwf_ifs_forecast_bias_layyah'");
    // Two inserts, both shadow: registration must never activate a model.
    expect(migrationSql.match(/'shadow', 'open_meteo', 'layyah'/g)).toHaveLength(2);
    // The gate still demands a holdout and a real improvement over the baseline.
    expect(migrationSql).toContain('v_test_rows < 30');
    expect(migrationSql).toContain('v_improvement <= 0');
    expect(migrationSql).toContain('Model activation requires admin or service authority');
  });

  it('has the same coefficients and metrics in the artifact, seed and migration', () => {
    for (const model of models) {
      for (const coefficient of model.coefficients) {
        const literal = String(coefficient);
        expect(seedSql).toContain(literal);
        expect(migrationSql).toContain(literal);
      }
      expect(seedSql).toContain(String(model.metrics.improvement_pct));
      expect(migrationSql).toContain(String(model.metrics.improvement_pct));
      expect(seedSql).toContain(String(model.metrics.calibrated_mae));
      expect(migrationSql).toContain(String(model.metrics.calibrated_mae));
    }
  });

  it('was trained from the sources it names, with the run recorded', () => {
    expect(artifact.sources).toContain(
      'https://single-runs-api.open-meteo.com/v1/forecast',
    );
    expect(artifact.sources).toContain(
      'https://power.larc.nasa.gov/api/temporal/daily/point',
    );
    expect(artifact.samples.train_rows).toBe(models[0]?.train_rows);
    expect(artifact.samples.test_rows).toBe(models[0]?.test_rows);
    expect(Date.parse(artifact.trained_at)).toBeGreaterThan(0);
    expect(migrationSql).toContain(artifact.trained_at);
  });
});
