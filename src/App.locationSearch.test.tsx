import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { completeSignIn } from '@/testing/credential';
import { clearPlaceCache } from '@/services/geocode';
import { writeSavedLocation } from '@/services/location';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * Finding your area by name, from the filter.
 *
 * Two behaviours are worth pinning. The first is that a tap *is* the save: there is
 * no second button, so a farmer who taps a place and looks away must not come back
 * to find the app still asking them to confirm. The second is that nothing is
 * asked of them first — a location is not published to anyone, so it is kept on
 * the phone when there is no account and handed to the account when there is one.
 * The tests drive it the way it is reached, through the filter on the dealer list,
 * and check that the place tapped is the place kept.
 *
 * The geocoder is stubbed at `fetch` rather than at the module, so the screen is
 * exercised through the real service: the request really goes out, with the
 * farmer's own words in it. Nominatim's usage policy forbids unattended querying,
 * and a test suite is exactly that.
 */

const PLACE = {
  place_id: 42,
  lat: '32.4601',
  lon: '74.0923',
  display_name: 'Kot Ladha, Punjab, Pakistan',
};

/*
 * The write is stubbed because there is no backend in the test environment, and
 * the assertion that matters is *what* was written and *where the app went
 * afterwards* — not whether Supabase accepts an insert. `serverSourceOf` is kept
 * real so the picker's vocabulary is still translated by the app's own code.
 */
vi.mock('@/services/location', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/location')>();
  return {
    ...actual,
    readSavedLocation: vi.fn(async () => null),
    clearSavedLocation: vi.fn(async () => {}),
    writeSavedLocation: vi.fn(async (input: { label: string; lat: number; lon: number }) => ({
      label: input.label,
      lat: input.lat,
      lon: input.lon,
      source: 'profile_entry' as const,
      setAt: Date.now(),
      radiusKm: 25,
    })),
  };
});

/** Long enough for the debounce plus a read on a loaded machine. */
const READY = { timeout: 5000 };

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  clearPlaceCache();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');

  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [PLACE],
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);

  // The mock outlives a single test, so its call log is cleared here — otherwise
  // "saved once" counts the previous test's save as well as this one's.
  vi.mocked(writeSavedLocation).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const signIn = completeSignIn;

/** The filter on the dealer list, and the location bar inside it. */
async function openLocationBar() {
  await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
  await screen.findByRole('region', { name: 'Current location' }, READY);
  await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));

  const sheet = await screen.findByRole('dialog', {}, READY);
  const bar = within(sheet).getByRole('button', { name: 'Change' });
  expect(within(sheet).getByText('Not set')).toBeInTheDocument();
  return bar;
}

const placeField = () => screen.getByRole('searchbox', { name: /Search village or town/ });

/** Signs in from where a farmer would: the profile's own account row. */
async function signInFromProfile(number: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Profile and settings' }));
  await userEvent.click(await screen.findByRole('button', { name: /Tap to sign in/ }, READY));
  await signIn(number);
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
}

describe('finding your area by name', () => {
  it('lives in the filter, and opens a page to type a place into', async () => {
    render(<App />);
    const bar = await openLocationBar();

    await userEvent.click(bar);

    expect(
      await screen.findByRole('heading', { name: 'Your location' }, READY),
    ).toBeInTheDocument();
    expect(placeField()).toHaveFocus();

    // Below the geocoder's own minimum, the page says what it needs rather than
    // spending a request to discover that two letters match half of Pakistan.
    expect(
      screen.getByText('Search by village, town or tehsil name.'),
    ).toBeInTheDocument();
  });

  it('asks the geocoder with the farmer’s own words and lists what comes back', async () => {
    render(<App />);
    await userEvent.click(await openLocationBar());

    await userEvent.type(placeField(), 'Kot Ladha');

    expect(
      await screen.findByText('Tap a place to choose it, then set how far to search.', {}, READY),
    ).toBeInTheDocument();
    expect(await screen.findByText(PLACE.display_name, {}, READY)).toBeInTheDocument();

    // The request carried the tidied query, in-country, and asked for Urdu first
    // so a Pakistani place is not returned in a script the dealer screen cannot use.
    const asked = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(asked).toContain('q=Kot+Ladha');
    expect(asked).toContain('countrycodes=pk');
    expect(asked).toContain('accept-language=en%2Cur');
  });

  it('says nothing was found rather than showing an empty list', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);

    render(<App />);
    await userEvent.click(await openLocationBar());

    await userEvent.type(placeField(), 'Nowhereabad');

    expect(
      await screen.findByText('Nothing found for "Nowhereabad".', {}, READY),
    ).toBeInTheDocument();
  });

  it('keeps the tapped place for a guest, with nothing to sign up for', async () => {
    render(<App />);
    await userEvent.click(await openLocationBar());

    await userEvent.type(placeField(), 'Kot Ladha');
    await userEvent.click(await screen.findByText(PLACE.display_name, {}, READY));

    /*
     * Nothing is asked of the farmer first. This used to open a sign-in sheet,
     * which made telling the app where you are — the thing that makes every shop
     * on the list nearby — the one act you could not perform until you had an
     * account. Install the app and use it.
     */
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    expect(await screen.findByText('Saved on this phone only.', {}, READY)).toBeInTheDocument();

    // The place is kept on the phone, and the app is back on the list it came from.
    const kept = JSON.parse(localStorage.getItem('agri-shop.location') ?? '{}');
    expect(kept).toMatchObject({ label: PLACE.display_name, lat: 32.4601, lon: 74.0923 });
    expect(await screen.findByText(PLACE.display_name, {}, READY)).toBeInTheDocument();

    // And there was no account to write to, so nothing was written to one.
    expect(writeSavedLocation).not.toHaveBeenCalled();
  });

  it('says the area is on this phone rather than in an account', async () => {
    render(<App />);
    await userEvent.click(await openLocationBar());

    await userEvent.type(placeField(), 'Kot Ladha');
    await userEvent.click(await screen.findByText(PLACE.display_name, {}, READY));

    /*
     * "Saved to your account" shown to a farmer who has no account is a false
     * statement about where their data is, which is a worse failure than not
     * saving at all.
     */
    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    expect(await screen.findByText('Saved on this phone only.', {}, READY)).toBeInTheDocument();
  });

  it('writes to the account instead when there is one, and leaves nothing on the phone', async () => {
    render(<App />);
    await signInFromProfile('0300 1112223');

    await userEvent.click(await openLocationBar());
    await userEvent.type(placeField(), 'Kot Ladha');
    await userEvent.click(await screen.findByText(PLACE.display_name, {}, READY));
    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));

    await waitFor(() => expect(writeSavedLocation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeSavedLocation).mock.calls[0]?.[0]).toMatchObject({
      label: PLACE.display_name,
      lat: 32.4601,
      lon: 74.0923,
      // How the place was found, translated into the server's own vocabulary.
      source: 'profile_entry',
    });

    // One answer to "where is this farmer": the account's, not a second copy.
    expect(localStorage.getItem('agri-shop.location')).toBeNull();
  });
});
