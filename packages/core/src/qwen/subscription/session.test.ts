/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfigHomeDirOverride } from '../../utils/paths.js';
import {
  getQwenSubscriptionAuthorizationUrl,
  getQwenSubscriptionCredentialsPath,
  getQwenSubscriptionPlansUrl,
} from './oauth-config.js';
import { QwenSubscriptionOAuthError } from './oauth-client.js';
import { QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE } from './models.js';
import { QwenSubscriptionSession } from './session.js';

const tokenPayload = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer' as const,
  expires_in: 3600,
  scope: 'model:invoke profile:read',
};

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subscription-'));
  setConfigHomeDirOverride(dir);
});

afterEach(async () => {
  setConfigHomeDirOverride(undefined);
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock(): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function writeCredentials(overrides: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  models?: string[];
} = {}): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getQwenSubscriptionCredentialsPath(),
    JSON.stringify({
      revision: 'revision-1',
      baseUrl: 'https://auth.qwen.ai',
      clientId: 'qwen-code-cli',
      ...(overrides.models ? { models: overrides.models } : {}),
      tokens: {
        access_token: overrides.accessToken ?? 'access-1',
        refresh_token: overrides.refreshToken ?? 'refresh-1',
        token_type: 'Bearer',
        scope: 'model:invoke profile:read',
        expires_in: 3600,
        expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
      },
    }),
    'utf8',
  );
}

describe('QwenSubscriptionSession', () => {
  it('runs the device flow and stores the token pair', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete:
            'https://chat.qwen.ai/device?user_code=USER-1',
          expires_in: 60,
          interval: 0.01,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: 'authorization_pending' }, 400),
      )
      .mockResolvedValueOnce(jsonResponse(tokenPayload))
      .mockResolvedValueOnce(
        jsonResponse({
          sub: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          member_type: 'plus',
        }),
      );
    const session = new QwenSubscriptionSession();
    const devices: string[] = [];

    const info = await session.signIn((device) => {
      devices.push(device.user_code);
    });

    expect(devices).toEqual(['USER-1']);
    expect(info).toMatchObject({ email: 'ada@example.com', member_type: 'plus' });
    expect(session.isSignedIn()).toBe(true);
    const stored = JSON.parse(
      await fs.readFile(getQwenSubscriptionCredentialsPath(), 'utf8'),
    );
    expect(stored.tokens).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('refreshes an expired token before inference', async () => {
    await writeCredentials({ expiresAt: Date.now() - 1000 });
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ ...tokenPayload, access_token: 'access-2' }),
    );

    const token = await new QwenSubscriptionSession().getAccessToken();

    expect(token).toBe('access-2');
    const stored = JSON.parse(
      await fs.readFile(getQwenSubscriptionCredentialsPath(), 'utf8'),
    );
    expect(stored.tokens.access_token).toBe('access-2');
    expect(stored.tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refreshes when the gateway rejected the stored token', async () => {
    await writeCredentials();
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ ...tokenPayload, access_token: 'access-2' }),
    );

    const token = await new QwenSubscriptionSession().getAccessToken(
      undefined,
      'access-1',
    );

    expect(token).toBe('access-2');
  });

  it('reloads the catalog once after an unauthorized models call and persists modelMetadata', async () => {
    await writeCredentials();
    const fetch = fetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({ ...tokenPayload, access_token: 'access-2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'qwen4',
              input_modalities: ['text', 'image', 'pdf'],
              context_window_tokens: 262_144,
            },
            { id: 'qwen3.8-flash' },
          ],
        }),
      );

    const session = new QwenSubscriptionSession();
    const result = await session.getModels();

    expect(result).toEqual({
      models: ['qwen4', 'qwen3.8-flash'],
      modelMetadata: [
        {
          id: 'qwen4',
          modalities: {
            image: true,
            video: false,
            audio: false,
            pdf: true,
          },
          contextWindowSize: 262_144,
        },
      ],
      cached: false,
    });
    expect(session.getCachedCatalog()).toEqual({
      models: ['qwen4', 'qwen3.8-flash'],
      modelMetadata: [
        {
          id: 'qwen4',
          modalities: {
            image: true,
            video: false,
            audio: false,
            pdf: true,
          },
          contextWindowSize: 262_144,
        },
      ],
    });
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/models')),
    ).toHaveLength(2);
    const stored = JSON.parse(
      await fs.readFile(getQwenSubscriptionCredentialsPath(), 'utf8'),
    );
    expect(stored.models).toEqual(['qwen4', 'qwen3.8-flash']);
    expect(stored.modelMetadata).toEqual([
      {
        id: 'qwen4',
        modalities: {
          image: true,
          video: false,
          audio: false,
          pdf: true,
        },
        contextWindowSize: 262_144,
      },
    ]);
  });

  it('surfaces gateway error details on 4xx /models responses without falling back to cache', async () => {
    await writeCredentials({ models: ['qwen3.8-max'] });
    fetchMock().mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'plan_required',
            message: 'Your account cannot access this model catalog.',
          },
        },
        403,
      ),
    );

    await expect(new QwenSubscriptionSession().getModels()).rejects.toEqual(
      new QwenSubscriptionOAuthError(
        'plan_required',
        403,
        'Your account cannot access this model catalog.',
      ),
    );
  });

  it('throws models_unavailable with explicit copy when /models returns an empty list', async () => {
    await writeCredentials();
    fetchMock().mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(new QwenSubscriptionSession().getModels()).rejects.toEqual(
      new QwenSubscriptionOAuthError(
        'models_unavailable',
        undefined,
        QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE,
      ),
    );
  });

  it('preserves signInAttempt when a concurrent refresh fails with invalid_grant', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      getQwenSubscriptionCredentialsPath(),
      JSON.stringify({
        revision: 'revision-1',
        signInAttempt: 'attempt-1',
        baseUrl: 'https://auth.qwen.ai',
        clientId: 'qwen-code-cli',
        models: ['qwen3.8-max'],
        tokens: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          scope: 'model:invoke profile:read',
          expires_in: 3600,
          expiresAt: Date.now() - 1_000,
        },
      }),
      'utf8',
    );
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_grant' }, 400),
    );

    await expect(
      new QwenSubscriptionSession().getAccessToken(),
    ).rejects.toMatchObject({ code: 'invalid_grant' });

    const stored = JSON.parse(
      await fs.readFile(getQwenSubscriptionCredentialsPath(), 'utf8'),
    );
    expect(stored.signInAttempt).toBe('attempt-1');
    expect(stored.tokens).toBeUndefined();
    expect(stored.models).toBeUndefined();
  });

  it('formats chat.qwen.ai URLs with entry and paywallScene tracking params', () => {
    expect(getQwenSubscriptionPlansUrl()).toBe(
      'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=cli',
    );
    expect(
      getQwenSubscriptionAuthorizationUrl({
        user_code: 'ABCD-1234',
      }),
    ).toBe(
      'https://chat.qwen.ai/authorize?user_code=ABCD-1234&client=cli&entry=qwen_code&paywallScene=cli',
    );
  });

  it('falls back to the cached catalog on server errors', async () => {
    await writeCredentials({ models: ['qwen3.8-max'] });
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 500 }));

    const result = await new QwenSubscriptionSession().getModels();

    expect(result).toEqual({ models: ['qwen3.8-max'], cached: true });
  });

  it('removes local credentials before revoking remotely', async () => {
    await writeCredentials();
    const fetch = fetchMock().mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );
    const session = new QwenSubscriptionSession();

    await session.signOut();

    expect(session.isSignedIn()).toBe(false);
    await expect(
      fs.access(getQwenSubscriptionCredentialsPath()),
    ).rejects.toThrow();
    expect(String(fetch.mock.calls[0]![0])).toContain('/api/oauth/revoke');
  });
});
