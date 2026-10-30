/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { bearerAuth, createMutationGate } from '../auth.js';
import { registerSubscriptionAuthRoutes } from './subscription-auth.js';

const mocks = vi.hoisted(() => ({
  userInfo: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getUserInfo = mocks.userInfo;
    signIn = mocks.signIn;
    signOut = mocks.signOut;
  },
}));
const user = {
  sub: 'u',
  name: 'User',
  email: 'u@example.com',
  member_type: 'free',
};
let dispose: (() => void) | undefined;
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(bearerAuth('daemon'));
  const mutate = vi.fn(
    createMutationGate({ tokenConfigured: true, requireAuth: true }),
  );
  dispose = registerSubscriptionAuthRoutes(app, mutate);
  const get = (path: string) =>
    request(app).get(path).set('Authorization', 'Bearer daemon');
  const post = (path: string) =>
    request(app).post(path).set('Authorization', 'Bearer daemon').send({});
  return { app, get, post, mutate };
}
const base = '/auth/subscription';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  vi.stubEnv('QWEN_OAUTH_BASE_URL', 'https://pre-auth.qwen.ai');
  mocks.userInfo.mockResolvedValue(null);
  mocks.signIn.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  dispose?.();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('process-global Subscription routes', () => {
  it('keeps existing daemon authentication and strict write protection', async () => {
    const { app, post, mutate } = makeApp();
    expect((await request(app).get(base)).status).toBe(401);
    expect((await request(app).post(`${base}/flows`)).status).toBe(401);
    expect((await post(`${base}/flows`)).status).toBe(201);
    expect(mutate.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [{ strict: true }]),
    );
  });
  it('keeps the capability development-only', async () => {
    process.env['DEV'] = 'false';
    const { get, post } = makeApp();
    expect((await get(base)).body).toEqual({ enabled: false });
    expect((await post(`${base}/flows`)).status).toBe(404);
    expect(mocks.userInfo).not.toHaveBeenCalled();
  });
  it('enables development login without OAuth environment configuration', async () => {
    vi.stubEnv('QWEN_OAUTH_BASE_URL', undefined);
    vi.stubEnv('QWEN_OAUTH_CLIENT_ID', undefined);
    vi.stubEnv('QWEN_HOME', undefined);
    const { get, post } = makeApp();
    expect((await get(base)).body).toEqual({
      enabled: true,
      plansUrl: 'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
    });
    expect((await post(`${base}/flows`)).status).toBe(201);
  });
  it('returns pre4 links and never exposes the device secret', async () => {
    mocks.signIn.mockImplementation((onDevice) => {
      onDevice({
        user_code: 'ABCD-EFGH',
        device_code: 'secret',
        verification_uri_complete:
          'https://chat.qwen.ai/authorize?user_code=ABCD-EFGH',
      });
      return new Promise(() => {});
    });
    const { get, post } = makeApp();
    expect((await get(base)).body).toEqual({
      enabled: true,
      plansUrl: 'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
    });
    const started = await post(`${base}/flows`);
    const view = await get(`${base}/flows/${started.body.id}`);
    expect(view.body).toEqual({
      id: started.body.id,
      status: 'waiting',
      authorizationUrl:
        'https://pre4-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
    });
    expect(JSON.stringify(view.body)).not.toContain('secret');
  });
  it('resumes shared credentials, redacts identity, and preserves another GUI terminal result', async () => {
    mocks.userInfo.mockResolvedValue({ ...user, access_token: 'secret' });
    const { post, get } = makeApp();
    const first = await post(`${base}/flows`);
    await post(`${base}/flows`);
    expect((await get(`${base}/flows/${first.body.id}`)).body).toEqual({
      id: first.body.id,
      status: 'ready',
      userInfo: user,
    });
    expect((await post(`${base}/userinfo`)).body).toEqual(user);
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it('cancels polling and ignores a late successful result', async () => {
    let resolve!: (value: typeof user) => void;
    mocks.signIn.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { app, post, get } = makeApp();
    const started = await post(`${base}/flows`);
    const signal = mocks.signIn.mock.calls[0][1] as AbortSignal;
    expect(
      (
        await request(app)
          .delete(`${base}/flows/${started.body.id}`)
          .set('Authorization', 'Bearer daemon')
          .send({})
      ).status,
    ).toBe(204);
    expect(signal.aborted).toBe(true);
    resolve(user);
    expect((await get(`${base}/flows/${started.body.id}`)).status).toBe(404);
  });
  it('bounds active flows and aborts them on daemon shutdown', async () => {
    const { post } = makeApp();
    for (let i = 0; i < 8; i++)
      expect((await post(`${base}/flows`)).status).toBe(201);
    expect((await post(`${base}/flows`)).status).toBe(429);
    dispose?.();
    for (const call of mocks.signIn.mock.calls)
      expect((call[1] as AbortSignal).aborted).toBe(true);
  });
  it.each([
    [
      new SubscriptionOAuthError(
        'access_denied',
        400,
        'secret',
        undefined,
        'userinfo',
      ),
      'access_denied',
    ],
    [
      new SubscriptionOAuthError(
        'operation_failed',
        undefined,
        '<html>secret</html>',
        undefined,
        'userinfo',
      ),
      'authentication_failed',
    ],
  ])('returns a safe error only', async (error, code) => {
    mocks.userInfo.mockRejectedValue(error);
    const { post, get } = makeApp();
    const started = await post(`${base}/flows`);
    expect((await get(`${base}/flows/${started.body.id}`)).body).toEqual({
      id: started.body.id,
      status: 'error',
      errorCode: code,
      errorStage: 'userinfo',
      ...(error instanceof SubscriptionOAuthError && error.status
        ? { errorStatus: error.status }
        : {}),
    });
    const failed = (await post(`${base}/userinfo`)).body;
    expect(failed).toMatchObject({ code, errorStage: 'userinfo' });
    expect(JSON.stringify(failed)).not.toContain('secret');
  });
  it('aborts userinfo work when the requesting GUI disconnects', async () => {
    mocks.userInfo.mockImplementation(() => new Promise(() => {}));
    const { app } = makeApp();
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const abort = new AbortController();
    const pending = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}/userinfo`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer daemon' },
        signal: abort.signal,
      },
    ).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(mocks.userInfo).toHaveBeenCalledOnce());
      const signal = mocks.userInfo.mock.calls[0][0] as AbortSignal;
      abort.abort();
      await pending;
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('prevents new authorization and identity work while signing out', async () => {
    let finish!: () => void;
    mocks.signOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { post } = makeApp();
    const pending = post(`${base}/revoke`).then((response) => response);
    await vi.waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    try {
      expect((await post(`${base}/flows`)).status).toBe(409);
      expect((await post(`${base}/userinfo`)).status).toBe(409);
      expect(mocks.userInfo).not.toHaveBeenCalled();
    } finally {
      finish();
      expect((await pending).status).toBe(204);
    }
  });
  it('finishes another GUI identity request when sign-out cancels it', async () => {
    mocks.userInfo.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { post } = makeApp();
    const query = post(`${base}/userinfo`).then((response) => response);
    await vi.waitFor(() => expect(mocks.userInfo).toHaveBeenCalledOnce());
    expect((await post(`${base}/revoke`)).status).toBe(204);
    const result = await query;
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'session_changed' });
  });
  it('sign-out cancels flows then invokes shared session revocation without cancelled signal', async () => {
    const { post, get } = makeApp();
    const started = await post(`${base}/flows`);
    const signal = mocks.signIn.mock.calls[0][1] as AbortSignal;
    expect((await post(`${base}/revoke`)).status).toBe(204);
    expect(signal.aborted).toBe(true);
    expect(mocks.signOut).toHaveBeenCalledWith();
    expect((await get(`${base}/flows/${started.body.id}`)).status).toBe(404);
  });
});

it('lets the OAuth client own a grant longer than ten minutes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  mocks.signIn.mockImplementation((onDevice) => {
    onDevice({
      user_code: 'TEST',
      device_code: 'secret',
      verification_uri_complete: 'https://example.test/authorize',
      expiresAt: Date.now() + 900_000,
      expires_in: 900,
    });
    return new Promise(() => {});
  });
  const { post, get } = makeApp();
  const started = await post(`${base}/flows`);
  const signal = mocks.signIn.mock.calls[0][1] as AbortSignal;
  await vi.advanceTimersByTimeAsync(600_001);
  expect(signal.aborted).toBe(false);
  expect((await get(`${base}/flows/${started.body.id}`)).body.status).toBe(
    'waiting',
  );
});

it('preserves safe recovery metadata while hiding backend descriptions', async () => {
  mocks.userInfo.mockRejectedValue(
    new SubscriptionOAuthError(
      'rate_limited',
      429,
      'synthetic-secret',
      60_000,
      'userinfo',
    ),
  );
  const { post, get } = makeApp();
  const started = await post(`${base}/flows`);
  expect((await get(`${base}/flows/${started.body.id}`)).body).toMatchObject({
    errorCode: 'rate_limited',
    errorStage: 'userinfo',
    errorStatus: 429,
    retryAfterMs: 60_000,
  });
  const failed = (await post(`${base}/userinfo`)).body;
  expect(failed).toEqual({
    code: 'rate_limited',
    errorStage: 'userinfo',
    errorStatus: 429,
    retryAfterMs: 60_000,
  });
  expect(JSON.stringify(failed)).not.toContain('synthetic-secret');
});
