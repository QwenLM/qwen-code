/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from "../config/brand.js";

import { SettingsService } from '@qwen-code/resource';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { Config } from '../config/config.js';
import { createCustomModelProviders } from '../provider/impl/customModelProviderFactory.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { ChatCompletionsTransport } from '../provider/transport/impl/chatCompletionsTransport.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';
import { createEmptyLoadedSettings } from './config.js';

export interface CapturedModelRequest {
  model: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content: unknown }>;
}

// Only the remote server is a fixture. Selection, query,
// tools, persistence and protocol conversion run their production implementations.
export async function createProviderHttpFixture(
  response: (index: number) => Record<string, unknown> = () => ({
    role: 'assistant',
    content: 'PROVIDER_HTTP_OK',
  }),
  sessionPersistence = false,
) {
  const dir = await mkdtemp(join(tmpdir(), 'provider-http-'));
  vi.stubEnv(ENV_CONFIG_DIR, join(dir, 'config'));
  _resetConfigHomeDirCache();
  const requests: CapturedModelRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as CapturedModelRequest;
    requests.push(body);
    const delta = response(requests.length - 1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, finish] of [
      [delta, null],
      [{}, delta['tool_calls'] ? 'tool_calls' : 'stop'],
    ]) {
      res.write(
        `data: ${JSON.stringify({
          id: `response-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: part, finish_reason: finish }],
          ...(finish
            ? {
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  total_tokens: 12,
                },
              }
            : {}),
        })}\n\n`,
      );
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settingsService = new SettingsService();
  const providers = createCustomModelProviders(
    {
      fixture: {
        apiKey: 'fixture-key',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: 'model-a',
        models: ['model-a', 'model-b', 'model-c'].map((model) => ({
          model,
          contextWindow: 200000,
          maxOutputTokens: 4096,
          capabilities: {
            tools: true,
            thinking: {
              modes: ['adaptive'],
              supportsEffort: true,
              supportedEffortLevels: ['low', 'high'],
            },
          },
        })),
      },
    },
    new ModelTransportManager([new ChatCompletionsTransport()]),
    settingsService,
    'user',
  );
  for (const provider of providers) await provider.start();
  const config = new Config({
    loadedSettings: createEmptyLoadedSettings(),
    settingsService,
    sessionId: 'provider-http-session',
    targetDir: dir,
    cwd: dir,
    debugMode: false,
    model: 'fixture/model-a',
    sessionPersistence,
    maxAttempts: 1,
    modelProviderFactory: () => providers,
  });
  const manager = config.getModelProviderManager();
  manager.setMainModel((await manager.getModel('fixture/model-a'))!, false);
  return {
    dir,
    config,
    manager,
    requests,
    async dispose() {
      await config.dispose();
      for (const provider of providers) await provider.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      _resetConfigHomeDirCache();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
