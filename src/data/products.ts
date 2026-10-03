import type { MessageKey } from '@/i18n/catalog';

/**
 * Canonical products — the identity a recommendation points at.
 *
 * This file is the *knowledge* half of the chain the PRD requires:
 *
 *   crop problem → approved treatment → **canonical product** → live dealer
 *   listings → location/availability → farmer result
 *
 * The knowledge half is what the app knows and can cite: the product's name, the
 * problem it is approved for, and the registration number that is the evidence.
 * The inventory half — who has it, at what price, confirmed when — is not here
 * any more. It lives in the dealer projection and is read through the dealer
 * service (`stockists`), because a listing written next to a treatment is a
 * listing that quietly becomes the reason the treatment was chosen, and the two
 * copies of a price drift apart on two different screens.
 *
 * `id` is the product's stable slug: the same identifier the dealer system files
 * its products under, so the knowledge layer and the inventory layer meet on a
 * value neither of them owns.
 */

export type CanonicalProduct = {
  /** Stable slug, shared with the dealer projection. */
  id: string;
  nameKey: MessageKey;
  /** Where the claim that this is an approved treatment comes from. */
  sourceKey: MessageKey;
  /** Registration number as published in the DPP registered-pesticide list. */
  registration: string;
  /** The problem this product is approved for, by canonical name. */
  problemKey: MessageKey;
};

export const ROUNDUP: CanonicalProduct = {
  id: 'roundup',
  nameKey: 'product.roundup',
  sourceKey: 'source.dpp',
  registration: 'DPP-PK-2019-0431',
  problemKey: 'insight.pest.title',
};
