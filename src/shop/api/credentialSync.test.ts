import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOP_CREDENTIAL_COLLECTION,
  clearAccountCredential,
  loadAccountCredential,
  saveAccountCredential,
} from './credentialSync';

/**
 * The account copy of a shop connection.
 *
 * What has to be true is the contract with the backend: the document lives in the
 * farmer's own `shop-credential` collection, it is written as the same validated
 * shape the device stores, and the reader refuses half a credential instead of
 * opening a conversation to nothing.
 */

type Call = { fn: string; args: Record<string, unknown> };

const calls: Call[] = [];
let reply: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock('@/services/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/config')>();
  return {
    ...actual,
    serviceConfig: {
      ...actual.serviceConfig,
      supabase: { url: 'http://example.test', anonKey: 'anon', configured: true },
    },
  };
});

vi.mock('@/services/supabaseClient', () => ({
  getSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return reply;
    },
  }),
}));

const credential = {
  token: 'a'.repeat(64),
  farmerId: 'farmer-1',
  shopId: 'shop-1',
  shopName: 'QA Farmer Bridge',
  joinedAt: 1_760_000_000_000,
};

beforeEach(() => {
  calls.length = 0;
  reply = { data: null, error: null };
});

describe('saveAccountCredential', () => {
  it('writes the connection into the farmer-only collection', async () => {
    expect(await saveAccountCredential('owner-1', credential)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('client_document_put');
    expect(calls[0]?.args.p_owner_id).toBe('owner-1');
    expect(calls[0]?.args.p_collection).toBe(SHOP_CREDENTIAL_COLLECTION);
    expect(calls[0]?.args.p_expected_revision).toBeNull();
    expect(calls[0]?.args.p_document).toMatchObject({
      token: credential.token,
      shopId: 'shop-1',
      shopName: 'QA Farmer Bridge',
    });
  });

  it('does nothing, and does not fail the chat, without an account', async () => {
    expect(await saveAccountCredential(null, credential)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('loadAccountCredential', () => {
  it('adopts a stored connection so a new device needs no code', async () => {
    reply = {
      data: [{ document: { version: 1, ...credential } }],
      error: null,
    };

    const restored = await loadAccountCredential('owner-1');

    expect(restored?.token).toBe(credential.token);
    expect(restored?.shopId).toBe('shop-1');
    expect(restored?.shopName).toBe('QA Farmer Bridge');
    expect(calls[0]?.fn).toBe('client_document_get');
    expect(calls[0]?.args.p_collection).toBe(SHOP_CREDENTIAL_COLLECTION);
  });

  it('rejects half a credential rather than connecting to nothing', async () => {
    reply = {
      data: [{ document: { version: 1, token: 'a'.repeat(64), farmerId: 'farmer-1' } }],
      error: null,
    };

    expect(await loadAccountCredential('owner-1')).toBeNull();
  });

  it('answers null when the account has nothing stored', async () => {
    expect(await loadAccountCredential('owner-1')).toBeNull();
    expect(await loadAccountCredential(undefined)).toBeNull();
  });
});

describe('clearAccountCredential', () => {
  it('removes the account copy when the shop ends the connection', async () => {
    await clearAccountCredential('owner-1');

    expect(calls[0]?.fn).toBe('client_document_delete');
    expect(calls[0]?.args.p_collection).toBe(SHOP_CREDENTIAL_COLLECTION);
  });
});
