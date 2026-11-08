-- Generated from artifacts/models/forecast-bias-layyah.json.
-- This migration registers the artifacts as shadow models. Activation is a
-- separate admin/service operation and is refused unless the holdout beats the
-- raw forecast with at least 30 test rows.
-- forecast_tmax_c: 50.75% holdout MAE improvement
insert into public.ml_models (
  model_code, version, target, algorithm, status, provider_code, district_code,
  feature_schema_version, feature_names, coefficients, metrics, provenance,
  confidence, train_rows, test_rows, training_start, training_end, trained_at
) values (
  'ecmwf_ifs_forecast_bias_layyah', 1, 'forecast_tmax_c',
  'ridge_linear_bias_correction', 'shadow', 'open_meteo', 'layyah',
  1, array['intercept','raw','lead_day','month_sin','month_cos'],
  '{"intercept":6.877793263917056,"raw":0.8721785949652248,"lead_day":-0.08844602860594315,"month_sin":0.6844755964720441,"month_cos":-0.7257473847938721}'::jsonb, '{"test_rows":193,"train_rows":455,"raw_mae":3.598,"calibrated_mae":1.772,"improvement_pct":50.75,"raw_rmse":3.973,"calibrated_rmse":2.171,"raw_bias":-3.593,"calibrated_bias":-1.373,"train_raw_mae":2.994,"train_calibrated_mae":1.475,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb, '{"forecast_provider":"open_meteo","forecast_model":"ecmwf_ifs","forecast_run":"00 UTC archived run","reference_provider":"nasa_power","reference_product":"MERRA-2 daily reanalysis, 0.5 degree","license":"Open-Meteo CC BY 4.0 (free tier non-commercial); NASA POWER open data with attribution","limitation":"Reanalysis reference and global forecast grid; not a field or station measurement. Do not present holdout metrics as field accuracy."}'::jsonb,
  0.95, 455, 193,
  '2025-01-04'::date, '2026-10-24'::date,
  '2026-11-04T19:44:53.200Z'::timestamptz
) on conflict (model_code, version, target, provider_code, district_code) do nothing;

-- forecast_tmin_c: 39.88% holdout MAE improvement
insert into public.ml_models (
  model_code, version, target, algorithm, status, provider_code, district_code,
  feature_schema_version, feature_names, coefficients, metrics, provenance,
  confidence, train_rows, test_rows, training_start, training_end, trained_at
) values (
  'ecmwf_ifs_forecast_bias_layyah', 1, 'forecast_tmin_c',
  'ridge_linear_bias_correction', 'shadow', 'open_meteo', 'layyah',
  1, array['intercept','raw','lead_day','month_sin','month_cos'],
  '{"intercept":3.672275915341093,"raw":0.8662820463208103,"lead_day":0.016503879529202875,"month_sin":0.03530063705993436,"month_cos":-2.089702943462793}'::jsonb, '{"test_rows":193,"train_rows":455,"raw_mae":2.011,"calibrated_mae":1.209,"improvement_pct":39.88,"raw_rmse":2.533,"calibrated_rmse":1.61,"raw_bias":-1.835,"calibrated_bias":-0.423,"train_raw_mae":1.426,"train_calibrated_mae":1.054,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb, '{"forecast_provider":"open_meteo","forecast_model":"ecmwf_ifs","forecast_run":"00 UTC archived run","reference_provider":"nasa_power","reference_product":"MERRA-2 daily reanalysis, 0.5 degree","license":"Open-Meteo CC BY 4.0 (free tier non-commercial); NASA POWER open data with attribution","limitation":"Reanalysis reference and global forecast grid; not a field or station measurement. Do not present holdout metrics as field accuracy."}'::jsonb,
  0.95, 455, 193,
  '2025-01-04'::date, '2026-10-24'::date,
  '2026-11-04T19:44:53.200Z'::timestamptz
) on conflict (model_code, version, target, provider_code, district_code) do nothing;

insert into public.ml_training_runs (
  model_code, target, provider_code, district_code, started_at, finished_at, status,
  train_rows, test_rows, metrics, artifact, source_urls
) values (
  'ecmwf_ifs_forecast_bias_layyah', 'forecast_tmax_c', 'open_meteo', 'layyah',
  '2026-11-04T19:44:53.200Z'::timestamptz, '2026-11-04T19:44:53.200Z'::timestamptz,
  'ok', 455, 193, '{"test_rows":193,"train_rows":455,"raw_mae":3.598,"calibrated_mae":1.772,"improvement_pct":50.75,"raw_rmse":3.973,"calibrated_rmse":2.171,"raw_bias":-3.593,"calibrated_bias":-1.373,"train_raw_mae":2.994,"train_calibrated_mae":1.475,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"coefficients":[6.877793263917056,0.8721785949652248,-0.08844602860594315,0.6844755964720441,-0.7257473847938721],"feature_names":["intercept","raw","lead_day","month_sin","month_cos"]}'::jsonb,
  array['https://single-runs-api.open-meteo.com/v1/forecast', 'https://power.larc.nasa.gov/api/temporal/daily/point', 'https://open-meteo.com/en/docs/single-runs-api', 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/']
);

insert into public.ml_training_runs (
  model_code, target, provider_code, district_code, started_at, finished_at, status,
  train_rows, test_rows, metrics, artifact, source_urls
) values (
  'ecmwf_ifs_forecast_bias_layyah', 'forecast_tmin_c', 'open_meteo', 'layyah',
  '2026-11-04T19:44:53.200Z'::timestamptz, '2026-11-04T19:44:53.200Z'::timestamptz,
  'ok', 455, 193, '{"test_rows":193,"train_rows":455,"raw_mae":2.011,"calibrated_mae":1.209,"improvement_pct":39.88,"raw_rmse":2.533,"calibrated_rmse":1.61,"raw_bias":-1.835,"calibrated_bias":-0.423,"train_raw_mae":1.426,"train_calibrated_mae":1.054,"test_start":"2026-04-11","test_end":"2026-10-24","train_start":"2025-01-04","train_end":"2026-04-04","reference":"NASA POWER daily reanalysis (0.5 degree)","forecast":"ECMWF IFS archived 00 UTC run via Open-Meteo Single Runs API","caveat":"Model-to-model comparison; not a station-observation validation."}'::jsonb,
  '{"coefficients":[3.672275915341093,0.8662820463208103,0.016503879529202875,0.03530063705993436,-2.089702943462793],"feature_names":["intercept","raw","lead_day","month_sin","month_cos"]}'::jsonb,
  array['https://single-runs-api.open-meteo.com/v1/forecast', 'https://power.larc.nasa.gov/api/temporal/daily/point', 'https://open-meteo.com/en/docs/single-runs-api', 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/']
);
