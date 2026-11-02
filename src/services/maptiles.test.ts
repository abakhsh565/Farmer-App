import { describe, expect, it } from 'vitest';

import { DEFAULT_TILE_SOURCE, TILE_SOURCES, tileSource } from './maptiles';

describe('map tile sources', () => {
  it('defaults to the keyless provider that needs no account', () => {
    // Every paid provider needs an API key, and no key is configured here, so
    // a paid default would ship a blank map.
    expect(DEFAULT_TILE_SOURCE).toBe('openfreemap-positron');
  });

  it('resolves the default when nothing is asked for', () => {
    expect(tileSource().id).toBe(DEFAULT_TILE_SOURCE);
    expect(tileSource(null).id).toBe(DEFAULT_TILE_SOURCE);
    expect(tileSource(undefined).id).toBe(DEFAULT_TILE_SOURCE);
  });

  it('falls back to a working map rather than throwing on a bad name', () => {
    // A mistyped configuration must not leave a farmer staring at a blank
    // screen with no way forward.
    expect(tileSource('mapbox-enterprise').id).toBe(DEFAULT_TILE_SOURCE);
  });

  it('gives every source a usable URL and an attribution line', () => {
    for (const source of Object.values(TILE_SOURCES)) {
      expect(source.attribution.length).toBeGreaterThan(0);

      if (source.kind === 'vector') {
        expect(source.styleUrl).toMatch(/^https:\/\//);
        expect(source.tileUrl).toBeUndefined();
      } else {
        expect(source.tileUrl).toContain('{z}');
        expect(source.styleUrl).toBeUndefined();
      }

      expect(source.maxZoom).toBeGreaterThan(0);
    }
  });

  it('keeps OSM standard tiles out of the default path', () => {
    // Their usage policy asks real applications to use a commercial provider,
    // so it is available for development but never chosen by accident.
    expect(tileSource().id).not.toBe('osm-standard');
  });
});