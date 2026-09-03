/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { createServer, get } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getServeAppLifecycle,
  installServeAppLifecycle,
} from './serve-app-lifecycle.js';

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe('ServeAppLifecycle', () => {
  it('opens boot only after the bound listener and host startup are ready', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    let markReady: (() => void) | undefined;
    const startupReady = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const server = createServer(app);
    servers.add(server);
    lifecycle.bindServer(server, { startupReady });
    const boot = vi.fn(async () => undefined);
    lifecycle.setBootStarter(boot);

    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    expect(boot).not.toHaveBeenCalled();
    markReady?.();
    await lifecycle.awaitBootAdmission();
    await vi.waitFor(() => expect(boot).toHaveBeenCalledOnce());
  });

  it('rejects unbound, already-listening, and duplicate binding', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    await expect(lifecycle.awaitBootAdmission()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
    });

    const listening = createServer(app);
    servers.add(listening);
    listening.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listening.once('listening', resolve));
    expect(() => lifecycle.bindServer(listening)).toThrow(/before its first/);

    const otherApp = express();
    const otherLifecycle = installServeAppLifecycle(otherApp);
    const first = createServer(otherApp);
    const second = createServer(otherApp);
    servers.add(first);
    servers.add(second);
    otherLifecycle.bindServer(first);
    expect(() => otherLifecycle.bindServer(second)).toThrow(/one server/);

    const closedLifecycle = installServeAppLifecycle(express());
    await closedLifecycle.close();
    expect(() => closedLifecycle.bindServer(createServer())).toThrow(
      /before its first listen/,
    );
  });

  it('runs direct-embed cleanup after a pre-listen server error', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    const drain = vi.fn(async () => undefined);
    const boot = vi.fn(async () => undefined);
    lifecycle.setAppDrain(drain);
    lifecycle.setBootStarter(boot);
    lifecycle.bindServer(server);

    server.emit('error', new Error('listen failed'));
    await lifecycle.close();

    expect(drain).toHaveBeenCalledOnce();
    expect(boot).not.toHaveBeenCalled();
  });

  it('waits for listener, app, and host drain before releasing ownership', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    let releaseApp: (() => void) | undefined;
    let releaseHost: (() => void) | undefined;
    const appDrain = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    const hostDrain = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const release = vi.fn(async () => true);
    lifecycle.setOwnership({
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release,
    });
    lifecycle.setAppDrain(() => appDrain);
    lifecycle.bindServer(server, { drainHost: () => hostDrain });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const close = lifecycle.close();
    await vi.waitFor(() => expect(server.listening).toBe(false));
    expect(release).not.toHaveBeenCalled();
    releaseApp?.();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    releaseHost?.();
    await close;
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses the same cleanup when the embed closes the server directly', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    const drain = vi.fn(async () => undefined);
    const release = vi.fn(async () => true);
    lifecycle.setAppDrain(drain);
    lifecycle.setOwnership({
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release,
    });
    lifecycle.bindServer(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    server.close();
    await lifecycle.close();
    expect(drain).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(getServeAppLifecycle(app)).toBe(lifecycle);
  });

  it('force-closes active connections when an embed listener is already closing', async () => {
    const app = express();
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    app.get('/hold', () => requestStarted?.());
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    const release = vi.fn(async () => true);
    lifecycle.setOwnership({
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release,
    });
    lifecycle.bindServer(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const client = get(`http://127.0.0.1:${address.port}/hold`);
    client.on('error', () => undefined);
    await started;

    server.close();
    expect(server.listening).toBe(false);
    await lifecycle.close({ timeoutMs: 0 });

    expect(release).toHaveBeenCalledOnce();
    client.destroy();
  });

  it('starts every drain and listener close when one drain throws synchronously', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    const hostDrain = vi.fn(async () => undefined);
    const release = vi.fn(async () => true);
    lifecycle.setAppDrain(() => {
      throw new Error('app drain failed');
    });
    lifecycle.setOwnership({
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release,
    });
    lifecycle.bindServer(server, { drainHost: hostDrain });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    await expect(lifecycle.close()).rejects.toThrow('app drain failed');
    expect(hostDrain).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it('tracks an explicit boot retry after the automatic attempt fails', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    const automaticBoot = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first boot failed'))
      .mockResolvedValue(undefined);
    lifecycle.setBootStarter(automaticBoot);
    lifecycle.bindServer(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await vi.waitFor(() => expect(automaticBoot).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lifecycle.getBootPromise()).toBeUndefined());

    await expect(lifecycle.startBoot(automaticBoot)).resolves.toBeUndefined();
    expect(automaticBoot).toHaveBeenCalledTimes(2);
  });

  it('waits for an explicit boot retry before releasing ownership', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    let finishBoot: (() => void) | undefined;
    const bootPending = new Promise<void>((resolve) => {
      finishBoot = resolve;
    });
    const boot = vi.fn(() => bootPending);
    const release = vi.fn(async () => true);
    lifecycle.setOwnership({
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release,
    });
    lifecycle.bindServer(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const retry = lifecycle.startBoot(boot);
    await vi.waitFor(() => expect(boot).toHaveBeenCalledOnce());
    const close = lifecycle.close();
    await vi.waitFor(() => expect(server.listening).toBe(false));
    expect(release).not.toHaveBeenCalled();
    finishBoot?.();
    await retry;
    await close;
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a late boot after shutdown has sealed admission', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    lifecycle.bindServer(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    await lifecycle.close();
    const boot = vi.fn(async () => undefined);
    await expect(lifecycle.startBoot(boot)).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
    });
    expect(boot).not.toHaveBeenCalled();
  });

  it('maps host startup failure to the structured unavailable error', async () => {
    const app = express();
    const lifecycle = installServeAppLifecycle(app);
    const server = createServer(app);
    servers.add(server);
    let rejectStartup: ((error: Error) => void) | undefined;
    const startupReady = new Promise<void>((_resolve, reject) => {
      rejectStartup = reject;
    });
    lifecycle.bindServer(server, { startupReady });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const admission = lifecycle.awaitBootAdmission();
    rejectStartup?.(new Error('private startup detail'));

    await expect(admission).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
  });
});
