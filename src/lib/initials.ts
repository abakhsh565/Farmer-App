/**
 * Initials for an avatar, derived from the name that is actually on screen.
 *
 * This lives in one place on purpose. Hardcoded Latin initials look right in
 * English and wrong the moment the interface is Urdu, so a component that keeps
 * its own letters drifts from every other avatar in the product. Taking the
 * first letter of the first two words works for both scripts: "Ali Traders" →
 * "AT", "علی ٹریڈرز" → "عٹ".
 */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('');
}
