/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { bearerAuth, createMutationGate } from '../auth.js';
import { registerGoogleOAuthRoutes } from './google-oauth.js';

let dispose: (() => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runtimeWith(
  workspaceCwd: string,
  trusted: boolean,
  start?: () => Promise<void>,
) {
  const calls: unknown[][] = [];
  const invoke = vi.fn(
    async (ctx: unknown, method: string, params: unknown) => {
      calls.push([ctx, method, params]);
      const cwd = (ctx as { workspaceCwd: string }).workspaceCwd;
      if (method === 'qwen/google-oauth/start') {
        await start?.();
        return { id: `flow-${cwd.replace(/\//g, '')}`, status: 'waiting' };
      }
      if (method === 'qwen/google-oauth/status') {
        return {
          id: (params as { id: string }).id,
          status: 'awaiting-code',
          authorizationUrl: 'https://accounts.google.test/oauth',
        };
      }
      if (method === 'qwen/google-oauth/code') return { accepted: true };
      if (method === 'qwen/google-oauth/cancel') return { cancelled: true };
      if (method === 'qwen/google-oauth/logout') return { signedOut: true };
      throw new Error('unexpected command');
    },
  );
  const runtime = {
    workspaceCwd,
    trusted,
    workspaceService: { googleOAuthCommand: invoke },
  } as unknown as WorkspaceRuntime;
  return { runtime, invoke, calls };
}

function makeApp(
  options: {
    trusted?: boolean;
    selectedTrusted?: boolean;
    tokenConfigured?: boolean;
    manyWorkspaces?: boolean;
    start?: () => Promise<void>;
  } = {},
) {
  const tokenConfigured = options.tokenConfigured ?? true;
  const primary = runtimeWith(
    '/primary',
    options.trusted ?? true,
    options.start,
  );
  const selected = runtimeWith('/workspace', options.selectedTrusted ?? true);
  const other = runtimeWith('/other', true);
  const untrusted = runtimeWith('/untrusted', false);
  const runtimes = [
    primary,
    ...(options.manyWorkspaces
      ? Array.from({ length: 9 }, (_, index) =>
          runtimeWith(`/workspace-${index}`, true, options.start),
        )
      : [selected, other, untrusted]),
  ];
  const registry = {
    primaryEntry: {
      state: 'active',
      current: { runtime: primary.runtime },
    },
    getEntryByWorkspaceId: (id: string) =>
      runtimes.find((item) => item.runtime.workspaceCwd === id)
        ? {
            state: 'active',
            current: {
              runtime: runtimes.find(
                (item) => item.runtime.workspaceCwd === id,
              )!.runtime,
            },
          }
        : undefined,
    getEntryByWorkspaceCwd: (cwd: string) =>
      runtimes.find((item) => item.runtime.workspaceCwd === cwd)
        ? {
            state: 'active',
            current: {
              runtime: runtimes.find(
                (item) => item.runtime.workspaceCwd === cwd,
              )!.runtime,
            },
          }
        : undefined,
  } as unknown as WorkspaceRegistry;
  const app = express();
  app.use(express.json());
  app.use(bearerAuth(tokenConfigured ? 'daemon' : undefined));
  dispose = registerGoogleOAuthRoutes(app, {
    workspaceRegistry: registry,
    mutate: createMutationGate({ tokenConfigured, requireAuth: true }),
    sendBridgeError: (res, error) => {
      res.status(503).json({
        code: 'bridge_error',
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  return { app, primary, selected, other, untrusted, registry, runtimes };
}

function workspaceUrl(workspace: string, suffix = '') {
  return `/workspaces/${encodeURIComponent(workspace)}/auth/google/flows${suffix}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

describe('Google OAuth daemon routes', () => {
  it('runs a flow through the owning runtime and forwards cancellation', async () => {
    const { app, primary } = makeApp();
    const started = await request(app)
      .post('/auth/google/flows')
      .set('Authorization', 'Bearer daemon');
    expect(started.status).toBe(201);
    const id = started.body.id as string;

    const status = await request(app)
      .get(`/auth/google/flows/${id}`)
      .set('Authorization', 'Bearer daemon');
    expect(status.body).toMatchObject({ status: 'awaiting-code' });

    const accepted = await request(app)
      .post(`/auth/google/flows/${id}/code`)
      .set('Authorization', 'Bearer daemon')
      .send({ code: 'manual-code' });
    expect(accepted.status).toBe(202);

    expect(
      (
        await request(app)
          .delete(`/auth/google/flows/${id}`)
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(204);
    expect(primary.calls.at(-1)).toMatchObject([
      { workspaceCwd: '/primary' },
      'qwen/google-oauth/cancel',
      { id },
    ]);
    expect(
      (
        await request(app)
          .get(`/auth/google/flows/${id}`)
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(404);
  });

  it('forwards logout only to the selected trusted runtime', async () => {
    const { app, primary, selected } = makeApp();
    expect(
      (
        await request(app)
          .delete(`/workspaces/${encodeURIComponent('/workspace')}/auth/google`)
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(204);
    expect(primary.invoke).not.toHaveBeenCalled();
    expect(selected.calls.at(-1)?.[1]).toBe('qwen/google-oauth/logout');
  });

  it('rejects cross-workspace and legacy access without touching the owner', async () => {
    const { app, primary, selected, other, untrusted } = makeApp();
    const started = await request(app)
      .post(workspaceUrl('/workspace'))
      .set('Authorization', 'Bearer daemon');
    expect(started.status).toBe(201);
    expect(primary.invoke).not.toHaveBeenCalled();
    const id = started.body.id as string;
    const before = selected.invoke.mock.calls.length;

    for (const path of [
      workspaceUrl('/other', `/${id}`),
      workspaceUrl('/untrusted', `/${id}`),
      workspaceUrl('/unknown', `/${id}`),
      `/auth/google/flows/${id}`,
    ]) {
      const response = await request(app)
        .get(path)
        .set('Authorization', 'Bearer daemon');
      expect(response.status).not.toBe(200);
    }
    expect(selected.invoke).toHaveBeenCalledTimes(before);
    expect(other.invoke).not.toHaveBeenCalled();
    expect(untrusted.invoke).not.toHaveBeenCalled();

    expect(
      (
        await request(app)
          .post(workspaceUrl('/other', `/${id}/code`))
          .set('Authorization', 'Bearer daemon')
          .send({ code: 'cross-workspace' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .delete(workspaceUrl('/other', `/${id}`))
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(409);
    expect(selected.invoke).toHaveBeenCalledTimes(before);
  });

  it('checks an untrusted selected runtime and validates a code on a real flow', async () => {
    const denied = makeApp({ selectedTrusted: false });
    expect(
      (
        await request(denied.app)
          .post(workspaceUrl('/workspace'))
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(403);
    expect(denied.selected.invoke).not.toHaveBeenCalled();
    expect(denied.primary.invoke).not.toHaveBeenCalled();
    const deniedDispose = dispose;
    deniedDispose?.();
    dispose = undefined;

    const { app, primary } = makeApp();
    await request(app)
      .post('/auth/google/flows')
      .set('Authorization', 'Bearer daemon');
    expect(
      (
        await request(app)
          .post('/auth/google/flows/flow-primary/code')
          .set('Authorization', 'Bearer daemon')
          .send({ code: ' ' })
      ).status,
    ).toBe(400);
    expect(
      primary.calls.filter(([, method]) => method === 'qwen/google-oauth/code'),
    ).toHaveLength(0);
  });

  it('enforces strict mutation auth separately from the bearer middleware', async () => {
    const { app, primary } = makeApp({ tokenConfigured: false });
    try {
      for (const prepare of [
        () => request(app).post('/auth/google/flows'),
        () => request(app).post('/auth/google/flows/id/code'),
        () => request(app).delete('/auth/google/flows/id'),
        () => request(app).delete('/auth/google'),
      ]) {
        const response = await prepare();
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('token_required');
      }
      expect(primary.invoke).not.toHaveBeenCalled();
    } finally {
      dispose?.();
      dispose = undefined;
    }
  });

  it('counts pending starts within the process-wide capacity', async () => {
    const start = deferred<void>();
    const { app, runtimes } = makeApp({
      start: () => start.promise,
      manyWorkspaces: true,
    });
    const pending = Array.from({ length: 9 }, (_, index) =>
      Promise.resolve(
        request(app)
          .post(workspaceUrl(`/workspace-${index}`))
          .set('Authorization', 'Bearer daemon'),
      ),
    );
    await vi.waitFor(() => {
      const calls = runtimes.reduce(
        (count, runtime) => count + runtime.invoke.mock.calls.length,
        0,
      );
      expect(calls).toBe(8);
    });
    start.resolve();
    const responses = await Promise.all(pending);
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(8);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(1);
  });

  it('reclaims idle records even when no terminal status was polled', async () => {
    vi.useFakeTimers();
    const { app, primary } = makeApp();
    const id = (
      await request(app)
        .post('/auth/google/flows')
        .set('Authorization', 'Bearer daemon')
    ).body.id as string;
    await vi.advanceTimersByTimeAsync(7 * 60_000 + 1);
    expect(
      (
        await request(app)
          .get(`/auth/google/flows/${id}`)
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(404);
    expect(
      primary.calls.filter(
        ([, method]) => method === 'qwen/google-oauth/cancel',
      ),
    ).toHaveLength(1);
  });

  it('cancels a flow that completes after the route has been disposed', async () => {
    const start = deferred<void>();
    const { app, primary } = makeApp({ start: () => start.promise });
    const pending = Promise.resolve(
      request(app)
        .post('/auth/google/flows')
        .set('Authorization', 'Bearer daemon'),
    );
    await vi.waitFor(() => expect(primary.invoke).toHaveBeenCalledOnce());
    dispose?.();
    dispose = undefined;
    start.resolve();
    expect((await pending).status).toBe(404);
    expect(primary.calls.at(-1)?.[1]).toBe('qwen/google-oauth/cancel');
    expect(
      primary.calls.filter(
        ([, method]) => method === 'qwen/google-oauth/cancel',
      ),
    ).toHaveLength(1);
  });

  it('aborts a late flow when its client disconnects during start', async () => {
    const start = deferred<void>();
    const { app, primary } = makeApp({ start: () => start.promise });
    const pending = request(app)
      .post('/auth/google/flows')
      .set('Authorization', 'Bearer daemon');
    const settled = Promise.resolve(pending).catch(() => undefined);
    await vi.waitFor(() => expect(primary.invoke).toHaveBeenCalledOnce());
    pending.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    start.resolve();
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      primary.calls.filter(
        ([, method]) => method === 'qwen/google-oauth/cancel',
      ),
    ).toHaveLength(1);
  });

  it('retains a cancel failure until the remote cancellation can be retried', async () => {
    const { app, primary } = makeApp();
    await request(app)
      .post('/auth/google/flows')
      .set('Authorization', 'Bearer daemon');
    primary.invoke.mockImplementationOnce(async (ctx, method, params) => {
      primary.calls.push([ctx, method, params]);
      throw new Error('cancel temporarily failed');
    });
    expect(
      (
        await request(app)
          .delete('/auth/google/flows/flow-primary')
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(503);
    expect(
      (
        await request(app)
          .get('/auth/google/flows/flow-primary')
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .delete('/auth/google/flows/flow-primary')
          .set('Authorization', 'Bearer daemon')
      ).status,
    ).toBe(204);
    expect(primary.calls.map(([, method]) => method)).toEqual([
      'qwen/google-oauth/start',
      'qwen/google-oauth/cancel',
      'qwen/google-oauth/status',
      'qwen/google-oauth/cancel',
    ]);
  });
});
