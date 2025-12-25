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
import { query, isSDKAssistantMessage, type SDKMessage } from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  findToolCalls,
  findToolResults,
  assertSuccessfulCompletion,
  createSharedTestOptions,
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
              expect(result.content).toMatch(/permission.*declined/i);
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
              expect(result.content).toMatch(/permission.*declined/i);
            }
          }

          const shellResults = findToolResults(messages, 'run_shell_command');
          if (shellResults.length > 0) {
            for (const result of shellResults) {
              expect(result.content).toMatch(/permission.*declined/i);
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
            expect(result.content).toMatch(/permission.*declined/i);
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
              expect(result.content).toMatch(/permission.*declined/i);
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
            coreTools: ['read_file', 'write_file', 'list_directory', 'edit'],
            // Block edit
            excludeTools: ['edit'],
            // Auto-approve write
            allowedTools: ['write_file'],
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

          // canUseTool should be called for tools not in allowedTools
          // but should NOT be called for write_file (in allowedTools)
          expect(canUseToolCalls).not.toContain('write_file');

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
});
