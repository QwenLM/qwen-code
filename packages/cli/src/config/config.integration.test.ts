/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '@qwen-code/core';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigParameters } from '@qwen-code/core';
import {
  Config,
  DEFAULT_FILE_FILTERING_OPTIONS,
} from '@qwen-code/core';
import { setupServer } from 'msw/node';

export const server = setupServer();

// TODO(richieforeman): Consider moving this to test setup globally.
beforeAll(() => {
  server.listen({});
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// Parsing a matched command runs it, and for the root command that means the
// whole startup tail. These tests only exercise argv parsing, so the root
// command's body is stubbed out.
vi.mock('../startup/rootCommandHandler.js', () => ({
  handleRootCommand: vi.fn(),
}));

// Mock file discovery service and tool registry
vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual('@qwen-code/core');
  return {
    ...actual,
    FileDiscoveryService: vi.fn().mockImplementation(() => ({
      initialize: vi.fn(),
    })),
    createToolRegistry: vi.fn().mockResolvedValue({}),
  };
});

describe('Configuration Integration Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'gemini-cli-test-'));
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('File Filtering and Configuration', () => {
    it.each([
      {
        description:
          'should load default file filtering settings when fileFiltering is missing',
        fileFiltering: undefined,
        expected: DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      },
      {
        description:
          'should load custom file filtering settings from configuration',
        fileFiltering: { respectGitIgnore: false },
        expected: false,
      },
      {
        description:
          'should respect file filtering settings from configuration',
        fileFiltering: { respectGitIgnore: true },
        expected: true,
      },
      {
        description:
          'should handle empty fileFiltering object gracefully and use defaults',
        fileFiltering: {},
        expected: DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      },
    ])('$description', async ({ fileFiltering, expected }) => {
      const configParams: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        cwd: '/tmp',
        model: 'test-model',
        embeddingModel: 'test-embedding-model',
        targetDir: tempDir,
        debugMode: false,
        fileFiltering,
      };

      const config = new Config(configParams);

      expect(config.getFileFilteringRespectGitIgnore()).toBe(expected);
    });
  });

  describe('Real-world Configuration Scenarios', () => {
    it.each([
      {
        description: 'should handle a security-focused configuration',
        respectGitIgnore: true,
      },
      {
        description: 'should handle a CI/CD environment configuration',
        respectGitIgnore: false,
      },
    ])('$description', async ({ respectGitIgnore }) => {
      const configParams: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        cwd: '/tmp',
        model: 'test-model',
        embeddingModel: 'test-embedding-model',
        targetDir: tempDir,
        debugMode: false,
        fileFiltering: {
          respectGitIgnore,
        },
      };

      const config = new Config(configParams);

      expect(config.getFileFilteringRespectGitIgnore()).toBe(respectGitIgnore);
    });
  });

  describe('File Checkpointing Configuration', () => {
    it('should enable file checkpointing when the setting is true', async () => {
      const configParams: ConfigParameters = {
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'test-session',
        cwd: '/tmp',
        model: 'test-model',
        embeddingModel: 'test-embedding-model',
        targetDir: tempDir,
        debugMode: false,
        fileCheckpointing: true,
      };

      const config = new Config(configParams);

      expect(config.getFileCheckpointingEnabled()).toBe(true);
    });
  });

  describe('Permission Mode Integration Tests', () => {
    let createCommand: typeof import('../commands/index.js').createCommand;
    let handleRootCommand: typeof import('../startup/rootCommandHandler.js').handleRootCommand;

    beforeEach(async () => {
      // Import the command tree builder for integration testing
      ({ createCommand } = await import('../commands/index.js'));
      ({ handleRootCommand } = await import('../startup/rootCommandHandler.js'));
    });

    /** Runs process.argv through the real command tree, the way main() does. */
    async function runCommandTree(): Promise<void> {
      const program = await createCommand();
      await program.parseAsync(process.argv);
    }

    /**
     * The command tree hands the parsed argv to the matched command's action
     * rather than returning it, so the stubbed root command is where the argv
     * is read back from.
     */
    async function parseArgsForRootCommand() {
      vi.mocked(handleRootCommand).mockClear();
      await runCommandTree();
      const call = vi.mocked(handleRootCommand).mock.calls.at(-1);
      if (!call) {
        throw new Error('argv did not route to the root command');
      }
      return call[0];
    }

    it.each([
      {
        description: 'should parse --permission-mode=accept_edits correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'accept_edits',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'accept_edits', prompt: 'test' },
      },
      {
        description:
          'should parse --permission-mode=bypass_permissions correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'bypass_permissions',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'bypass_permissions', prompt: 'test' },
      },
      {
        description: 'should parse --permission-mode=default correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'default',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'default', prompt: 'test' },
      },
      {
        description: 'should parse --permission-mode=acceptEdits correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'acceptEdits',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'accept_edits', prompt: 'test' },
      },
      {
        description:
          'should parse --permission-mode=bypassPermissions correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'bypassPermissions',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'bypass_permissions', prompt: 'test' },
      },
      {
        description: 'should parse --permission-mode=dontAsk correctly',
        argv: [
          'node',
          'script.js',
          '--permission-mode',
          'dontAsk',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'dont_ask', prompt: 'test' },
      },
      {
        description: 'should handle no permission mode arguments',
        argv: ['node', 'script.js', '-p', 'test'],
        expected: { permissionMode: undefined, prompt: 'test' },
      },
      {
        description: 'should parse --yolo as bypass_permissions',
        argv: ['node', 'script.js', '--yolo', '-p', 'test'],
        expected: { permissionMode: 'bypass_permissions', prompt: 'test' },
      },
      {
        description:
          'should parse --dangerously-skip-permissions as bypass_permissions',
        argv: [
          'node',
          'script.js',
          '--dangerously-skip-permissions',
          '-p',
          'test',
        ],
        expected: { permissionMode: 'bypass_permissions', prompt: 'test' },
      },
    ])('$description', async ({ argv, expected }) => {
      const originalArgv = process.argv;
      try {
        process.argv = argv;
        const parsedArgs = await parseArgsForRootCommand();
        expect(parsedArgs.permissionMode).toBe(expected.permissionMode);
        expect(parsedArgs.prompt).toBe(expected.prompt);
      } finally {
        process.argv = originalArgv;
      }
    });

    it.each([
      {
        description: 'should reject invalid permission mode values',
        argv: ['node', 'script.js', '--permission-mode', 'invalid_mode'],
      },
    ])('$description', async ({ argv }) => {
      const originalArgv = process.argv;
      try {
        process.argv = argv;
        await expect(runCommandTree()).rejects.toThrow();
      } finally {
        process.argv = originalArgv;
      }
    });
  });
});
