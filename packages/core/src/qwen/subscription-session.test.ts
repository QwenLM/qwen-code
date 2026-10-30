/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QwenSubscriptionSession } from './subscription-session.js';
import { SubscriptionOAuthError } from './subscription-oauth-client.js';
import {
  readCachedSubscriptionModels,
  selectSubscriptionModel,
} from './subscription-models.js';

const modelFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/fetch.js', () => ({ fetchWithPolicy: modelFetch }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const client = vi.hoisted(() => ({
  requestDeviceAuthorization: vi.fn(),
  pollForToken: vi.fn(),
  refreshToken: vi.fn(),
  revokeToken: vi.fn(),
  getUserInfo: vi.fn(),
}));
vi.mock('./subscription-oauth-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./subscription-oauth-client.js')>();
  return {
    ...actual,
    QwenSubscriptionOAuthClient: class {
      constructor() {
        return client;
      }
    },
  };
});

const user = {
  sub: 'user-one',
  name: 'User',
  email: 'user@example.test',
  member_type: 'free',
};
const tokens = {
  access_token: 'synthetic-access-one',
  refresh_token: 'synthetic-refresh-one',
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'model:invoke profile:read',
};
const rotated = {
  ...tokens,
  access_token: 'synthetic-access-two',
  refresh_token: 'synthetic-refresh-two',
};
const device = {
  device_code: 'synthetic-device',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://oauth.example.test/device',
  verification_uri_complete:
    'https://oauth.example.test/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
  expiresAt: Date.now() + 600_000,
};
let directory: string;
let file: string;

beforeEach(async () => {
  vi.clearAllMocks();
  modelFetch.mockReset();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-session-'));
  file = path.join(directory, 'subscription_credentials.json');
  vi.stubEnv('QWEN_HOME', directory);
  client.requestDeviceAuthorization.mockResolvedValue(device);
  client.pollForToken.mockResolvedValue(tokens);
  client.getUserInfo.mockResolvedValue(user);
  client.refreshToken.mockResolvedValue(rotated);
  client.revokeToken.mockResolvedValue(undefined);
});

function modelResponse(ids: string[], status = 200) {
  return {
    kind: 'response',
    status,
    body: Buffer.from(JSON.stringify({ data: ids.map((id) => ({ id })) })),
  };
}

it('loads every served model, persists the account cache and preserves it across token refresh', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  const ids = ['qwen3.8-max', 'qwen3.7-flash', 'future-model'];
  modelFetch.mockResolvedValue(modelResponse(ids));
  expect(await session.getModels()).toEqual({ models: ids, cached: false });
  expect(readCachedSubscriptionModels()).toEqual(ids);
  expect(modelFetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/models$/),
    expect.objectContaining({ maxRedirects: 0, timeoutMs: 5000 }),
  );
  await expire();
  await session.getAccessToken();
  expect(readCachedSubscriptionModels()).toEqual(ids);
  await session.signOut();
  expect(readCachedSubscriptionModels()).toEqual([]);
});

it('retains credentials and the last catalog after network errors and empty responses', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse(['served']));
  await session.getModels();
  modelFetch.mockRejectedValue(new Error('network failure'));
  expect(await session.getModels()).toEqual({
    models: ['served'],
    cached: true,
  });
  modelFetch.mockResolvedValue(modelResponse([]));
  expect(await session.getModels()).toEqual({
    models: ['served'],
    cached: true,
  });
  expect(await session.getUserInfo()).toEqual(user);
});

it('does not hide a repeated unauthorized response behind the cached catalog', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse(['served']));
  await session.getModels();
  modelFetch.mockReset().mockResolvedValue(modelResponse([], 401));
  await expect(session.getModels()).rejects.toMatchObject({
    code: 'invalid_token',
    status: 401,
  });
  expect(client.refreshToken).toHaveBeenCalledOnce();
  expect(modelFetch).toHaveBeenCalledTimes(2);
  expect(readCachedSubscriptionModels()).toEqual(['served']);
});

it.each([false, true])(
  'preserves a backend model permission error (cached catalog: %s)',
  async (cached) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    if (cached) {
      modelFetch.mockResolvedValue(modelResponse(['served']));
      await session.getModels();
    }
    modelFetch.mockResolvedValue({
      kind: 'response',
      status: 403,
      body: Buffer.from(
        JSON.stringify({
          error: 'access_denied',
          error_description: 'Your account cannot access this model catalog.',
        }),
      ),
    });
    await expect(session.getModels()).rejects.toMatchObject({
      code: 'request_failed',
      status: 403,
      description: 'Your account cannot access this model catalog.',
    });
    expect(readCachedSubscriptionModels()).toEqual(cached ? ['served'] : []);
  },
);

it('does not hide a refresh service failure behind the cached catalog', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse(['served']));
  await session.getModels();
  modelFetch.mockResolvedValue(modelResponse([], 401));
  client.refreshToken.mockRejectedValue(
    new SubscriptionOAuthError(
      'service_unavailable',
      503,
      'Refresh service temporarily unavailable.',
      undefined,
      'refresh',
    ),
  );
  await expect(session.getModels()).rejects.toMatchObject({
    code: 'service_unavailable',
    stage: 'refresh',
    status: 503,
  });
  expect(readCachedSubscriptionModels()).toEqual(['served']);
});

it('reports an unavailable catalog without clearing login or inventing models', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse([]));
  await expect(session.getModels()).rejects.toThrow(
    'Could not load Qwen Subscription models',
  );
  expect(readCachedSubscriptionModels()).toEqual([]);
  expect(await session.getUserInfo()).toEqual(user);
});

it('does not commit a late catalog after logout or a new login', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  let resolve!: (value: ReturnType<typeof modelResponse>) => void;
  modelFetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = session.getModels();
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(modelFetch).toHaveBeenCalled());
  await session.signOut();
  await session.signIn(() => {});
  resolve(modelResponse(['old-account-model']));
  expect(await outcome).toMatchObject({ code: 'session_changed' });
  expect(readCachedSubscriptionModels()).toEqual([]);
});

it('replaces a successful catalog and never silently replaces a removed selection', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse(['old-model', 'next-model']));
  await session.getModels();
  modelFetch.mockResolvedValue(modelResponse(['next-model']));
  const result = await session.getModels();
  expect(result.models).toEqual(['next-model']);
  expect(() => selectSubscriptionModel(result.models, 'old-model')).toThrow(
    'Run /model',
  );
  expect(selectSubscriptionModel(result.models)).toBe('next-model');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

async function expire() {
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.tokens.expiresAt = 1;
  await fs.writeFile(file, JSON.stringify(saved));
}

it('persists private credentials before identity lookup and restores them in a new instance', async () => {
  client.getUserInfo.mockImplementation(async () => {
    expect(
      JSON.parse(await fs.readFile(file, 'utf8')).tokens.access_token,
    ).toBe(tokens.access_token);
    return user;
  });
  const session = new QwenSubscriptionSession();
  const onDevice = vi.fn();
  expect(await session.signIn(onDevice)).toEqual(user);
  expect(onDevice).toHaveBeenCalledWith(device);
  expect(await new QwenSubscriptionSession().getUserInfo()).toEqual(user);
  expect(client.requestDeviceAuthorization).toHaveBeenCalledTimes(1);
  expect(client.refreshToken).not.toHaveBeenCalled();
  if (process.platform !== 'win32')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  await expect(
    fs.stat(path.join(directory, 'oauth_creds.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns null for no session without requesting device authorization', async () => {
  expect(await new QwenSubscriptionSession().getUserInfo()).toBeNull();
  expect(client.requestDeviceAuthorization).not.toHaveBeenCalled();
});

it.each(['baseUrl', 'clientId'])(
  'does not reuse or revoke credentials for a different %s',
  async (key) => {
    await new QwenSubscriptionSession().signIn(() => {});
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved[key] =
      key === 'baseUrl' ? 'https://other.example.test' : 'other-client';
    await fs.writeFile(file, JSON.stringify(saved));
    client.getUserInfo.mockClear();
    const other = new QwenSubscriptionSession();
    expect(await other.getUserInfo()).toBeNull();
    await other.signOut();
    expect(client.getUserInfo).not.toHaveBeenCalled();
    expect(client.revokeToken).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).tokens).toBeDefined();
  },
);

it('serializes concurrent refreshes and replaces the complete token pair', async () => {
  await new QwenSubscriptionSession().signIn(() => {});
  await expire();
  const a = new QwenSubscriptionSession();
  const b = new QwenSubscriptionSession();
  expect(await Promise.all([a.getUserInfo(), b.getUserInfo()])).toEqual([
    user,
    user,
  ]);
  expect(client.refreshToken).toHaveBeenCalledTimes(1);
  expect(client.refreshToken).toHaveBeenCalledWith(
    tokens.refresh_token,
    undefined,
  );
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(saved.tokens).toMatchObject(rotated);
  expect(saved.tokens.expiresAt).toBeGreaterThan(Date.now());
  expect(client.getUserInfo).toHaveBeenLastCalledWith(
    rotated.access_token,
    undefined,
  );
});

it('refreshes once after a 401 without opening a new authorization flow', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  client.getUserInfo.mockRejectedValueOnce(
    new SubscriptionOAuthError('invalid_token', 401),
  );
  expect(await session.getUserInfo()).toEqual(user);
  expect(client.refreshToken).toHaveBeenCalledTimes(1);
  expect(client.requestDeviceAuthorization).toHaveBeenCalledTimes(1);
});

it('clears an invalid refresh grant and leaves reauthorization to the caller', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  await expire();
  client.refreshToken.mockRejectedValueOnce(
    new SubscriptionOAuthError('invalid_grant', 400),
  );
  await expect(session.getUserInfo()).rejects.toMatchObject({
    code: 'invalid_grant',
  });
  expect(await session.getUserInfo()).toBeNull();
  expect(client.requestDeviceAuthorization).toHaveBeenCalledTimes(1);
});

it('preserves credentials on transient refresh failure', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  await expire();
  client.refreshToken.mockRejectedValueOnce(new TypeError('fetch failed'));
  await expect(session.getUserInfo()).rejects.toThrow('fetch failed');
  expect(JSON.parse(await fs.readFile(file, 'utf8')).tokens.refresh_token).toBe(
    tokens.refresh_token,
  );
  expect(await session.getUserInfo()).toEqual(user);
});

it('keeps saved tokens when identity lookup fails so retry does not authorize again', async () => {
  client.getUserInfo.mockRejectedValueOnce(
    new SubscriptionOAuthError('invalid_response', 503),
  );
  const session = new QwenSubscriptionSession();
  await expect(session.signIn(() => {})).rejects.toMatchObject({ status: 503 });
  expect(await new QwenSubscriptionSession().getUserInfo()).toEqual(user);
  expect(client.pollForToken).toHaveBeenCalledTimes(1);
});

it('revokes the rotated refresh token and clears local credentials even on network failure', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  await expire();
  await session.getUserInfo();
  client.revokeToken.mockRejectedValueOnce(new TypeError('fetch failed'));
  await expect(session.signOut()).rejects.toThrow('fetch failed');
  expect(client.revokeToken).toHaveBeenCalledWith(
    rotated.refresh_token,
    'refresh_token',
    undefined,
  );
  expect(await session.getUserInfo()).toBeNull();
});

it('does not resurrect an in-flight login after another session signs out', async () => {
  let finish!: (value: typeof tokens) => void;
  let started!: () => void;
  const polling = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.pollForToken.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const result = new QwenSubscriptionSession().signIn(() => {});
  const outcome = result.then(
    () => null,
    (error: unknown) => error,
  );
  await polling;
  await new QwenSubscriptionSession().signOut();
  finish(tokens);
  expect(await outcome).toMatchObject({ code: 'session_changed' });
  expect(await new QwenSubscriptionSession().getUserInfo()).toBeNull();
});

it('does not write tokens when login was cancelled before polling completed', async () => {
  const abort = new AbortController();
  client.pollForToken.mockImplementationOnce(async () => {
    abort.abort();
    return tokens;
  });
  await expect(
    new QwenSubscriptionSession().signIn(() => {}, abort.signal),
  ).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(file, 'utf8')).tokens).toBeUndefined();
  expect(client.getUserInfo).not.toHaveBeenCalled();
});

it('serializes sign-out after an in-flight refresh so refreshed credentials are removed', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  await expire();
  let finish!: (value: typeof rotated) => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  client.refreshToken.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const query = session.getUserInfo();
  await refreshing;
  const signOut = new QwenSubscriptionSession().signOut();
  finish(rotated);
  await query;
  await signOut;
  expect(client.revokeToken).toHaveBeenLastCalledWith(
    rotated.refresh_token,
    'refresh_token',
    undefined,
  );
  expect(await session.getUserInfo()).toBeNull();
});

it('does not disclose malformed credential contents in errors', async () => {
  await fs.writeFile(file, '{"access_token":"synthetic-secret",BROKEN');
  await expect(new QwenSubscriptionSession().getUserInfo()).rejects.toThrow(
    'Invalid Qwen Subscription credentials.',
  );
});

it('cancels while another process holds the credential lock without issuing a request', async () => {
  const release = await lockfile.lock(file, { realpath: false });
  const lock = vi.spyOn(lockfile, 'lock');
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = new QwenSubscriptionSession()
      .getUserInfo(abort.signal)
      .then(
        () => 'unexpected-success',
        (error: unknown) => error,
      );
    await vi.waitFor(() => expect(lock).toHaveBeenCalled());
    abort.abort();
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still-waiting-for-lock'), 500);
      }),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
    expect(client.getUserInfo).not.toHaveBeenCalled();
    expect(client.refreshToken).not.toHaveBeenCalled();
    expect(await lockfile.check(file, { realpath: false })).toBe(true);
  } finally {
    clearTimeout(timer);
    await release();
  }
});

it.each(['userinfo', 'refresh'] as const)(
  'persists %s Retry-After across session instances',
  async (stage) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    if (stage === 'refresh') await expire();
    const request =
      stage === 'refresh' ? client.refreshToken : client.getUserInfo;
    request.mockClear();
    request.mockRejectedValueOnce(
      new SubscriptionOAuthError('rate_limited', 429, 'private detail', 60_000),
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await expect(session.getUserInfo()).rejects.toMatchObject({
        code: 'rate_limited',
        stage,
      });
      await expect(
        new QwenSubscriptionSession().getUserInfo(),
      ).rejects.toMatchObject({
        code: 'rate_limited',
        stage,
        retryAfterMs: 60_000,
      });
      expect(request).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(now + 60_000);
      expect(await new QwenSubscriptionSession().getUserInfo()).toEqual(user);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  },
);

it('tags a failed first identity query and can recover without another token exchange', async () => {
  client.getUserInfo.mockRejectedValueOnce(new TypeError('fetch failed'));
  const session = new QwenSubscriptionSession();
  await expect(session.signIn(() => {})).rejects.toMatchObject({
    code: 'network_error',
    stage: 'userinfo',
  });
  expect(await new QwenSubscriptionSession().getUserInfo()).toEqual(user);
  expect(client.pollForToken).toHaveBeenCalledTimes(1);
});

it('distinguishes remote revocation failure from local credential cleanup failure', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  client.revokeToken.mockRejectedValueOnce(new TypeError('fetch failed'));
  await expect(session.signOut()).rejects.toMatchObject({ stage: 'revoke' });
  await session.signIn(() => {});
  vi.mocked(fs.rm).mockRejectedValueOnce(
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
  );
  await expect(session.signOut()).rejects.toMatchObject({
    stage: 'cleanup',
    code: 'credentials_error',
  });
  expect(JSON.parse(await fs.readFile(file, 'utf8')).tokens).toBeDefined();
  expect(client.revokeToken).toHaveBeenCalledTimes(1);
});

it('honors device authorization Retry-After when a new session retries login', async () => {
  client.requestDeviceAuthorization.mockRejectedValueOnce(
    new SubscriptionOAuthError('rate_limited', 429, undefined, 60_000),
  );
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await expect(
      new QwenSubscriptionSession().signIn(() => {}),
    ).rejects.toMatchObject({ stage: 'device', retryAfterMs: 60_000 });
    await expect(
      new QwenSubscriptionSession().signIn(() => {}),
    ).rejects.toMatchObject({ stage: 'device', retryAfterMs: 60_000 });
    expect(client.requestDeviceAuthorization).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 60_000);
    expect(await new QwenSubscriptionSession().signIn(() => {})).toEqual(user);
    expect(client.requestDeviceAuthorization).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

it('obtains an inference token without repeating membership requests', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  client.getUserInfo.mockClear();
  expect(await session.getAccessToken()).toBe(tokens.access_token);
  expect(client.getUserInfo).not.toHaveBeenCalled();
  expect(client.refreshToken).not.toHaveBeenCalled();
});

it('refreshes an expired inference token and persists the rotated pair', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  await expire();
  expect(await session.getAccessToken()).toBe(rotated.access_token);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).tokens.refresh_token).toBe(
    rotated.refresh_token,
  );
  expect(client.refreshToken).toHaveBeenCalledTimes(1);
});

it('only rotates once for concurrent inference failures using the same rejected token', async () => {
  await new QwenSubscriptionSession().signIn(() => {});
  expect(
    await Promise.all([
      new QwenSubscriptionSession().getAccessToken(
        undefined,
        tokens.access_token,
      ),
      new QwenSubscriptionSession().getAccessToken(
        undefined,
        tokens.access_token,
      ),
    ]),
  ).toEqual([rotated.access_token, rotated.access_token]);
  expect(client.refreshToken).toHaveBeenCalledTimes(1);
});

it('does not return cached inference credentials after signout', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  expect(await session.getAccessToken()).toBe(tokens.access_token);
  await session.signOut();
  await expect(session.getAccessToken()).rejects.toMatchObject({
    code: 'session_changed',
  });
});

it('rejects inference token access in a different authentication environment', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  const credentials = JSON.parse(await fs.readFile(file, 'utf8'));
  credentials.baseUrl = 'https://other.example';
  await fs.writeFile(file, JSON.stringify(credentials));
  await expect(session.getAccessToken()).rejects.toMatchObject({
    code: 'session_changed',
  });
  expect(client.refreshToken).not.toHaveBeenCalled();
});
