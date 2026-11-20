/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// The helper's only job is the client-side half of the daemon contract: the
// method and path each wrapper builds, and how a 404 is read. A wrong path here
// would silently turn the panel's cancel into a 404 and bring back the orphan
// flow, so the wiring is pinned rather than assumed.
const restRequest = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
);
vi.mock('../../daemon/rest-request.js', () => ({
  createDaemonRestRequest: () => restRequest,
}));

const {
  cancelWeixinLoginFlow,
  getWeixinAccountStatus,
  getWeixinLoginFlow,
  revokeWeixinLogin,
  startWeixinLogin,
  WeixinAuthError,
} = await import('./weixin-auth-api');

const target = {
  baseUrl: 'http://127.0.0.1:4170',
  token: 'tok',
};

function respond(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  restRequest.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response);
}

function called() {
  const last = restRequest.mock.calls.at(-1);
  return {
    path: last?.[0],
    method: last?.[1]?.method,
    authorization: new Headers(last?.[1]?.headers).get('authorization'),
  };
}

describe('weixin auth API wiring', () => {
  it('gives the mint-backed start its own budget, not the poll budget', async () => {
    // The start handler awaits the upstream QR mint, which the daemon allows
    // 30 s. On the shared 15 s poll budget a 16–30 s mint aborted in the
    // browser and the daemon then cancelled the flow it was about to return.
    // The budget is read off AbortSignal.timeout rather than inferred from the
    // signal, which does not expose its deadline.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      respond({ id: 'flow-1', status: 'waiting' });
      await startWeixinLogin(target);
      expect(timeout).toHaveBeenLastCalledWith(35_000);

      respond({ id: 'flow-1', status: 'waiting' });
      await getWeixinLoginFlow(target, 'flow-1');
      expect(timeout).toHaveBeenLastCalledWith(15_000);

      respond({ enabled: true, configured: false });
      await getWeixinAccountStatus(target);
      expect(timeout).toHaveBeenLastCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('reads the account status from the process-global route', async () => {
    respond({ enabled: true, configured: false });

    await expect(getWeixinAccountStatus(target)).resolves.toEqual({
      enabled: true,
      configured: false,
    });
    expect(called()).toMatchObject({
      path: '/auth/weixin',
      method: 'GET',
      authorization: 'Bearer tok',
    });
  });

  it('starts a flow with a POST', async () => {
    respond(
      { id: 'f1', status: 'waiting', qrcodeUrl: 'https://qr' },
      { status: 201 },
    );

    await startWeixinLogin(target);
    expect(called()).toMatchObject({
      path: '/auth/weixin/flows',
      method: 'POST',
    });
  });

  it('polls one flow by its encoded id', async () => {
    respond({ id: 'a/b', status: 'scanned' });

    await getWeixinLoginFlow(target, 'a/b');
    expect(called()).toMatchObject({
      path: '/auth/weixin/flows/a%2Fb',
      method: 'GET',
    });
  });

  it('cancels one flow with DELETE on its own id', async () => {
    respond(undefined, { status: 204 });

    await cancelWeixinLoginFlow(target, 'flow-1');
    expect(called()).toMatchObject({
      path: '/auth/weixin/flows/flow-1',
      method: 'DELETE',
    });
  });

  it('revokes the stored account', async () => {
    respond(undefined, { status: 204 });

    await revokeWeixinLogin(target);
    expect(called()).toMatchObject({
      path: '/auth/weixin/revoke',
      method: 'POST',
    });
  });

  it('reads a 404 as "this daemon does not support login"', async () => {
    // A daemon that predates the routes answers 404 for every one of them; the
    // panel renders that as unsupported rather than as a failure.
    respond(undefined, { status: 404 });

    await expect(getWeixinAccountStatus(target)).resolves.toBeUndefined();
  });

  it('surfaces the daemon code for a refused start', async () => {
    respond({ code: 'too_many_flows' }, { status: 429 });

    await expect(startWeixinLogin(target)).rejects.toMatchObject({
      name: 'WeixinAuthError',
      code: 'too_many_flows',
      status: 429,
    });
    expect(new WeixinAuthError('x').name).toBe('WeixinAuthError');
  });
});
