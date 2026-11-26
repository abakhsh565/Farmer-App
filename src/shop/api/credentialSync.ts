/**
 * The shop connection, kept on the farmer's account.
 *
 * A shop credential used to live only in this device's `localStorage`, which made
 * a connection a fact about *a phone* rather than about a farmer: connect once in
 * the app, open the site on a laptop, and the shops were gone — the same counter
 * that answered a minute ago looked like it had never been joined.
 *
 * It is stored in `client_documents`, the per-account store this app already uses
 * for everything else a farmer owns. Three properties matter here:
 *
 *   · the row is keyed by the signed-in account and guarded by row level
 *     security, so a device can only ever read or write its own owner's row;
 *   · it travels with the sign-in, so the phone, the browser and a replaced phone
 *     all see the same shops with no code typed again;
 *   · a failure is quiet. A chat that works on this device must not stop working
 *     because a backup did not save — the next successful read writes it again.
 *
 * The token is still written to `localStorage` as well, because the credential is
 * what the chat reads on launch, before any network call: a farmer opening the app
 * in a dead zone should still see his conversation.
 */

import { serviceConfig } from '@/services/config';
import { getSupabaseClient } from '@/services/supabaseClient';
import {
  hydrateShopCredential,
  serialiseShopCredential,
  type ShopCredential,
} from './credential';

/** The collection name, which is also the document's identity on the account. */
export const SHOP_CREDENTIAL_COLLECTION = 'shop-credential';

type DocumentRow = { document?: unknown };

function rowOf(data: unknown): DocumentRow | null {
  const row = (Array.isArray(data) ? data[0] : data) as DocumentRow | null;
  return row && typeof row === 'object' ? row : null;
}

/**
 * The credential this account connected with, or `null`.
 *
 * The document is hydrated through the same validator the device copy uses, so a
 * half-written row — a token without a shop id — is rejected here exactly as it
 * would be locally rather than opening a conversation to nothing.
 */
export async function loadAccountCredential(ownerId: string | null | undefined): Promise<ShopCredential | null> {
  if (!ownerId) return null;
  if (!serviceConfig.supabase.configured) return null;

  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return null;

  try {
    const { data, error } = await client.rpc('client_document_get', {
      p_owner_id: ownerId,
      p_collection: SHOP_CREDENTIAL_COLLECTION,
    });
    if (error) return null;

    const document = rowOf(data)?.document;
    if (!document) return null;

    return hydrateShopCredential(JSON.stringify(document));
  } catch {
    return null;
  }
}

/**
 * Write the connection to the account, so the next device does not need a code.
 *
 * Returns whether it was stored. Callers ignore `false` on purpose: a backup that
 * did not happen is not a reason to refuse a chat that the shop already accepted.
 */
export async function saveAccountCredential(
  ownerId: string | null | undefined,
  credential: ShopCredential,
): Promise<boolean> {
  if (!ownerId) return false;
  if (!serviceConfig.supabase.configured) return false;

  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return false;

  try {
    const document = JSON.parse(serialiseShopCredential(credential)) as Record<string, unknown>;
    const { error } = await client.rpc('client_document_put', {
      p_owner_id: ownerId,
      p_collection: SHOP_CREDENTIAL_COLLECTION,
      p_document: document,
      // The credential is a single value, so last write wins is the right rule:
      // the newest successful read of the shop is the truth about the shop.
      p_expected_revision: null,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Remove the connection from the account.
 *
 * Called when the shop itself says the credential is gone, and when the farmer
 * disconnects: a row left behind would connect the next device to a shop that has
 * already ended the relationship.
 */
export async function clearAccountCredential(ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return;
  if (!serviceConfig.supabase.configured) return;

  const client = await getSupabaseClient(serviceConfig.supabase);
  if (!client) return;

  try {
    await client.rpc('client_document_delete', {
      p_owner_id: ownerId,
      p_collection: SHOP_CREDENTIAL_COLLECTION,
    });
  } catch {
    // Nothing to do: the device copy is already gone, which is what the farmer sees.
  }
}
