/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

describe.each(['diagnostics', 'workspaceDiagnostics'] as const)(
  'headless LSP %s',
  (operation) => {
    let rig: TestRig;
    let server: FakeOpenAIServer;

    afterEach(async () => {
      await server?.close();
      await rig?.cleanup();
      vi.unstubAllEnvs();
    });

    it.each(['failure', 'unavailable', 'empty', 'diagnostics'] as const)(
      'reports %s in tool results and statistics',
      async (mode) => {
        rig = new TestRig();
        await rig.setup(`lsp-${operation}-${mode}`);
        rig.createFile('main.ts', 'const value = 1;\n');
        const fixture = rig.createFile(
          'diagnostic-lsp.mjs',
          readFileSync(
            new URL('../fixtures/diagnostic-lsp.mjs', import.meta.url),
            'utf8',
          ),
        );
        rig.createFile(
          '.lsp.json',
          JSON.stringify(
            mode === 'unavailable'
              ? {}
              : {
                  probe: {
                    command: 'node',
                    args: [fixture, mode],
                    extensionToLanguage: { '.ts': 'typescript' },
                  },
                },
          ),
        );
        const trustedFolders = rig.createFile(
          'trusted-folders.json',
          JSON.stringify({ [rig.testDir!]: 'TRUST_FOLDER' }),
        );
        vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', trustedFolders);
        vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen-home'));
        vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.runtime'));
        const noProxy = IS_CONTAINER_SANDBOX
          ? CONTAINER_SANDBOX_NO_PROXY
          : '127.0.0.1,localhost';
        vi.stubEnv('NO_PROXY', noProxy);
        vi.stubEnv('no_proxy', noProxy);
        let turn = 0;
        server = await startFakeOpenAIServer(({ body }) => {
          if (body['stream'] !== true)
            return { content: '{"selected_memories":[]}' };
          if (turn++ === 0)
            return {
              toolCalls: [
                fakeToolCall(
                  'lsp',
                  {
                    operation,
                    ...(operation === 'diagnostics'
                      ? { filePath: 'main.ts' }
                      : {}),
                  },
                  'diagnostic-call',
                ),
              ],
            };
          return { content: 'Diagnostic check finished.' };
        }, fakeServerHostOptions());
        const output = await rig.run(
          'Check diagnostics.',
          '--experimental-lsp',
          '--output-format',
          'json',
          '--auth-type',
          'openai',
          '--model',
          'fake-model',
          '--openai-base-url',
          server.baseUrl,
          '--openai-api-key',
          'fake-key',
          '--max-session-turns',
          '3',
        );
        const messages = JSON.parse(output) as Array<{
          type: string;
          message?: {
            content?: Array<{
              type: string;
              is_error?: boolean;
              content?: string;
            }>;
          };
          stats?: {
            tools: {
              totalCalls: number;
              totalSuccess: number;
              totalFail: number;
            };
          };
        }>;
        const toolResults = messages
          .flatMap((message) => message.message?.content ?? [])
          .filter((part) => part.type === 'tool_result');
        const failed = mode === 'failure' || mode === 'unavailable';
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].is_error).toBe(failed);
        const expected = {
          failure: 'failed: controlled diagnostic failure',
          unavailable: 'unavailable: No LSP servers are configured.',
          empty: 'No diagnostics found',
          diagnostics: 'controlled diagnostic issue',
        }[mode]!;
        expect(toolResults[0].content).toContain(expected);
        if (failed)
          expect(toolResults[0].content).not.toContain('No diagnostics found');
        expect(
          messages.find((message) => message.type === 'result')?.stats?.tools,
        ).toMatchObject({
          totalCalls: 1,
          totalSuccess: failed ? 0 : 1,
          totalFail: failed ? 1 : 0,
        });
      },
      60_000,
    );
  },
);
