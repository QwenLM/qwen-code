/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { lock } from 'proper-lockfile';
import { z } from 'zod';

import { delay } from '../../utils/delay.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  getQwenOAuthConfig,
  getQwenSubscriptionCredentialsPath,
  QWEN_SUBSCRIPTION_BASE_URL,
} from './oauth-config.js';
import {
  QwenSubscriptionOAuthClient,
  QwenSubscriptionOAuthError,
  toSubscriptionOAuthError,
  type QwenSubscriptionDeviceAuthorization,
  type QwenSubscriptionTokens,
  type QwenSubscriptionUserInfo,
} from './oauth-client.js';

const credentialSchema = z.object({
  revision: z.string().min(1),
  signInAttempt: z.string().min(1).optional(),
  baseUrl: z.string(),
  clientId: z.string(),
  models: z.array(z.string().min(1)).optional(),
  tokens: z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      token_type: z.literal('Bearer'),
      scope: z.string(),
      expires_in: z.number().positive().finite(),
      expiresAt: z.number().finite(),
    })
    .optional(),
});
type Credentials = z.infer<typeof credentialSchema>;

const CREDENTIAL_FILE_MODE = 0o600;
const CREDENTIAL_DIR_MODE = 0o700;
const REFRESH_LEEWAY_MS = 30_000;
const MODELS_TIMEOUT_MS = 5_000;
const MODELS_MAX_BYTES = 1024 * 1024;
const LOCK_RETRIES = 350;
const LOCK_RETRY_DELAY_MS = 100;
export const QWEN_SUBSCRIPTION_SIGNED_OUT_HINT =
  'Your login credentials are no longer valid. Run /auth to sign in again.';

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Persisted Qwen membership login.
 *
 * Owns the device sign-in flow, rotating token refresh, the account model
 * catalog and sign-out. Inference reads the access token through
 * `getAccessToken()`; a token rejected with HTTP 401 is passed back so a
 * concurrent refresh in another process is not repeated.
 */
export class QwenSubscriptionSession {
  private readonly config = getQwenOAuthConfig();
  private readonly client = new QwenSubscriptionOAuthClient();

  private get filePath(): string {
    return getQwenSubscriptionCredentialsPath();
  }

  isSignedIn(): boolean {
    return this.getIdentity() !== undefined;
  }

  /** Last successfully loaded catalog, read without touching the network. */
  getCachedModels(): string[] {
    try {
      const credentials = credentialSchema.parse(
        JSON.parse(readCredentialsSync(this.filePath)),
      );
      return credentials.tokens && this.matches(credentials)
        ? [...(credentials.models ?? [])]
        : [];
    } catch {
      return [];
    }
  }

  /** Local login revision; undefined when no usable token pair is stored. */
  getIdentity(): string | undefined {
    try {
      const credentials = credentialSchema.parse(
        JSON.parse(readCredentialsSync(this.filePath)),
      );
      return credentials.tokens && this.matches(credentials)
        ? credentials.revision
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Fresh device sign-in; the previous account stays active until exchange. */
  async signIn(
    onDevice: (device: QwenSubscriptionDeviceAuthorization) => void,
    signal?: AbortSignal,
  ): Promise<QwenSubscriptionUserInfo> {
    const signInAttempt = randomUUID();
    const device = await this.locked(async (assertCanCommit) => {
      const previous = await this.read();
      const credentials: Credentials = {
        ...(previous && this.matches(previous)
          ? previous
          : { ...this.config, revision: signInAttempt }),
        signInAttempt,
      };
      await this.write(credentials, assertCanCommit);
      return this.client.requestDeviceAuthorization(signal);
    }, signal);
    signal?.throwIfAborted();
    onDevice(device);
    const tokens = await this.client
      .pollForToken(device, signal)
      .catch((error: unknown) => {
        throw toSubscriptionOAuthError(error, 'exchange');
      });
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    return this.locked(async (assertCanCommit) => {
      const current = await this.read();
      if (current?.signInAttempt !== signInAttempt) {
        throw new QwenSubscriptionOAuthError('session_changed');
      }
      const credentials: Credentials = {
        ...this.config,
        revision: signInAttempt,
        tokens: { ...tokens, expiresAt },
      };
      await this.write(credentials, assertCanCommit);
      return this.client.getUserInfo(tokens.access_token, signal);
    }, signal);
  }

  async getUserInfo(
    signal?: AbortSignal,
  ): Promise<QwenSubscriptionUserInfo | null> {
    return this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials)) return null;
      let refreshed = false;
      const refresh = async () => {
        await this.refresh(credentials, assertCanCommit, signal);
        refreshed = true;
      };
      if (credentials.tokens.expiresAt <= Date.now() + REFRESH_LEEWAY_MS) {
        await refresh();
      }
      try {
        return await this.client.getUserInfo(
          credentials.tokens!.access_token,
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof QwenSubscriptionOAuthError) ||
          error.status !== 401 ||
          refreshed
        ) {
          throw error;
        }
        await refresh();
        return this.client.getUserInfo(credentials.tokens!.access_token, signal);
      }
    }, signal);
  }

  /**
   * Bearer token for inference. `rejectedToken` is the token the gateway
   * refused, letting a concurrent rotation win without a second refresh.
   */
  async getAccessToken(
    signal?: AbortSignal,
    rejectedToken?: string,
  ): Promise<string> {
    return this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials)) {
        throw new QwenSubscriptionOAuthError(
          'session_changed',
          undefined,
          QWEN_SUBSCRIPTION_SIGNED_OUT_HINT,
        );
      }
      if (
        credentials.tokens.expiresAt <= Date.now() + REFRESH_LEEWAY_MS ||
        credentials.tokens.access_token === rejectedToken
      ) {
        await this.refresh(credentials, assertCanCommit, signal);
      }
      return credentials.tokens!.access_token;
    }, signal);
  }

  /** Account model catalog; falls back to the cached list on transport errors. */
  async getModels(
    signal?: AbortSignal,
  ): Promise<{ models: string[]; cached: boolean }> {
    const snapshot = await this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials)) {
        throw new QwenSubscriptionOAuthError(
          'session_changed',
          undefined,
          QWEN_SUBSCRIPTION_SIGNED_OUT_HINT,
        );
      }
      if (credentials.tokens.expiresAt <= Date.now() + REFRESH_LEEWAY_MS) {
        await this.refresh(credentials, assertCanCommit, signal);
      }
      return {
        revision: credentials.revision,
        token: credentials.tokens!.access_token,
        cachedModels: credentials.models,
      };
    }, signal);

    const readCurrent = async (): Promise<Credentials> => {
      const credentials = await this.read();
      if (
        !credentials?.tokens ||
        !this.matches(credentials) ||
        credentials.revision !== snapshot.revision
      ) {
        throw new QwenSubscriptionOAuthError(
          'session_changed',
          undefined,
          QWEN_SUBSCRIPTION_SIGNED_OUT_HINT,
        );
      }
      return credentials;
    };

    try {
      let response = await this.requestModels(snapshot.token, signal);
      if (response.status === 401) {
        const token = await this.locked(async (assertCanCommit) => {
          const credentials = await readCurrent();
          if (credentials.tokens!.access_token === snapshot.token) {
            await this.refresh(credentials, assertCanCommit, signal);
          }
          return credentials.tokens!.access_token;
        }, signal);
        response = await this.requestModels(token, signal);
      }
      signal?.throwIfAborted();
      if (response.status !== 200) {
        throw new QwenSubscriptionOAuthError(
          'models_request_failed',
          response.status,
        );
      }
      const models = parseModelIds(await response.text());
      if (models.length === 0) {
        throw new QwenSubscriptionOAuthError('models_unavailable');
      }
      await this.locked(async (assertCanCommit) => {
        const credentials = await readCurrent();
        credentials.models = models;
        await this.write(credentials, assertCanCommit);
      }, signal);
      return { models, cached: false };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof QwenSubscriptionOAuthError &&
        (error.stage || !error.status || error.status < 500)
      ) {
        throw error;
      }
      if (snapshot.cachedModels?.length) {
        return { models: [...snapshot.cachedModels], cached: true };
      }
      throw error instanceof QwenSubscriptionOAuthError
        ? error
        : new QwenSubscriptionOAuthError('models_unavailable');
    }
  }

  /** Removes local credentials first, then best-effort remote revocation. */
  async signOut(signal?: AbortSignal): Promise<void> {
    const tokens = await this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (credentials && !this.matches(credentials)) return undefined;
      assertCanCommit();
      await fs
        .rm(this.filePath, { force: true })
        .catch((error: unknown) => {
          throw toSubscriptionOAuthError(error, 'cleanup');
        });
      return credentials?.tokens;
    }, signal);
    if (!tokens) return;
    try {
      await this.client.revokeToken(
        tokens.refresh_token,
        'refresh_token',
        signal,
      );
    } catch (error) {
      runLogger.warn(
        `[qwen-subscription] remote sign-out failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async refresh(
    credentials: Credentials,
    assertCanCommit: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let tokens: QwenSubscriptionTokens;
    try {
      tokens = await this.client.refreshToken(
        credentials.tokens!.refresh_token,
        signal,
      );
    } catch (error) {
      if (
        error instanceof QwenSubscriptionOAuthError &&
        error.code === 'invalid_grant'
      ) {
        assertCanCommit();
        await fs.rm(this.filePath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
    credentials.tokens = {
      ...tokens,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    await this.write(credentials, assertCanCommit);
  }

  private requestModels(
    token: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS);
    const composed = composeSignals(signal, timeout);
    return fetch(`${QWEN_SUBSCRIPTION_BASE_URL}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      redirect: 'error',
      signal: composed.signal,
    }).finally(composed.cleanup);
  }

  private matches(credentials: Credentials): boolean {
    return (
      credentials.baseUrl === this.config.baseUrl &&
      credentials.clientId === this.config.clientId
    );
  }

  private async read(): Promise<Credentials | null> {
    let file;
    try {
      file = await fs.open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let data: unknown;
      try {
        data = JSON.parse(await file.readFile('utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new QwenSubscriptionOAuthError(
            'credentials_error',
            undefined,
            'Invalid Qwen Subscription credentials.',
            undefined,
            'credentials',
          );
        }
        throw error;
      }
      const parsed = credentialSchema.safeParse(data);
      if (!parsed.success) {
        throw new QwenSubscriptionOAuthError(
          'credentials_error',
          undefined,
          'Invalid Qwen Subscription credentials.',
          undefined,
          'credentials',
        );
      }
      return parsed.data;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw toSubscriptionOAuthError(error, 'credentials');
    } finally {
      await file?.close();
    }
  }

  private write(
    credentials: Credentials,
    assertCanCommit: () => void,
  ): Promise<void> {
    return atomicWriteFile(
      this.filePath,
      JSON.stringify(credentials),
      assertCanCommit,
    );
  }

  private async locked<T>(
    run: (assertCanCommit: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, {
        recursive: true,
        mode: CREDENTIAL_DIR_MODE,
      });
      let release: () => Promise<void>;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          release = await lock(this.filePath, {
            realpath: false,
            stale: 60_000,
            retries: 0,
          });
          break;
        } catch (error) {
          if (
            !isNodeError(error) ||
            error.code !== 'ELOCKED' ||
            attempt >= LOCK_RETRIES
          ) {
            throw error;
          }
          await delay(LOCK_RETRY_DELAY_MS, signal);
        }
      }
      const assertCanCommit = () => signal?.throwIfAborted();
      try {
        return await run(assertCanCommit);
      } finally {
        await release().catch(() => undefined);
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw toSubscriptionOAuthError(error, 'credentials');
    }
  }
}

function composeSignals(
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!signal) return { signal: timeout, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort(timeout.reason);
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else if (timeout.aborted) {
    controller.abort(timeout.reason);
  } else {
    signal.addEventListener('abort', forward, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      signal.removeEventListener('abort', forward);
      timeout.removeEventListener('abort', abort);
    },
  };
}

function parseModelIds(text: string): string[] {
  if (text.length > MODELS_MAX_BYTES) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of (body as { data: unknown[] }).data) {
    if (typeof item !== 'object' || item === null) return [];
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') return [];
    const trimmed = id.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      ids.push(trimmed);
    }
  }
  return ids;
}

async function atomicWriteFile(
  filePath: string,
  contents: string,
  assertCanCommit: () => void,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await fs.open(temporaryPath, 'wx', CREDENTIAL_FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertCanCommit();
    await fs.rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function readCredentialsSync(filePath: string): string {
  const fd = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
