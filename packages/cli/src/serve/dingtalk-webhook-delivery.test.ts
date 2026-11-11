/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  runChannelDaemonWorker,
  type ChannelDaemonWorkerHandle,
} from '../commands/channel/daemon-worker.js';
import { resetHomeEnvBootstrapForTesting } from '../config/settings.js';
import { ChannelDeliveryAuthorizationStore } from './channel-delivery-authorization.js';
import type { ChannelWorkerManager } from './channel-worker-manager.js';
import { createBoundChannelDeliveryHandler } from './run-qwen-serve.js';

vi.mock('../commands/channel/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/channel/runtime.js')>()),
  loadChannelsFromExtensions: async () => 0,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetHomeEnvBootstrapForTesting();
});

it('delivers authorized prompt and scheduled results to the configured webhook through the worker', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-webhook-delivery-')),
  );
  const workspace = path.join(root, 'workspace');
  const qwenHome = path.join(root, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(qwenHome);
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('QWEN_HOME', qwenHome);
  vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', path.join(root, 'system.json'));
  vi.stubEnv(
    'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    path.join(root, 'defaults.json'),
  );
  resetHomeEnvBootstrapForTesting();
  fs.writeFileSync(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({
      channels: {
        reports: {
          type: 'dingtalk-webhook',
          webhookUrl:
            'https://oapi.dingtalk.com/robot/send?access_token=test-token',
        },
      },
    }),
  );

  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"errcode":0}');
    });
  });
  let worker: ChannelDaemonWorkerHandle | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const realFetch = globalThis.fetch;
    const transport = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://oapi.dingtalk.com') {
        throw new Error('Unexpected network request');
      }
      return realFetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    });
    vi.stubGlobal('fetch', transport);
    const createSession = vi.fn(async () => {
      throw new Error('Delivery must not start an agent session');
    });
    worker = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace,
      selection: { mode: 'names', names: ['reports'] },
      loadDaemonSdk: async () => ({
        DaemonClient: class {
          async capabilities() {
            return { features: [], workspaceCwd: workspace };
          }
          async requestRest(): Promise<never> {
            throw new Error('Delivery must not call session APIs');
          }
        },
        DaemonSessionClient: {
          createOrAttach: createSession,
          resume: createSession,
          resetWorktree: createSession,
        },
      }),
    });
    expect(worker.channels).toEqual(['reports']);
    const runningWorker = worker;
    // Replace process transport only; the daemon and worker do their own mapping.
    const manager = {
      async deliverChannelMessage(cwd, request) {
        expect(cwd).toBe(workspace);
        await runningWorker.deliverChannelMessage(request);
        return { delivered: true as const };
      },
    } satisfies Pick<ChannelWorkerManager, 'deliverChannelMessage'>;
    const authorizations = new ChannelDeliveryAuthorizationStore();
    const handler = createBoundChannelDeliveryHandler(
      workspace,
      () => manager as ChannelWorkerManager,
      authorizations,
    );
    const target = {
      channelName: 'reports',
      type: 'chat' as const,
      id: 'default',
    };
    const scheduled = {
      sessionId: 'persistent-session',
      taskId: 'daily-report',
      firedAt: 100,
      deliveryId: 'daily-report:100',
      source: 'scheduled' as const,
      target,
      text: '# Scheduled report\n\n**Complete**',
    };
    authorizations.registerScheduledTask(workspace, {
      sessionId: scheduled.sessionId,
      taskId: scheduled.taskId,
      target,
      recurring: true,
    });
    await expect(
      handler({ ...scheduled, target: { ...target, id: 'other' } }),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'channel_delivery_invalid',
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(handler(scheduled)).resolves.toEqual({ status: 'delivered' });

    authorizations.authorizePrompt(workspace, {
      sessionId: scheduled.sessionId,
      deliveryId: 'prompt-1',
      target,
    });
    await expect(
      handler({
        sessionId: scheduled.sessionId,
        deliveryId: 'prompt-1',
        promptId: 'prompt-1',
        source: 'prompt',
        target,
        text: 'Prompt result',
      }),
    ).resolves.toEqual({ status: 'delivered' });
    await runningWorker.deliverChannelMessage({
      deliveryId: 'notify-1',
      channelName: 'reports',
      target: { type: 'chat', id: 'default' },
      text: 'Notification',
    });
    await expect(
      runningWorker.deliverChannelMessage({
        deliveryId: 'invalid-notify',
        channelName: 'reports',
        target: { type: 'chat', id: 'other' },
        text: 'Must not be sent',
      }),
    ).rejects.toMatchObject({ disposition: 'permanent' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(createSession).not.toHaveBeenCalled();
    expect(requests).toEqual(
      [
        { title: 'Scheduled report', text: scheduled.text },
        { title: 'Prompt result', text: 'Prompt result' },
        { title: 'Notification', text: 'Notification' },
      ].map((markdown) => ({
        method: 'POST',
        url: '/robot/send?access_token=test-token',
        body: { msgtype: 'markdown', markdown },
      })),
    );
  } finally {
    try {
      await worker?.close();
    } finally {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
