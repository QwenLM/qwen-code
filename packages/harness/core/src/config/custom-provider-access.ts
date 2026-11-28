/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type CustomProviderAccessMode = 'local' | 'sdk' | 'disabled';

export type CustomProviderAccessState =
  | 'uninitialized'
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'unavailable';

type AccessFailure = 'denied' | 'unavailable' | 'identity_changed' | 'timeout';

export const DEFAULT_ACCESS_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Product access check: true allows, false denies, null is unavailable. */
export type CustomProviderAccessCheck = () => Promise<boolean | null>;

export class CustomProviderAccessError extends Error {
  readonly status: number;

  constructor(readonly reason: AccessFailure) {
    const messages: Record<AccessFailure, string> = {
      denied: 'Custom Provider access is not allowed for the current account.',
      unavailable: 'Could not verify Custom Provider access. Please retry.',
      identity_changed:
        'The account changed while preparing the model request.',
      timeout: 'Timed out waiting for Custom Provider access.',
    };
    super(messages[reason]);
    this.name = 'CustomProviderAccessError';
    this.status = reason === 'unavailable' || reason === 'timeout' ? 503 : 403;
  }
}

/** Coordinates account access; the API service continues to own its network cache. */
export class CustomProviderAccess {
  private currentState: CustomProviderAccessState = 'uninitialized';
  private identity: string;
  private revision = 0;
  private pending: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      getIdentity: () => string;
      isEnabled: () => boolean;
      check: () => Promise<boolean | null>;
      onChange?: (state: CustomProviderAccessState) => void;
    },
  ) {
    this.identity = options.getIdentity();
  }

  get state(): CustomProviderAccessState {
    if (!this.options.isEnabled()) return 'denied';
    return this.identity === this.options.getIdentity()
      ? this.currentState
      : 'uninitialized';
  }

  /** Invalidates publication and wakes waiters without cancelling the API's shared request. */
  invalidate(): void {
    this.revision++;
    this.identity = this.options.getIdentity();
    this.pending = undefined;
    this.setState(this.options.isEnabled() ? 'uninitialized' : 'denied');
  }

  refresh(): Promise<void> {
    if (this.identity !== this.options.getIdentity()) this.invalidate();
    if (!this.options.isEnabled()) {
      this.invalidate();
      return Promise.resolve();
    }
    if (this.pending) return this.pending;
    const revision = ++this.revision;
    const identity = this.identity;
    this.setState('checking');
    const pending = Promise.resolve()
      .then(() => this.options.check())
      .then(
        (allowed) => this.publishCheck(revision, identity, allowed),
        () => this.publishCheck(revision, identity, null),
      )
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  async waitUntilReady(options: {
    identity: string;
    signal?: AbortSignal;
    /** Finite positive wait budget in milliseconds; defaults to 30 seconds. */
    timeoutMs?: number;
  }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ACCESS_TIMEOUT_MS;
    options.signal?.throwIfAborted();
    this.assertIdentity(options.identity);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CustomProviderAccessError('timeout');
    }
    const deadline = Date.now() + timeoutMs;
    if (this.state === 'uninitialized' || this.state === 'unavailable') {
      void this.refresh();
    }
    for (;;) {
      options.signal?.throwIfAborted();
      this.assertIdentity(options.identity);
      switch (this.state) {
        case 'allowed':
          return;
        case 'denied':
          throw new CustomProviderAccessError('denied');
        case 'unavailable':
          throw new CustomProviderAccessError('unavailable');
        case 'uninitialized':
          void this.refresh();
          break;
        case 'checking':
          await this.waitForChange(options.signal, deadline);
          break;
        default:
          throw new Error('Unexpected Custom Provider access state');
      }
    }
  }

  assertReady(identity: string): void {
    this.assertIdentity(identity);
    if (this.state !== 'allowed') {
      throw new CustomProviderAccessError(
        this.state === 'denied' ? 'denied' : 'unavailable',
      );
    }
  }

  private assertIdentity(identity: string): void {
    if (identity !== this.options.getIdentity()) {
      throw new CustomProviderAccessError('identity_changed');
    }
  }

  private publishCheck(
    revision: number,
    identity: string,
    allowed: boolean | null,
  ): void {
    if (revision !== this.revision) return;
    if (identity !== this.options.getIdentity()) {
      // SDK-owned auth can change without a local auth notification. Wake
      // old-owner waiters as soon as its response completes, but never publish it.
      this.invalidate();
      return;
    }
    this.setState(
      !this.options.isEnabled()
        ? 'denied'
        : allowed === null
          ? 'unavailable'
          : allowed
            ? 'allowed'
            : 'denied',
    );
  }

  private setState(state: CustomProviderAccessState): void {
    this.currentState = state;
    this.options.onChange?.(state);
    for (const listener of this.listeners) listener();
  }

  private waitForChange(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return Promise.reject(new CustomProviderAccessError('timeout'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        signal?.removeEventListener('abort', aborted);
      };
      const changed = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          if (remaining > MAX_TIMER_DELAY_MS) {
            // Avoid timer overflow; the waiter resumes against the same deadline.
            resolve();
          } else {
            reject(new CustomProviderAccessError('timeout'));
          }
        },
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
      this.listeners.add(changed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
}
