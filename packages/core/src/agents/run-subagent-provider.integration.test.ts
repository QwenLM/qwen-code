/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingsService } from '@qwen-code/resource';
import { createCustomModelProviders } from '../provider/impl/customModelProviderFactory.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { ChatCompletionsTransport } from '../provider/transport/impl/chatCompletionsTransport.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { runSideQuestion } from '../core/side-question.js';
import { runSubagent } from './run-subagent.js';
import { SubagentForkContext } from './subagent-fork-context.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

import { TaskRegistry } from '../tasks/task-registry.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';

// Exercise actual Agent, fork and side-question query/HTTP/SSE paths. Only the remote account
// permission service is a fixture; this never bypasses a production gate.
describe('Subagent Provider bridge with a direct custom HTTP endpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { entry: 'agent', requestedModel: 'main' },
    { entry: 'agent', requestedModel: 'child' },
    { entry: 'fork-default', requestedModel: 'main' },
    { entry: 'fork-explicit', requestedModel: 'child' },
    { entry: 'fork-parent', requestedModel: 'main' },
    { entry: 'fork-registered', requestedModel: 'child' },
    { entry: 'fork-registered-parent', requestedModel: 'main' },
    { entry: 'side-fresh', requestedModel: 'main' },
  ])(
    'selects $requestedModel through the real $entry/query/HTTP chain',
    async ({ entry, requestedModel }) => {
      const calls: Array<{ model: string; roles: string[] }> = [];
      const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls.push({
          model: body.model,
          roles: body.messages.map((m: { role: string }) => m.role),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (delta: object, finish_reason: string | null) => ({
          id: 'direct-task-response',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
        res.write(
          `data: ${JSON.stringify(frame({ role: 'assistant', content: 'DIRECT_TASK_OK' }, null))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...frame({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const settingsService = new SettingsService();
      const transports = new ModelTransportManager([
        new ChatCompletionsTransport(),
      ]);
      const providers = {
        fixture: {
          apiKey: 'fixture-key',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          model: 'main',
          models: [{ model: 'main' }, { model: 'child' }],
          routing: { subagent: 'child' },
        },
      };
      const runtimeProviders = createCustomModelProviders(
        providers,
        transports,
        settingsService,
        'user',
      );
      for (const provider of runtimeProviders) await provider.start();
      const config = new Config({
        loadedSettings: createEmptyLoadedSettings(),
        settingsService,
        sessionId: 'direct-subagent-session',
        targetDir: '.',
        cwd: '.',
        debugMode: false,
        model: 'fixture/main',
        sessionPersistence: false,
        maxAttempts: 1,
        modelProviderFactory: () => runtimeProviders,
      });
      const manager = config.getModelProviderManager();
      try {
        manager.setMainModel((await manager.getModel('fixture/main'))!, false);
        const parentSelection = await manager.select({ purpose: 'main' });
        const select = vi.spyOn(manager, 'select');
        const host = vi.fn<NonNullable<Config['getModelPolicy']>>(
          async () => undefined,
        );
        config.setModelPolicyCallbacks(host);
        const registeredFork = entry.startsWith('fork-registered');
        const completion = vi.fn();
        if (registeredFork) {
          config.taskRegistry = new TaskRegistry();
          config.taskRegistry.register({
            id: 'a-direct-fork',
            agentId: 'direct-fork',
            agentName: 'fork',
            agentType: 'fork',
            resolvedModel: 'fixture/child',
            type: 'local_agent',
            status: 'running',
            description: 'Fork',
            startTime: 0,
            notified: false,
            executionId: 1,
            completionBehavior: 'silent',
            prompt: 'Inspect',
            isBackgrounded: false,
            taskId: 'fork-task',
          });
        }
        if (entry !== 'agent') {
          const result =
            entry === 'side-fresh'
              ? await runSideQuestion({
                  config,
                  sessionId: config.getSessionId(),
                  question: 'Return DIRECT_TASK_OK',
                  systemPrompt: systemPromptFromText('Return the marker.'),
                })
              : await runForkedAgent({
                  config,
                  sessionId: config.getSessionId(),
                  prompt: 'Return DIRECT_TASK_OK',
                  promptId: 'direct-fork',
                  forkLabel: 'fixture',
                  systemPrompt: systemPromptFromText('Return the marker.'),
                  ...(entry === 'fork-explicit'
                    ? { model: 'fixture/child' }
                    : {}),
                  ...(entry === 'fork-parent' ||
                  entry === 'fork-registered-parent'
                    ? { parentSelection }
                    : {}),
                  ...(registeredFork
                    ? {
                        agentType: 'fork',
                        attachmentCtx: createAttachmentContext(
                          process.cwd(),
                          'direct-fork',
                          { config, isMainAgent: false },
                        ),
                        toolRegistry: {
                          getSchema: () => [],
                        } as unknown as ToolRegistry,
                        onCompleted: completion,
                      }
                    : {}),
                });
          expect(result.textContent).toBe('DIRECT_TASK_OK');
          expect(calls.map((call) => call.model)).toEqual([requestedModel]);
          expect(select).toHaveBeenCalledOnce();
          expect(host).toHaveBeenCalledTimes(entry === 'side-fresh' ? 1 : 0);
          expect(manager.getMainModelKey()).toBe('fixture/main');
          if (registeredFork) {
            expect(select.mock.calls[0][0].overrideSelection).toBeUndefined();
            expect(completion).toHaveBeenCalledWith(
              expect.objectContaining({ model: `fixture/${requestedModel}` }),
            );
          }
          return;
        }

        const result = await runSubagent({
          definition: {
            kind: 'local',
            name: 'direct-probe',
            description: 'Direct fixture',
            modelConfig: { model: 'inherit' },
            promptConfig: { systemPrompt: 'Return the marker.' },
            inputConfig: { inputSchema: { type: 'object', properties: {} } },
            runConfig: { maxTimeMinutes: 1 },
          },
          context: { config } as AgentLoopContext,
          agentId: 'direct-probe-id',
          promptId: 'direct-probe-prompt',
          prompt: 'Return DIRECT_TASK_OK',
          parentSelection,
          model: `fixture/${requestedModel}`,
          systemPrompt: systemPromptFromText('Return the marker.'),
          sessionId: config.getSessionId(),
          toolRegistry: {
            getSchema: () => [],
            executeTool: vi.fn(),
          } as unknown as ToolRegistry,
          forkContext: new SubagentForkContext(),
          disableCompression: true,
          maxTurns: 1,
        });
        expect(result.textContent).toBe('DIRECT_TASK_OK');
        expect(result.terminal?.reason).toBe('end_turn');
        expect(calls).toEqual([
          { model: requestedModel, roles: ['system', 'user'] },
        ]);
        expect(select).toHaveBeenCalledOnce();
        expect(select.mock.calls[0][0]).toMatchObject({
          purpose: 'task',
          parentSelection,
        });
        if (requestedModel === 'main') {
          expect(select.mock.calls[0][0].overrideSelection).toBeUndefined();
        } else {
          expect(select.mock.calls[0][0].overrideSelection).toMatchObject({
            key: 'fixture/child',
            config: { reasoning: { effort: 'none' } },
          });
        }
        expect(host).toHaveBeenCalledOnce();
        expect(host.mock.calls[0][5]).toMatchObject({
          resolvedModel: `fixture/${requestedModel}`,
        });
        expect(manager.getMainModelKey()).toBe('fixture/main');
      } finally {
        await config.dispose();
        for (const provider of runtimeProviders) await provider.stop();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
