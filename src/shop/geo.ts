/** A point on the earth, in the shape the location provider already uses. */
export type Point = { lat: number; lon: number };

const RAD = Math.PI / 180;
const EARTH_KM = 6371;

/**
 * How far apart two points are, in kilometres.
 *
 * The dealer platform returns each shop's coordinates, so "which shop is near me"
 * is answered from the shop's own position rather than from a product listing —
 * which is why a shop can be listed here while having nothing priced yet.
 */
export function distanceKmBetween(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
