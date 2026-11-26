/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { isNodeError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import type { QoderAccountRecord, QoderAccountSummary } from './account.js';
import { refreshQoderAccount } from './auth-service.js';
import {
  QoderCredentialStore,
  getQoderCredentialsPath,
} from './credential-store.js';
import { QoderOAuthError } from './oauth-client.js';
import type { QoderAccountRegion } from './regions.js';

const LOCK_FILENAME = 'qoder_oauth_creds.lock';
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const FILE_CHECK_INTERVAL_MS = 5_000;
const LOCK_TIMEOUT_MS = 35_000;
const STALE_LOCK_MS = 120_000;
const LOCK_RETRY_MS = 100;

interface CachedAccount {
  account?: QoderAccountRecord;
  fileModTime: number;
  lastCheck: number;
}

export interface QoderTokenManagerOptions {
  readonly credentialStore?: QoderCredentialStore;
  readonly credentialFilePath?: string;
  readonly lockFilePath?: string;
  readonly now?: () => number;
  readonly checkIntervalMs?: number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  /** Refresh strategy; defaults to the OAuth refresh endpoint. */
  readonly refreshAccount?: (
    region: QoderAccountRegion,
    options: {
      credentialStore: QoderCredentialStore;
      now: () => number;
    },
  ) => Promise<QoderAccountSummary>;
}

/**
 * Cross-process token source for Qoder inference. Coordinates access to the
 * credential file and the refresh endpoint: a file lock serializes refresh
 * across processes, an mtime cache observes other processes' rotations, and a
 * single in-flight refresh is shared inside one process.
 */
export class QoderTokenManager {
  private static readonly instances = new Map<string, QoderTokenManager>();

  private readonly region: QoderAccountRegion;
  private readonly options: QoderTokenManagerOptions;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  private cached: CachedAccount = {
    account: undefined,
    fileModTime: 0,
    lastCheck: 0,
  };
  private inflight?: Promise<string>;

  private constructor(
    region: QoderAccountRegion,
    options: QoderTokenManagerOptions = {},
  ) {
    this.region = region;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.checkIntervalMs = options.checkIntervalMs ?? FILE_CHECK_INTERVAL_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  }

  static forRegion(
    region: QoderAccountRegion,
    options?: QoderTokenManagerOptions,
  ): QoderTokenManager {
    const store = options?.credentialStore;
    const filePath = store?.path ?? options?.credentialFilePath;
    const key = `${region}:${filePath ?? 'default'}`;
    const existing = this.instances.get(key);
    if (existing) {
      return existing;
    }
    const manager = new QoderTokenManager(region, options);
    this.instances.set(key, manager);
    return manager;
  }

  /** @internal */
  static resetForTests(): void {
    this.instances.clear();
  }

  /** Drop the in-memory account cache so the next read re-stats the file. */
  invalidate(): void {
    this.cached = { account: undefined, fileModTime: 0, lastCheck: 0 };
  }

  async getAccessToken(options?: {
    forceRefresh?: boolean;
    credentialStore?: QoderCredentialStore;
  }): Promise<string> {
    const forceRefresh = options?.forceRefresh ?? false;
    const store = this.resolveStore(options?.credentialStore);
    if (!forceRefresh) {
      const account = await this.readAccountCached(store);
      if (account && this.isUsable(account)) {
        return account.accessToken;
      }
    }

    if (this.inflight) {
      return this.inflight;
    }

    const pending = this.resolveToken(forceRefresh, store).finally(() => {
      if (this.inflight === pending) {
        this.inflight = undefined;
      }
    });
    this.inflight = pending;
    return pending;
  }

  forceRefresh(store?: QoderCredentialStore): Promise<string> {
    return this.getAccessToken({ forceRefresh: true, credentialStore: store });
  }

  private async resolveToken(
    forceRefresh: boolean,
    store: QoderCredentialStore,
  ): Promise<string> {
    const release = await this.acquireLock(store);
    try {
      const account = await this.readAccount(store, true);
      if (!forceRefresh && account && this.isUsable(account)) {
        return account.accessToken;
      }
      if (!account?.refreshToken) {
        throw authRequiredError(this.region);
      }
      if (
        account.refreshTokenExpiresAt !== undefined &&
        account.refreshTokenExpiresAt <= this.now()
      ) {
        throw authRequiredError(this.region);
      }

      runLogger.debug(
        `[qoder-token] refreshing access token region=${this.region}`,
      );
      const refresh = this.options.refreshAccount ?? refreshQoderAccount;
      await refresh(this.region, {
        credentialStore: store,
        now: this.now,
      });

      const refreshed = await this.readAccount(store, true);
      if (!refreshed?.accessToken) {
        throw authRequiredError(this.region);
      }
      return refreshed.accessToken;
    } finally {
      await release();
    }
  }

  private isUsable(account: QoderAccountRecord): boolean {
    return (
      Boolean(account.accessToken) &&
      account.expiresAt > this.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS &&
      (account.refreshTokenExpiresAt === undefined ||
        account.refreshTokenExpiresAt > this.now())
    );
  }

  private async readAccountCached(
    store: QoderCredentialStore,
  ): Promise<QoderAccountRecord | undefined> {
    const now = this.now();
    if (
      this.cached.account &&
      now - this.cached.lastCheck < this.checkIntervalMs
    ) {
      return this.cached.account;
    }

    const fileModTime = await this.statModTime(store);
    if (fileModTime === 0) {
      this.cached = { account: undefined, fileModTime: 0, lastCheck: now };
      return undefined;
    }
    if (fileModTime === this.cached.fileModTime && this.cached.account) {
      this.cached.lastCheck = now;
      return this.cached.account;
    }
    return this.readAccount(store, false);
  }

  private async readAccount(
    store: QoderCredentialStore,
    force: boolean,
  ): Promise<QoderAccountRecord | undefined> {
    const now = this.now();
    if (
      !force &&
      this.cached.account &&
      now - this.cached.lastCheck < this.checkIntervalMs
    ) {
      return this.cached.account;
    }

    let account: QoderAccountRecord | undefined;
    try {
      account = await store.getAccount(this.region);
    } catch (error) {
      runLogger.warn('[qoder-token] failed to read credentials:', error);
      this.cached = { account: undefined, fileModTime: 0, lastCheck: now };
      return undefined;
    }

    this.cached = {
      account,
      fileModTime: await this.statModTime(store),
      lastCheck: now,
    };
    return account;
  }

  private async statModTime(store: QoderCredentialStore): Promise<number> {
    try {
      return (await fs.stat(store.path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async acquireLock(
    store: QoderCredentialStore,
  ): Promise<() => Promise<void>> {
    const lockPath = this.lockPath(store);
    const owner = randomUUID();
    const deadline = this.now() + this.lockTimeoutMs;

    for (;;) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(owner, 'utf8');
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            const content = await fs.readFile(lockPath, 'utf8');
            if (content === owner) {
              await fs.unlink(lockPath);
            }
          } catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT') {
              runLogger.warn('[qoder-token] failed to release lock:', error);
            }
          }
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
        if (await this.isStaleLock(lockPath)) {
          try {
            await fs.unlink(lockPath);
          } catch (unlinkError) {
            if (
              !isNodeError(unlinkError) ||
              unlinkError.code !== 'ENOENT'
            ) {
              throw unlinkError;
            }
          }
          continue;
        }
        if (this.now() >= deadline) {
          throw new QoderOAuthError(
            'http',
            'Timed out waiting for the Qoder credential lock.',
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      return this.now() - stat.mtimeMs > this.staleLockMs;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return true;
      }
      return false;
    }
  }

  private resolveStore(
    override?: QoderCredentialStore,
  ): QoderCredentialStore {
    if (override) return override;
    if (this.options.credentialStore) return this.options.credentialStore;
    return new QoderCredentialStore({
      ...(this.options.credentialFilePath
        ? { filePath: this.options.credentialFilePath }
        : {}),
      now: this.now,
    });
  }

  private lockPath(store: QoderCredentialStore): string {
    if (this.options.lockFilePath) {
      return this.options.lockFilePath;
    }
    const credentialsPath = store.path || getQoderCredentialsPath();
    return path.join(path.dirname(credentialsPath), LOCK_FILENAME);
  }
}

function authRequiredError(region: QoderAccountRegion): QoderOAuthError {
  return new QoderOAuthError(
    'invalid_grant',
    `Qoder sign-in is required for ${region}.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
