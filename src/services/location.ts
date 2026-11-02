/**
 * The farmer's saved location, read and written through the database.
 *
 * There is exactly one entry point for each direction, and the write is a single
 * named function (`farmer_location_save`) rather than an update to a profile row.
 * That shape is the rule: a temporary search may pass coordinates to a dealer
 * query, but the only thing in the system that can move the saved location is an
 * explicit save, and it validates on the server so a client that skips the picker
 * reaches the same checks.
 *
 * Reads are free and answer "nothing saved" for a guest. Writes are not: the
 * function is granted to `authenticated` only, and raises if there is no party, so
 * a guest who taps Save is stopped by the database rather than by a hidden button.
 *
 * `default_location_source` is a closed set on the server — how the location was
 * established is part of the record. The picker's own vocabulary ('gps', 'search',
 * 'map') is translated here, in one place, so the two cannot drift apart.
 */

import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

/** The server's closed set. Kept in step with the check constraint on the column. */
export type LocationSource = 'profile_entry' | 'device_permission' | 'dealer_record';

/** How the picker got the point. */
export type PickedSource = 'gps' | 'search' | 'map';

export type SavedLocation = {
  label: string;
  lat: number;
  lon: number;
  source: LocationSource;
  /** When the farmer chose it, or null if the row predates the column being set. */
  setAt: number | null;
  /** The search radius that travels with the location, 1–100 km. */
  radiusKm: number;
};

export type LocationWrite = {
  label: string;
  lat: number;
  lon: number;
  source: LocationSource;
  radiusKm?: number;
};

/** The picker's vocabulary, translated once. */
export function serverSourceOf(picked: PickedSource): LocationSource {
  if (picked === 'gps') return 'device_permission';
  return 'profile_entry';
}

type LocationRow = {
  label: string | null;
  lat: number | null;
  lon: number | null;
  source: string | null;
  set_at: string | null;
  radius_km: number | null;
};

function rowToLocation(row: LocationRow): SavedLocation | null {
  // A row with no coordinates is the honest state of a farmer who has not chosen
  // a location yet, and it is not a saved location — reporting it as one would
  // put "not set" into places that read a place name.
  if (row.lat === null || row.lon === null || !row.label) return null;

  const source: LocationSource =
    row.source === 'device_permission' || row.source === 'dealer_record'
      ? row.source
      : 'profile_entry';

  return {
    label: row.label,
    lat: Number(row.lat),
    lon: Number(row.lon),
    source,
    setAt: row.set_at ? Date.parse(row.set_at) : null,
    radiusKm: typeof row.radius_km === 'number' ? row.radius_km : 10,
  };
}

/** The signed-in farmer's saved location, or null — including for a guest. */
export async function readSavedLocation(): Promise<SavedLocation | null> {
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return null;

  const { data, error } = await client.rpc('farmer_location_get');
  if (error) return null;

  const rows = (data as LocationRow[] | null) ?? [];
  const row = rows[0];
  if (!row) return null;

  return rowToLocation(row);
}

/**
 * Save, explicitly. Throws with the server's own message when it refuses, so the
 * screen can show the real reason (not signed in, coordinates out of range, name
 * missing) instead of a generic failure.
 */
export async function writeSavedLocation(input: LocationWrite): Promise<SavedLocation> {
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) throw new Error('The backend is not configured.');

  const { data, error } = await client.rpc('farmer_location_save', {
    p_label: input.label,
    p_lat: input.lat,
    p_lon: input.lon,
    p_source: input.source,
    p_radius_km: input.radiusKm ?? null,
  });

  if (error) throw new Error(error.message);

  const rows = (data as LocationRow[] | null) ?? [];
  const row = rows[0];
  const saved = row ? rowToLocation(row) : null;
  if (!saved) throw new Error('The saved location was not returned by the server.');

  return saved;
}

/** Forget the saved location. The next search falls back to the farmer's area. */
export async function clearSavedLocation(): Promise<void> {
  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return;
  const { error } = await client.rpc('farmer_location_clear');
  if (error) throw new Error(error.message);
}
