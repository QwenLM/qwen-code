/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { Storage } from '../config/storage.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { isNodeError } from '../utils/errors.js';
import {
  getQwenOAuthConfig,
  QWEN_SUBSCRIPTION_BASE_URL,
} from './oauth-config.js';
import { fetchWithPolicy } from '../utils/fetch.js';
import { subscriptionHttpError } from './subscription-errors.js';
import {
  subscriptionModelIdsSchema,
  SUBSCRIPTION_MODELS_UNAVAILABLE,
} from './subscription-models.js';
import {
  QwenSubscriptionOAuthClient,
  SubscriptionOAuthError,
  subscriptionError,
  type SubscriptionDeviceAuthorization,
  type SubscriptionTokens,
  type SubscriptionUserInfo,
} from './subscription-oauth-client.js';

const credentialSchema = z.object({
  revision: z.string().min(1),
  baseUrl: z.string(),
  clientId: z.string(),
  models: subscriptionModelIdsSchema.optional(),
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
  retryAfter: z
    .object({
      device: z.number().optional(),
      refresh: z.number().optional(),
      userinfo: z.number().optional(),
    })
    .optional(),
});
type Credentials = z.infer<typeof credentialSchema>;

export class QwenSubscriptionSession {
  private readonly config = getQwenOAuthConfig();
  private readonly client = new QwenSubscriptionOAuthClient();
  private readonly filePath = path.join(
    Storage.getGlobalQwenDir(),
    'subscription_credentials.json',
  );

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
        if (error instanceof SyntaxError)
          throw new Error('Invalid Qwen Subscription credentials.');
        throw error;
      }
      const parsed = credentialSchema.safeParse(data);
      if (!parsed.success)
        throw new Error('Invalid Qwen Subscription credentials.');
      return parsed.data;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    } finally {
      await file?.close();
    }
  }

  private matches(credentials: Credentials): boolean {
    return (
      credentials.baseUrl === this.config.baseUrl &&
      credentials.clientId === this.config.clientId
    );
  }

  private async locked<T>(
    run: (assertCanCommit: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const lockPath = path.join(
        await fs.realpath(directory),
        path.basename(this.filePath),
      );
      let compromised: Error | undefined;
      let release: () => Promise<void>;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          release = await lockfile.lock(lockPath, {
            realpath: false,
            stale: 60_000,
            retries: 0,
            onCompromised: (error) => {
              compromised = error;
            },
          });
          break;
        } catch (error) {
          if (
            !isNodeError(error) ||
            error.code !== 'ELOCKED' ||
            attempt >= 350
          ) {
            throw error;
          }
          await delay(100, undefined, { signal });
        }
      }
      const assertCanCommit = () => {
        signal?.throwIfAborted();
        if (compromised) throw compromised;
      };
      try {
        assertCanCommit();
        const result = await run(assertCanCommit);
        assertCanCommit();
        return result;
      } finally {
        await release().catch(() => undefined);
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw subscriptionError(error, 'credentials');
    }
  }

  private write(
    credentials: Credentials,
    assertCanCommit: () => void,
  ): Promise<void> {
    return atomicWriteFile(this.filePath, JSON.stringify(credentials), {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
      assertCanCommit,
    });
  }

  private async requestWithCooldown<T>(
    credentials: Credentials,
    stage: 'device' | 'refresh' | 'userinfo',
    assertCanCommit: () => void,
    request: () => Promise<T>,
  ): Promise<T> {
    const retryAfterMs = (credentials.retryAfter?.[stage] ?? 0) - Date.now();
    if (retryAfterMs > 0) {
      throw new SubscriptionOAuthError(
        'rate_limited',
        429,
        undefined,
        retryAfterMs,
        stage,
      );
    }
    try {
      return await request();
    } catch (error) {
      const failure = subscriptionError(error, stage);
      if (failure.status === 429 && failure.retryAfterMs) {
        credentials.retryAfter = {
          ...credentials.retryAfter,
          [stage]: Date.now() + failure.retryAfterMs,
        };
        await this.write(credentials, assertCanCommit);
      }
      throw failure;
    }
  }

  async signIn(
    onDevice: (device: SubscriptionDeviceAuthorization) => void,
    signal?: AbortSignal,
  ): Promise<SubscriptionUserInfo> {
    // Establish a revision before polling so logout or a newer login invalidates this attempt.
    const revision = randomUUID();
    const device = await this.locked(async (assertCanCommit) => {
      const previous = await this.read();
      const credentials = {
        ...this.config,
        revision,
        ...(previous && this.matches(previous)
          ? { tokens: previous.tokens, retryAfter: previous.retryAfter }
          : {}),
      };
      await this.write(credentials, assertCanCommit);
      return this.requestWithCooldown(
        credentials,
        'device',
        assertCanCommit,
        () => this.client.requestDeviceAuthorization(signal),
      );
    }, signal);
    signal?.throwIfAborted();
    onDevice(device);
    const tokens = await this.client
      .pollForToken(device, signal)
      .catch((error: unknown) => {
        throw subscriptionError(error, 'exchange');
      });
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    return this.locked(async (assertCanCommit) => {
      const current = await this.read();
      if (current?.revision !== revision) {
        throw new SubscriptionOAuthError('session_changed');
      }
      const credentials = {
        ...this.config,
        revision,
        tokens: { ...tokens, expiresAt },
      };
      await this.write(credentials, assertCanCommit);
      return this.requestWithCooldown(
        credentials,
        'userinfo',
        assertCanCommit,
        () => this.client.getUserInfo(tokens.access_token, signal),
      );
    }, signal);
  }

  async getUserInfo(
    signal?: AbortSignal,
  ): Promise<SubscriptionUserInfo | null> {
    return this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials)) return null;
      let refreshed = false;
      const refresh = async () => {
        await this.refresh(credentials, assertCanCommit, signal);
        refreshed = true;
      };
      if (credentials.tokens.expiresAt <= Date.now() + 30_000) await refresh();
      try {
        return await this.requestWithCooldown(
          credentials,
          'userinfo',
          assertCanCommit,
          () =>
            this.client.getUserInfo(credentials.tokens!.access_token, signal),
        );
      } catch (error) {
        if (
          !(error instanceof SubscriptionOAuthError) ||
          error.status !== 401 ||
          refreshed
        )
          throw error;
        await refresh();
        return this.requestWithCooldown(
          credentials,
          'userinfo',
          assertCanCommit,
          () =>
            this.client.getUserInfo(credentials.tokens!.access_token, signal),
        );
      }
    }, signal);
  }

  private async refresh(
    credentials: Credentials,
    assertCanCommit: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let tokens: SubscriptionTokens;
    try {
      tokens = await this.requestWithCooldown(
        credentials,
        'refresh',
        assertCanCommit,
        () =>
          this.client.refreshToken(credentials.tokens!.refresh_token, signal),
      );
    } catch (error) {
      if (
        error instanceof SubscriptionOAuthError &&
        error.code === 'invalid_grant'
      ) {
        assertCanCommit();
        await fs.rm(this.filePath, { force: true });
      }
      throw error;
    }
    credentials.tokens = {
      ...tokens,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    await this.write(credentials, assertCanCommit);
  }

  async getAccessToken(
    signal?: AbortSignal,
    rejectedToken?: string,
  ): Promise<string> {
    return this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials)) {
        throw new SubscriptionOAuthError('session_changed');
      }
      if (
        credentials.tokens.expiresAt <= Date.now() + 30_000 ||
        credentials.tokens.access_token === rejectedToken
      ) {
        await this.refresh(credentials, assertCanCommit, signal);
      }
      return credentials.tokens!.access_token;
    }, signal);
  }

  async signOut(signal?: AbortSignal): Promise<void> {
    await this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (credentials && !this.matches(credentials)) return;
      assertCanCommit();
      await fs.rm(this.filePath, { force: true }).catch((error: unknown) => {
        throw subscriptionError(error, 'cleanup');
      });
      if (credentials?.tokens && this.matches(credentials)) {
        await this.client
          .revokeToken(
            credentials.tokens.refresh_token,
            'refresh_token',
            signal,
          )
          .catch((error: unknown) => {
            throw subscriptionError(error, 'revoke');
          });
      }
    }, signal);
  }

  async getModels(
    signal?: AbortSignal,
  ): Promise<{ models: string[]; cached: boolean }> {
    const snapshot = await this.locked(async (assertCanCommit) => {
      const credentials = await this.read();
      if (!credentials?.tokens || !this.matches(credentials))
        throw new SubscriptionOAuthError('session_changed');
      if (credentials.tokens.expiresAt <= Date.now() + 30_000)
        await this.refresh(credentials, assertCanCommit, signal);
      return {
        revision: credentials.revision,
        token: credentials.tokens!.access_token,
      };
    }, signal);
    const current = async () => {
      const credentials = await this.read();
      if (
        !credentials?.tokens ||
        !this.matches(credentials) ||
        credentials.revision !== snapshot.revision
      )
        throw new SubscriptionOAuthError('session_changed');
      return credentials;
    };
    try {
      const request = (token: string) =>
        fetchWithPolicy(`${QWEN_SUBSCRIPTION_BASE_URL}/models`, {
          timeoutMs: 5000,
          maxBytes: 1024 * 1024,
          maxRedirects: 0,
          retryTransient: false,
          readErrorBody: true,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          signal,
        });
      let response = await request(snapshot.token);
      if (response.kind === 'response' && response.status === 401) {
        const token = await this.locked(async (assertCanCommit) => {
          const credentials = await current();
          if (credentials.tokens!.access_token === snapshot.token)
            await this.refresh(credentials, assertCanCommit, signal);
          return credentials.tokens!.access_token;
        }, signal);
        response = await request(token);
      }
      signal?.throwIfAborted();
      if (response.kind !== 'response')
        throw new Error(SUBSCRIPTION_MODELS_UNAVAILABLE);
      if (response.status !== 200) {
        let body: unknown;
        try {
          body = JSON.parse(response.body.toString('utf8'));
        } catch {
          /* No business message in a non-JSON response. */
        }
        throw subscriptionHttpError(response.status, body, response.retryAfter);
      }
      const body = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(response.body.toString('utf8')));
      const models = [
        ...new Set(
          subscriptionModelIdsSchema.parse(body.data.map((model) => model.id)),
        ),
      ];
      await this.locked(async (assertCanCommit) => {
        const credentials = await current();
        credentials.models = models;
        await this.write(credentials, assertCanCommit);
      }, signal);
      return { models, cached: false };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof SubscriptionOAuthError &&
        (error.stage || !error.status || error.status < 500)
      )
        throw error;
      return this.locked(async () => {
        const credentials = await current();
        if (!credentials.models?.length)
          throw error instanceof SubscriptionOAuthError
            ? error
            : new Error(SUBSCRIPTION_MODELS_UNAVAILABLE);
        return { models: credentials.models, cached: true };
      }, signal);
    }
  }
}
