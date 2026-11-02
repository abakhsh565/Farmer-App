import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationProvider, useLocation } from '@/location/LocationProvider';
import {
  clearSavedLocation,
  readSavedLocation,
  writeSavedLocation,
  type SavedLocation,
} from '@/services/location';

/**
 * One owner per value: where the saved location comes from, and what is left on
 * the phone afterwards.
 *
 * This is the branch every screen depends on and no screen test can reach: the
 * whole signed-in path only runs when a backend is configured, and the suites run
 * with `VITE_SUPABASE_URL` deliberately empty (see the `test.env` block in
 * `vite.config.ts`). So the configuration is set here, for this file only, and the
 * provider is exercised directly.
 *
 * The property under test is the one the docblock promises and the code has to
 * keep: a phone may hold an area of its own while nobody is signed in, and the
 * moment an account answers, that account is the single source — the phone's copy
 * goes. Leaving it behind is not a stale-cache nuisance. It is the *previous*
 * farmer's village, still on the handset, shown to whoever picks it up next.
 */

vi.mock('@/services/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/config')>();
  return {
    ...actual,
    serviceConfig: {
      ...actual.serviceConfig,
      // A configured backend is the precondition for the account being asked at
      // all. The value is fake on purpose: every call that would use it is mocked
      // below, so nothing here can reach a real project.
      supabase: {
        url: 'https://project.supabase.co',
        anonKey: 'test-anon-key',
        configured: true,
      },
    },
  };
});

/** Mutable so a single file can be both a guest and a farmer. */
const mockSession: { account: { partyId: string } | null } = { account: null };

vi.mock('@/session/SessionProvider', () => ({
  useSession: () => mockSession,
}));

vi.mock('@/services/location', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/location')>();
  return {
    ...actual,
    readSavedLocation: vi.fn(),
    writeSavedLocation: vi.fn(),
    clearSavedLocation: vi.fn(),
  };
});

const PARTY_ID = 'b0da419c-2f5f-4f4a-9a58-6f1b0e0d2a71';
const DEVICE_KEY = 'agri-shop.location';
const RADIUS_KEY = 'agri-shop.radius';

/** What a guest typed on this handset before signing in. */
const GUEST_AREA: SavedLocation = {
  label: 'Alipur',
  lat: 32.5,
  lon: 74.0,
  source: 'profile_entry',
  setAt: 1,
  radiusKm: 10,
};

/** What the account already holds. */
const ACCOUNT_AREA: SavedLocation = {
  label: 'Gujranwala',
  lat: 32.1877,
  lon: 74.1945,
  source: 'profile_entry',
  setAt: 2,
  radiusKm: 25,
};

/** Everything the provider decides, read the way a screen reads it. */
function Probe() {
  const location = useLocation();
  return (
    <dl>
      <dt>Area</dt>
      <dd data-testid="area">{location.saved?.label ?? 'none'}</dd>
      <dt>Range</dt>
      <dd data-testid="radius">{location.radiusKm}</dd>
      <dt>On the phone</dt>
      <dd data-testid="on-device">{String(location.savedOnDevice)}</dd>
    </dl>
  );
}

const open = () =>
  render(
    <LocationProvider>
      <Probe />
    </LocationProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  mockSession.account = { partyId: PARTY_ID };

  /* Defaults, stated rather than inherited: a test that forgets to set one gets
     an empty account rather than the previous test's answer. */
  vi.mocked(readSavedLocation).mockReset();
  vi.mocked(readSavedLocation).mockResolvedValue(null);
  vi.mocked(writeSavedLocation).mockReset();
  vi.mocked(writeSavedLocation).mockImplementation(async (input) => ({
    ...input,
    // The server fills a range in when the caller gives none, so the stub does too.
    radiusKm: input.radiusKm ?? 10,
    setAt: Date.now(),
  }));
  vi.mocked(clearSavedLocation).mockReset();
});

describe('a signed-in farmer', () => {
  it("keeps the account's area and drops the phone's copy of the guest's", async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(GUEST_AREA));
    vi.mocked(readSavedLocation).mockResolvedValue(ACCOUNT_AREA);

    open();

    await waitFor(() => expect(screen.getByTestId('area')).toHaveTextContent('Gujranwala'));

    /* The account is the source, so this is not a location "on the phone" — the
       screen says which, and it must not claim to hold what it does not. */
    expect(screen.getByTestId('on-device')).toHaveTextContent('false');

    /* The range travels with the account's record, because that is the number the
       server searches with. It is mirrored so a cold start shows the right one. */
    expect(screen.getByTestId('radius')).toHaveTextContent('25');
    expect(localStorage.getItem(RADIUS_KEY)).toBe('25');

    /* And the area does not travel: nothing of the guest's is left on the handset
       for the next person to find, and a cold start cannot contradict the account.
       This is the assertion the fix in the provider exists for. */
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();

    // The account already had an answer, so nothing was written over it.
    expect(writeSavedLocation).not.toHaveBeenCalled();
  });

  it("adopts the phone's area when the account has none, then drops it", async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(GUEST_AREA));

    open();

    await waitFor(() => expect(screen.getByTestId('area')).toHaveTextContent('Alipur'));

    // Handed over exactly once, as the guest's own record with its own range.
    expect(writeSavedLocation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeSavedLocation).mock.calls[0]?.[0]).toMatchObject({
      label: 'Alipur',
      lat: 32.5,
      lon: 74.0,
      radiusKm: 10,
    });

    // The account owns it now, so the phone's copy is gone here too — otherwise
    // signing out would resurrect the area the farmer has just moved into an
    // account.
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(screen.getByTestId('on-device')).toHaveTextContent('false');
  });

  it('says nothing is saved when neither the account nor the phone has an area', async () => {
    open();

    await waitFor(() => expect(screen.getByTestId('area')).toHaveTextContent('none'));
    expect(screen.getByTestId('on-device')).toHaveTextContent('false');
    expect(writeSavedLocation).not.toHaveBeenCalled();
  });
});

describe('a guest', () => {
  it("reads the phone and never asks the account, and the area stays theirs", async () => {
    mockSession.account = null;
    localStorage.setItem(DEVICE_KEY, JSON.stringify(GUEST_AREA));

    open();

    await waitFor(() => expect(screen.getByTestId('area')).toHaveTextContent('Alipur'));

    // No account, so there is nothing to ask and nothing to write to.
    expect(readSavedLocation).not.toHaveBeenCalled();
    expect(writeSavedLocation).not.toHaveBeenCalled();

    // A guest's own area survives: it is kept on the phone, and said so.
    expect(JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}').label).toBe('Alipur');
    expect(screen.getByTestId('on-device')).toHaveTextContent('true');
  });
});
