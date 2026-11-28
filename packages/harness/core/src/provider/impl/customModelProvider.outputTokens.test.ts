/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '@qwen-code/resource';
import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { Storage } from '../../config/storage.js';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';
import { CustomProviderManager } from '../custom/customProviderManager.js';
import type { ModelSelectContext } from '../model/modelSelectContext.js';
import { ChatCompletionsTransport } from '../transport/impl/chatCompletionsTransport.js';
import { MessagesTransport } from '../transport/impl/messagesTransport.js';
import { ResponsesTransport } from '../transport/impl/responsesTransport.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { createCustomModelProvidersFromSettingsTexts } from './customModelProviderFactory.js';
import { ModelProviderManager } from './modelProviderManager.js';

const protocols = [
  {
    protocol: 'openai',
    path: '/v1/chat/completions',
    field: 'max_tokens',
    frames: [
      {
        id: 'a',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'answer' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'a',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ],
  },
  {
    protocol: 'openai-responses',
    path: '/v1/responses',
    field: 'max_output_tokens',
    frames: [
      { type: 'response.created', response: { id: 'a', model: 'm' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'answer' },
      { type: 'response.completed', response: {} },
    ],
  },
  {
    protocol: 'anthropic',
    path: '/v1/messages',
    field: 'max_tokens',
    frames: [
      { type: 'message_start', message: { id: 'a', model: 'm' } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'answer' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ],
  },
] as const;

it.each(protocols)(
  '$protocol applies business overrides, persisted preferences, then provider defaults',
  async ({ protocol, path, field, frames }) => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-output-tokens-'));
    vi.stubEnv(ENV_CONFIG_DIR, join(dir, 'config'));
    _resetConfigHomeDirCache();
    const settingsService = new SettingsService();
    const requests: Array<{
      path: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      );
    });
    let manager: ModelProviderManager | undefined;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const source = settingsService.getUserSettingsSource(
        Storage.getGlobalSettingsPath(),
      );
      const configs = new CustomProviderManager(settingsService);
      await configs.create({
        providerId: 'gateway',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: 'test-only-key',
        protocol,
        models: [{ model: 'm', maxOutputTokens: 8192 }],
      });
      const transports = new ModelTransportManager([
        new ChatCompletionsTransport(),
        new ResponsesTransport(),
        new MessagesTransport(),
      ]);
      manager = new ModelProviderManager({
        userProviders: createCustomModelProvidersFromSettingsTexts(
          [source.read()],
          transports,
          settingsService,
          'user',
        ),
        modelTransportManager: transports,
        settingsService,
        projectPath: dir,
      });
      await manager.start();
      manager.setMainModel((await manager.getModel('gateway/m'))!, false);

      async function assertRequestLimit(
        input: ModelSelectContext,
        expected: number,
        expectedModel = 'm',
      ) {
        const resolution = await manager!.select(input);
        const response = await manager!.inference({
          resolution,
          prompt: { messages: [{ role: 'user', content: 'hello' }] },
        });
        expect((await response.completed).blocks).toEqual([
          expect.objectContaining({ type: 'text', text: 'answer' }),
        ]);
        expect(requests.at(-1)).toEqual({
          path,
          body: expect.objectContaining({ model: expectedModel, [field]: expected }),
        });
      }

      await assertRequestLimit({ purpose: 'main' }, 8192);
      await configs.update({
        providerId: 'gateway',
        models: [
          { model: 'm', maxOutputTokens: 12288 },
          { model: 'helper', maxOutputTokens: 6144 },
        ],
      });
      const saved = JSON.parse(source.read()!);
      saved.providers.gateway.routing = { summary: 'helper' };
      source.mutate((settings) => {
        settings['providers'] = saved.providers;
        return true;
      });
      await manager.replaceCustomProviders(saved.providers, {});
      await assertRequestLimit({ purpose: 'main' }, 12288);

      for (const maxTokens of [4096, 16384]) {
        source.mutate((settings) => {
          settings['model'] = {
            preferences: {
              'gateway/m': { maxTokens },
              'gateway/helper': { maxTokens: 24576 },
            },
          };
          return true;
        });
        await manager.stop();
        await manager.start();
        manager.setMainModel((await manager.getModel('gateway/m'))!, false);
        await assertRequestLimit({ purpose: 'main' }, maxTokens);
        await assertRequestLimit({ purpose: 'title' }, maxTokens);
        await assertRequestLimit(
          {
            purpose: 'summary',
            overrideSelection: { key: 'gateway/m' },
          },
          maxTokens,
        );
      }
      await assertRequestLimit(
        {
          purpose: 'title',
          overrideSelection: {
            config: { context: { maxOutputTokens: 2048 } },
          },
        },
        2048,
      );
      await assertRequestLimit(
        {
          purpose: 'main',
          overrideSelection: {
            config: { context: { maxOutputTokens: 32768 } },
          },
        },
        32768,
      );
      for (const purpose of [
        'hook_prompt', 'plan', 'auto_permission', 'insights', 'suggestion',
        'generate', 'web_fetch', 'side_question', 'fork',
      ] as const) {
        await assertRequestLimit({ purpose }, 16384);
      }
      await assertRequestLimit({ purpose: 'summary' }, 24576, 'helper');
      await assertRequestLimit({
        purpose: 'main',
        overrideSelection: { key: 'gateway/helper' },
      }, 24576, 'helper');
      await assertRequestLimit({
        purpose: 'summary',
        overrideSelection: { config: { context: { maxOutputTokens: 40960 } } },
      }, 40960, 'helper');
      const parentSelection = await manager.select({
        purpose: 'main',
        overrideSelection: { config: { context: { maxOutputTokens: 24576 } } },
      });
      for (const purpose of ['main', 'hook_prompt', 'task', 'compact'] as const) {
        await assertRequestLimit({ purpose, parentSelection }, 24576);
        await assertRequestLimit({
          purpose,
          parentSelection,
          overrideSelection: {
            model: parentSelection.model,
            config: { context: { maxOutputTokens: 40960 } },
          },
        }, 40960);
      }
      await assertRequestLimit({
        purpose: 'suggestion',
        parentSelection,
        overrideSelection: { model: parentSelection.model, config: {} },
      }, 24576);
      for (const purpose of ['fork', 'side_question'] as const) {
        await assertRequestLimit({ purpose, parentSelection }, 24576);
      }
      for (const purpose of ['main', 'fork'] as const) {
        await assertRequestLimit({
          purpose,
          modelResolution: parentSelection,
          adjustment: { kind: 'output-limit', maxOutputTokens: 49152 },
        }, 49152);
      }
      manager.setSelectionPolicy(async () => ({
        config: { context: { maxOutputTokens: 57344 } },
      }));
      await assertRequestLimit({
        purpose: 'main',
        request: { sessionId: 'test', turnIndex: 1 },
        overrideSelection: { config: { context: { maxOutputTokens: 1024 } } },
      }, 57344);
      manager.setSelectionPolicy(async () => ({ key: 'gateway/helper' }));
      await assertRequestLimit({
        purpose: 'main',
        request: { sessionId: 'test', turnIndex: 2 },
      }, 24576, 'helper');
      manager.setSelectionPolicy(undefined);
      source.mutate((settings) => {
        delete settings['model'];
        return true;
      });
      await manager.stop();
      await manager.start();
      manager.setMainModel((await manager.getModel('gateway/m'))!, false);
      await assertRequestLimit({ purpose: 'main' }, 12288);
      await assertRequestLimit({ purpose: 'summary' }, 6144, 'helper');
      await configs.update({
        providerId: 'gateway',
        models: [{ model: 'm' }, { model: 'helper', maxOutputTokens: 6144 }],
      });
      await manager.replaceCustomProviders(JSON.parse(source.read()!).providers, {});
      await assertRequestLimit({ purpose: 'main' }, 32000);
      expect(requests).toHaveLength(40);
    } finally {
      await manager?.stop();
      await settingsService.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      _resetConfigHomeDirCache();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
