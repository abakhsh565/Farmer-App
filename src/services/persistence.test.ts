import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServices } from '@/services/registry';
import { FlakyRepository } from '@/services/testing';
import {
  deviceOwnerId,
  isDeviceDocument,
  isPermanentWriteFailure,
  isServerOwned,
  ownerFor,
  publishRepository,
  resetPersistence,
  usePersistentDocument,
} from './persistence';

/**
 * The document layer's rules about *where a write can go*.
 *
 * Two of these are new, and both come from the same defect found against the live
 * project: the app was enqueueing writes that the database could only ever refuse.
 *
 *   · an owner id the server cannot address — a guest's `device-…`, or a
 *     `phone:…` account whose party id never arrived — used to be sent anyway,
 *     and PostgreSQL rejected it with `22P02`. The write could never succeed, and
 *     the queue retried it forever.
 *   · a *refusal* (a stale revision, a permission, a malformed key) and an
 *     *outage* (no signal) were treated identically, so a permanent failure kept
 *     a "waiting to sync" badge alive with nothing behind it.
 *
 * These tests are about restraint: the app must not make a claim it cannot keep.
 * The suite's other half — that a farmer's words survive an unreachable backend —
 * lives in `App.resilience.test.tsx`.
 */

const PARTY = 'b0da419c-7763-44e1-886a-5e711ce9c113';

type Doc = { n: number };

const spec = (ownerId: string) => ({
  /* Any collection the client actually owns. Note the database's own check
     constraint also permits `preferences`, which no store here uses yet. */
  collection: 'crops' as const,
  ownerId,
  seed: (): Doc => ({ n: 0 }),
  hydrate: (raw: string | null): Doc | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Doc;
      return typeof parsed?.n === 'number' ? parsed : null;
    } catch {
      return null;
    }
  },
  serialise: (value: Doc) => JSON.stringify(value),
});

beforeEach(() => {
  localStorage.clear();
  resetPersistence();
});

describe('which owners the backend can be asked about', () => {
  it('accepts a party id and nothing else', () => {
    expect(isServerOwned(PARTY)).toBe(true);
    expect(isServerOwned(PARTY.toUpperCase())).toBe(true);
    // A guest: nobody has signed in, so there is no party to write under.
    expect(isServerOwned(deviceOwnerId())).toBe(false);
    // Signed in, but the database never handed back a party id. This is the case
    // that used to crash into `invalid input syntax for type uuid`.
    expect(isServerOwned('phone:03001234567')).toBe(false);
    expect(isServerOwned('email:ali@example.com')).toBe(false);
    expect(isServerOwned('')).toBe(false);
    // Off by one character is still not a uuid.
    expect(isServerOwned(PARTY.slice(0, -1))).toBe(false);
  });

  it('still recognises the device\u2019s own document, and keys the guest to it', () => {
    expect(isDeviceDocument(deviceOwnerId())).toBe(true);
    expect(isDeviceDocument(PARTY)).toBe(false);
    expect(ownerFor(null)).toBe(deviceOwnerId());
    expect(ownerFor(PARTY)).toBe(PARTY);
    // The device's id is minted once and kept, or every launch would look like a
    // different person to the document layer.
    expect(deviceOwnerId()).toBe(deviceOwnerId());
  });
});

describe('telling a refusal apart from an outage', () => {
  it('treats anything the retrying cannot fix as permanent', () => {
    // A stale revision — the optimistic-concurrency token did its job.
    expect(
      isPermanentWriteFailure('Document chat for abc changed on another device.'),
    ).toBe(true);
    // The pre-0024 server, and any primary-key collision.
    expect(
      isPermanentWriteFailure(
        'duplicate key value violates unique constraint "client_documents_pkey"',
      ),
    ).toBe(true);
    // The database refusing the row, or the caller.
    expect(isPermanentWriteFailure('A client may only write its own documents.')).toBe(true);
    expect(isPermanentWriteFailure('new row violates row-level security policy')).toBe(true);
    expect(isPermanentWriteFailure('permission denied for table client_documents')).toBe(true);
    // The owner id is not a uuid, and no number of retries makes it one.
    expect(isPermanentWriteFailure('invalid input syntax for type uuid: "phone:0300"')).toBe(true);
  });

  it('treats a bad connection as something worth waiting for', () => {
    expect(isPermanentWriteFailure('Backend unreachable')).toBe(false);
    expect(isPermanentWriteFailure('Network request failed')).toBe(false);
    expect(isPermanentWriteFailure('Failed to fetch')).toBe(false);
    expect(isPermanentWriteFailure('Could not save chat: timeout')).toBe(false);
  });
});

describe('what the queue does with a refusal', () => {
  /** The local repository, behind a wall that never comes down. */
  const refusing = (message: string) => {
    const base = createServices();
    const repository = new FlakyRepository(base.repository, Number.POSITIVE_INFINITY, message);
    publishRepository(repository);
    return repository;
  };

  it('makes one attempt, reports why, and stops', async () => {
    const repository = refusing('Document preferences for abc changed on another device.');

    const { result } = renderHook(() => usePersistentDocument<Doc>(spec(PARTY)));

    // The document is loaded and its first state is offered to the backend.
    await waitFor(() => expect(repository.attempts).toBe(1));

    /* The backoff is 1s, 3s, 8s… — so if a retry were scheduled, this window
       would hold a second attempt. Nothing here will ever succeed, and the queue
       must not pretend otherwise. */
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(repository.attempts).toBe(1);
    expect(result.current.pending).toBe(1);
    expect(result.current.syncError).toContain('changed on another device');
  });

  it('keeps retrying when the backend is merely unreachable', async () => {
    const repository = refusing('Backend unreachable');

    renderHook(() => usePersistentDocument<Doc>(spec(PARTY)));

    await waitFor(() => expect(repository.attempts).toBe(1));

    /* Same window, opposite outcome: an outage is worth waiting for, so the first
       backoff fires and the queue tries again on its own. */
    await waitFor(() => expect(repository.attempts).toBeGreaterThanOrEqual(2), { timeout: 4000 });
  });
});
