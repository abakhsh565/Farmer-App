# Phase 7 — Forecast-bias model card

Status: **implemented and verified against staging** for the two temperature
corrections below. It is not a production deployment, not a field-accuracy
claim, and it does not generalize beyond Layyah or beyond the forecast provider
it was trained on.

## What it is

A ridge-linear bias correction applied to daily maximum and minimum temperature
from Open-Meteo's ECMWF IFS forecast. Two independent targets, one row each in
`ml_models`, with the coefficients also tracked in
`models/forecast-bias-layyah.json` and `models/forecast-bias-layyah-seed.sql`.

| Field | Value |
| --- | --- |
| Model code | `ecmwf_ifs_forecast_bias_layyah`, version 1 |
| District | Layyah only |
| Provider gate | `open_meteo` only |
| Features | intercept, raw value, lead day, month sine, month cosine |
| Algorithm | `ridge_linear_bias_correction` |
| Targets | `forecast_tmax_c`, `forecast_tmin_c` |
| Trained at | 2026-10-24 |

## Data and split

- Forecast input: archived ECMWF IFS 00 UTC runs from Open-Meteo's Single Runs
  API.
- Reference: NASA POWER MERRA-2 daily reanalysis (`t2m_max`, `t2m_min`).
- Split: chronological, not random. 455 training rows, the last 193 rows held
  out.
- Source licence recorded in the artifact: Open-Meteo's free tier is
  non-commercial.

This is a **model-to-model** comparison. NASA POWER reanalysis is not a weather
station, and neither source is a field measurement. The numbers below say the
correction removes a large systematic bias in the forecast relative to that
reanalysis; they do not say a farmer's field measured the same temperature.

## Measured holdout results

| Target | Raw MAE | Calibrated MAE | Improvement | Holdout rows |
| --- | ---: | ---: | ---: | ---: |
| tmax | 3.598 °C | 1.772 °C | 50.75% | 193 |
| tmin | 2.011 °C | 1.209 °C | 39.88% | 193 |

An independent post-training check used nine archived issue dates
(2026-10-25..2026-11-02), 42 matched forecast days and only forecasts issued
after training ended:

| Target | Samples | Issues | Raw MAE | Calibrated MAE | Improvement |
| --- | ---: | ---: | ---: | ---: | ---: |
| tmax | 42 | 9 | 3.717 °C | 1.550 °C | 58.30% |
| tmin | 42 | 9 | 1.663 °C | 0.776 °C | 53.34% |

Every lead day 0–6 improved, but the window is 11 days and still
model-to-model. It is a sanity check that the coefficients did not stop working
after training, not an independent seasonal validation.

## How it reaches a forecast

1. `forecast-ingest` writes `climate_forecasts` for the provider and district.
2. The `climate_forecasts_apply_model` trigger calls `ml_apply_linear` only when
   the model's provider and district match the row and the model is active.
3. The calibrated value is stored on `calibrated_tmax_c` / `calibrated_tmin_c`
   with `ml_model_id`. The raw value is never overwritten.
4. `generate_forecast_risks()` prefers the calibrated value and records
   `calibrated` and the model id in each risk's basis. With no model it uses the
   raw value — the fallback is visible, not silent.

## Registry and activation gate

The migration registers both models as `shadow`. Activation
(`activate_ml_model`) is admin/service-only and refuses:

- a model whose district/provider do not match the registration,
- fewer than 30 holdout rows,
- a non-positive improvement over the raw baseline,
- a missing training run.

`20261104002400_historical_backtest.sql` adds `record_ml_backtest()` and the
health read. Backtests are stored in `ml_forecast_backtests`; two independent
evaluations exist for these models, both `evaluated` / `beats_raw`.

`ml_model_health()` reports per-model active state, training and backtest
recency, and calibrated-versus-raw error where a backtest exists. It does not
promote a model.

The artifact test `src/intelligence/forecastBiasArtifact.test.ts` fails if the
tracked JSON, the seed SQL and the migration drift apart, if either model loses
its chronology or holdout size, or if the registration stops being shadow.

## Limitations and what would change the claim

- **Geography.** One district. Applying these coefficients elsewhere is
  unsupported; a second district needs its own training run, holdout and
  registry row.
- **Provider.** The bias belongs to ECMWF IFS via Open-Meteo. WeatherAPI
  forecasts are not calibrated by this model.
- **Reference.** Reanalysis, not stations. A station or on-farm comparison is
  the missing validation.
- **Season.** Training covers the available archive, not a full multi-year
  seasonal cycle; the 11-day independent window cannot establish monsoon or
  winter performance.
- **Drift.** Forecast models change. Backtests and the health read exist so a
  degrading model is visible; they do not retrain it.
- **Licence.** The free Open-Meteo tier is non-commercial. Commercial use needs
  a paid plan or a different provider, and that decision has not been made.

## Reproduction

```
node scripts/train-forecast-bias.mjs \
  --district=layyah --lat=30.969 --lon=70.943 \
  --out=models/forecast-bias-layyah.json \
  --seed-out=models/forecast-bias-layyah-seed.sql
```

The trainer archives the runs it used, reports the same metrics, and emits the
seed SQL. Applying the seed SQL does not activate a model; activation remains an
explicit admin/service action.
