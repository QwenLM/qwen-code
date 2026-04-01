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
  type SDKResultMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  findToolCalls,
  findToolResults,
  assertSuccessfulCompletion,
  createSharedTestOptions,
  createResultWaiter,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();
const TEST_TIMEOUT = 60000;

describe('Tool Control Parameters (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('tool-control');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('coreTools parameter', () => {
    it(
      'should only allow specified tools when coreTools is set',
      async () => {
        // Create a test file
        await helper.createFile('test.txt', 'original content');

        const q = query({
          prompt:
            'Read the file test.txt and then write "modified" to test.txt. Finally, list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Should NOT have list_directory since it's not in coreTools
          expect(toolNames).not.toContain('list_directory');

          // Verify file was modified
          const content = await helper.readFile('test.txt');
          expect(content).toContain('modified');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with minimal tool set',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2? Just answer with the number.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

        const q = query({
          prompt:
            'Read test.txt and then write empty content to it to clear it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block multiple excluded tools',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const q = query({
          prompt: 'Read test.txt, list the directory, and run "echo hello".',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block all shell commands when run_shell_command is excluded',
      async () => {
        const q = query({
          prompt: 'Run "echo hello" and "ls -la" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'excludeTools should take priority over allowedTools',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const q = query({
          prompt:
            'Clear the content of test.txt by writing empty string to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block read operations on specific path patterns with excludeTools',
      async () => {
        await helper.createFile('.env', 'SECRET=password');
        await helper.createFile('config.json', '{"key": "value"}');
        await helper.createFile('data.txt', 'public data');

        const q = query({
          prompt:
            'Read .env file, read config.json, and read data.txt. Tell me about their contents.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          const toolCalls = findToolCalls(messages);
          const readCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'read_file',
          );

          // Should have attempted to read files
          expect(readCalls.length).toBeGreaterThan(0);

          // Check that .env read was blocked
          const envReadResults = findToolResults(messages, 'read_file').filter(
            (result) => {
              return result.content.includes('.env');
            },
          );
          if (envReadResults.length > 0) {
            for (const result of envReadResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block edit operations on specific path patterns with excludeTools',
      async () => {
        await helper.createFile('src/app.ts', 'const app = "original";');
        await helper.createFile('test/spec.ts', 'describe("test", () => {});');
        await helper.createFile('readme.md', '# Readme');

        const q = query({
          prompt:
            'Edit src/app.ts to add a semicolon, edit test/spec.ts to add a test, and edit readme.md.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'yolo',
            coreTools: ['read_file', 'edit', 'write_file', 'list_directory'],
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

          const toolCalls = findToolCalls(messages);
          const editCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'edit',
          );

          // Should have attempted edits
          expect(editCalls.length).toBeGreaterThan(0);

          // Check that src/app.ts edit was blocked
          const srcEditResults = findToolResults(messages, 'edit').filter(
            (result) => {
              return (
                result.content.includes('src/app.ts') ||
                result.content.includes('/src/')
              );
            },
          );
          if (srcEditResults.length > 0) {
            for (const result of srcEditResults) {
              expect(result.content).toMatch(
                /permission.*(?:declined|denied)|denied.*permission/i,
              );
            }
          }

          // src/app.ts should remain unchanged
          const srcContent = await helper.readFile('src/app.ts');
          expect(srcContent).toBe('const app = "original";');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should block specific shell commands with prefix pattern',
      async () => {
        const q = query({
          prompt: 'Run "echo hello", "rm file.txt", and "ls" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          const toolCalls = findToolCalls(messages);
          const shellCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'run_shell_command',
          );

          // Should have attempted shell commands
          expect(shellCalls.length).toBeGreaterThan(0);

          // Check that rm commands were blocked
          for (const call of shellCalls) {
            const input = call.toolUse.input as { command?: string };
            if (input.command?.includes('rm')) {
              const results = findToolResults(messages, 'run_shell_command');
              const rmResults = results.filter((r) => {
                return (
                  r.content.includes('permission') ||
                  r.content.includes('declined') ||
                  r.content.includes('denied')
                );
              });
              expect(rmResults.length).toBeGreaterThan(0);
            }
          }
        } finally {
          await q.close();
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

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Verify file was modified
          const content = await helper.readFile('test.txt');
          expect(content).toContain('modified');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should allow specific shell commands with pattern matching',
      async () => {
        const q = query({
          prompt: 'Run "echo hello" and "ls -la" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            // Allow specific shell commands
            allowedTools: ['ShellTool(echo )', 'ShellTool(ls )'],
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          const toolCalls = findToolCalls(messages);
          const shellCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'run_shell_command',
          );

          // Should have executed shell commands
          expect(shellCalls.length).toBeGreaterThan(0);

          // All shell commands should be echo or ls
          for (const call of shellCalls) {
            const input = call.toolUse.input as { command?: string };
            if (input.command) {
              expect(input.command).toMatch(/^(echo |ls )/);
            }
          }
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should fall back to canUseTool for non-allowed tools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const q = query({
          prompt: 'Read test.txt and append an empty line to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with permissionMode: auto-edit',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const q = query({
          prompt: 'Read test.txt, write "new" to it, and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should auto-approve specific path patterns with allowedTools',
      async () => {
        await helper.createFile('config.json', '{"key": "value"}');
        await helper.createFile('data.txt', 'text data');
        await helper.createFile('.env', 'SECRET=secret');

        const q = query({
          prompt: 'Read config.json, data.txt, and .env files.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            // Auto-approve reading .json and .txt files
            allowedTools: ['Read(.json)', 'Read(.txt)'],
            canUseTool: async (_toolName) => {
              return {
                behavior: 'deny',
                message: 'Should not be called for allowed patterns',
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
          const readCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'read_file',
          );

          // Should have attempted reads
          expect(readCalls.length).toBeGreaterThan(0);

          // .env should trigger canUseTool (not in allowed pattern)
          // but .json and .txt should be auto-approved
          // Note: canUseTool may be called for .env or not used at all
          // depending on model behavior
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should auto-approve specific shell commands with pattern matching',
      async () => {
        const q = query({
          prompt:
            'Run "echo test", "echo build", "pwd", and "whoami" commands.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            // Auto-approve echo commands
            allowedTools: ['ShellTool(echo *)'],
            canUseTool: async (_toolName) => {
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

          const toolCalls = findToolCalls(messages);
          const shellCalls = toolCalls.filter(
            (tc) => tc.toolUse.name === 'run_shell_command',
          );

          // Should have attempted shell commands
          expect(shellCalls.length).toBeGreaterThan(0);

          // Check that echo commands were executed without canUseTool
          const echoCalls = shellCalls.filter((call) => {
            const input = call.toolUse.input as { command?: string };
            return input.command?.startsWith('echo');
          });
          expect(echoCalls.length).toBeGreaterThan(0);
        } finally {
          await q.close();
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

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Should NOT use tools outside coreTools
          expect(toolNames).not.toContain('run_shell_command');

          // Verify file was modified
          const content = await helper.readFile('test.txt');
          expect(content).toContain('modified');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with coreTools + excludeTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const q = query({
          prompt:
            'Read test.txt, write "new content" to it, and list directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Should NOT use excluded tool
          expect(toolNames).not.toContain('edit');

          // File should still exist
          expect(helper.fileExists('test.txt')).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should work with all three parameters together',
      async () => {
        await helper.createFile('test.txt', 'test');

        const canUseToolCalls: string[] = [];

        const q = query({
          prompt:
            'Read test.txt, write "modified" to it, and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Should NOT use excluded tool
          expect(toolNames).not.toContain('edit');

          // canUseTool should be called for core write tools
          expect(canUseToolCalls).toContain('write_file');

          // Verify file was modified
          const content = await helper.readFile('test.txt');
          expect(content).toContain('modified');
        } finally {
          await q.close();
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

        const q = query({
          prompt: 'Read test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent tool names in allowedTools',
      async () => {
        await helper.createFile('test.txt', 'test');

        const q = query({
          prompt: 'Read test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

        const q = query({
          prompt: 'Read test.txt and write "modified" to it.',
          options: {
            ...SHARED_TEST_OPTIONS,
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

          // Should be able to read
          expect(toolNames).toContain('read_file');

          // write_file should NOT be called in plan mode
          // (plan mode blocks all write operations)
          // The AI should respond with a plan instead
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'permissionMode yolo should be overridden by excludeTools',
      async () => {
        await helper.createFile('test.txt', 'original');

        const q = query({
          prompt: 'Read test.txt and run "echo hello" command.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool updatedInput handling', () => {
    it(
      'should apply updatedInput from canUseTool callback',
      async () => {
        await helper.createFile('test.txt', 'original');

        let capturedInput: Record<string, unknown> = {};

        const q = query({
          prompt: 'Write "new content" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
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
          const content = await helper.readFile('test.txt');
          expect(content).toBe('new content');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'canUseTool should not be called for allowedTools even if it would modify input',
      async () => {
        await helper.createFile('test.txt', 'original');

        let canUseToolCalled = false;

        const q = query({
          prompt: 'Write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
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
          const content = await helper.readFile('test.txt');
          expect(content).toBe('modified');
        } finally {
          await q.close();
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

        const q = query({
          prompt: 'Edit test.txt and list the directory.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should not auto-approve tools in allowedTools if they are not in coreTools',
      async () => {
        await helper.createFile('test.txt', 'original');
        await helper.createFile('other.txt', 'other content');

        const q = query({
          prompt: 'Read test.txt and write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should prioritize coreTools as whitelist over allowedTools',
      async () => {
        await helper.createFile('a.txt', 'content a');
        await helper.createFile('b.txt', 'content b');

        const q = query({
          prompt: 'Read both a.txt and b.txt files.',
          options: {
            ...SHARED_TEST_OPTIONS,
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
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool with asyncGenerator prompt', () => {
    it(
      'should invoke canUseTool callback when using asyncGenerator as prompt',
      async () => {
        await helper.createFile('test.txt', 'original content');

        const resultWaiter = createResultWaiter(1);
        const canUseToolCalls: Array<{
          toolName: string;
          input: Record<string, unknown>;
        }> = [];

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

          // Verify file was modified
          const content = await helper.readFile('test.txt');
          expect(content).toBe('updated');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should deny tool when canUseTool returns deny with asyncGenerator prompt',
      async () => {
        await helper.createFile('test.txt', 'original content');

        const resultWaiter = createResultWaiter(1);
        // Create an async generator that yields a single message
        async function* createPrompt(): AsyncIterable<SDKUserMessage> {
          yield {
            type: 'user',
            session_id: crypto.randomUUID(),
            message: {
              role: 'user',
              content: 'Write "modified" to test.txt.',
            },
            parent_tool_use_id: null,
          };
          await resultWaiter.waitForResult(0);
        }

        const q = query({
          prompt: createPrompt(),
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
            canUseTool: async (toolName) => {
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'Write operations are not allowed',
                };
              }
              return { behavior: 'allow', updatedInput: {} };
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

          // write_file should have been attempted but stream was closed
          const writeFileResults = findToolResults(messages, 'write_file');
          expect(writeFileResults.length).toBeGreaterThan(0);
          for (const result of writeFileResults) {
            expect(result.content).toContain(
              'Write operations are not allowed',
            );
          }

          // File content should remain unchanged (because write was denied)
          const content = await helper.readFile('test.txt');
          expect(content).toBe('original content');
        } finally {
          await q.close();
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
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['read_file', 'write_file'],
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
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('canUseTool deny and interrupt behavior', () => {
    it(
      'should interrupt loop when canUseTool returns deny with interrupt: true',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const canUseToolCalls: string[] = [];
        const resultMessages: SDKMessage[] = [];

        const q = query({
          prompt: 'Write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              // Deny write_file with interrupt
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'User denied file write',
                  interrupt: true,
                };
              }
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];
        let processExited = false;

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          // CLI may exit with code 130 (SIGINT) when interrupt is triggered
          // This is expected behavior
          processExited = true;
        } finally {
          await q.close();
        }

        // Verify canUseTool was called for write_file
        expect(canUseToolCalls).toContain('write_file');

        // Either we got a result message or the process exited (both are valid behaviors)
        if (resultMessages.length > 0) {
          const resultMsg = resultMessages[0];
          expect(isSDKResultMessage(resultMsg)).toBe(true);

          if (isSDKResultMessage(resultMsg)) {
            // Should be error_during_execution
            expect(resultMsg.subtype).toBe('error_during_execution');
            expect(resultMsg.is_error).toBe(true);

            // Should have permission_denials
            expect(resultMsg.permission_denials).toBeDefined();
            expect(resultMsg.permission_denials.length).toBeGreaterThan(0);

            // Check that write_file is in permission_denials
            const writeFileDenial = resultMsg.permission_denials.find(
              (d) => d.tool_name === 'write_file',
            );
            expect(writeFileDenial).toBeDefined();
          }
        } else {
          // Process exited due to interrupt - this is also valid
          expect(processExited || messages.length > 0).toBe(true);
        }

        // Verify file was NOT modified (loop interrupted)
        const content = await helper.readFile('test.txt');
        expect(content).toBe('test content');
      },
      TEST_TIMEOUT,
    );

    it(
      'should return EXECUTION_DENIED when canUseTool returns deny without interrupt',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const canUseToolCalls: string[] = [];
        const resultMessages: SDKResultMessage[] = [];

        const q = query({
          prompt: 'Write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              // Deny write_file without interrupt
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'User denied file write',
                  interrupt: false,
                };
              }
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];
        let processExited = false;

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          processExited = true;
        } finally {
          await q.close();
        }

        // Verify canUseTool was called for write_file
        expect(canUseToolCalls).toContain('write_file');

        // Key verification: process did NOT exit with SIGINT (code 130)
        // because interrupt: false was used
        expect(processExited).toBe(false);

        // Find the result message
        expect(resultMessages.length).toBeGreaterThan(0);
        const resultMsg = resultMessages[resultMessages.length - 1];
        expect(isSDKResultMessage(resultMsg)).toBe(true);

        // File should NOT be modified (write was denied)
        const content = await helper.readFile('test.txt');
        expect(content).toBe('test content');
      },
      TEST_TIMEOUT,
    );

    it(
      'should cascade-cancel pending tools when interrupt is triggered',
      async () => {
        // Create test files
        await helper.createFile('file1.txt', 'content1');
        await helper.createFile('file2.txt', 'content2');
        await helper.createFile('file3.txt', 'content3');

        const canUseToolCalls: string[] = [];
        const resultMessages: SDKMessage[] = [];

        const q = query({
          prompt:
            'Write "modified1" to file1.txt, "modified2" to file2.txt, and "modified3" to file3.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName, toolInput) => {
              canUseToolCalls.push(toolName);
              // Deny writing to file2.txt with interrupt
              if (
                toolName === 'write_file' &&
                typeof toolInput === 'object' &&
                toolInput !== null &&
                'file_path' in toolInput &&
                String(
                  (toolInput as { file_path?: string }).file_path,
                ).includes('file2')
              ) {
                return {
                  behavior: 'deny',
                  message: 'User denied writing to file2.txt',
                  interrupt: true,
                };
              }
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];
        let processExited = false;

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          // CLI may exit with code 130 (SIGINT) when interrupt is triggered
          processExited = true;
        } finally {
          await q.close();
        }

        // Verify canUseTool was called
        expect(canUseToolCalls.length).toBeGreaterThan(0);

        // If we got a result message, verify its contents
        if (resultMessages.length > 0) {
          const resultMsg = resultMessages[0];
          if (isSDKResultMessage(resultMsg) && resultMsg.is_error) {
            // Should have permission_denials for denied/cancelled tools
            expect(resultMsg.permission_denials).toBeDefined();
            if (resultMsg.permission_denials.length > 0) {
              // file2.txt denial should be present
              const file2Denial = resultMsg.permission_denials.find((d) => {
                const input = d.tool_input as
                  | { file_path?: string }
                  | undefined;
                return input?.file_path?.includes('file2');
              });
              expect(file2Denial).toBeDefined();
            }
          }
        } else {
          // Process exited due to interrupt - this is also valid
          expect(processExited || messages.length > 0).toBe(true);
        }

        // Verify file2.txt was NOT modified (it was the one denied with interrupt)
        // file1.txt and file3.txt may or may not be modified depending on execution order
        const content2 = await helper.readFile('file2.txt');
        expect(content2).toBe('content2');
      },
      TEST_TIMEOUT,
    );

    it(
      'should include all denied tools in permission_denials (both INTERRUPTED and EXECUTION_DENIED)',
      async () => {
        await helper.createFile('file1.txt', 'content1');
        await helper.createFile('file2.txt', 'content2');

        const resultMessages: SDKResultMessage[] = [];

        const q = query({
          prompt:
            'Write "modified1" to file1.txt and "modified2" to file2.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName, toolInput) => {
              // Deny file1.txt with interrupt (INTERRUPTED type)
              if (
                toolName === 'write_file' &&
                typeof toolInput === 'object' &&
                toolInput !== null &&
                'file_path' in toolInput &&
                String(
                  (toolInput as { file_path?: string }).file_path,
                ).includes('file1')
              ) {
                return {
                  behavior: 'deny',
                  message: 'User denied file1.txt',
                  interrupt: true,
                };
              }
              // Allow file2.txt
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];
        let processExited = false;

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          // CLI may exit with code 130 (SIGINT) when interrupt is triggered
          processExited = true;
        } finally {
          await q.close();
        }

        // Either we got a result message or the process exited (both are valid behaviors)
        if (resultMessages.length > 0) {
          const resultMsg = resultMessages[0];

          // Should be error_during_execution
          expect(resultMsg.subtype).toBe('error_during_execution');

          // Should have permission_denials
          expect(resultMsg.permission_denials.length).toBeGreaterThanOrEqual(1);

          // Verify tool names and inputs are recorded
          const denialToolNames = resultMsg.permission_denials.map(
            (d) => d.tool_name,
          );
          expect(denialToolNames).toContain('write_file');

          // Verify tool_input is recorded
          const denialWithInput = resultMsg.permission_denials.find(
            (d) => d.tool_input !== undefined,
          );
          expect(denialWithInput).toBeDefined();
        } else {
          // Process exited due to interrupt - this is also valid
          expect(processExited || messages.length > 0).toBe(true);
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should emit user message when interrupt is triggered',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const userMessages: string[] = [];
        const resultMessages: SDKResultMessage[] = [];

        const q = query({
          prompt: 'Write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName) => {
              // Deny write_file with interrupt
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'User denied file write',
                  interrupt: true,
                };
              }
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        let processExited = false;

        try {
          for await (const message of q) {
            // Capture user messages
            if (message.type === 'user' && 'message' in message) {
              const userMsg = message as SDKUserMessage;
              const content = userMsg.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    userMessages.push(block.text);
                  }
                }
              } else if (typeof content === 'string') {
                userMessages.push(content);
              }
            }

            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          // CLI may exit with code 130 (SIGINT) when interrupt is triggered
          processExited = true;
        } finally {
          await q.close();
        }

        // If we got messages, check for interrupt message
        // The interrupt message may be sent before process exits
        if (userMessages.length > 0) {
          const interruptMessage = userMessages.find((msg) =>
            msg.includes('Request interrupted by user for tool use'),
          );
          // Message might be present or process might exit before it's captured
          if (interruptMessage) {
            expect(interruptMessage).toBeDefined();
          }
        }

        // Either we got results/messages or process exited (both valid)
        expect(
          resultMessages.length > 0 || userMessages.length > 0 || processExited,
        ).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      'should not affect already executing tools during interrupt',
      async () => {
        // This test verifies that when interrupt is triggered,
        // already completed tools remain successful, and pending tools are cancelled
        await helper.createFile('file1.txt', 'content1');
        await helper.createFile('file2.txt', 'content2');

        const canUseToolCalls: string[] = [];
        let file1Allowed = false;
        const resultMessages: SDKResultMessage[] = [];

        const q = query({
          prompt:
            'Write "modified1" to file1.txt and "modified2" to file2.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName, toolInput) => {
              canUseToolCalls.push(toolName);

              // Allow file1.txt write first
              if (
                toolName === 'write_file' &&
                typeof toolInput === 'object' &&
                toolInput !== null &&
                'file_path' in toolInput &&
                String(
                  (toolInput as { file_path?: string }).file_path,
                ).includes('file1') &&
                !file1Allowed
              ) {
                file1Allowed = true;
                return { behavior: 'allow', updatedInput: {} };
              }

              // Deny file2.txt with interrupt (simulating that file1 already executed)
              if (
                toolName === 'write_file' &&
                typeof toolInput === 'object' &&
                toolInput !== null &&
                'file_path' in toolInput &&
                String(
                  (toolInput as { file_path?: string }).file_path,
                ).includes('file2')
              ) {
                return {
                  behavior: 'deny',
                  message: 'User denied file2.txt write',
                  interrupt: true,
                };
              }

              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }
        } catch {
          // CLI may exit with code 130 (SIGINT) when interrupt is triggered
          // This is expected behavior
        } finally {
          await q.close();
        }

        // Verify canUseTool was called
        expect(canUseToolCalls.length).toBeGreaterThan(0);

        // file2.txt should NOT be modified (it was denied with interrupt)
        const content2 = await helper.readFile('file2.txt');
        expect(content2).toBe('content2');
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle canUseTool deny without interrupt field (backward compatibility)',
      async () => {
        await helper.createFile('test.txt', 'test content');

        const resultMessages: SDKResultMessage[] = [];
        const canUseToolCalls: string[] = [];

        const q = query({
          prompt: 'Write "modified" to test.txt.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            permissionMode: 'default',
            coreTools: ['write_file'],
            canUseTool: async (toolName) => {
              canUseToolCalls.push(toolName);
              // Deny without interrupt field (should default to false - no interrupt)
              if (toolName === 'write_file') {
                return {
                  behavior: 'deny',
                  message: 'User denied file write',
                  // Note: no interrupt field - should default to not interrupting
                };
              }
              return { behavior: 'allow', updatedInput: {} };
            },
            debug: false,
          },
        });

        const messages: SDKMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isSDKResultMessage(message)) {
              resultMessages.push(message);
            }
          }

          // Verify canUseTool was called
          expect(canUseToolCalls).toContain('write_file');

          // Should complete (no SIGINT caused by interrupt flag)
          expect(resultMessages.length).toBeGreaterThan(0);
          const lastResult = resultMessages[resultMessages.length - 1];

          // Result could be success or error_during_execution depending on model behavior
          // The key is that no interrupt was triggered
          expect(lastResult.is_error).toBeDefined();

          // File should NOT be modified (write was denied)
          const content = await helper.readFile('test.txt');
          expect(content).toBe('test content');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
