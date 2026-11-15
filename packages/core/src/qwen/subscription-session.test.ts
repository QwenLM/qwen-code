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
  readCachedSubscriptionCatalog,
  selectSubscriptionModel,
  SUBSCRIPTION_MODELS_UNAVAILABLE,
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

it('checks persisted login independently of the selected provider and model cache', async () => {
  const session = new QwenSubscriptionSession();
  expect(session.isSignedIn()).toBe(false);
  await session.signIn(() => {});
  expect(session.isSignedIn()).toBe(true);
  await expire();
  expect(session.isSignedIn()).toBe(true);
  client.refreshToken.mockRejectedValue(
    new SubscriptionOAuthError('invalid_grant'),
  );
  await expect(session.getAccessToken()).rejects.toThrow();
  expect(session.isSignedIn()).toBe(false);
});

it('keeps the login identity across token refresh and replaces it on sign-in', async () => {
  const session = new QwenSubscriptionSession();
  expect(session.getIdentity()).toBeUndefined();
  await session.signIn(() => {});
  const identity = session.getIdentity();
  expect(identity).toEqual(expect.any(String));
  await expire();
  await session.getAccessToken();
  expect(session.getIdentity()).toBe(identity);
  await session.signIn(() => {});
  expect(session.getIdentity()).not.toBe(identity);
  await session.signOut();
  expect(session.getIdentity()).toBeUndefined();
});

it('notifies observers when credentials are created or removed by another session', async () => {
  const session = new QwenSubscriptionSession();
  const changed = vi.fn();
  const unsubscribe = session.onChange(changed);
  try {
    await new QwenSubscriptionSession().signIn(() => {});
    await vi.waitFor(
      () =>
        expect(changed).toHaveBeenCalledWith(
          expect.objectContaining({ nlink: 1 }),
          expect.anything(),
        ),
      {
        timeout: 2000,
      },
    );
    expect(session.isSignedIn()).toBe(true);
    changed.mockClear();
    await new QwenSubscriptionSession().signOut();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(session.isSignedIn()).toBe(false);
  } finally {
    unsubscribe();
  }
});

it('does not treat credentials for another OAuth environment as signed in', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  const credentials = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(
    file,
    JSON.stringify({ ...credentials, clientId: 'another-client' }),
  );
  expect(session.isSignedIn()).toBe(false);
});

it('loads every served model, persists the account cache and preserves it across token refresh', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  const ids = ['qwen3.8-max', 'qwen3.7-flash', 'future-model'];
  modelFetch.mockResolvedValue(modelResponse(ids));
  expect(await session.getModels()).toEqual({ models: ids, cached: false });
  expect(readCachedSubscriptionCatalog().models).toEqual(ids);
  expect(modelFetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/models$/),
    expect.objectContaining({ maxRedirects: 0, timeoutMs: 5000 }),
  );
  await expire();
  await session.getAccessToken();
  expect(readCachedSubscriptionCatalog().models).toEqual(ids);
  await session.signOut();
  expect(readCachedSubscriptionCatalog().models).toEqual([]);
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

it('validates optional metadata per field and replaces or reuses it with the model list', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue({
    kind: 'response',
    status: 200,
    body: Buffer.from(
      JSON.stringify({
        data: [
          {
            id: ' qwen3.8-max ',
            input_modalities: ['text'],
            context_window_tokens: 262144,
          },
          { id: 'qwen3.8-max', input_modalities: ['text', 'video'] },
          {
            id: 'vision',
            input_modalities: ['text', 'image', 'video', 'audio', 'pdf'],
            context_window_tokens: '1000000',
          },
          {
            id: 'window-only',
            input_modalities: 'text',
            context_window_tokens: 1000000,
          },
          { id: 'legacy' },
        ],
      }),
    ),
  });

  const catalog = {
    models: ['qwen3.8-max', 'vision', 'window-only', 'legacy'],
    modelMetadata: [
      { id: 'qwen3.8-max', modalities: {}, contextWindowSize: 262144 },
      {
        id: 'vision',
        modalities: { image: true, video: true, audio: true, pdf: true },
      },
      { id: 'window-only', contextWindowSize: 1000000 },
    ],
  };
  expect(await session.getModels()).toEqual({ ...catalog, cached: false });
  expect(readCachedSubscriptionCatalog()).toEqual(catalog);

  modelFetch.mockResolvedValue(modelResponse([], 503));
  expect(await session.getModels()).toEqual({ ...catalog, cached: true });

  modelFetch.mockResolvedValue(modelResponse(catalog.models));
  expect(await session.getModels()).toEqual({
    models: catalog.models,
    cached: false,
  });
  expect(readCachedSubscriptionCatalog().modelMetadata).toBeUndefined();

  await session.signOut();
  expect(readCachedSubscriptionCatalog()).toEqual({ models: [] });
});

it('does not hide a repeated unauthorized response behind the cached catalog', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  modelFetch.mockResolvedValue(modelResponse(['served']));
  await session.getModels();
  modelFetch.mockReset().mockResolvedValue(modelResponse([], 401));
  await expect(
    session.getModels(undefined, '0.0.0-test'),
  ).rejects.toMatchObject({
    code: 'invalid_token',
    status: 401,
  });
  expect(client.refreshToken).toHaveBeenCalledOnce();
  expect(modelFetch.mock.calls.map(([, options]) => options.headers)).toEqual(
    [tokens.access_token, rotated.access_token].map((token) => ({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': `QwenCode/0.0.0-test (${process.platform}; ${process.arch})`,
    })),
  );
  expect(readCachedSubscriptionCatalog().models).toEqual(['served']);
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
    expect(readCachedSubscriptionCatalog().models).toEqual(
      cached ? ['served'] : [],
    );
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
  expect(readCachedSubscriptionCatalog().models).toEqual(['served']);
});

it.each(['empty response', 'network failure'])(
  'reports %s as an unavailable catalog without clearing login or inventing models',
  async (failure) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    if (failure === 'network failure')
      modelFetch.mockRejectedValue(new TypeError('fetch failed'));
    else modelFetch.mockResolvedValue(modelResponse([]));
    const error = await session.getModels().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SubscriptionOAuthError);
    expect(error).toMatchObject({ message: SUBSCRIPTION_MODELS_UNAVAILABLE });
    expect(readCachedSubscriptionCatalog().models).toEqual([]);
    expect(await session.getUserInfo()).toEqual(user);
  },
);

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
  expect(readCachedSubscriptionCatalog().models).toEqual([]);
});

it.each(['response', 'network failure'])(
  'rejects an old account catalog %s requested before reauthorization',
  async (outcome) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    const identity = session.getIdentity();
    modelFetch.mockResolvedValueOnce(modelResponse(['old-account-model']));
    await session.getModels();
    modelFetch.mockClear();
    let finishAuthorization!: (value: typeof rotated) => void;
    client.pollForToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAuthorization = resolve;
        }),
    );
    client.getUserInfo.mockResolvedValueOnce({ ...user, sub: 'new-account' });
    const onDevice = vi.fn();

    let finishCatalog!: (value: ReturnType<typeof modelResponse>) => void;
    let failCatalog!: (error: Error) => void;
    modelFetch.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishCatalog = resolve;
          failCatalog = reject;
        }),
    );
    const catalog = session.getModels().catch((error: unknown) => error);
    await vi.waitFor(() => expect(modelFetch).toHaveBeenCalledOnce());
    expect(modelFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${tokens.access_token}`,
        }),
      }),
    );
    const authorization = session.signIn(onDevice);
    await vi.waitFor(() => expect(onDevice).toHaveBeenCalledOnce());
    expect(session.getIdentity()).toBe(identity);
    expect(await session.getAccessToken()).toBe(tokens.access_token);
    expect(readCachedSubscriptionCatalog().models).toEqual([
      'old-account-model',
    ]);
    expect(modelFetch).toHaveBeenCalledOnce();
    finishAuthorization(rotated);
    await authorization;
    expect(session.getIdentity()).not.toBe(identity);
    if (outcome === 'response')
      finishCatalog(modelResponse(['old-account-model']));
    else failCatalog(new TypeError('offline'));
    expect(await catalog).toMatchObject({ code: 'session_changed' });
    expect(await session.getAccessToken()).toBe(rotated.access_token);
    expect(readCachedSubscriptionCatalog().models).toEqual([]);
  },
);

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

it('keeps newly exchanged tokens when identity lookup fails so retry does not authorize again', async () => {
  const session = new QwenSubscriptionSession();
  await session.signIn(() => {});
  client.pollForToken.mockResolvedValueOnce(rotated);
  client.getUserInfo.mockRejectedValueOnce(
    new SubscriptionOAuthError('invalid_response', 503),
  );
  await expect(session.signIn(() => {})).rejects.toMatchObject({ status: 503 });
  const restored = new QwenSubscriptionSession();
  expect(await restored.getAccessToken()).toBe(rotated.access_token);
  expect(await restored.getUserInfo()).toEqual(user);
  expect(client.pollForToken).toHaveBeenCalledTimes(2);
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

it.each(['new sign-in', 'invalid refresh grant'])(
  'handles a %s while reauthorizing',
  async (event) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    let finish!: (value: typeof rotated) => void;
    client.pollForToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const authorization = session.signIn(() => {});
    const outcome = authorization.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(client.pollForToken).toHaveBeenCalledTimes(2),
    );

    const other = new QwenSubscriptionSession();
    if (event === 'new sign-in') {
      await other.signIn(() => {});
      finish(rotated);
      expect(await outcome).toMatchObject({ code: 'session_changed' });
      expect(await other.getAccessToken()).toBe(tokens.access_token);
    } else {
      await expire();
      client.refreshToken.mockRejectedValueOnce(
        new SubscriptionOAuthError('invalid_grant', 400),
      );
      await expect(other.getAccessToken()).rejects.toMatchObject({
        code: 'invalid_grant',
      });
      expect(other.isSignedIn()).toBe(false);
      finish(rotated);
      await expect(outcome).resolves.toEqual(user);
      expect(await other.getAccessToken()).toBe(rotated.access_token);
    }
  },
);

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

it.each(['cancel', 'device failure', 'access_denied', 'expired_token'])(
  'preserves the previous account and model cache after authorization %s',
  async (failure) => {
    const session = new QwenSubscriptionSession();
    await session.signIn(() => {});
    const identity = session.getIdentity();
    modelFetch.mockResolvedValue(modelResponse(['served']));
    await session.getModels();
    const abort = new AbortController();
    client.requestDeviceAuthorization.mockImplementationOnce(async () => {
      if (failure === 'device failure') {
        throw new SubscriptionOAuthError(
          'network_error',
          undefined,
          undefined,
          undefined,
          'device',
        );
      }
      return device;
    });
    if (failure === 'cancel') {
      client.pollForToken.mockImplementationOnce(async () => {
        abort.abort();
        return rotated;
      });
    } else if (failure !== 'device failure') {
      client.pollForToken.mockRejectedValueOnce(
        new SubscriptionOAuthError(
          failure,
          400,
          undefined,
          undefined,
          'exchange',
        ),
      );
    }
    await expect(session.signIn(() => {}, abort.signal)).rejects.toMatchObject(
      failure === 'cancel'
        ? { name: 'AbortError' }
        : { code: failure === 'device failure' ? 'network_error' : failure },
    );
    expect(session.getIdentity()).toBe(identity);
    expect(await session.getAccessToken()).toBe(tokens.access_token);
    expect(readCachedSubscriptionCatalog().models).toEqual(['served']);
    expect(client.revokeToken).not.toHaveBeenCalled();
  },
);

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
