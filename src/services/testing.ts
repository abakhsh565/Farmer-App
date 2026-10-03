/**
 * Test doubles for the service contracts.
 *
 * These exist because the user-visible states that matter most are the ones that
 * only appear when something is slow, broken or unreachable — a loading state, a
 * retry, a queued write draining after the network comes back. A suite that can
 * only simulate success cannot test any of them, and a suite that fakes them by
 * reaching into a component cannot prove the real code path ran.
 *
 * Each double wraps a working implementation rather than replacing it, so a test
 * that uses one is still exercising the genuine store, the genuine queue and the
 * genuine screen — only the transport is degraded.
 */

import type { Collection, Repository } from './types';

/** The repository, but slow. Exercises loading states without a fake timer. */
export class DelayedRepository implements Repository {
  readonly name: string;
  readonly isRemote = true;

  constructor(
    private readonly inner: Repository,
    private readonly delayMs: number,
  ) {
    this.name = `${inner.name} · delayed ${delayMs}ms`;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async read<T>(collection: Collection, ownerId: string): Promise<T | null> {
    await this.wait();
    return this.inner.read<T>(collection, ownerId);
  }

  async write<T>(collection: Collection, ownerId: string, value: T): Promise<void> {
    await this.wait();
    return this.inner.write(collection, ownerId, value);
  }

  async remove(collection: Collection, ownerId: string): Promise<void> {
    await this.wait();
    return this.inner.remove(collection, ownerId);
  }
}

/**
 * The repository, but the first `failures` writes are refused.
 *
 * This is the "network failure → retry → recovery" path. It counts attempts so a
 * test can assert that the app *retried* rather than that it merely survived.
 */
export class FlakyRepository implements Repository {
  readonly name: string;
  readonly isRemote = true;
  /** Every write attempt, including the ones that failed. */
  attempts = 0;

  constructor(
    private readonly inner: Repository,
    private failures: number,
    private readonly message = 'Network request failed',
  ) {
    this.name = `${inner.name} · flaky(${failures})`;
  }

  /** Stop refusing, so the test can prove the queue drains afterwards. */
  recover(): void {
    this.failures = 0;
  }

  async read<T>(collection: Collection, ownerId: string): Promise<T | null> {
    return this.inner.read<T>(collection, ownerId);
  }

  async write<T>(collection: Collection, ownerId: string, value: T): Promise<void> {
    this.attempts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(this.message);
    }
    return this.inner.write(collection, ownerId, value);
  }

  async remove(collection: Collection, ownerId: string): Promise<void> {
    return this.inner.remove(collection, ownerId);
  }
}

/** A backend that is never reachable. The device must keep working regardless. */
export class UnreachableRepository implements Repository {
  readonly name = 'Unreachable backend';
  readonly isRemote = true;

  async read<T>(): Promise<T | null> {
    throw new Error('Backend unreachable');
  }

  async write(): Promise<void> {
    throw new Error('Backend unreachable');
  }

  async remove(): Promise<void> {
    throw new Error('Backend unreachable');
  }
}
