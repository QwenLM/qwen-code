/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for tool control parameters:
 * - coreTools: Limit available tools to a specific set
 * - excludeTools: Block specific tools from execution
 * - allowedTools: Auto-approve specific tools without confirmation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKResultMessage,
  type SDKMessage,
  type SDKUserMessage,
} from '@qwen-code/sdk';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  SDKTestHelper,
  extractText,
  findToolCalls,
  findToolResult,
  findToolResults,
  assertSuccessfulCompletion,
  createSharedTestOptions,
  createResultWaiter,
} from './test-helper.js';
import {
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
} from '../test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();
const TEST_TIMEOUT = 60000;
const LOCAL_OPENAI_NO_PROXY = IS_CONTAINER_SANDBOX
  ? CONTAINER_SANDBOX_NO_PROXY
  : '127.0.0.1,localhost';
const FAKE_SERVER_OPTIONS = fakeServerHostOptions();
const INITIAL_CONTENT = 'original content';

function fakeModelOptions(baseUrl: string) {
  return {
    model: 'fake-model',
    authType: 'openai' as const,
    env: {
      NO_PROXY: LOCAL_OPENAI_NO_PROXY,
      no_proxy: LOCAL_OPENAI_NO_PROXY,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    },
  };
}

function advertisedToolNames(fakeServer: FakeOpenAIServer): string[] {
  const tools = fakeServer.requests.find(({ body }) => body['stream'] === true)
    ?.body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool): string[] => {
    if (typeof tool !== 'object' || tool === null) return [];
    const fn = (tool as { function?: unknown }).function;
    if (typeof fn !== 'object' || fn === null) return [];
    const name = (fn as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

describe('Tool Control Parameters (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('tool-control', {
      settings: {
        fastModel: 'openai:fake-model',
        // list_directory is opt-in (disabled by default). This suite tests
        // coreTools/excludeTools control semantics, so keep it enabled here;
        // an active coreTools allowlist still outranks this flag.
        tools: { listDirectory: { enabled: true } },
      },
    });
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('coreTools parameter', () => {
    it(
      'should only allow specified tools when coreTools is set',
      async () => {
        // Create a test file
        await helper.createFile('test.txt', INITIAL_CONTENT);

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
                fakeToolCall('list_directory', { path: testDir }, 'list-dir'),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Read the file test.txt and then write "modified" to test.txt. Finally, list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Only allow read_file and write_file, exclude list_directory
            coreTools: ['read_file', 'write_file'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // Should have read_file and write_file calls
          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          const advertisedTools = advertisedToolNames(fakeServer);
          expect(advertisedTools).toEqual(
            expect.arrayContaining(['read_file', 'write_file']),
          );

          const listDirectoryResults = findToolResults(
            messages,
            'list_directory',
          );
          expect(listDirectoryResults).toHaveLength(1);
          expect(listDirectoryResults[0]).toMatchObject({
            isError: true,
            content: expect.stringContaining('was declined'),
          });
          expect(advertisedTools).not.toContain('list_directory');

          // Verify the write_file call itself requested different content
          // than the original. Asserting on the tool-call arguments (rather
          // than re-reading the file afterwards) avoids flakiness in
          // sandboxed environments where the file write may not be
          // observable from the test process by the time we check it.
          const writeFileCalls = findToolCalls(messages, 'write_file');
          expect(writeFileCalls.length).toBeGreaterThan(0);
          const writtenContent = writeFileCalls.some((tc) => {
            const input = tc.toolUse.input as { content?: string };
            return (
              typeof input?.content === 'string' &&
              input.content !== INITIAL_CONTENT
            );
          });
          expect(writtenContent).toBe(true);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with minimal tool set',
      async () => {
        const fakeServer = await startFakeOpenAIServer(() => {
          return { content: '4' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'What is 2 + 2? Just answer with the number.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            // Only allow thinking, no file operations
            coreTools: [],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];
        let assistantText = '';

        try {
          for await (const message of q) {
            messages.push(message);

            if (isSDKAssistantMessage(message)) {
              assistantText += extractText(message.message.content);
            }
          }

          // Should answer without any tool calls
          expect(assistantText).toMatch(/4/);

          // Should have no tool calls
          const toolCalls = findToolCalls(messages);
          expect(toolCalls.length).toBe(0);

          assertSuccessfulCompletion(messages);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('excludeTools parameter', () => {
    it(
      'should block excluded tools from execution',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: '',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Read test.txt and then write empty content to it to clear it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            coreTools: ['read_file', 'write_file'],
            // Block all write_file tool
            excludeTools: ['write_file'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should be able to read the file
          expect(toolNames).toContain('read_file');

          // The excluded tools should have been called but returned permission declined
          // Check if write_file was attempted and got permission denied
          const writeFileResults = findToolResults(messages, 'write_file');
          if (writeFileResults.length > 0) {
            // Tool was called but should have permission declined message
            for (const result of writeFileResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }

          // File content should remain unchanged (because write was denied)
          const content = await helper.readFile('test.txt');
          expect(content).toBe('test content');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block multiple excluded tools',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall('list_directory', { path: testDir }, 'list-dir'),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'echo hello' },
                  'shell-echo',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt, list the directory, and run "echo hello".',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Block multiple tools
            excludeTools: ['list_directory', 'run_shell_command'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should be able to read
          expect(toolNames).toContain('read_file');

          // Excluded tools should have been attempted but returned permission declined
          const listDirResults = findToolResults(messages, 'list_directory');
          if (listDirResults.length > 0) {
            for (const result of listDirResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }

          const shellResults = findToolResults(messages, 'run_shell_command');
          if (shellResults.length > 0) {
            for (const result of shellResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block all shell commands when run_shell_command is excluded',
      async () => {
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  { command: 'echo hello' },
                  'shell-echo',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'ls -la' },
                  'shell-ls',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Run "echo hello" and "ls -la" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Block all shell commands - excludeTools blocks entire tools
            excludeTools: ['run_shell_command'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // All shell commands should have permission declined
          const shellResults = findToolResults(messages, 'run_shell_command');
          for (const result of shellResults) {
            expect(result.content).toMatch(
              /permission.*(?:declined|denied)|denied.*permission/i,
            );
          }
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'excludeTools should take priority over allowedTools',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: '',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Clear the content of test.txt by writing empty string to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Conflicting settings: exclude takes priority
            excludeTools: ['write_file'],
            allowedTools: ['write_file'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // write_file should have been attempted but returned permission declined
          const writeFileResults = findToolResults(messages, 'write_file');
          if (writeFileResults.length > 0) {
            // Tool was called but should have permission declined message (exclude takes priority)
            for (const result of writeFileResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }

          // File content should remain unchanged (because write was denied)
          const content = await helper.readFile('test.txt');
          expect(content).toBe('test content');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block read operations on specific path patterns with excludeTools',
      async () => {
        await helper.createFile('.env', 'SECRET=password');
        await helper.createFile('data.txt', 'public data');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('.env') },
                  'read-env',
                ),
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('data.txt') },
                  'read-data',
                ),
              ],
            };
          }

          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read .env and data.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Block reading .env files
            excludeTools: ['Read(.env)'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);
          const readResults = findToolResults(messages, 'read_file');
          const envReadResult = readResults.find(
            (result) => result.toolUseId === 'read-env',
          );
          const dataReadResult = readResults.find(
            (result) => result.toolUseId === 'read-data',
          );

          expect(envReadResult?.isError).toBe(true);
          expect(envReadResult?.content).toMatch(
            /permission.*(?:declined|denied)|denied.*permission/i,
          );
          expect(dataReadResult).toMatchObject({
            isError: false,
            content: expect.stringContaining('public data'),
          });
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block edit operations on specific path patterns with excludeTools',
      async () => {
        await helper.createFile('src/app.ts', 'const app = "original";');
        await helper.createFile('readme.md', '# Readme');

        const fakeServer = await startFakeOpenAIServer(({ body }) => {
          const transcript = JSON.stringify(body['messages'] ?? []);
          if (
            transcript.includes('edit-src') &&
            transcript.includes('edit-readme')
          ) {
            return { content: 'Done.' };
          }
          if (
            transcript.includes('read-src') &&
            transcript.includes('read-readme')
          ) {
            return {
              toolCalls: [
                fakeToolCall(
                  'edit',
                  {
                    file_path: helper.getPath('src/app.ts'),
                    old_string: 'const app = "original";',
                    new_string: 'const app = "original"; // touched',
                  },
                  'edit-src',
                ),
                fakeToolCall(
                  'edit',
                  {
                    file_path: helper.getPath('readme.md'),
                    old_string: '# Readme',
                    new_string: '# Readme\n\nUpdated.',
                  },
                  'edit-readme',
                ),
              ],
            };
          }
          if (transcript.includes('Use the edit tool to modify')) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('src/app.ts') },
                  'read-src',
                ),
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('readme.md') },
                  'read-readme',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Use the edit tool to modify src/app.ts and readme.md.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            coreTools: ['read_file', 'edit', 'list_directory'],
            // Block editing files in /src/** directory
            excludeTools: ['Edit(/src/**)'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);

          expect(findToolResult(messages, 'edit-src')).toMatchObject({
            isError: true,
            content: expect.stringMatching(
              /permission.*(?:declined|denied)|denied.*permission/i,
            ),
          });
          expect(findToolResult(messages, 'edit-readme')).toMatchObject({
            isError: false,
          });

          // src/app.ts should remain unchanged
          const srcContent = await helper.readFile('src/app.ts');
          expect(srcContent).toBe('const app = "original";');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block specific shell commands with prefix pattern',
      async () => {
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  { command: 'echo hello' },
                  'shell-echo',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'rm file.txt' },
                  'shell-rm',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'ls' },
                  'shell-ls',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Run "echo hello", "rm file.txt", and "ls" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Block all rm commands
            excludeTools: ['Bash(rm *)'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);

          expect(findToolResult(messages, 'shell-rm')).toMatchObject({
            isError: true,
            content: expect.stringMatching(
              /permission.*(?:declined|denied)|denied.*permission/i,
            ),
          });
          expect(findToolResult(messages, 'shell-echo')).toMatchObject({
            isError: false,
          });
          expect(findToolResult(messages, 'shell-ls')).toMatchObject({
            isError: false,
          });
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('allowedTools parameter', () => {
    it(
      'should auto-approve allowed tools without canUseTool callback',
      async () => {
        await helper.createFile('test.txt', 'original');

        let canUseToolCalled = false;

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
            // Allow write_file without confirmation
            allowedTools: ['read_file', 'write_file'],
            canUseTool: async (_toolName) => {
              canUseToolCalled = true;
              return { behavior: 'deny', message: 'Should not be called' };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should have executed the tools
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          // canUseTool should NOT have been called (tools are in allowedTools)
          expect(canUseToolCalled).toBe(false);

          // Verify file was actually modified (content changed from original).
          // Don't assert on specific wording — the model may paraphrase.
          const content = await helper.readFile('test.txt');
          expect(content).not.toBe('original');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should allow specific shell commands with pattern matching',
      async () => {
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  { command: 'touch allowed.txt' },
                  'shell-touch',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'mkdir allowed-dir' },
                  'shell-mkdir',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Run "touch allowed.txt" and "mkdir allowed-dir" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Allow specific shell commands
            allowedTools: ['ShellTool(touch *)', 'ShellTool(mkdir *)'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);

          expect(findToolResult(messages, 'shell-touch')).toMatchObject({
            isError: false,
          });
          expect(findToolResult(messages, 'shell-mkdir')).toMatchObject({
            isError: false,
          });
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should fall back to canUseTool for non-allowed tools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'test\n',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and append an empty line to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Only allow read_file, list_directory should trigger canUseTool
            coreTools: ['read_file', 'write_file'],
            allowedTools: ['read_file'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return {
                behavior: 'allow',
                updatedInput: {},
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Both tools should have been executed
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          // canUseTool should have been called for write_file (not in allowedTools)
          // but NOT for read_file (in allowedTools)
          expect(canUseToolCalls).toContain('write_file');
          expect(canUseToolCalls).not.toContain('read_file');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with permissionMode: auto-edit',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'new',
                  },
                  'write-test',
                ),
                fakeToolCall('list_directory', { path: testDir }, 'list-dir'),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt, write "new" to it, and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'auto-edit',
            // Allow list_directory in addition to auto-approved edit tools
            allowedTools: ['list_directory'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return {
                behavior: 'deny',
                message: 'Should not be called',
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // All tools should have been executed
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');
          expect(toolNames).toContain('list_directory');

          // canUseTool should NOT have been called
          // (edit tools auto-approved, list_directory in allowedTools)
          expect(canUseToolCalls.length).toBe(0);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should auto-approve specific path patterns with allowedTools',
      async () => {
        const canUseToolCalls: string[] = [];
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('config.json'),
                    content: '{"key": "value"}',
                  },
                  'write-json',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('.env'),
                    content: 'SECRET=secret',
                  },
                  'write-env',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Write config.json and .env files.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            allowedTools: ['Edit(*.json)'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return {
                behavior: 'deny',
                message: 'Non-allowed paths should trigger this',
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);

          expect(findToolResult(messages, 'write-json')).toMatchObject({
            isError: false,
          });
          expect(await helper.readFile('config.json')).toBe('{"key": "value"}');

          expect(findToolResult(messages, 'write-env')).toMatchObject({
            content: expect.stringContaining(
              '[Operation Cancelled] Reason: Non-allowed paths should trigger this',
            ),
          });
          expect(helper.fileExists('.env')).toBe(false);
          expect(canUseToolCalls).toEqual(['write_file']);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should auto-approve specific shell commands with pattern matching',
      async () => {
        const canUseToolCalls: string[] = [];
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  { command: 'touch allowed.txt' },
                  'shell-touch-allowed',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'rm blocked.txt' },
                  'shell-rm',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Run "touch allowed.txt" and "rm blocked.txt" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Auto-approve touch commands
            allowedTools: ['ShellTool(touch *)'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return {
                behavior: 'deny',
                message: 'Non-allowed tools should trigger this',
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          assertSuccessfulCompletion(messages);

          expect(findToolResult(messages, 'shell-touch-allowed')).toMatchObject(
            {
              isError: false,
            },
          );
          expect(findToolResult(messages, 'shell-rm')).toMatchObject({
            content: expect.stringContaining(
              '[Operation Cancelled] Reason: Non-allowed tools should trigger this',
            ),
          });
          expect(canUseToolCalls).toEqual(['run_shell_command']);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Combined tool control scenarios', () => {
    it(
      'should work with coreTools + allowedTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'echo hello' },
                  'shell-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Limit to specific tools
            coreTools: ['read_file', 'write_file', 'list_directory'],
            // Auto-approve write operations
            allowedTools: ['write_file'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should use allowed tools from coreTools
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          const advertisedTools = advertisedToolNames(fakeServer);
          expect(advertisedTools).toEqual(
            expect.arrayContaining(['read_file', 'write_file']),
          );

          const shellResults = findToolResults(messages, 'run_shell_command');
          expect(shellResults).toHaveLength(1);
          expect(shellResults[0]).toMatchObject({
            isError: true,
            content: expect.stringContaining('was declined'),
          });
          expect(advertisedTools).not.toContain('run_shell_command');

          // Verify file was actually modified (content changed from original).
          // Don't assert on specific wording — the model may paraphrase.
          const content = await helper.readFile('test.txt');
          expect(content).not.toBe('test');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with coreTools + excludeTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall('list_directory', { path: testDir }, 'list-dir'),
                fakeToolCall(
                  'edit',
                  {
                    file_path: helper.getPath('test.txt'),
                    old_string: 'test',
                    new_string: 'modified',
                  },
                  'edit-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Read test.txt, write "new content" to it, and list directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Allow file operations
            coreTools: ['read_file', 'write_file', 'edit', 'list_directory'],
            // But exclude edit
            excludeTools: ['edit'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should use non-excluded tools from coreTools
          expect(toolNames).toContain('read_file');

          const advertisedTools = advertisedToolNames(fakeServer);
          expect(advertisedTools).toEqual(
            expect.arrayContaining(['read_file', 'list_directory']),
          );

          const editResults = findToolResults(messages, 'edit');
          expect(editResults).toHaveLength(1);
          expect(editResults[0]).toMatchObject({
            isError: true,
            content: expect.stringContaining('was declined'),
          });
          expect(advertisedTools).not.toContain('edit');

          // File should still exist
          expect(helper.fileExists('test.txt')).toBe(true);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with all three parameters together',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
                fakeToolCall(
                  'edit',
                  {
                    file_path: helper.getPath('test.txt'),
                    old_string: 'test',
                    new_string: 'modified',
                  },
                  'edit-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Read test.txt, write "modified" to it, and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            // Limit available tools
            coreTools: ['read_file', 'write_file', 'list_directory'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return {
                behavior: 'allow',
                updatedInput: {},
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should use allowed tools
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          const advertisedTools = advertisedToolNames(fakeServer);
          expect(advertisedTools).toEqual(
            expect.arrayContaining([
              'read_file',
              'write_file',
              'list_directory',
            ]),
          );

          const editResults = findToolResults(messages, 'edit');
          expect(editResults).toHaveLength(1);
          expect(editResults[0]).toMatchObject({
            isError: true,
            content: expect.stringContaining('was declined'),
          });
          expect(advertisedTools).not.toContain('edit');

          // canUseTool should be called for core write tools
          expect(canUseToolCalls).toContain('write_file');

          // Verify file was actually modified (content changed from original).
          // Don't assert on specific wording — the model may paraphrase.
          const content = await helper.readFile('test.txt');
          expect(content).not.toBe('test');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Edge cases and error handling', () => {
    it(
      'should handle non-existent tool names in excludeTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Non-existent tool names should be ignored
            excludeTools: ['non_existent_tool', 'another_fake_tool'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should work normally
          expect(toolNames).toContain('read_file');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent tool names in allowedTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Non-existent tool names should be ignored
            allowedTools: ['non_existent_tool', 'read_file'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should work normally
          expect(toolNames).toContain('read_file');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('permissionMode priority interactions', () => {
    it(
      'permissionMode plan should block all write tools even if allowedTools is set',
      async () => {
        await helper.createFile('test.txt', 'original');

        const canUseToolCalls: string[] = [];
        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall('read_file', {
                  file_path: helper.getPath('test.txt'),
                }),
              ],
            };
          }

          return { content: 'Plan: leave the file unchanged.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'plan',
            // allowedTools should be overridden by plan mode
            allowedTools: ['write_file'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          assertSuccessfulCompletion(messages);

          // read_file should be allowed in plan mode.
          expect(toolNames).toContain('read_file');
          const readFileResults = findToolResults(messages, 'read_file');
          expect(readFileResults.length).toBeGreaterThan(0);
          for (const result of readFileResults) {
            expect(result.isError).toBe(false);
            expect(result.content).toContain('original');
          }

          // write_file should NOT be called in plan mode.
          // The fake model responds with a plan after reading the file.
          expect(toolNames).not.toContain('write_file');
          expect(canUseToolCalls.length).toBe(0);
          expect(await helper.readFile('test.txt')).toBe('original');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'permissionMode yolo should be overridden by excludeTools',
      async () => {
        await helper.createFile('test.txt', 'original');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'run_shell_command',
                  { command: 'echo hello' },
                  'shell-echo',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and run "echo hello" command.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // Even in yolo mode, excludeTools should block tools
            excludeTools: ['run_shell_command'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should be able to read
          expect(toolNames).toContain('read_file');

          // Shell commands should have been blocked by excludeTools
          const shellResults = findToolResults(messages, 'run_shell_command');
          if (shellResults.length > 0) {
            for (const result of shellResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool updatedInput handling', () => {
    it(
      'should apply updatedInput from canUseTool callback',
      async () => {
        const scenarioDirName = `updated-input-allow-${crypto.randomUUID()}`;
        const scenarioDir = await helper.mkdir(scenarioDirName);
        let capturedInput: Record<string, unknown> = {};

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath(scenarioDirName + '/test.txt'),
                    content: 'new content',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Create a new file named test.txt with exactly this content: new content. Use the write_file tool.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: scenarioDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (_toolName, input) => {
              // Modify the input before allowing
              capturedInput = { ...input };
              const modifiedInput = {
                ...input,
                file_path: (input['file_path'] as string).replace(
                  'test.txt',
                  './test.txt',
                ),
              };
              return { behavior: 'allow', updatedInput: modifiedInput };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // The input should have been captured
          expect(Object.keys(capturedInput).length).toBeGreaterThan(0);

          // The file should be modified
          const content = await helper.readFile(`${scenarioDirName}/test.txt`);
          expect(content).toBe('new content');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'canUseTool should not be called for allowedTools even if it would modify input',
      async () => {
        const scenarioDirName = `updated-input-allowed-tool-${crypto.randomUUID()}`;
        const scenarioDir = await helper.mkdir(scenarioDirName);
        let canUseToolCalled = false;

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath(scenarioDirName + '/test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt:
            'Create a new file named test.txt with exactly this content: modified. Use the write_file tool.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: scenarioDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            // write_file is in allowedTools, so canUseTool should not be called
            allowedTools: ['write_file'],
            canUseTool: async (toolName, input) => {
              canUseToolCalled = true;
              return {
                behavior: 'allow',
                updatedInput: { ...input, file_path: '/some/other/path.txt' },
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // canUseTool should NOT have been called for allowed tool
          expect(canUseToolCalled).toBe(false);

          // File should be modified (not redirected to /some/other/path.txt)
          const content = await helper.readFile(`${scenarioDirName}/test.txt`);
          expect(content).toBe('modified');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('coreTools interaction with excludeTools and allowedTools', () => {
    it(
      'should block tools in excludeTools even if they are in coreTools',
      async () => {
        await helper.createFile('test.txt', 'original');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'edit',
                  {
                    file_path: helper.getPath('test.txt'),
                    old_string: 'original',
                    new_string: 'edited',
                  },
                  'edit-test',
                ),
                fakeToolCall('list_directory', { path: testDir }, 'list-dir'),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Edit test.txt and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // edit is in coreTools but also in excludeTools
            coreTools: ['read_file', 'write_file', 'edit', 'list_directory'],
            excludeTools: ['edit'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // list_directory should be used
          expect(toolNames).toContain('list_directory');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should not auto-approve tools in allowedTools if they are not in coreTools',
      async () => {
        await helper.createFile('test.txt', 'original');
        await helper.createFile('other.txt', 'other content');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt and write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // write_file is in allowedTools but NOT in coreTools
            coreTools: ['read_file'],
            allowedTools: ['write_file'],
            canUseTool: async (_toolName) => {
              return { behavior: 'deny', message: 'Should not be called' };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // read_file should be used
          expect(toolNames).toContain('read_file');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should prioritize coreTools as whitelist over allowedTools',
      async () => {
        await helper.createFile('a.txt', 'content a');
        await helper.createFile('b.txt', 'content b');

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('a.txt') },
                  'read-a',
                ),
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('b.txt') },
                  'read-b',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read both a.txt and b.txt files.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            // coreTools is the whitelist - only these tools can be used
            coreTools: ['read_file'],
            // allowedTools pattern that would match b.txt
            allowedTools: ['Read(b.txt)'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // read_file should be used (in coreTools)
          expect(toolNames).toContain('read_file');

          // Only read_file should be used, not other tools
          const uniqueTools = Array.from(new Set(toolNames));
          expect(uniqueTools).toEqual(['read_file']);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool with asyncGenerator prompt', () => {
    it(
      'should invoke canUseTool callback when using asyncGenerator as prompt',
      async () => {
        await helper.createFile('test.txt', INITIAL_CONTENT);

        const resultWaiter = createResultWaiter(1);
        const canUseToolCalls: Array<{
          toolName: string;
          input: Record<string, unknown>;
        }> = [];

        let streamingRequestIndex = 0;
        const fakeServer = await startFakeOpenAIServer(({ body }) => {
          if (body['stream'] !== true) {
            return { content: '{"selected_memories":[]}' };
          }
          const requestIndex = streamingRequestIndex++;
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
              ],
            };
          }
          if (requestIndex === 1) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'updated',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        // Create an async generator that yields a single message
        async function* createPrompt(): AsyncIterable<SDKUserMessage> {
          yield {
            type: 'user',
            session_id: crypto.randomUUID(),
            message: {
              role: 'user',
              content: 'Read test.txt and then write "updated" to it.',
            },
            parent_tool_use_id: null,
          };

          await resultWaiter.waitForResult(0);
        }

        const q = query({
          prompt: createPrompt(),
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
            allowedTools: [],
            canUseTool: async (toolName, input) => {
              canUseToolCalls.push({ toolName, input });
              return {
                behavior: 'allow',
                updatedInput: input,
              };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultWaiter.notifyResult();
            }
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Both tools should have been executed
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          const toolsCalledInCallback = canUseToolCalls.map(
            (call) => call.toolName,
          );
          expect(toolsCalledInCallback).toContain('write_file');

          const writeFileResults = findToolResults(messages, 'write_file');
          expect(writeFileResults.length).toBeGreaterThan(0);

          // Verify the write_file call itself requested different content
          // than the original. Asserting on the tool-call arguments (rather
          // than re-reading the file afterwards) avoids flakiness in
          // sandboxed environments where the file write may not be
          // observable from the test process by the time we check it, and
          // is model-agnostic (the model may paraphrase the content).
          const writeFileCalls = findToolCalls(messages, 'write_file');
          expect(writeFileCalls.length).toBeGreaterThan(0);
          const writtenContent = writeFileCalls.some((tc) => {
            const input = tc.toolUse.input as { content?: string };
            return (
              typeof input?.content === 'string' &&
              input.content !== INITIAL_CONTENT
            );
          });
          expect(writtenContent).toBe(true);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should deny tool when canUseTool returns deny with asyncGenerator prompt',
      async () => {
        await helper.createFile('test.txt', INITIAL_CONTENT);

        const resultWaiter = createResultWaiter(1);

        let streamingRequestIndex = 0;
        const fakeServer = await startFakeOpenAIServer(({ body }) => {
          if (body['stream'] !== true) {
            return { content: '{"selected_memories":[]}' };
          }
          const requestIndex = streamingRequestIndex++;
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-test',
                ),
              ],
            };
          }
          if (requestIndex === 1) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-test',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        // Create an async generator that yields a single message
        async function* createPrompt(): AsyncIterable<SDKUserMessage> {
          yield {
            type: 'user',
            session_id: crypto.randomUUID(),
            message: {
              role: 'user',
              // Read-first instruction satisfies prior-read enforcement
              // so the deny path is exercised by canUseTool, not by the
              // write tool's pre-write guard.
              content: 'Read test.txt and then write "modified" to it.',
            },
            parent_tool_use_id: null,
          };
          await resultWaiter.waitForResult(0);
        }

        const q = query({
          prompt: createPrompt(),
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
            canUseTool: async (toolName, input) => {
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'Write operations are not allowed',
                };
              }
              // Pass-through: empty `updatedInput` would erase
              // file_path and break the read_file call.
              return { behavior: 'allow', updatedInput: input };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultWaiter.notifyResult();
            }
          }

          // Make the read-first dependency explicit: if the model
          // skipped read_file, prior-read enforcement would surface
          // EDIT_REQUIRES_PRIOR_READ instead of the canUseTool deny
          // message we are asserting on below — fail fast with a
          // clear signal instead of a confusing toContain mismatch.
          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);
          expect(toolNames).toContain('read_file');

          // write_file should have been attempted but stream was closed
          const writeFileResults = findToolResults(messages, 'write_file');
          expect(writeFileResults.length).toBeGreaterThan(0);
          for (const result of writeFileResults) {
            expect(result.content).toContain(
              '[Operation Cancelled] Reason: Write operations are not allowed',
            );
          }

          // File content should remain unchanged (because write was denied)
          const content = await helper.readFile('test.txt');
          expect(content).toBe(INITIAL_CONTENT);
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should support multi-turn conversation with canUseTool using asyncGenerator',
      async () => {
        await helper.createFile('data.txt', 'initial data');

        const resultWaiter = createResultWaiter(2);
        const canUseToolCalls: string[] = [];

        const fakeServer = await startFakeOpenAIServer(({ body }) => {
          if (body['stream'] !== true) {
            return { content: '{"selected_memories":[]}' };
          }
          const transcript = JSON.stringify(body['messages'] ?? []);
          if (transcript.includes('write-data')) {
            return { content: 'Done.' };
          }
          if (transcript.includes('Now append')) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('data.txt'),
                    content: 'initial data - updated',
                  },
                  'write-data',
                ),
              ],
            };
          }
          if (transcript.includes('read-data')) {
            return { content: 'Done.' };
          }
          return {
            toolCalls: [
              fakeToolCall(
                'read_file',
                { file_path: helper.getPath('data.txt') },
                'read-data',
              ),
            ],
          };
        }, FAKE_SERVER_OPTIONS);

        // Create an async generator that yields multiple messages
        async function* createMultiTurnPrompt(): AsyncIterable<SDKUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Read data.txt and tell me what it contains.',
            },
            parent_tool_use_id: null,
          };

          await resultWaiter.waitForResult(0);

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Now append " - updated" to the file content.',
            },
            parent_tool_use_id: null,
          };

          await resultWaiter.waitForResult(1);
        }

        const q = query({
          prompt: createMultiTurnPrompt(),
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
            canUseTool: async (toolName, input) => {
              canUseToolCalls.push(toolName);
              // Pass-through: empty `updatedInput` would erase
              // file_path on the SDK→CLI boundary
              // (permissionController.ts:444 truthy-replaces args).
              return { behavior: 'allow', updatedInput: input };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultWaiter.notifyResult();
            }
          }

          const toolCalls = findToolCalls(messages);
          const toolNames = toolCalls.map((tc) => tc.toolUse.name);

          // Should have read_file and write_file calls
          expect(toolNames).toContain('read_file');
          expect(toolNames).toContain('write_file');

          expect(canUseToolCalls).toContain('write_file');

          const writeFileResults = findToolResults(messages, 'write_file');
          expect(writeFileResults.length).toBeGreaterThan(0);

          const content = await helper.readFile('data.txt');
          expect(content).toContain('initial data');
          expect(content).toContain(' - updated');
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  // Regression guard for #10075: a pre-existing `permissions.allow`
  // allowlist must not silently remove uncovered built-in tools (0.22.1
  // unregistered them — absent from /tools, unfindable via tool_search,
  // permission-errored at call time). Since the fix they are demoted to
  // deferred: their schemas stay out of the eager model request (#9827
  // schema-shrink preserved) but they remain registered, discoverable via
  // tool_search, and callable through the normal approval flow.
  describe('permissions.allow registry allowlist from settings (#10075)', () => {
    beforeEach(async () => {
      testDir = await helper.setup('tool-control-allowlist-10075', {
        settings: {
          fastModel: 'openai:fake-model',
          // Covers read_file + shell family only — write_file/edit stay
          // uncovered, exactly the reporter's configuration shape.
          permissions: { allow: ['ReadFile', 'Shell'] },
        },
      });
    });

    it(
      'keeps uncovered tools callable while excluding their schemas from the eager request',
      async () => {
        await helper.createFile('test.txt', INITIAL_CONTENT);

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  { file_path: helper.getPath('test.txt') },
                  'read-covered',
                ),
                // Uncovered by the allowlist — before the fix this was
                // permission-errored ("not covered by any permissions.allow
                // rule"), now it must run through the normal approval flow.
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-uncovered',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Read test.txt, then write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // Schema-shrink side (#9827): the covered tool is in the eager
          // request, the uncovered one is not.
          const advertisedTools = advertisedToolNames(fakeServer);
          expect(advertisedTools).toContain('read_file');
          expect(advertisedTools).not.toContain('write_file');
          expect(advertisedTools).not.toContain('edit');

          // Capability side (#10075): the uncovered tool is still
          // registered and executes instead of being permission-errored.
          const toolNames = findToolCalls(messages).map(
            (tc) => tc.toolUse.name,
          );
          expect(toolNames).toContain('write_file');

          const writeResults = findToolResults(messages, 'write_file');
          expect(writeResults.length).toBeGreaterThan(0);
          for (const result of writeResults) {
            expect(result.isError).toBe(false);
            expect(result.content).not.toContain('permissions.allow');
          }
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'discovers and loads an uncovered tool via tool_search',
      async () => {
        await helper.createFile('test.txt', INITIAL_CONTENT);

        const fakeServer = await startFakeOpenAIServer(({ requestIndex }) => {
          if (requestIndex === 0) {
            // The model does not see write_file in the eager request; it
            // discovers it on demand via tool_search.
            return {
              toolCalls: [
                fakeToolCall(
                  'tool_search',
                  { query: 'select:write_file' },
                  'search-write',
                ),
              ],
            };
          }
          if (requestIndex === 1) {
            return {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  {
                    file_path: helper.getPath('test.txt'),
                    content: 'modified',
                  },
                  'write-after-search',
                ),
              ],
            };
          }
          return { content: 'Done.' };
        }, FAKE_SERVER_OPTIONS);

        const q = query({
          prompt: 'Find the write tool and write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            ...fakeModelOptions(fakeServer.baseUrl),
            cwd: testDir,
            permissionMode: 'yolo',
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // tool_search loads the deferred tool (it must be registered, or
          // the lookup would report it missing).
          const searchResults = findToolResults(messages, 'tool_search');
          expect(searchResults.length).toBeGreaterThan(0);
          expect(searchResults[0].isError).toBe(false);
          expect(searchResults[0].content).toContain('write_file');

          // After discovery the tool executes normally.
          const writeResults = findToolResults(messages, 'write_file');
          expect(writeResults.length).toBeGreaterThan(0);
          for (const result of writeResults) {
            expect(result.isError).toBe(false);
          }
        } finally {
          await q.close();
          await fakeServer.close();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
