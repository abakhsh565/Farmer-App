/**
 * Map tiles.
 *
 * One file decides which basemap the app draws. That is the whole point: every
 * tile provider — free or paid — has terms, and terms change. When the free one
 * stops being appropriate, this is the only file that changes.
 *
 * WHY OPENFREEMAP IS THE DEFAULT.
 *
 * It needs no API key, no account and no billing card, and it publishes no
 * message quota. Verified reachable on 4 October 2026 with three styles.
 *
 * `positron` is the default rather than `liberty` because its background is a
 * near-white with dark, high-contrast labels: a farmer reading this outdoors,
 * often in direct sun on a cheap phone with a scratched screen, gets a map they
 * can actually read. Cartography that looks good on a desk can be unusable in a
 * field.
 *
 * `carto-light` is the fallback for a weak connection: raster tiles are simpler
 * for a low-end device to fetch than vector geometry plus glyphs.
 *
 * OpenStreetMap's own tiles are deliberately the last entry, not the first.
 * They are free, but their usage policy asks busy and commercial applications
 * to use a commercial provider instead — so they belong in development, where
 * their familiarity helps, and out of a build aimed at real farmers.
 */

export type TileSourceId =
  | 'openfreemap-positron'
  | 'openfreemap-liberty'
  | 'carto-light'
  | 'osm-standard';

export type TileSource = {
  id: TileSourceId;
  /** Shown in the map's attribution line, as each provider requires. */
  attribution: string;
  /** Vector tiles are a style URL; raster tiles are a `{z}/{x}/{y}` template. */
  kind: 'vector' | 'raster';
  /** A MapLibre style URL, for a vector source. */
  styleUrl?: string;
  /** A raster tile template, for a raster source. */
  tileUrl?: string;
  maxZoom: number;
};

export const TILE_SOURCES: Record<TileSourceId, TileSource> = {
  'openfreemap-positron': {
    id: 'openfreemap-positron',
    kind: 'vector',
    styleUrl: 'https://tiles.openfreemap.org/styles/positron',
    attribution: '© OpenFreeMap © OpenStreetMap contributors',
    maxZoom: 18,
  },
  'openfreemap-liberty': {
    id: 'openfreemap-liberty',
    kind: 'vector',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '© OpenFreeMap © OpenStreetMap contributors',
    maxZoom: 18,
  },
  'carto-light': {
    id: 'carto-light',
    kind: 'raster',
    tileUrl: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  },
  'osm-standard': {
    id: 'osm-standard',
    kind: 'raster',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
};

/** What the app uses unless told otherwise. */
export const DEFAULT_TILE_SOURCE: TileSourceId = 'openfreemap-positron';

/**
 * The source to draw.
 *
 * An unknown name falls back to the default rather than throwing: a typo in
 * configuration should produce a working map, not a blank screen a farmer cannot
 * get past.
 */
export function tileSource(id?: string | null): TileSource {
  if (id && id in TILE_SOURCES) return TILE_SOURCES[id as TileSourceId];
  return TILE_SOURCES[DEFAULT_TILE_SOURCE];
}