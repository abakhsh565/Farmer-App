import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The saved location's rules, tested where they are decided.
 *
 * The point of these cases is not the plumbing — it is that the service layer has
 * exactly one write path, that it reports the server's own refusal instead of
 * inventing one, and that a row with no coordinates is not treated as a place. The
 * last one matters most: a farmer who has never chosen a location has a profile row
 * with three NULLs in it, and calling that "Wazirabad" would put a made-up place
 * name in front of them.
 */

type RpcResult = { data: unknown; error: { message: string } | null };

const rpc = vi.fn<(fn: string, args?: Record<string, unknown>) => Promise<RpcResult>>();

vi.mock('./supabaseClient', async () => {
  const actual = await vi.importActual<typeof import('./supabaseClient')>('./supabaseClient');
  return {
    ...actual,
    getSupabaseClient: async () => ({ rpc, auth: {} }),
  };
});

const {
  clearSavedLocation,
  readSavedLocation,
  serverSourceOf,
  writeSavedLocation,
} = await import('./location');

beforeEach(() => {
  rpc.mockReset();
});

describe('the picker vocabulary on the server', () => {
  it('reports a GPS fix as a device permission and everything else as an entry', () => {
    // The column's closed set is about *how the location was established*, and the
    // picker's own three words are not it. Translating here keeps the two from
    // drifting: a value the check constraint rejects would fail the whole save.
    expect(serverSourceOf('gps')).toBe('device_permission');
    expect(serverSourceOf('search')).toBe('profile_entry');
    expect(serverSourceOf('map')).toBe('profile_entry');
  });
});

describe('reading the saved location', () => {
  it('answers "nothing saved" for a guest rather than raising', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(readSavedLocation()).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith('farmer_location_get');
  });

  it('does not call a profile row with no coordinates a location', async () => {
    rpc.mockResolvedValue({
      data: [{ label: null, lat: null, lon: null, source: null, set_at: null, radius_km: 10 }],
      error: null,
    });
    await expect(readSavedLocation()).resolves.toBeNull();
  });

  it('maps a saved row, keeping the radius the farmer chose', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          label: 'Wazirabad, G.T. Road',
          lat: 32.443,
          lon: 74.115,
          source: 'device_permission',
          set_at: '2026-10-04T03:27:46.189Z',
          radius_km: 25,
        },
      ],
      error: null,
    });

    const saved = await readSavedLocation();
    expect(saved).toEqual({
      label: 'Wazirabad, G.T. Road',
      lat: 32.443,
      lon: 74.115,
      source: 'device_permission',
      setAt: Date.parse('2026-10-04T03:27:46.189Z'),
      radiusKm: 25,
    });
  });

  it('falls back to the entry source for a value the picker does not use', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          label: 'Kot Ladha',
          lat: 32.55,
          lon: 74.05,
          source: 'dealer_record',
          set_at: null,
          radius_km: null,
        },
      ],
      error: null,
    });

    const saved = await readSavedLocation();
    expect(saved?.source).toBe('dealer_record');
    expect(saved?.setAt).toBeNull();
    // A missing radius is the schema's default, not zero kilometres.
    expect(saved?.radiusKm).toBe(10);
  });
});

describe('saving', () => {
  it('goes through the single save function with named arguments', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          label: 'Alipur',
          lat: 29.38,
          lon: 71.06,
          source: 'profile_entry',
          set_at: '2026-10-04T04:00:00Z',
          radius_km: 100,
        },
      ],
      error: null,
    });

    await writeSavedLocation({
      label: 'Alipur',
      lat: 29.38,
      lon: 71.06,
      source: 'profile_entry',
      radiusKm: 100,
    });

    expect(rpc).toHaveBeenCalledWith('farmer_location_save', {
      p_label: 'Alipur',
      p_lat: 29.38,
      p_lon: 71.06,
      p_source: 'profile_entry',
      p_radius_km: 100,
    });
  });

  it('surfaces the server refusal in the server words', async () => {
    // The database is the source of truth for the rules, so its sentence is the
    // one the farmer sees. Replacing it with a generic failure would hide the only
    // actionable part — that signing in is what is missing.
    rpc.mockResolvedValue({ data: null, error: { message: 'Sign in to save a location.' } });
    await expect(
      writeSavedLocation({ label: 'X', lat: 1, lon: 1, source: 'profile_entry' }),
    ).rejects.toThrow('Sign in to save a location.');
  });

  it('treats a save that returned no row as a failure', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(
      writeSavedLocation({ label: 'X', lat: 1, lon: 1, source: 'profile_entry' }),
    ).rejects.toThrow('not returned by the server');
  });
});

describe('clearing', () => {
  it('reports a refusal rather than pretending the location was forgotten', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Sign in to change your saved location.' } });
    await expect(clearSavedLocation()).rejects.toThrow('Sign in to change your saved location.');
  });
});
