# Phase 9 — Intelligence data and evaluated models

Status: **implemented and exercised against the staging project**, with the
limits listed at the end. This is not a production deployment and it is not a
claim of field accuracy.

## What changed

| Area | Implementation |
| --- | --- |
| Idempotent weather | `weather_readings_event_uidx` plus `weather-ingest` upsert. A retry corrects a reading instead of duplicating it. `weather_ingestion_targets()` exposes the farmer cells that actually need a fetch; the adapter accepts `targets=true` and caps a batch at 20 cells. |
| Soil priors | `soil_observations`, `soil_ingestion_runs`, service-only `soil_context(lat,lon)` and the keyless `soil-ingest` adapter for ISRIC SoilGrids 250 m. Values are stored at a 2-decimal cell (~1.1 km), with the provider's `d_factor` and uncertainty retained. |
| Forecast calibration | `ml_models`, `ml_training_runs`, `ml_forecast_backtests`, `ml_apply_linear`, the `climate_forecasts_apply_model` trigger, and service/admin model activation. The active model is applied only when provider and district match. |
| Forecast ingestion | `forecast-ingest` defaults to keyless Open-Meteo ECMWF IFS (`models=ecmwf_ifs`, 7 days) and writes `provider_code='open_meteo'`. WeatherAPI remains an explicit `provider=weatherapi` path with a 3-day cap. |
| Risk integration | `generate_forecast_risks()` uses `calibrated_tmax_c` / `calibrated_tmin_c` when present, and records `calibrated` and `model_id` in each risk's basis. It falls back to the raw value when no model applies. |
| Source health | `ingestion_health()` reports last attempt, last success, freshness and rejection details. It is admin-only; migrations 026/027 make every branch inventory-based and forecast per provider, and were runtime-verified on staging with temporary fixtures that were then deleted. The function had a real `source_code` ambiguity, now fixed and deployed only to staging. It was not widened to service role. |

## Real artifacts and measured results

The trainer is `scripts/train-forecast-bias.mjs`. It uses archived ECMWF IFS
00 UTC runs from Open-Meteo's Single Runs API as the forecast input and NASA
POWER MERRA-2 daily reanalysis as the reference. The split is chronological:
455 training rows and the last 193 rows held out. This is a **model-to-model**
comparison, not validation against a weather station or a field measurement.

| Target | Raw MAE | Calibrated MAE | Improvement | Holdout rows |
| --- | ---: | ---: | ---: | ---: |
| Daily tmax | 3.598 °C | 1.772 °C | 50.75% | 193 |
| Daily tmin | 2.011 °C | 1.209 °C | 39.88% | 193 |

Both artifacts are registered by `20261104002300_forecast_bias_model.sql` as
`shadow` first. They were then activated through the service authority; activation
still enforced 30+ holdout rows and a positive improvement. The artifact is in
`models/forecast-bias-layyah.json`; the model applies only to Layyah and
only to `open_meteo` forecasts.

The live trigger was exercised with the actual seven-day ECMWF forecast for
Layyah issued 2026-11-04. All seven days carried both calibrated values and model
IDs. Example: 29.3 °C raw tmax became 31.48 °C calibrated; 18.6 °C raw tmin
became 18.71 °C calibrated. These are the model's corrections, not observations.

## Data present in staging after verification

| Table | Rows / state |
| --- | --- |
| `climate_forecasts` | 7 Layyah days, issued 2026-11-04, all calibrated |
| `weather_readings` | 3 current readings (2 refreshed farmer cells + 1 older cell) and 21 daily readings; latest current observation 2026-11-04 20:00 UTC |
| `soil_observations` | 12 rows across 6 depths for 2 of 6 district headquarters: Dera Ghazi Khan and Layyah |
| `soil_ingestion_runs` | 1 run, `partial`, 2 cells written of 6 requested |
| `climate_observations` | 9 NASA POWER reanalysis days, 2026-10-25..2026-11-02, with units and provenance |
| `climate_forecasts` archive | 63 archived ECMWF IFS rows across 9 issue dates, `is_archived=true` |
| `forecast_risk_rules` | 0 active; no forecast risks generated |
| `ml_models` | 2 active Layyah temperature models |
| `ml_forecast_backtests` | Two independent evaluations, both `evaluated` / `beats_raw` |

## Independent historical validation

The post-training window 2026-10-25..2026-11-02 was loaded with nine archived
ECMWF IFS runs and nine NASA POWER reanalysis days. The model was evaluated only
on forecasts issued after its 2026-10-24 training end. The database matched 42
forecast days across all nine issue dates (87.5% of past-valid archive rows):

| Target | Samples | Issues | Raw MAE | Calibrated MAE | Improvement | Raw bias | Calibrated bias |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tmax | 42 | 9 | 3.717 °C | 1.550 °C | 58.30% | -3.717 | -1.550 |
| tmin | 42 | 9 | 1.663 °C | 0.776 °C | 53.34% | -1.663 | -0.675 |

Every lead day 0–6 improved for both targets. The smallest per-horizon wins were
36.50% (tmin, lead 6, 3 samples) and 57.03% (tmax, lead 2, 7 samples). This is
independent chronology, but only an 11-day window and still a model-to-model
comparison against NASA POWER, not a station record. It supports keeping the
models active; it is not a claim of field accuracy.

The soil loader found real SoilGrids NoData at Taunsa, Rajanpur, Muzaffargarh and
Kot Addu headquarters points. Those districts are absent, not filled with a
nearby or regional value. Layyah 0–5 cm currently has clay 21.4%, sand 37.8%,
pH 8.3 and SOC 6.6 g/kg, with the provider's raw uncertainty retained.

The weather loader found live current readings for the two due cells
(29.382, 70.910 and 29.511, 70.846) at 22 °C and wrote seven daily days for each.
A follow-up target query should show zero due cells until the 75-minute window
expires.

## Runtime and scheduling verified

The five ingestion functions are deployed on staging, authenticated with a
separate function token, and connected to the existing `pg_cron` + `pg_net`
stack. Weather, forecast, climate, historical archive and soil calls were
actually executed; the scheduler was demonstrated on real cron ticks. See
[PHASE-9-INGESTION-RUNTIME.md](PHASE-9-INGESTION-RUNTIME.md) for the execution,
idempotency, freshness, licensing and security evidence.

Staging only: no production deployment, no paid provider activation and no
commercial clearance. The migration bundle remains generated by
`npm run db:bundle`; the migration ledger was not fabricated.

## Honest limits

- **No station validation.** The model metrics compare two gridded products. Do
  not present 50.75% / 39.88% as field accuracy or as a promise to a farmer.
- **Open-Meteo's free tier is non-commercial.** Staging/evaluation use is covered;
  commercial deployment needs the paid plan or another licensed source. The
  source registry keeps the licence caveat.
- **SoilGrids is a model at 250 m.** The stored values are priors, not a soil test.
  Four district headquarters returned NoData and remain empty.
- **Independent validation is preliminary.** 42 matched rows across 9 issue
  dates support the active models, but the window is 11 days and the reference is
  NASA POWER reanalysis. More seasons and a station record are still required.
- **No future live monitoring yet.** The backtest now works on the independent
  archive; ongoing evaluation needs scheduled archive and NASA ingestion.
- **No active forecast-risk rule.** The temperature calibration is connected to
  risk generation, but an agronomist-approved threshold is still required before
  any warning can fire. No agricultural content was invented to change that.
- **No production deployment; staging has the Edge functions and scheduler.**
  No AMIS feed and no official advisory feed. Punjab AMIS and advisory access
  remain permission/manual-import blockers.
- **No permanent staging admin capability** remains. Model activation used the
  service authority added in migration 023; `ingestion_health()` remains
  admin-only. A temporary admin fixture was used for the Phase 9 QA read and
  removed afterward.
