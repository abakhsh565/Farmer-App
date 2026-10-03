import { beforeEach, describe, expect, it } from 'vitest';
import {
  DevelopmentAiProvider,
  DevelopmentDealerProvider,
  DevelopmentMarketProvider,
  DevelopmentOtpProvider,
  DevelopmentWeatherProvider,
  LocalRepository,
} from './providers/develop';
import { createServices } from './registry';
import type { ServiceConfig } from './config';
import { AI_CONFIDENCE_THRESHOLD, isRateQuotable, isWeatherUsable, rateRange } from './types';
import {
  canResend,
  codeSent,
  hasExpired,
  initialOtpState,
  otpErrorKey,
  requestStarted,
  secondsUntilResend,
  verifyFailed,
  verifySucceeded,
} from './otpFlow';

const PROFILE = { lat: 32.443, lon: 74.115 };
const FAR_AWAY = { lat: 30.0, lon: 71.0 };

/* -------------------------------------------------------------------------- */

describe('weather provider', () => {
  const weather = new DevelopmentWeatherProvider();

  it('returns a fresh, usable reading at the profile location', async () => {
    const reading = await weather.current(PROFILE);
    expect(reading.freshness).toBe('fresh');
    expect(reading.data.tempC).not.toBeNull();
    expect(isWeatherUsable(reading)).toBe(true);
  });

  it('reports an unreachable location as unusable so advice pauses', async () => {
    // This is the path that matters: the PRD requires advice to pause when the
    // reading cannot be trusted, and that is untestable if the fixture always
    // succeeds.
    const reading = await weather.current(FAR_AWAY);
    expect(reading.freshness).toBe('unavailable');
    expect(reading.status).toBe('failing');
    expect(reading.error).toBeTruthy();
    expect(isWeatherUsable(reading)).toBe(false);
    expect(reading.data.tempC).toBeNull();
  });

  it('forecasts only as many days as asked for', async () => {
    const forecast = await weather.forecast(PROFILE, 3);
    expect(forecast.data).toHaveLength(3);
  });

  it('caps an unreasonable forecast request', async () => {
    const forecast = await weather.forecast(PROFILE, 999);
    expect(forecast.data.length).toBeLessThanOrEqual(10);
  });
});

/* -------------------------------------------------------------------------- */

describe('market provider', () => {
  const market = new DevelopmentMarketProvider();

  it('never turns an unreported price into zero', async () => {
    const { data } = await market.rates();
    const rice = data.find((r) => r.commodity === 'rice');
    expect(rice).toBeDefined();
    // NULL, explicitly. A zero here would be a price a farmer could be offered.
    expect(rice?.minPrice).toBeNull();
    expect(rice?.minPrice).not.toBe(0);
  });

  it('marks an old rate as not quotable', async () => {
    const { data } = await market.rates();
    const now = Date.now();
    const maize = data.find((r) => r.commodity === 'maize');
    const wheat = data.find((r) => r.commodity === 'wheat');
    expect(maize && isRateQuotable(maize, now)).toBe(false);
    expect(wheat && isRateQuotable(wheat, now)).toBe(true);
  });

  it('returns no range rather than 0 – 0 when a minimum is missing', () => {
    const range = rateRange([
      {
        commodity: 'rice',
        nameEn: 'Rice',
        unit: '40kg',
        marketName: 'Hafizabad',
        district: null,
        observedOn: new Date().toISOString(),
        minPrice: null,
        maxPrice: 3400,
        modalPrice: 3250,
        currency: 'PKR',
        sourceLabel: 'test',
      },
    ]);
    expect(range).toBeNull();
  });

  it('carries a display name that does not depend on a catalogue key', async () => {
    const { data } = await market.rates();
    for (const rate of data) {
      expect(rate.nameEn.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('AI provider pipeline', () => {
  const ai = new DevelopmentAiProvider();
  const context = { language: 'ur', cropCode: 'cotton' };

  it('refuses an off-domain question instead of answering it', async () => {
    const answer = await ai.ask('who won the cricket match last night', context);
    expect(answer.gate).toBe('off_domain');
    expect(answer.text).toBeUndefined();
    expect(answer.refusalReasonKey).toBeTruthy();
  });

  it('refuses to guess when the knowledge does not cover the question', async () => {
    const answer = await ai.ask('how do I grow pistachios in this soil', context);
    expect(answer.gate).toBe('not_covered');
    expect(answer.confidence).toBeLessThan(AI_CONFIDENCE_THRESHOLD);
    expect(answer.escalate).toBe(true);
  });

  it('answers an agricultural question with its knowledge version cited', async () => {
    const answer = await ai.ask('how do I deal with pink bollworm in cotton', context);
    expect(answer.gate).toBe('agriculture');
    expect(answer.text).toBeTruthy();
    expect(answer.citations.some((c) => c.kind === 'knowledge' && typeof c.version === 'number')).toBe(true);
  });

  it('states the weather caveat rather than assuming conditions', async () => {
    // The rule is that advice depending on conditions must say when it cannot
    // read them, instead of quietly guessing.
    const answer = await ai.ask('when should I spray against bollworm', {
      ...context,
      weatherUsable: false,
    });
    expect(answer.caveats.join(' ')).toMatch(/weather/i);
  });

  it('does not add the weather caveat when the reading is usable', async () => {
    const answer = await ai.ask('when should I spray against bollworm', {
      ...context,
      weatherUsable: true,
    });
    expect(answer.caveats).toHaveLength(0);
  });

  it('diagnoses deterministically and cites a registration number', async () => {
    const result = await ai.diagnose('media://1', context);
    expect(result.gate).toBe('agriculture');
    expect(result.diagnosis).toBeTruthy();
    expect(result.product?.registrationNo).toBe('DPP-PK-2019-0431');
  });

  it('escalates a crop it cannot diagnose rather than inventing one', async () => {
    const result = await ai.diagnose('media://1', { language: 'ur', cropCode: 'wheat' });
    expect(result.diagnosis).toBeNull();
    expect(result.escalate).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('OTP provider', () => {
  it('completes a request and verification', async () => {
    const otp = new DevelopmentOtpProvider();
    const request = await otp.request('phone', '03001234567');
    expect(request.developmentCode).toMatch(/^\d{6}$/);

    const result = await otp.verify('phone', '03001234567', request.developmentCode as string);
    expect(result.ok).toBe(true);
  });

  it('consumes a code so it cannot be replayed', async () => {
    const otp = new DevelopmentOtpProvider();
    const request = await otp.request('phone', '03001234567');
    await otp.verify('phone', '03001234567', request.developmentCode as string);

    const again = await otp.verify('phone', '03001234567', request.developmentCode as string);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe('unknown');
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const otp = new DevelopmentOtpProvider();
    await otp.request('email', 'farmer@example.com');
    const wrong = await otp.verify('email', 'farmer@example.com', '000000');
    expect(wrong.ok).toBe(false);
  });

  it('expires a code rather than accepting it late', async () => {
    let clock = 1_000_000;
    const otp = new DevelopmentOtpProvider(() => clock);
    const request = await otp.request('phone', '03001234567');

    clock += 6 * 60 * 1000;
    const late = await otp.verify('phone', '03001234567', request.developmentCode as string);
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.reason).toBe('expired');
  });

  it('locks out after the attempt limit', async () => {
    const otp = new DevelopmentOtpProvider();
    await otp.request('phone', '03001234567');

    for (let i = 0; i < 5; i += 1) {
      await otp.verify('phone', '03001234567', '000000');
    }
    const result = await otp.verify('phone', '03001234567', '000000');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('too_many_attempts');
  });

  it('does not mint a second code inside the resend cooldown', async () => {
    // Two valid codes is how a farmer enters the wrong one.
    const otp = new DevelopmentOtpProvider();
    const first = await otp.request('phone', '03001234567');
    const second = await otp.request('phone', '03001234567');
    expect(second.developmentCode).toBe(first.developmentCode);
    expect(second.resendAfterSeconds).toBeLessThanOrEqual(30);
  });
});

/* -------------------------------------------------------------------------- */

describe('OTP flow machine', () => {
  const now = 5_000_000;

  it('walks request → code sent → verified', () => {
    let state = initialOtpState('phone', '03001234567');
    state = requestStarted(state);
    expect(state.phase).toBe('sending');

    state = codeSent(state, { expiresAt: now + 300_000, resendAfterSeconds: 30, developmentCode: '123456' }, now);
    expect(state.phase).toBe('awaiting_code');
    expect(hasExpired(state, now)).toBe(false);

    state = verifySucceeded(state);
    expect(state.phase).toBe('verified');
    expect(state.developmentCode).toBeNull();
  });

  it('blocks resend during the cooldown and allows it after', () => {
    const state = codeSent(
      requestStarted(initialOtpState('phone', '03001234567')),
      { expiresAt: now + 300_000, resendAfterSeconds: 30 },
      now,
    );

    expect(canResend(state, now + 10_000)).toBe(false);
    expect(secondsUntilResend(state, now + 10_000)).toBe(20);
    expect(canResend(state, now + 31_000)).toBe(true);
    expect(secondsUntilResend(state, now + 31_000)).toBe(0);
  });

  it('treats expiry as its own reason, not as a wrong code', () => {
    const state = verifyFailed(
      codeSent(requestStarted(initialOtpState('phone', 'x')), { expiresAt: now + 1000, resendAfterSeconds: 0 }, now),
      'expired',
    );
    // The distinction that matters: a farmer told "wrong code" when it merely
    // expired will re-read six digits hunting for a typo that is not there.
    expect(otpErrorKey('expired')).not.toBe(otpErrorKey('mismatch'));
    expect(otpErrorKey('expired')).toBe('otp.expired');
    expect(otpErrorKey('too_many_attempts')).toBe('otp.tooManyAttempts');
    expect(otpErrorKey('network')).toBe('otp.network');
    expect(state.expiresAt).toBeNull();
  });

  it('counts attempts so a code cannot be brute-forced', () => {
    let state = codeSent(
      requestStarted(initialOtpState('phone', 'x')),
      { expiresAt: now + 300_000, resendAfterSeconds: 0 },
      now,
    );
    state = verifyFailed(state, 'mismatch');
    state = verifyFailed(state, 'mismatch');
    expect(state.attempts).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('local repository', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a document', async () => {
    const repo = new LocalRepository();
    await repo.write('credit', 'farmer-1', { status: 'awaiting_final_approval' });
    const read = await repo.read<{ status: string }>('credit', 'farmer-1');
    expect(read?.status).toBe('awaiting_final_approval');
  });

  it('keeps one farmer\'s document away from another', async () => {
    const repo = new LocalRepository();
    await repo.write('credit', 'farmer-1', { status: 'accepted' });
    expect(await repo.read('credit', 'farmer-2')).toBeNull();
  });

  it('treats a corrupt document as absent rather than crashing', async () => {
    const repo = new LocalRepository();
    localStorage.setItem('agri-shop.credit.farmer-1', '{not json');
    expect(await repo.read('credit', 'farmer-1')).toBeNull();
  });

  it('removes a document', async () => {
    const repo = new LocalRepository();
    await repo.write('visits', 'farmer-1', { a: 1 });
    await repo.remove('visits', 'farmer-1');
    expect(await repo.read('visits', 'farmer-1')).toBeNull();
  });

  it('is not a remote repository', () => {
    expect(new LocalRepository().isRemote).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('dealer provider', () => {
  const dealer = new DevelopmentDealerProvider();

  it('applies its own 100 km ceiling regardless of what the caller asks for', async () => {
    const { data } = await dealer.search({ radiusKm: 5000 });
    expect(dealer.maxRadiusKm).toBe(100);
    for (const row of data) {
      expect(row.distanceKm).toBeLessThanOrEqual(100);
    }
  });

  it('narrows results as the radius shrinks', async () => {
    const wide = await dealer.search({ radiusKm: 100 });
    const narrow = await dealer.search({ radiusKm: 5 });
    expect(narrow.data.length).toBeLessThanOrEqual(wide.data.length);
  });

  it('takes an explicit origin for a temporary search area', async () => {
    /*
     * The property that matters is not "a different list" but *the distances are
     * measured from the origin given*: a temporary search area must move the
     * results without touching the farmer's own location, and that is only true if
     * the number on each row is computed from the origin of that search.
     */
    const nearProfile = await dealer.search({ radiusKm: 100 });
    const nearHafizabad = await dealer.search({
      radiusKm: 100,
      origin: { lat: 32.0702, lon: 73.688 },
    });

    const aliHere = nearProfile.data.find((d) => d.id === 'dealer.aliTraders');
    const aliThere = nearHafizabad.data.find((d) => d.id === 'dealer.aliTraders');
    expect(aliHere).toBeDefined();
    expect(aliThere).toBeDefined();
    expect(aliThere?.distanceKm).toBeGreaterThan(aliHere?.distanceKm ?? 0);
  });

  it('never returns the shop that sits beyond the ceiling, even at the maximum radius', async () => {
    const { data } = await dealer.search({ radiusKm: dealer.maxRadiusKm });
    expect(data.some((d) => d.id === 'dealer.farMandi')).toBe(false);
    for (const row of data) expect(row.distanceKm).toBeLessThanOrEqual(100);
  });

  it('reports dealer freshness rather than assuming it', async () => {
    const { data } = await dealer.search({ radiusKm: 100 });
    const states = new Set(data.map((d) => d.syncState));
    expect(states.has('fresh')).toBe(true);
    // The fixture contains a stale and an unreachable dealer on purpose, so the
    // "this information may be out of date" path is exercised.
    expect(states.size).toBeGreaterThan(1);
  });

  it('passes an unknown stock quantity through as null, not zero', async () => {
    const { data } = await dealer.products('dealer.aliTraders');
    const confidor = data.find((p) => p.name === 'Confidor');
    expect(confidor?.availableQty).toBeNull();
    expect(confidor?.availableQty).not.toBe(0);
  });

  it('finds the shops that stock a canonical product, nearest first', async () => {
    const { data } = await dealer.stockists({ canonicalProductId: 'roundup', radiusKm: 10 });

    expect(data.map((row) => row.dealerId)).toEqual([
      'dealer.aliTraders',
      'dealer.greenAgro',
    ]);
    // Nearest first, so the shop a farmer can walk to is the first line.
    expect(data[0]?.distanceKm).toBeLessThan(data[1]?.distanceKm ?? 0);
    // Each shop quotes its own price for the same product.
    expect(data[0]?.unitPrice).not.toBe(data[1]?.unitPrice);
  });

  it('leaves out the shop that has confirmed it is out of stock', async () => {
    /* Green Agro's urea is confirmed none. Sending a farmer there would be worse
       than saying nothing, so the row is not in the list at all. */
    const { data } = await dealer.stockists({ canonicalProductId: 'urea', radiusKm: 10 });
    expect(data.some((row) => row.dealerId === 'dealer.greenAgro')).toBe(false);
  });

  it('keeps a listing whose stock the dealer system did not report, marked unknown', async () => {
    const { data } = await dealer.stockists({ canonicalProductId: 'confidor', radiusKm: 10 });
    const ali = data.find((row) => row.dealerId === 'dealer.aliTraders');
    expect(ali).toBeDefined();
    expect(ali?.inStock).toBeNull();
    expect(ali?.inStock).not.toBe(false);
  });

  it('carries the listing\u2019s own observation time and sync state', async () => {
    const now = Date.now();
    const { data } = await dealer.stockists({
      canonicalProductId: 'bt-cotton-seed',
      radiusKm: 10,
    });
    const punjab = data[0];
    expect(punjab?.dealerId).toBe('dealer.punjabSeed');
    /* Four days since the dealer system reached this shop: the row says so, and
       the screen turns that into a sentence rather than showing the stock as if
       it were confirmed this morning. */
    expect(punjab?.syncState).toBe('unreachable');
    expect(punjab?.observedAt).toBeLessThan(now - 24 * 60 * 60 * 1000);
  });

  it('honours the radius for listings, and the ceiling with it', async () => {
    const tight = await dealer.stockists({ canonicalProductId: 'roundup', radiusKm: 3 });
    expect(tight.data.map((row) => row.dealerId)).toEqual(['dealer.aliTraders']);

    const enormous = await dealer.stockists({ canonicalProductId: 'roundup', radiusKm: 5000 });
    expect(enormous.data.length).toBeGreaterThan(0);
    for (const row of enormous.data) expect(row.distanceKm).toBeLessThanOrEqual(100);
  });
});

/* -------------------------------------------------------------------------- */

describe('registry selection', () => {
  const unconfigured: ServiceConfig = {
    supabase: { url: null, anonKey: null, configured: false },
    aiEndpoint: { url: null, configured: false },
    otpEndpoint: { url: null, configured: false },
    dealerEndpoint: { url: null, configured: false },
    weatherIngestEndpoint: { url: null, configured: false },
    analytics: { key: null, host: 'https://example.invalid', configured: false },
    // `auto` with no backend resolves to the fixture, which is what this build is.
    weather: { provider: 'development' },
  };

  const configured: ServiceConfig = {
    supabase: { url: 'https://example.supabase.co', anonKey: 'anon', configured: true },
    aiEndpoint: { url: 'https://example.supabase.co/functions/v1/ai', configured: true },
    otpEndpoint: { url: 'https://example.supabase.co/functions/v1/otp', configured: true },
    dealerEndpoint: { url: 'https://example.supabase.co/functions/v1/dealer', configured: true },
    weatherIngestEndpoint: { url: 'https://example.supabase.co/functions/v1/weather-ingest', configured: true },
    analytics: { key: 'phc_test', host: 'https://example.invalid', configured: false },
    // `auto` with a backend resolves to the normalised table.
    weather: { provider: 'supabase' },
  };

  it('runs everything in development mode with nothing configured', () => {
    const services = createServices(unconfigured);
    expect(services.repository.isRemote).toBe(false);
    expect(services.repository.name).toBe('Local device storage');
    expect(services.weather.name).toContain('Development');
    expect(services.ai.name).toContain('Development');
    expect(services.anyRemote).toBe(false);
  });

  it('switches persistence, weather, market and dealers together', () => {
    // They are all reads of the same normalised backend, so a split would let the
    // app contradict itself about the same fact.
    const services = createServices(configured);
    expect(services.repository.isRemote).toBe(true);
    expect(services.weather.name).toContain('Supabase');
    expect(services.market.name).toContain('Supabase');
    expect(services.dealer.name).toContain('Supabase');
    expect(services.anyRemote).toBe(true);
  });

  it('does not switch AI or OTP on the presence of a database alone', () => {
    const services = createServices({
      ...unconfigured,
      supabase: { url: 'https://example.supabase.co', anonKey: 'anon', configured: true },
    });
    // Separate server endpoints can be deployed at different times, and claiming
    // otherwise would mean pretending a feature works before it does.
    expect(services.ai.name).toContain('Development');
    expect(services.otp.name).toContain('Development');
  });
});
