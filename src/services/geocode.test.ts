import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPlaceCache, searchPlaces } from './geocode';

/**
 * Place search tests.
 *
 * The cases that matter are the ones a farmer would hit with a thumb on a
 * slow connection: a half-typed word, a name that exists in two countries, and
 * a request that fails. None of those may throw.
 */
describe('place search', () => {
  beforeEach(() => {
    clearPlaceCache();
  });

  function fakeFetch(rows: unknown, ok = true) {
    return vi.fn(async () => ({
      ok,
      json: async () => rows,
    })) as unknown as typeof fetch;
  }

  it('does not search until the word is worth searching', async () => {
    const fetchImpl = fakeFetch([]);

    // Two letters matches most of the country and wastes a request.
    await expect(searchPlaces('Mu', { fetchImpl })).resolves.toEqual([]);
    await expect(searchPlaces('  M  ', { fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('scopes the search to Pakistan', async () => {
    const fetchImpl = fakeFetch([]);
    await searchPlaces('Muzaffargarh', { fetchImpl });

    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    expect(url).toContain('countrycodes=pk');
    expect(url).toContain('Muzaffargarh');
  });

  it('returns coordinates in the shape the app stores', async () => {
    const fetchImpl = fakeFetch([
      { place_id: 1, lat: '30.3705', lon: '71.4986', display_name: 'Muzaffargarh, Punjab, Pakistan' },
      { place_id: 2, lat: '32.4430', lon: '74.1150', display_name: 'Wazirabad, Punjab, Pakistan' },
    ]);

    const results = await searchPlaces('Muzaffargarh', { fetchImpl });

    expect(results).toEqual([
      { id: '1', label: 'Muzaffargarh, Punjab, Pakistan', lat: 30.3705, lon: 71.4986 },
      { id: '2', label: 'Wazirabad, Punjab, Pakistan', lat: 32.443, lon: 74.115 },
    ]);
  });

  it('asks in the language the screen needs, Urdu first by default', async () => {
    const fetchImpl = fakeFetch([]);
    await searchPlaces('Muzaffargarh', { fetchImpl });

    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    // Unasked, Nominatim returns "مظفر گڑھ" — right, and useless on an
    // English dealer screen.
    expect(url).toContain('accept-language=ur%2Cen');
  });

  it('lets a caller ask for English instead', async () => {
    const fetchImpl = fakeFetch([]);
    await searchPlaces('Muzaffargarh', { fetchImpl, language: 'en' });

    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    expect(url).toContain('accept-language=en');
  });

  it('drops rows the app cannot use instead of showing a broken result', async () => {
    const fetchImpl = fakeFetch([
      { place_id: 1, lat: 'not-a-number', lon: '71.4986', display_name: 'Broken' },
      { place_id: 2, lat: '30.37', lon: '71.49', display_name: '' },
      { place_id: 3, lat: '30.37', lon: '71.49', display_name: 'Good' },
    ]);

    const results = await searchPlaces('Muzaffargarh', { fetchImpl });

    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('Good');
  });

  it('asks once for the same term, because Nominatim allows about one a second', async () => {
    const fetchImpl = fakeFetch([{ place_id: 1, lat: '30.37', lon: '71.49', display_name: 'Muzaffargarh' }]);

    await searchPlaces('Muzaffargarh', { fetchImpl });
    await searchPlaces('Muzaffargarh', { fetchImpl });
    await searchPlaces('  muzaffargarh ', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('survives a failing network without breaking the screen', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(searchPlaces('Muzaffargarh', { fetchImpl: failing })).resolves.toEqual([]);
  });

  it('treats a server error as no results', async () => {
    const fetchImpl = fakeFetch([], false);

    await expect(searchPlaces('Muzaffargarh', { fetchImpl })).resolves.toEqual([]);
  });
});