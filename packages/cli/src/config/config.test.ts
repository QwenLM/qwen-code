/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ToolNames,
  DEFAULT_QWEN_MODEL,
  OutputFormat,
  NativeLspService,
  Storage,
  SessionIdCaseConflictError,
} from '@qwen-code/qwen-code-core';
import {
  isValidSessionId,
  loadCliConfig,
  parseArguments,
  SessionIdConflictError,
  type CliArgs,
} from './config.js';
import type { Settings } from './settings.js';
import * as ServerConfig from '@qwen-code/qwen-code-core';
import { isWorkspaceTrusted } from './trustedFolders.js';
import { resetMcpApprovalsForTesting } from './mcpApprovals.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockUpdateHandler = vi.hoisted(() => vi.fn());
const mockSessionServiceInstance = vi.hoisted(() => ({
  loadLastSession: vi.fn(),
  loadSession: vi.fn(),
  forkSession: vi.fn(),
  sessionExists: vi.fn(),
  sessionExistsInAnyState: vi.fn(),
  findSessionIdIgnoringCase: vi.fn(),
}));
const mockSessionServiceCtor = vi.hoisted(() =>
  vi.fn(() => mockSessionServiceInstance),
);
const mockConfigConstructorParams = vi.hoisted(() => vi.fn());

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: mockWriteStdoutLine,
  clearScreen: vi.fn(),
}));

vi.mock('../commands/update.js', () => ({
  updateCommand: {
    command: 'update',
    describe: 'mock update command',
    handler: mockUpdateHandler,
  },
}));

const createNativeLspServiceInstance = () => ({
  discoverAndPrepare: vi.fn(),
  start: vi.fn(),
  definitions: vi.fn().mockResolvedValue([]),
  references: vi.fn().mockResolvedValue([]),
  workspaceSymbols: vi.fn().mockResolvedValue([]),
  hover: vi.fn().mockResolvedValue(null),
  documentSymbols: vi.fn().mockResolvedValue([]),
  implementations: vi.fn().mockResolvedValue([]),
  prepareCallHierarchy: vi.fn().mockResolvedValue([]),
  incomingCalls: vi.fn().mockResolvedValue([]),
  outgoingCalls: vi.fn().mockResolvedValue([]),
  diagnostics: vi.fn().mockResolvedValue([]),
  workspaceDiagnostics: vi.fn().mockResolvedValue([]),
  codeActions: vi.fn().mockResolvedValue([]),
  applyWorkspaceEdit: vi.fn().mockResolvedValue(false),
  getStatusSnapshot: vi.fn().mockReturnValue({
    enabled: true,
    configuredServers: 1,
    readyServers: 1,
    failedServers: 0,
    inProgressServers: 0,
    notStartedServers: 0,
    servers: [
      {
        name: 'typescript',
        status: 'READY',
        languages: ['typescript'],
        transport: 'stdio',
      },
    ],
  }),
});

vi.mock('./trustedFolders.js', () => ({
  isWorkspaceTrusted: vi
    .fn()
    .mockReturnValue({ isTrusted: true, source: 'file' }), // Default to trusted
}));

const nativeLspServiceMock = vi.mocked(NativeLspService);
const getLastLspInstance = () => {
  const results = nativeLspServiceMock.mock.results;
  if (results.length === 0) {
    return undefined;
  }
  return results[results.length - 1]?.value as ReturnType<
    typeof createNativeLspServiceInstance
  >;
};

vi.mock('fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof import('fs')>();
  const pathMod = await import('node:path');
  const mockHome = '/mock/home/user';
  const MOCK_CWD1 = process.cwd();
  const MOCK_CWD2 = pathMod.resolve(pathMod.sep, 'home', 'user', 'project');

  const mockPaths = new Set([
    MOCK_CWD1,
    MOCK_CWD2,
    pathMod.resolve(pathMod.sep, 'cli', 'path1'),
    pathMod.resolve(pathMod.sep, 'settings', 'path1'),
    pathMod.join(mockHome, 'settings', 'path2'),
    pathMod.join(MOCK_CWD2, 'cli', 'path2'),
    pathMod.join(MOCK_CWD2, 'settings', 'path3'),
  ]);

  return {
    ...actualFs,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn((p) => mockPaths.has(p.toString())),
    statSync: vi.fn((p) => {
      if (mockPaths.has(p.toString())) {
        return { isDirectory: () => true } as unknown as import('fs').Stats;
      }
      return (actualFs as typeof import('fs')).statSync(p as unknown as string);
    }),
    realpathSync: vi.fn((p) => p),
  };
});

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(() => '/mock/home/user'),
  };
});

vi.mock('open', () => ({
  default: vi.fn(),
}));

vi.mock('read-package-up', () => ({
  readPackageUp: vi.fn(() =>
    Promise.resolve({
      packageJson: {
        version: 'test-version',
        config: { sandboxImageUri: 'pkg-default-image' },
      },
    }),
  ),
}));

vi.mock('command-exists', () => ({
  default: {
    sync: vi.fn(() => true),
  },
}));

// #7734 added a sandbox runtime probe that spawns a real `docker version`
// subprocess during sandbox selection. These tests enable the sandbox to assert
// image precedence, not which runtime is chosen, so left unmocked the probe runs
// for real and the suite fails on any non-macOS host without a running daemon
// (macOS is masked because the sandbox-exec branch returns before probing).
// Report the runtime probe healthy; leave every other spawnSync call real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = vi.fn(
    (command: string, args?: readonly string[], options?: unknown) => {
      if (
        (command === 'docker' || command === 'podman') &&
        args?.[0] === 'version'
      ) {
        return {
          status: 0,
          stdout: '',
          stderr: '',
          signal: null,
          pid: 0,
          output: [],
          error: undefined,
        };
      }
      return (actual.spawnSync as unknown as (...a: unknown[]) => unknown)(
        command,
        args,
        options,
      );
    },
  );
  return { ...actual, default: { ...actual, spawnSync }, spawnSync };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actualServer = await importOriginal<typeof ServerConfig>();
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.listSkills = vi.fn().mockResolvedValue([]);
  SkillManagerMock.prototype.addChangeListener = vi.fn();
  SkillManagerMock.prototype.removeChangeListener = vi.fn();
  class ConfigWithParamCapture extends actualServer.Config {
    constructor(...args: ConstructorParameters<typeof actualServer.Config>) {
      mockConfigConstructorParams(args[0]);
      super(...args);
    }
  }
  return {
    ...actualServer,
    Config: ConfigWithParamCapture,
    NativeLspService: vi
      .fn()
      .mockImplementation(() => createNativeLspServiceInstance()),
    SessionService: mockSessionServiceCtor,
    SkillManager: SkillManagerMock,
    IdeClient: {
      getInstance: vi.fn().mockResolvedValue({
        getConnectionStatus: vi.fn(),
        initialize: vi.fn(),
        shutdown: vi.fn(),
      }),
    },
    loadEnvironment: vi.fn(),
    loadServerHierarchicalMemory: vi.fn(
      // Match the real signature: (cwd, includeDirs, fileService,
      // extensionContextFilePaths, folderTrust, importFormat,
      // contextRuleExcludes, options)
      (cwd, _dirs, _fileService, extensionContextFilePaths) =>
        Promise.resolve({
          memoryContent: extensionContextFilePaths?.join(',') || '',
          fileCount: extensionContextFilePaths?.length || 0,
          contextFilePaths: extensionContextFilePaths || [],
          ruleCount: 0,
          conditionalRules: [],
          projectRoot: cwd || '/tmp',
        }),
    ),
    DEFAULT_MEMORY_FILE_FILTERING_OPTIONS: {
      respectGitIgnore: false,
      respectQwenIgnore: true,
    },
    DEFAULT_FILE_FILTERING_OPTIONS: {
      respectGitIgnore: true,
      respectQwenIgnore: true,
    },
  };
});

describe('isValidSessionId', () => {
  it.each([
    ['a canonical UUID', 'b2a1c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    [
      'an agent-suffixed UUID',
      'b2a1c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d-agent-qwen',
    ],
  ])('accepts %s', (_, value) => {
    expect(isValidSessionId(value)).toBe(true);
  });

  // These shapes are paste-into-shell payloads for the exit-time resume
  // echo, so the production gate must reject them.
  it.each([
    ['newline', 'evil\nrm -rf ~'],
    ['escape sequence', 'evil\u001B]52;c;pwned\u0007session'],
    ['leading dash', '-cafebabe0123456789abcdef01234567'],
    ['non-UUID token', 'abc123'],
  ])('rejects a payload with a %s', (_, value) => {
    expect(isValidSessionId(value)).toBe(false);
  });
});

describe('parseArguments', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('includes every approval mode description in --help', async () => {
    process.argv = ['node', 'script.js', '--help'];
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });
    try {
      await expect(parseArguments()).rejects.toThrow(
        'process.exit unexpectedly called with "0"',
      );
      const help = output.join('');
      for (const mode of ServerConfig.APPROVAL_MODES) {
        expect(help).toContain(
          `${mode} (${ServerConfig.APPROVAL_MODE_INFO[mode].description})`,
        );
      }
    } finally {
      log.mockRestore();
    }
  });

  it('should throw an error when both --prompt and --prompt-interactive are used together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--prompt',
      'test prompt',
      '--prompt-interactive',
      'interactive prompt',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both --prompt (-p) and --prompt-interactive (-i) together',
      ),
    );

    mockExit.mockRestore();
  });

  it('should throw an error when using short flags -p and -i together', async () => {
    process.argv = [
      'node',
      'script.js',
      '-p',
      'test prompt',
      '-i',
      'interactive prompt',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both --prompt (-p) and --prompt-interactive (-i) together',
      ),
    );

    mockExit.mockRestore();
  });

  it('should allow --prompt without --prompt-interactive', async () => {
    process.argv = ['node', 'script.js', '--prompt', 'test prompt'];
    const argv = await parseArguments();
    expect(argv.prompt).toBe('test prompt');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('registers update as an exiting subcommand', async () => {
    process.argv = ['node', 'script.js', 'update'];
    mockUpdateHandler.mockResolvedValue(undefined);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockUpdateHandler).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });

  it('propagates non-zero exitCode from the update handler', async () => {
    process.argv = ['node', 'script.js', 'update'];
    mockUpdateHandler.mockImplementation(() => {
      process.exitCode = 1;
    });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(parseArguments()).rejects.toThrow('process.exit called');

      expect(mockUpdateHandler).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockExit.mockRestore();
      mockUpdateHandler.mockReset();
      process.exitCode = undefined;
    }
  });

  it('should allow --prompt-interactive without --prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--prompt-interactive',
      'interactive prompt',
    ];
    const argv = await parseArguments();
    expect(argv.promptInteractive).toBe('interactive prompt');
    expect(argv.prompt).toBeUndefined();
  });

  it('should allow -i flag as alias for --prompt-interactive', async () => {
    process.argv = ['node', 'script.js', '-i', 'interactive prompt'];
    const argv = await parseArguments();
    expect(argv.promptInteractive).toBe('interactive prompt');
    expect(argv.prompt).toBeUndefined();
  });

  it('parses --insecure as a boolean flag (default false)', async () => {
    process.argv = ['node', 'script.js'];
    const defaultArgv = await parseArguments();
    expect(defaultArgv.insecure).toBe(false);

    process.argv = ['node', 'script.js', '--insecure'];
    const argv = await parseArguments();
    expect(argv.insecure).toBe(true);
  });

  it('rejects --json-schema combined with --acp', async () => {
    // ACP runs an independent turn loop (runAcpAgent) that doesn't honour
    // the synthetic structured_output terminal contract. The yargs check
    // must reject the combination at parse time so users get an actionable
    // error instead of silently watching the run never terminate.
    process.argv = [
      'node',
      'script.js',
      '--acp',
      '--json-schema',
      '{"type":"object"}',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('--json-schema cannot be used with --acp'),
    );

    mockExit.mockRestore();
  });

  it('rejects --json-schema combined with --experimental-acp (deprecated alias)', async () => {
    // --experimental-acp is the deprecated alias; the same mutual-
    // exclusion logic must apply or users get the silent-no-terminate
    // behaviour the --acp check was added to prevent.
    process.argv = [
      'node',
      'script.js',
      '--experimental-acp',
      '--json-schema',
      '{"type":"object"}',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('--json-schema cannot be used with --acp'),
    );

    mockExit.mockRestore();
  });

  it('rejects --json-schema combined with --prompt-interactive (-i)', async () => {
    // The interactive flow doesn't honour the synthetic-tool terminal
    // contract — `structured_output` would just print "accepted" and
    // leave the chat alive. The yargs check must reject this at parse
    // time so users get an actionable message instead of a silently
    // misbehaving run.
    process.argv = [
      'node',
      'script.js',
      '-i',
      'do work then submit',
      '--json-schema',
      '{"type":"object"}',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'structured output only terminates the non-interactive flow',
      ),
    );

    mockExit.mockRestore();
  });

  it('rejects --json-schema combined with --input-format stream-json', async () => {
    // The "first valid structured_output call ends the session"
    // contract is incompatible with the long-lived stream-json input
    // protocol. Also load-bearing: gemini.tsx's
    // `process.exit(process.exitCode ?? 0)` plumbing in the stream-json
    // branch explicitly relies on this rejection holding. Pair with
    // --output-format stream-json because input/output formats must
    // match (a separate yargs check fires first otherwise).
    process.argv = [
      'node',
      'script.js',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--json-schema',
      '{"type":"object"}',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('first structured_output call ends the session'),
    );

    mockExit.mockRestore();
  });

  it('should parse --system-prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--system-prompt',
      'You are a test system prompt.',
    ];
    const argv = await parseArguments();
    expect(argv.systemPrompt).toBe('You are a test system prompt.');
    expect(argv.appendSystemPrompt).toBeUndefined();
  });

  it('should parse --append-system-prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--append-system-prompt',
      'Be extra concise.',
    ];
    const argv = await parseArguments();
    expect(argv.appendSystemPrompt).toBe('Be extra concise.');
    expect(argv.systemPrompt).toBeUndefined();
  });

  it('should allow -r flag as alias for --resume', async () => {
    process.argv = [
      'node',
      'script.js',
      '-r',
      '123e4567-e89b-12d3-a456-426614174000',
    ];
    const argv = await parseArguments();
    expect(argv.resume).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('should allow -c flag as alias for --continue', async () => {
    process.argv = ['node', 'script.js', '-c'];
    const argv = await parseArguments();
    expect(argv.continue).toBe(true);
  });

  it('should parse --fork-session with --resume', async () => {
    process.argv = [
      'node',
      'script.js',
      '--resume',
      '123e4567-e89b-12d3-a456-426614174000',
      '--fork-session',
    ];
    const argv = await parseArguments();
    expect(argv.resume).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(argv.forkSession).toBe(true);
  });

  it('should parse --fork-session with the --resume picker form', async () => {
    process.argv = ['node', 'script.js', '--resume', '--fork-session'];
    const argv = await parseArguments();
    // Empty string is the existing yargs shape for picker form: --resume
    // without an explicit session ID.
    expect(argv.resume).toBe('');
    expect(argv.forkSession).toBe(true);
  });

  it('should reject --fork-session without --resume or --continue', async () => {
    process.argv = ['node', 'script.js', '--fork-session'];
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        '--fork-session must be used with --resume or --continue',
      ),
    );

    mockExit.mockRestore();
  });

  it('should convert positional query argument to prompt by default', async () => {
    process.argv = ['node', 'script.js', 'Hi Gemini'];
    const argv = await parseArguments();
    expect(argv.query).toBe('Hi Gemini');
    expect(argv.prompt).toBe('Hi Gemini');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should map @path to prompt (one-shot) when it starts with @', async () => {
    process.argv = ['node', 'script.js', '@path ./file.md'];
    const argv = await parseArguments();
    expect(argv.query).toBe('@path ./file.md');
    expect(argv.prompt).toBe('@path ./file.md');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should map @path to prompt even when config flags are present', async () => {
    // @path queries should now go to one-shot mode regardless of other flags
    process.argv = [
      'node',
      'script.js',
      '@path',
      './file.md',
      '--model',
      'gemini-1.5-pro',
    ];
    const argv = await parseArguments();
    expect(argv.query).toBe('@path ./file.md');
    expect(argv.prompt).toBe('@path ./file.md'); // Should map to one-shot
    expect(argv.promptInteractive).toBeUndefined();
    expect(argv.model).toBe('gemini-1.5-pro');
  });

  it('maps unquoted positional @path + arg to prompt (one-shot)', async () => {
    // Simulate: gemini @path ./file.md
    process.argv = ['node', 'script.js', '@path', './file.md'];
    const argv = await parseArguments();
    // After normalization, query is a single string
    expect(argv.query).toBe('@path ./file.md');
    // And it's mapped to one-shot prompt when no -p/-i flags are set
    expect(argv.prompt).toBe('@path ./file.md');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should handle multiple @path arguments in a single command (one-shot)', async () => {
    // Simulate: gemini @path ./file1.md @path ./file2.md
    process.argv = [
      'node',
      'script.js',
      '@path',
      './file1.md',
      '@path',
      './file2.md',
    ];
    const argv = await parseArguments();
    // After normalization, all arguments are joined with spaces
    expect(argv.query).toBe('@path ./file1.md @path ./file2.md');
    // And it's mapped to one-shot prompt
    expect(argv.prompt).toBe('@path ./file1.md @path ./file2.md');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should handle mixed quoted and unquoted @path arguments (one-shot)', async () => {
    // Simulate: gemini "@path ./file1.md" @path ./file2.md "additional text"
    process.argv = [
      'node',
      'script.js',
      '@path ./file1.md',
      '@path',
      './file2.md',
      'additional text',
    ];
    const argv = await parseArguments();
    // After normalization, all arguments are joined with spaces
    expect(argv.query).toBe(
      '@path ./file1.md @path ./file2.md additional text',
    );
    // And it's mapped to one-shot prompt
    expect(argv.prompt).toBe(
      '@path ./file1.md @path ./file2.md additional text',
    );
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should map @path to prompt with ambient flags (debug, telemetry)', async () => {
    // Ambient flags like debug, telemetry should NOT affect routing
    process.argv = [
      'node',
      'script.js',
      '@path',
      './file.md',
      '--debug',
      '--telemetry',
    ];
    const argv = await parseArguments();
    expect(argv.query).toBe('@path ./file.md');
    expect(argv.prompt).toBe('@path ./file.md'); // Should map to one-shot
    expect(argv.promptInteractive).toBeUndefined();
    expect(argv.debug).toBe(true);
    expect(argv.telemetry).toBe(true);
  });

  it('should map any @command to prompt (one-shot)', async () => {
    // Test that all @commands now go to one-shot mode
    const testCases = [
      '@path ./file.md',
      '@include src/',
      '@search pattern',
      '@web query',
      '@git status',
    ];

    for (const testQuery of testCases) {
      process.argv = ['node', 'script.js', testQuery];
      const argv = await parseArguments();
      expect(argv.query).toBe(testQuery);
      expect(argv.prompt).toBe(testQuery);
      expect(argv.promptInteractive).toBeUndefined();
    }
  });

  it('should handle @command with leading whitespace', async () => {
    // Test that trim() + routing handles leading whitespace correctly
    process.argv = ['node', 'script.js', '  @path ./file.md'];
    const argv = await parseArguments();
    expect(argv.query).toBe('  @path ./file.md');
    expect(argv.prompt).toBe('  @path ./file.md');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should throw an error when both --yolo and --approval-mode are used together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--yolo',
      '--approval-mode',
      'default',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.',
      ),
    );

    mockExit.mockRestore();
  });

  it('should throw an error when using short flags -y and --approval-mode together', async () => {
    process.argv = ['node', 'script.js', '-y', '--approval-mode', 'yolo'];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.',
      ),
    );

    mockExit.mockRestore();
  });

  it('should allow --system-prompt and --append-system-prompt together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--system-prompt',
      'Override prompt',
      '--append-system-prompt',
      'Append prompt',
    ];

    const argv = await parseArguments();
    expect(argv.systemPrompt).toBe('Override prompt');
    expect(argv.appendSystemPrompt).toBe('Append prompt');
  });

  it('should throw an error when include-partial-messages is used without stream-json output', async () => {
    process.argv = ['node', 'script.js', '--include-partial-messages'];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        '--include-partial-messages requires --output-format stream-json',
      ),
    );

    mockExit.mockRestore();
  });

  it('should reject --json-schema with no prompt source when stdin is a TTY', async () => {
    // True interactive invocation with no prompt anywhere → fail fast.
    process.argv = ['node', 'script.js', '--json-schema', '{"type":"object"}'];

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    try {
      await expect(parseArguments()).rejects.toThrow('process.exit called');
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining(
          '--json-schema only applies to non-interactive mode',
        ),
      );
    } finally {
      mockExit.mockRestore();
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('should accept --json-schema with no -p / positional when stdin is piped', async () => {
    // `echo "..." | qwen --json-schema ...` — input arrives via the
    // pipe, so the prompt-presence check must not block the run.
    process.argv = ['node', 'script.js', '--json-schema', '{"type":"object"}'];

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const argv = await parseArguments();
      expect(argv.jsonSchema).toBe('{"type":"object"}');
      expect(argv.prompt).toBeUndefined();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('should throw when --json-schema is combined with --input-format stream-json', async () => {
    // stream-json input runs through runNonInteractiveStreamJson which
    // doesn't honor the structured-output single-shot termination
    // contract — reject the combination at parse time so the user sees
    // the mismatch immediately.
    process.argv = [
      'node',
      'script.js',
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--json-schema',
      '{"type":"object"}',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        '--json-schema cannot be used with --input-format stream-json',
      ),
    );

    mockExit.mockRestore();
  });

  it('should parse stream-json formats and include-partial-messages flag', async () => {
    process.argv = [
      'node',
      'script.js',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
    ];

    const argv = await parseArguments();

    expect(argv.outputFormat).toBe('stream-json');
    expect(argv.inputFormat).toBe('stream-json');
    expect(argv.includePartialMessages).toBe(true);
  });

  it('should allow --approval-mode without --yolo', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'auto-edit'];
    const argv = await parseArguments();
    expect(argv.approvalMode).toBe('auto-edit');
    expect(argv.yolo).toBe(false);
  });

  it('should allow --yolo without --approval-mode', async () => {
    process.argv = ['node', 'script.js', '--yolo'];
    const argv = await parseArguments();
    expect(argv.yolo).toBe(true);
    expect(argv.approvalMode).toBeUndefined();
  });

  it('should accept desktop as a channel identifier', async () => {
    process.argv = ['node', 'script.js', '--channel', 'desktop'];
    const argv = await parseArguments();
    expect(argv.channel).toBe('desktop');
  });

  it('should accept daemon as a channel identifier', async () => {
    process.argv = ['node', 'script.js', '--channel', 'daemon'];
    const argv = await parseArguments();
    expect(argv.channel).toBe('daemon');
  });

  it('should default ACP mode to the ACP channel when no channel is provided', async () => {
    vi.stubEnv('QWEN_CODE_SERVE', '');
    vi.stubEnv('QWEN_CODE_DESKTOP', '');
    try {
      process.argv = ['node', 'script.js', '--acp'];
      const argv = await parseArguments();
      expect(argv.channel).toBe('ACP');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps an explicit --channel when combined with --acp (the desktop invocation)', async () => {
    process.argv = ['node', 'script.js', '--acp', '--channel', 'desktop'];
    const argv = await parseArguments();
    // The `!result['channel']` guard must not override an explicitly provided
    // channel with the ACP default.
    expect(argv.channel).toBe('desktop');
    expect(argv.acp).toBe(true);
  });

  it('reports the daemon channel for daemon-spawned ACP children', async () => {
    vi.stubEnv('QWEN_CODE_SERVE', '1');
    vi.stubEnv('QWEN_CODE_DESKTOP', '');
    try {
      process.argv = ['node', 'script.js', '--acp'];
      const argv = await parseArguments();
      expect(argv.channel).toBe('daemon');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the desktop channel for the Tauri desktop shell', async () => {
    vi.stubEnv('QWEN_CODE_SERVE', '1');
    vi.stubEnv('QWEN_CODE_DESKTOP', '1');
    try {
      process.argv = ['node', 'script.js', '--acp'];
      const argv = await parseArguments();
      expect(argv.channel).toBe('desktop');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps an explicit --channel over the daemon markers', async () => {
    vi.stubEnv('QWEN_CODE_SERVE', '1');
    try {
      process.argv = ['node', 'script.js', '--acp', '--channel', 'VSCode'];
      const argv = await parseArguments();
      expect(argv.channel).toBe('VSCode');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('should reject invalid --approval-mode values', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'invalid'];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Invalid values:'),
    );

    mockExit.mockRestore();
  });

  it('should support comma-separated values for --allowed-tools', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-tools',
      'read_file,ShellTool(git status)',
    ];
    const argv = await parseArguments();
    expect(argv.allowedTools).toEqual(['read_file', 'ShellTool(git status)']);
  });

  it('should support comma-separated values for --allowed-mcp-server-names', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1,server2',
    ];
    const argv = await parseArguments();
    expect(argv.allowedMcpServerNames).toEqual(['server1', 'server2']);
  });

  it('should support comma-separated values for --extensions', async () => {
    process.argv = ['node', 'script.js', '--extensions', 'ext1,ext2'];
    const argv = await parseArguments();
    expect(argv.extensions).toEqual(['ext1', 'ext2']);
  });

  it('should parse --bare', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    expect(argv.bare).toBe(true);
  });

  describe('--fallback-model flag', () => {
    it('parses a single fallback model', async () => {
      process.argv = ['node', 'script.js', '--fallback-model', 'qwen-plus'];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toEqual(['qwen-plus']);
    });

    it('parses repeated --fallback-model flags', async () => {
      process.argv = [
        'node',
        'script.js',
        '--fallback-model',
        'qwen-plus',
        '--fallback-model',
        'qwen-turbo',
      ];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('splits comma-separated values in a single flag', async () => {
      process.argv = [
        'node',
        'script.js',
        '--fallback-model',
        'qwen-plus,qwen-turbo',
      ];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('combines repeated flags with comma-separated values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--fallback-model',
        'qwen-plus,qwen-turbo',
        '--fallback-model',
        'qwen-max',
      ];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toEqual([
        'qwen-plus',
        'qwen-turbo',
        'qwen-max',
      ]);
    });

    it('trims whitespace around comma-separated values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--fallback-model',
        ' qwen-plus , qwen-turbo ',
      ];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toEqual(['qwen-plus', 'qwen-turbo']);
    });

    it('defaults to undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      expect(argv.fallbackModel).toBeUndefined();
    });
  });
});

describe('loadCliConfig', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    nativeLspServiceMock.mockReset();
    nativeLspServiceMock.mockImplementation(
      () => createNativeLspServiceInstance() as unknown as NativeLspService,
    );
    mockSessionServiceCtor.mockImplementation(() => mockSessionServiceInstance);
    mockSessionServiceInstance.loadLastSession.mockResolvedValue(undefined);
    mockSessionServiceInstance.loadSession.mockResolvedValue(undefined);
    mockSessionServiceInstance.forkSession.mockResolvedValue({
      filePath: '/mock/fork.jsonl',
      copiedCount: 1,
    });
    mockSessionServiceInstance.sessionExists.mockResolvedValue(false);
    mockSessionServiceInstance.sessionExistsInAnyState.mockResolvedValue(false);
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      undefined,
    );
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    resetMcpApprovalsForTesting();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    resetMcpApprovalsForTesting();
    vi.restoreAllMocks();
  });

  it('should reset context file names to QWEN.md and AGENTS.md by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const setGeminiMdFilenameSpy = vi.spyOn(
      ServerConfig,
      'setGeminiMdFilename',
    );

    await loadCliConfig(settings, argv);

    expect(setGeminiMdFilenameSpy).toHaveBeenCalledTimes(1);
    expect(setGeminiMdFilenameSpy).toHaveBeenCalledWith([
      ServerConfig.DEFAULT_CONTEXT_FILENAME,
      ServerConfig.AGENT_CONTEXT_FILENAME,
    ]);
  });

  it('enables debug file logging for --debug when QWEN_DEBUG_LOG_FILE is unset', async () => {
    delete process.env['QWEN_DEBUG_LOG_FILE'];
    process.argv = ['node', 'script.js', '--debug'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(process.env['QWEN_DEBUG_LOG_FILE']).toBe('1');
  });

  it('maps --restore-ask-user-question only in ACP mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--acp',
      '--restore-ask-user-question',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv);
    expect(config.getRestoreAskUserQuestion()).toBe(true);
  });

  it('ignores --restore-ask-user-question outside ACP mode', async () => {
    process.argv = ['node', 'script.js', '--restore-ask-user-question'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv);
    expect(config.getRestoreAskUserQuestion()).toBe(false);
  });

  it('defaults restoreAskUserQuestion to false', async () => {
    process.argv = ['node', 'script.js', '--acp'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv);
    expect(config.getRestoreAskUserQuestion()).toBe(false);
  });

  it('preserves explicit opt-out when --debug is used', async () => {
    process.env['QWEN_DEBUG_LOG_FILE'] = '0';
    process.argv = ['node', 'script.js', '--debug'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(process.env['QWEN_DEBUG_LOG_FILE']).toBe('0');
  });

  it('leaves debug file logging unset outside --debug mode', async () => {
    delete process.env['QWEN_DEBUG_LOG_FILE'];
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(process.env['QWEN_DEBUG_LOG_FILE']).toBeUndefined();
  });

  describe('usage statistics', () => {
    it.each<[string, string | undefined, boolean | undefined, boolean]>([
      ['defaults to enabled', undefined, undefined, true],
      ['uses a disabled setting', undefined, false, false],
      ['lets true override a disabled setting', 'true', false, true],
      ['lets 1 override a disabled setting', '1', false, true],
      ['lets false override an enabled setting', 'false', true, false],
      ['lets 0 override an enabled setting', '0', true, false],
    ])('%s', async (_name, envValue, settingValue, expected) => {
      vi.stubEnv('QWEN_USAGE_STATISTICS_ENABLED', envValue);
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const settings: Settings =
        settingValue === undefined
          ? {}
          : { privacy: { usageStatisticsEnabled: settingValue } };

      const config = await loadCliConfig(settings, argv);

      expect(config.getUsageStatisticsEnabled()).toBe(expected);
    });
  });

  it('should use configured context file name when settings.context.fileName is set', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      context: {
        fileName: 'CUSTOM_AGENTS.md',
      },
    };
    const setGeminiMdFilenameSpy = vi.spyOn(
      ServerConfig,
      'setGeminiMdFilename',
    );

    await loadCliConfig(settings, argv);

    expect(setGeminiMdFilenameSpy).toHaveBeenCalledTimes(1);
    expect(setGeminiMdFilenameSpy).toHaveBeenCalledWith('CUSTOM_AGENTS.md');
  });

  it('should propagate stream-json formats to config', async () => {
    process.argv = [
      'node',
      'script.js',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv);

    expect(config.getOutputFormat()).toBe('stream-json');
    expect(config.getInputFormat()).toBe('stream-json');
    expect(config.getIncludePartialMessages()).toBe(true);
  });

  it('should prefer CLI fallback models over settings fallback models', async () => {
    process.argv = ['node', 'script.js', '--fallback-model', 'cli-a,cli-b'];
    const argv = await parseArguments();
    const config = await loadCliConfig({ modelFallbacks: 'settings-a' }, argv);

    expect(config.getModelFallbacks()).toEqual(['cli-a', 'cli-b']);
  });

  it('should use settings fallback models when the CLI flag is absent', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { modelFallbacks: ' settings-a , settings-b ' },
      argv,
    );

    expect(config.getModelFallbacks()).toEqual(['settings-a', 'settings-b']);
  });

  it('passes agents.maxParallelAgents from settings to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { agents: { maxParallelAgents: 2 } },
      argv,
    );

    expect(config.getAgentsSettings().maxParallelAgents).toBe(2);
  });

  it('passes agents.maxParallelAgentsByModel from settings to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { agents: { maxParallelAgentsByModel: { 'weak-model': 1 } } },
      argv,
    );

    expect(config.getAgentsSettings().maxParallelAgentsByModel).toEqual({
      'weak-model': 1,
    });
  });

  it('passes tools.shell.defaultTimeoutMs from settings to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { tools: { shell: { defaultTimeoutMs: 300000 } } },
      argv,
    );

    expect(config.getShellDefaultTimeoutMs()).toBe(300000);
  });

  it('passes agents.builtin.exploreModel from settings to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { agents: { builtin: { exploreModel: 'fast' } } },
      argv,
    );

    expect(config.getAgentsSettings().builtin?.exploreModel).toBe('fast');
  });

  it('passes model grade settings to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        agents: {
          modelGrades: { small: 'fast', high: 'qwen-max' },
          allowedGrades: ['small'],
        },
      },
      argv,
    );

    expect(config.getAgentsSettings().modelGrades).toEqual({
      small: 'fast',
      high: 'qwen-max',
    });
    expect(config.getAgentsSettings().allowedGrades).toEqual(['small']);
  });

  it('should ignore blank settings fallback models', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({ modelFallbacks: '   ' }, argv);

    expect(config.getModelFallbacks()).toEqual([]);
  });

  it('should enable runtime sleep prevention by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv);

    expect(config.getPreventSystemSleepEnabled()).toBe(true);
  });

  describe('--insecure flag', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      for (const key of ['QWEN_TLS_INSECURE', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      // Silence (and capture) the intentional MITM warning loadCliConfig emits.
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('sets QWEN_TLS_INSECURE=1 and NODE_TLS_REJECT_UNAUTHORIZED=0 when --insecure is passed', async () => {
      process.argv = ['node', 'script.js', '--insecure'];
      const argv = await parseArguments();
      await loadCliConfig({}, argv);
      expect(process.env['QWEN_TLS_INSECURE']).toBe('1');
      expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('leaves TLS env vars unset without --insecure', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      await loadCliConfig({}, argv);
      expect(process.env['QWEN_TLS_INSECURE']).toBeUndefined();
      expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('propagates a pre-set QWEN_TLS_INSECURE to NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
      process.env['QWEN_TLS_INSECURE'] = '1';
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      await loadCliConfig({}, argv);
      expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('skips re-assignment and warning when NODE_TLS_REJECT_UNAUTHORIZED is already 0', async () => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      process.argv = ['node', 'script.js', '--insecure'];
      const argv = await parseArguments();
      await loadCliConfig({}, argv);
      expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  it('should propagate runtime sleep prevention setting', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        general: {
          preventSystemSleep: false,
        },
      },
      argv,
    );

    expect(config.getPreventSystemSleepEnabled()).toBe(false);
  });

  it('should propagate artifact auto-open setting', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        artifact: {
          autoOpen: false,
        },
      },
      argv,
    );

    expect(config.shouldAutoOpenArtifact()).toBe(false);
  });

  it('should enable artifacts by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactEnabled: true,
      }),
    );
  });

  it('should propagate artifact disable setting', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({ experimental: { artifact: false } }, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactEnabled: false,
      }),
    );
  });

  it('should keep the session writer lease disabled by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWriterLeaseEnabled: false,
      }),
    );
  });

  it('should propagate the session writer lease opt-in', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({ experimental: { sessionWriterLease: true } }, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWriterLeaseEnabled: true,
      }),
    );
  });

  it('keeps Session Workflow disabled by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWorkflowEnabled: false,
      }),
    );
  });

  it('propagates the Session Workflow opt-in', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig({ experimental: { sessionWorkflow: true } }, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWorkflowEnabled: true,
      }),
    );
  });

  it('should not enable the session writer lease for invalid truthy values', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig(
      {
        experimental: {
          sessionWriterLease: 'true',
        },
      } as unknown as Settings,
      argv,
    );

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWriterLeaseEnabled: false,
      }),
    );
  });

  it('should propagate the image model selection', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();

    await loadCliConfig(
      {
        imageModel: 'openai:qwen-image-2.0\0https://images.example.com/api/v1',
      },
      argv,
    );

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        imageModel: 'openai:qwen-image-2.0\0https://images.example.com/api/v1',
      }),
    );
  });

  it('places session-injected (ACP/IDE) MCP servers at the top precedence tier', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      mcpServers: {
        shared: { command: 'settings-cmd' },
        'settings-only': { command: 'settings-only-cmd' },
      },
    };
    const sessionMcpServers = {
      shared: new ServerConfig.MCPServerConfig('session-cmd'),
      'ide-only': new ServerConfig.MCPServerConfig('ide-cmd'),
    };

    const config = await loadCliConfig(
      settings,
      argv,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionMcpServers,
    );

    const servers = config.getMcpServers() ?? {};
    // Session source wins a name clash with settings.
    expect(servers['shared'].command).toBe('session-cmd');
    // Both session-only and settings-only servers survive.
    expect(servers['ide-only'].command).toBe('ide-cmd');
    expect(servers['settings-only'].command).toBe('settings-only-cmd');
    // Session servers are never approval-gated.
    expect(config.isMcpServerPendingApproval('ide-only')).toBe(false);
  });

  it('preserves session/CLI-supplied MCP servers under safe mode while dropping settings-sourced ones', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      mcpServers: {
        'settings-only': { command: 'settings-only-cmd' },
      },
    };
    const sessionMcpServers = {
      'session-server': new ServerConfig.MCPServerConfig('session-cmd'),
    };

    const config = await loadCliConfig(
      settings,
      argv,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionMcpServers,
    );

    const servers = config.getMcpServers() ?? {};
    // Session-supplied server survives safe mode — it's an explicit,
    // per-invocation argument (ACP session/new), not ambient local state.
    expect(servers['session-server']?.command).toBe('session-cmd');
    // Settings-sourced server is still dropped under safe mode.
    expect(servers['settings-only']).toBeUndefined();
    // Never approval-gated, same as the non-safe-mode case above.
    expect(config.isMcpServerPendingApproval('session-server')).toBe(false);
  });

  it('preserves --mcp-config-supplied MCP servers under safe mode while dropping settings-sourced ones', async () => {
    process.argv = [
      'node',
      'script.js',
      '--safe-mode',
      '--mcp-config',
      JSON.stringify({ 'cli-server': { command: 'cli-cmd' } }),
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      mcpServers: {
        'settings-only': { command: 'settings-only-cmd' },
      },
    };

    const config = await loadCliConfig(settings, argv, process.cwd());

    const servers = config.getMcpServers() ?? {};
    expect(servers['cli-server']?.command).toBe('cli-cmd');
    expect(servers['settings-only']).toBeUndefined();
  });

  it('does NOT let a settings-sourced mcp.allowed list silently filter a session-supplied server under safe mode', async () => {
    // Found by an automated review pass on PR #7827: the allowedMcpServers
    // assembly guard was `!bareMode` only (missing `&& !safeMode`), so
    // settings.mcp.allowed/excluded — LOCAL/ambient state, same category as
    // settings.mcpServers itself — was still read under safe mode. Combined
    // with getMcpServers()'s own allowedMcpServers filter (added earlier in
    // this same PR for the --allowed-mcp-server-names case), a narrow
    // settings.json mcp.allowed list would silently drop a caller-supplied
    // top-tier server, defeating the very guarantee this PR exists to
    // provide — via an indirect vector (a filter's SOURCE), not the
    // mcpServers map directly.
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      mcp: { allowed: ['some-other-server'] },
    };
    const sessionMcpServers = {
      'session-server': new ServerConfig.MCPServerConfig('session-cmd'),
    };

    const config = await loadCliConfig(
      settings,
      argv,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      sessionMcpServers,
    );

    const servers = config.getMcpServers() ?? {};
    expect(servers['session-server']?.command).toBe('session-cmd');
  });

  it('drops ALL MCP servers under safe mode when none were supplied by the caller', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      mcpServers: {
        'settings-only': { command: 'settings-only-cmd' },
      },
    };

    const config = await loadCliConfig(settings, argv, process.cwd());

    expect(config.getMcpServers()).toEqual({});
  });

  it('gates unapproved workspace MCP servers in non-interactive runs', async () => {
    process.argv = ['node', 'script.js', '-p', 'hello'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        mcpServers: {
          'workspace-server': {
            command: 'workspace-cmd',
            scope: 'workspace',
          },
          'user-server': {
            command: 'user-cmd',
          },
        },
      },
      argv,
    );

    expect(config.isInteractive()).toBe(false);
    expect(config.isMcpServerPendingApproval('workspace-server')).toBe(true);
    expect(config.isMcpServerPendingApproval('user-server')).toBe(false);
  });

  it('keeps session-injected MCP servers ungated in non-interactive runs', async () => {
    process.argv = ['node', 'script.js', '-p', 'hello'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        mcpServers: {
          'workspace-server': {
            command: 'workspace-cmd',
            scope: 'workspace',
          },
        },
      },
      argv,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      {
        'ide-only': new ServerConfig.MCPServerConfig('ide-cmd'),
      },
    );

    expect(config.isMcpServerPendingApproval('workspace-server')).toBe(true);
    expect(config.isMcpServerPendingApproval('ide-only')).toBe(false);
  });

  it('should fork and load a new session when --resume is combined with --fork-session', async () => {
    const sourceSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const sourceData = {
      conversation: { sessionId: sourceSessionId, messages: [] },
      uiHistory: [],
    };
    const forkedData = {
      conversation: { sessionId: 'forked-session-id', messages: [] },
      uiHistory: [],
    };
    mockSessionServiceInstance.loadSession.mockImplementation(
      async (sessionId: string) => {
        if (sessionId === sourceSessionId) return sourceData;
        return forkedData;
      },
    );

    const config = await loadCliConfig({}, {
      resume: sourceSessionId,
      forkSession: true,
    } as CliArgs);

    expect(mockSessionServiceInstance.forkSession).toHaveBeenCalledWith(
      sourceSessionId,
      config.getSessionId(),
    );
    expect(config.getSessionId()).toBe(
      mockSessionServiceInstance.forkSession.mock.calls[0]?.[1],
    );
    expect(mockSessionServiceInstance.loadSession).toHaveBeenCalledWith(
      config.getSessionId(),
    );
  });

  it('rebinds a selective restore projection to the forked session', async () => {
    const sourceSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const projectionSource = vi.fn(async (sessionId: string) => ({
      sessionId,
      filePath: `/mock/${sessionId}.jsonl`,
      startTime: '2026-08-13T00:00:00.000Z',
      lastUpdated: '2026-08-13T00:00:00.000Z',
      runtime: {
        apiHistory: [],
        uiTelemetryEvents: [],
        recording: { lastCompletedUuid: 'leaf', turnParentUuids: [] },
        goalRecords: [],
        initialTurn: 0,
        backgroundNotificationTaskIds: [],
      },
    }));

    const config = await loadCliConfig(
      {},
      { resume: sourceSessionId, forkSession: true } as CliArgs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { sessionRestore: { projectionSource } },
    );

    const forkedSessionId = config.getSessionId();
    expect(mockSessionServiceInstance.forkSession).toHaveBeenCalledWith(
      sourceSessionId,
      forkedSessionId,
    );
    expect(projectionSource).toHaveBeenCalledOnce();
    expect(projectionSource).toHaveBeenCalledWith(forkedSessionId);
    expect(mockSessionServiceInstance.loadSession).not.toHaveBeenCalled();
    const configParams = mockConfigConstructorParams.mock.calls.at(-1)?.[0];
    expect(configParams).toEqual(
      expect.objectContaining({
        sessionId: forkedSessionId,
        sessionData: undefined,
        sessionRestoreProjection: expect.objectContaining({
          sessionId: forkedSessionId,
        }),
        sessionRestoreProjectionSource: expect.any(Function),
      }),
    );

    const deferredProjection =
      await configParams.sessionRestoreProjectionSource();
    expect(deferredProjection).toEqual(
      expect.objectContaining({ sessionId: forkedSessionId }),
    );
    expect(projectionSource).toHaveBeenNthCalledWith(2, forkedSessionId);
  });

  it('preloads a selective projection when a non-ACP host cannot acquire a writer lease', async () => {
    const sourceSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const projectionSource = vi.fn(async (sessionId: string) => ({
      sessionId,
      filePath: `/mock/${sessionId}.jsonl`,
      startTime: '2026-08-13T00:00:00.000Z',
      lastUpdated: '2026-08-13T00:00:00.000Z',
      runtime: {
        apiHistory: [],
        uiTelemetryEvents: [],
        recording: { lastCompletedUuid: 'leaf', turnParentUuids: [] },
        goalRecords: [],
        initialTurn: 0,
        backgroundNotificationTaskIds: [],
      },
    }));

    await loadCliConfig(
      { experimental: { sessionWriterLease: true } },
      { resume: sourceSessionId } as CliArgs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { sessionRestore: { projectionSource } },
    );

    expect(projectionSource).toHaveBeenCalledOnce();
    expect(projectionSource).toHaveBeenCalledWith(sourceSessionId);
    expect(mockConfigConstructorParams).toHaveBeenLastCalledWith(
      expect.objectContaining({
        experimentalZedIntegration: false,
        sessionWriterLeaseEnabled: true,
        sessionRestoreProjection: expect.objectContaining({
          sessionId: sourceSessionId,
        }),
      }),
    );
  });

  it('should explain when --fork-session fails to copy the source session', async () => {
    const sourceSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const sourceData = {
      conversation: { sessionId: sourceSessionId, messages: [] },
      uiHistory: [],
    };
    mockSessionServiceInstance.loadSession.mockResolvedValue(sourceData);
    mockSessionServiceInstance.forkSession.mockRejectedValue(
      new Error('source session belongs to another project'),
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(
      loadCliConfig({}, {
        resume: sourceSessionId,
        forkSession: true,
      } as CliArgs),
    ).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      `Failed to fork session ${sourceSessionId}: source session belongs to another project`,
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should explain when --continue --fork-session has no saved session to fork', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(
      loadCliConfig({}, {
        continue: true,
        forkSession: true,
      } as CliArgs),
    ).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Cannot use --fork-session with --continue: no saved session found to fork.',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit when a caller-supplied sessionId already exists (default CLI behavior)', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      sessionId,
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(loadCliConfig({}, { sessionId } as CliArgs)).rejects.toThrow(
      'process.exit called',
    );

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit when a caller-supplied sessionId matches a legacy case-variant transcript', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    // The id is free in its exact spelling, but a legacy uppercase twin
    // occupies it — creating would mint a permanently unrestorable pair.
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      sessionId.toUpperCase(),
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(loadCliConfig({}, { sessionId } as CliArgs)).rejects.toThrow(
      'process.exit called',
    );

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit when the case-insensitive occupancy check reports a conflict', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockRejectedValue(
      new SessionIdCaseConflictError(sessionId),
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(loadCliConfig({}, { sessionId } as CliArgs)).rejects.toThrow(
      'process.exit called',
    );

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should throw SessionIdConflictError instead of exiting when throwOnSessionIdConflict is set', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      sessionId,
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const promise = loadCliConfig(
      {},
      { sessionId } as CliArgs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await expect(promise).rejects.toBeInstanceOf(SessionIdConflictError);
    await expect(promise).rejects.toMatchObject({ sessionId });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should not throw for a fresh caller-supplied sessionId when throwOnSessionIdConflict is set', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      undefined,
    );

    const config = await loadCliConfig(
      {},
      { sessionId } as CliArgs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(config.getSessionId()).toBe(sessionId);
  });

  it('canonicalizes a mixed-case caller-supplied sessionId before storing it', async () => {
    const sessionId = '123E4567-E89B-12D3-A456-426614174000';
    mockSessionServiceInstance.findSessionIdIgnoringCase.mockResolvedValue(
      undefined,
    );

    const config = await loadCliConfig(
      {},
      { sessionId } as CliArgs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(config.getSessionId()).toBe(sessionId.toLowerCase());
  });

  it('should use internal sandbox session ID without treating it as a new session', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubEnv('SANDBOX', 'sandbox-exec');
    process.argv = ['node', 'script.js', '--sandbox-session-id', sessionId];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv);

    expect(config.getSessionId()).toBe(sessionId);
    expect(mockSessionServiceInstance.sessionExists).not.toHaveBeenCalled();
  });

  it('should reject direct use of the internal sandbox session ID flag', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    process.argv = ['node', 'script.js', '--sandbox-session-id', sessionId];
    const argv = await parseArguments();

    await expect(loadCliConfig({}, argv)).rejects.toThrow(
      'process.exit called',
    );

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '--sandbox-session-id is for internal sandbox use only.',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockSessionServiceInstance.sessionExists).not.toHaveBeenCalled();
  });

  it('should reset context filenames to defaults when context.fileName is not configured', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const defaultContextFiles = ['QWEN.md', 'AGENTS.md'];
    const getAllSpy = vi
      .spyOn(ServerConfig, 'getAllGeminiMdFilenames')
      .mockReturnValue(defaultContextFiles);
    const setFilenameSpy = vi.spyOn(ServerConfig, 'setGeminiMdFilename');

    await loadCliConfig(settings, argv);

    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(setFilenameSpy).toHaveBeenCalledWith(defaultContextFiles);
  });

  it('should use context.fileName from settings when provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { context: { fileName: 'CUSTOM_CONTEXT.md' } };
    const getAllSpy = vi.spyOn(ServerConfig, 'getAllGeminiMdFilenames');
    const setFilenameSpy = vi.spyOn(ServerConfig, 'setGeminiMdFilename');

    await loadCliConfig(settings, argv);

    expect(setFilenameSpy).toHaveBeenCalledWith('CUSTOM_CONTEXT.md');
    expect(getAllSpy).not.toHaveBeenCalled();
  });

  it('should initialize native LSP service when enabled', async () => {
    process.argv = ['node', 'script.js', '--experimental-lsp'];
    const argv = await parseArguments();
    const settings: Settings = {};

    const config = await loadCliConfig(settings, argv);

    // LSP is enabled via --experimental-lsp flag
    expect(config.isLspEnabled()).toBe(true);
    expect(nativeLspServiceMock).toHaveBeenCalledTimes(1);
    const lspInstance = getLastLspInstance();
    expect(lspInstance).toBeDefined();
    expect(lspInstance?.discoverAndPrepare).toHaveBeenCalledTimes(1);
    expect(lspInstance?.start).toHaveBeenCalledTimes(1);
  });

  it('should collect LSP status snapshots during debug-mode startup', async () => {
    process.argv = ['node', 'script.js', '--experimental-lsp', '--debug'];
    const argv = await parseArguments();
    const settings: Settings = {};

    await loadCliConfig(settings, argv);

    const lspInstance = getLastLspInstance();
    expect(lspInstance?.getStatusSnapshot).toHaveBeenCalledTimes(2);
  });

  it('should not collect LSP status snapshots during normal startup', async () => {
    process.argv = ['node', 'script.js', '--experimental-lsp'];
    const argv = await parseArguments();
    const settings: Settings = {};

    await loadCliConfig(settings, argv);

    const lspInstance = getLastLspInstance();
    expect(lspInstance?.getStatusSnapshot).not.toHaveBeenCalled();
  });

  describe('Proxy configuration', () => {
    const originalProxyEnv: { [key: string]: string | undefined } = {};
    const proxyEnvVars = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
    ];

    beforeEach(() => {
      for (const key of proxyEnvVars) {
        originalProxyEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of proxyEnvVars) {
        if (originalProxyEnv[key]) {
          process.env[key] = originalProxyEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it(`should leave proxy to empty by default`, async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const settings: Settings = {};
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBeFalsy();
    });

    const proxy_url = 'http://localhost:7890';
    const testCases = [
      {
        input: {
          env_name: 'https_proxy',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'http_proxy',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'HTTPS_PROXY',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'HTTP_PROXY',
          proxy_url,
        },
        expected: proxy_url,
      },
    ];
    testCases.forEach(({ input, expected }) => {
      it(`should set proxy to ${expected} according to environment variable [${input.env_name}]`, async () => {
        vi.stubEnv(input.env_name, input.proxy_url);
        process.argv = ['node', 'script.js'];
        const argv = await parseArguments();
        const settings: Settings = {};
        const config = await loadCliConfig(settings, argv);
        expect(config.getProxy()).toBe(expected);
      });
    });

    it('should set proxy when --proxy flag is present', async () => {
      process.argv = ['node', 'script.js', '--proxy', 'http://localhost:7890'];
      const argv = await parseArguments();
      const settings: Settings = {};
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });

    it('should set proxy from settings when present', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const settings: Settings = { proxy: 'http://localhost:7890' };
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });

    it('should normalize proxy from settings when scheme is omitted', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const settings: Settings = { proxy: 'localhost:7890' };
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });

    it('should prioritize settings proxy over environment variable', async () => {
      vi.stubEnv('HTTPS_PROXY', 'http://localhost:7891');
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const settings: Settings = { proxy: 'http://localhost:7890' };
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });

    it('should prioritize CLI flag over environment variable for proxy (CLI http://localhost:7890, environment variable http://localhost:7891)', async () => {
      vi.stubEnv('http_proxy', 'http://localhost:7891');
      process.argv = ['node', 'script.js', '--proxy', 'http://localhost:7890'];
      const argv = await parseArguments();
      const settings: Settings = {};
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });

    it('should prioritize CLI flag over settings proxy', async () => {
      process.argv = ['node', 'script.js', '--proxy', 'http://localhost:7890'];
      const argv = await parseArguments();
      const settings: Settings = { proxy: 'http://localhost:7891' };
      const config = await loadCliConfig(settings, argv);
      expect(config.getProxy()).toBe('http://localhost:7890');
    });
  });

  describe('web search settings resolution', () => {
    const loadWithSettings = async (settings: Settings) => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      return loadCliConfig(settings, argv);
    };

    it('returns undefined when neither settings nor env configure web search', async () => {
      const config = await loadWithSettings({});
      expect(config.getWebSearchSettings()).toBeUndefined();
    });

    it('passes tools.webSearch through from settings', async () => {
      const config = await loadWithSettings({
        tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } },
      });
      expect(config.getWebSearchSettings()).toEqual({
        enabled: true,
        model: 'qwen3.6-plus',
      });
    });

    it('lets ENABLE_WEB_SEARCH override the settings flag', async () => {
      vi.stubEnv('ENABLE_WEB_SEARCH', 'false');
      const config = await loadWithSettings({
        tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } },
      });
      expect(config.getWebSearchSettings()?.enabled).toBe(false);
    });

    it('treats a set-but-empty ENABLE_WEB_SEARCH as unset', async () => {
      vi.stubEnv('ENABLE_WEB_SEARCH', '');
      const config = await loadWithSettings({
        tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } },
      });
      expect(config.getWebSearchSettings()?.enabled).toBe(true);
    });

    it('lets WEB_SEARCH_MODEL and WEB_SEARCH_EXTRACTOR override settings', async () => {
      vi.stubEnv('WEB_SEARCH_MODEL', 'env-model');
      vi.stubEnv('WEB_SEARCH_EXTRACTOR', 'false');
      const config = await loadWithSettings({
        tools: {
          webSearch: { enabled: true, model: 'settings-model' },
        },
      });
      expect(config.getWebSearchSettings()).toEqual({
        enabled: true,
        model: 'env-model',
        webExtractor: false,
      });
    });

    it('resolves WEB_SEARCH_BASE_URL with the DASHSCOPE_API_KEY fallback', async () => {
      vi.stubEnv(
        'WEB_SEARCH_BASE_URL',
        'https://dashscope.aliyuncs.com/api/v2',
      );
      const config = await loadWithSettings({});
      expect(config.getWebSearchSettings()).toEqual({
        baseUrl: 'https://dashscope.aliyuncs.com/api/v2',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
      });
    });

    it('selects WEB_SEARCH_API_KEY when it is non-empty', async () => {
      vi.stubEnv(
        'WEB_SEARCH_BASE_URL',
        'https://dashscope.aliyuncs.com/api/v2',
      );
      vi.stubEnv('WEB_SEARCH_API_KEY', 'sk-live');
      const config = await loadWithSettings({});
      expect(config.getWebSearchSettings()?.apiKeyEnv).toBe(
        'WEB_SEARCH_API_KEY',
      );
    });

    it('treats a whitespace-only WEB_SEARCH_API_KEY as unset', async () => {
      vi.stubEnv(
        'WEB_SEARCH_BASE_URL',
        'https://dashscope.aliyuncs.com/api/v2',
      );
      vi.stubEnv('WEB_SEARCH_API_KEY', '   ');
      const config = await loadWithSettings({});
      expect(config.getWebSearchSettings()?.apiKeyEnv).toBe(
        'DASHSCOPE_API_KEY',
      );
    });

    it('disables web search in safe mode', async () => {
      process.argv = ['node', 'script.js', '--safe-mode'];
      const argv = await parseArguments();
      const config = await loadCliConfig(
        { tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } } },
        argv,
      );
      expect(config.getWebSearchSettings()).toBeUndefined();
    });

    it('disables web search in bare mode', async () => {
      process.argv = ['node', 'script.js', '--bare'];
      const argv = await parseArguments();
      const config = await loadCliConfig(
        { tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } } },
        argv,
      );
      expect(config.getWebSearchSettings()).toBeUndefined();
    });
  });
});

describe('loadCliConfig telemetry', () => {
  const originalArgv = process.argv;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should set telemetry to false by default when no flag or setting is present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('should set telemetry to true when --telemetry flag is present', async () => {
    process.argv = ['node', 'script.js', '--telemetry'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('should initialize telemetry before prompt-interactive startup', async () => {
    process.argv = [
      'node',
      'script.js',
      '-i',
      'hello from prompt-interactive',
      '--telemetry',
    ];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'hello from prompt-interactive',
        deferTelemetryInitialization: false,
      }),
    );
  });

  it('should defer telemetry for ordinary interactive startup', async () => {
    process.argv = ['node', 'script.js', '--telemetry'];
    process.stdin.isTTY = true;
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        question: '',
        deferTelemetryInitialization: true,
      }),
    );
  });

  it('should defer telemetry for ACP startup', async () => {
    process.argv = ['node', 'script.js', '--acp', '--telemetry'];
    const argv = await parseArguments();

    await loadCliConfig({}, argv);

    expect(mockConfigConstructorParams).toHaveBeenCalledWith(
      expect.objectContaining({
        deferTelemetryInitialization: true,
      }),
    );
  });

  it('should set telemetry to false when --no-telemetry flag is present', async () => {
    process.argv = ['node', 'script.js', '--no-telemetry'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('should use telemetry value from settings if CLI flag is not present (settings true)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('should use telemetry value from settings if CLI flag is not present (settings false)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: false } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('should prioritize --telemetry CLI flag (true) over settings (false)', async () => {
    process.argv = ['node', 'script.js', '--telemetry'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: false } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('should prioritize --no-telemetry CLI flag (false) over settings (true)', async () => {
    process.argv = ['node', 'script.js', '--no-telemetry'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('should use telemetry OTLP endpoint from settings if CLI flag is not present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { otlpEndpoint: 'http://settings.example.com' },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpEndpoint()).toBe(
      'http://settings.example.com',
    );
  });

  it('should prioritize --telemetry-otlp-endpoint CLI flag over settings', async () => {
    process.argv = [
      'node',
      'script.js',
      '--telemetry-otlp-endpoint',
      'http://cli.example.com',
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { otlpEndpoint: 'http://settings.example.com' },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpEndpoint()).toBe('http://cli.example.com');
  });

  it('should use default endpoint if no OTLP endpoint is provided via CLI or settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpEndpoint()).toBe('http://localhost:4317');
  });

  it('should use telemetry target from settings if CLI flag is not present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { target: ServerConfig.DEFAULT_TELEMETRY_TARGET },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryTarget()).toBe(
      ServerConfig.DEFAULT_TELEMETRY_TARGET,
    );
  });

  it('should prioritize --telemetry-target CLI flag over settings', async () => {
    process.argv = ['node', 'script.js', '--telemetry-target', 'gcp'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { target: ServerConfig.DEFAULT_TELEMETRY_TARGET },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryTarget()).toBe('gcp');
  });

  it('should use default target if no target is provided via CLI or settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryTarget()).toBe(
      ServerConfig.DEFAULT_TELEMETRY_TARGET,
    );
  });

  it('should use telemetry log prompts from settings if CLI flag is not present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { logPrompts: false } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
  });

  it('should prioritize --telemetry-log-prompts CLI flag (true) over settings (false)', async () => {
    process.argv = ['node', 'script.js', '--telemetry-log-prompts'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { logPrompts: false } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
  });

  it('should prioritize --no-telemetry-log-prompts CLI flag (false) over settings (true)', async () => {
    process.argv = ['node', 'script.js', '--no-telemetry-log-prompts'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { logPrompts: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
  });

  it('should use default log prompts (true) if no value is provided via CLI or settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
  });

  it('should use includeSensitiveSpanAttributes from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { includeSensitiveSpanAttributes: true },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(true);
  });

  it('should default includeSensitiveSpanAttributes to false', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(false);
  });

  it('should use sensitiveSpanAttributeMaxLength from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { sensitiveSpanAttributeMaxLength: 65_536 },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetrySensitiveSpanAttributeMaxLength()).toBe(65_536);
  });

  it('should default sensitiveSpanAttributeMaxLength to 1MiB', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetrySensitiveSpanAttributeMaxLength()).toBe(
      1024 * 1024,
    );
  });

  it('should use telemetry OTLP protocol from settings if CLI flag is not present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { otlpProtocol: 'http' },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpProtocol()).toBe('http');
  });

  it('should prioritize --telemetry-otlp-protocol CLI flag over settings', async () => {
    process.argv = ['node', 'script.js', '--telemetry-otlp-protocol', 'http'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { otlpProtocol: 'grpc' },
    };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpProtocol()).toBe('http');
  });

  it('should use default protocol if no OTLP protocol is provided via CLI or settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv);
    expect(config.getTelemetryOtlpProtocol()).toBe('grpc');
  });

  it('should reject invalid --telemetry-otlp-protocol values', async () => {
    process.argv = [
      'node',
      'script.js',
      '--telemetry-otlp-protocol',
      'invalid',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Invalid values:'),
    );

    mockExit.mockRestore();
  });
});

describe('mergeExcludeTools', () => {
  const defaultExcludes = [
    ToolNames.SHELL,
    ToolNames.MONITOR,
    ToolNames.EDIT,
    ToolNames.WRITE_FILE,
  ];
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should return an empty array when no excludeTools are specified and it is interactive', async () => {
    process.stdin.isTTY = true;
    const settings: Settings = {};
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toEqual([]);
  });

  it('should return default excludes when no excludeTools are specified and it is not interactive', async () => {
    process.stdin.isTTY = false;
    const settings: Settings = {};
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toEqual(defaultExcludes);
  });

  it('should handle settings with excludeTools but no extensions', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { exclude: ['tool1', 'tool2'] } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toEqual(
      expect.arrayContaining(['tool1', 'tool2']),
    );
    expect(config.getPermissionsDeny()).toHaveLength(2);
  });

  it('should add tool_search to deny list when tools.toolSearch.enabled is false', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { toolSearch: { enabled: false } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toContain('tool_search');
  });

  it('should auto-disable tool_search for deepseek-v4 models', async () => {
    process.argv = ['node', 'script.js', '--model', 'deepseek-v4-flash'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toContain('tool_search');
  });

  it('should auto-disable tool_search for deepseek-v3 models', async () => {
    process.argv = ['node', 'script.js', '--model', 'deepseek-v3'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toContain('tool_search');
  });

  it('should auto-disable tool_search for deepseek-chat models with provider prefix', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'openrouter/deepseek/deepseek-chat',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).toContain('tool_search');
  });

  it('should not auto-disable tool_search for non-deepseek models', async () => {
    process.argv = ['node', 'script.js', '--model', 'qwen-max'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).not.toContain('tool_search');
  });

  it('should respect explicit enabled:true override for deepseek models', async () => {
    process.argv = ['node', 'script.js', '--model', 'deepseek-v4-flash'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { toolSearch: { enabled: true } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getPermissionsDeny()).not.toContain('tool_search');
  });

  it('should pass tools.toolSearch.threshold through to the config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { toolSearch: { threshold: 25 } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getToolSearchThreshold()).toBe(25);
  });

  it('should default tools.toolSearch.threshold to 10', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getToolSearchThreshold()).toBe(10);
  });

  it('should default tools.listDirectory.enabled to false', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isLsToolEnabled()).toBe(false);
  });

  it('should enable list_directory when tools.listDirectory.enabled is true', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { listDirectory: { enabled: true } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.isLsToolEnabled()).toBe(true);
  });

  it('should force tools.toolSearch.threshold to 0 in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { toolSearch: { threshold: 25 } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getToolSearchThreshold()).toBe(0);
  });

  it('should force tools.toolSearch.threshold to 0 in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: { toolSearch: { threshold: 25 } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getToolSearchThreshold()).toBe(0);
  });
});

describe('Approval mode tool exclusion logic', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = false; // Ensure non-interactive mode
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should exclude all interactive tools in non-interactive mode with default approval mode', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should exclude all interactive tools in non-interactive mode with plan approval mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--approval-mode',
      'plan',
      '-p',
      'test',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should exclude all interactive tools in non-interactive mode with explicit default approval mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--approval-mode',
      'default',
      '-p',
      'test',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should not exclude a tool explicitly allowed in tools.allowed', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        allowed: [ToolNames.SHELL],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should not exclude monitor when explicitly allowed in tools.allowed', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        allowed: [ToolNames.MONITOR],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should honor monitor aliases in tools.allowed for non-interactive exclusions', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        allowed: ['Monitor', 'Shell(git status)'],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should not exclude a tool explicitly allowed in tools.core', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        core: [ToolNames.SHELL],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should not exclude monitor when explicitly allowed in tools.core', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        core: [ToolNames.MONITOR],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).toContain(ToolNames.EDIT);
    expect(excludedTools).toContain(ToolNames.WRITE_FILE);
  });

  it('should exclude only shell tools in non-interactive mode with auto-edit approval mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--approval-mode',
      'auto-edit',
      '-p',
      'test',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain(ToolNames.SHELL);
    expect(excludedTools).toContain(ToolNames.MONITOR);
    expect(excludedTools).not.toContain(ToolNames.EDIT);
    expect(excludedTools).not.toContain(ToolNames.WRITE_FILE);
  });

  it('should exclude no interactive tools in non-interactive mode with yolo approval mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--approval-mode',
      'yolo',
      '-p',
      'test',
    ];
    const argv = await parseArguments();
    const settings: Settings = {};

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).not.toContain(ToolNames.EDIT);
    expect(excludedTools).not.toContain(ToolNames.WRITE_FILE);
  });

  it('should exclude no interactive tools in non-interactive mode with legacy yolo flag', async () => {
    process.argv = ['node', 'script.js', '--yolo', '-p', 'test'];
    const argv = await parseArguments();
    const settings: Settings = {};

    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).not.toContain(ToolNames.EDIT);
    expect(excludedTools).not.toContain(ToolNames.WRITE_FILE);
  });

  it('should not exclude interactive tools in interactive mode regardless of approval mode', async () => {
    process.stdin.isTTY = true; // Interactive mode

    const testCases = [
      { args: ['node', 'script.js'] }, // default
      { args: ['node', 'script.js', '--approval-mode', 'plan'] },
      { args: ['node', 'script.js', '--approval-mode', 'default'] },
      { args: ['node', 'script.js', '--approval-mode', 'auto-edit'] },
      { args: ['node', 'script.js', '--approval-mode', 'yolo'] },
      { args: ['node', 'script.js', '--yolo'] },
    ];

    for (const testCase of testCases) {
      process.argv = testCase.args;
      const argv = await parseArguments();
      const settings: Settings = {};

      const config = await loadCliConfig(settings, argv, undefined, []);

      const excludedTools = config.getPermissionsDeny();
      expect(excludedTools).not.toContain(ToolNames.SHELL);
      expect(excludedTools).not.toContain(ToolNames.MONITOR);
      expect(excludedTools).not.toContain(ToolNames.EDIT);
      expect(excludedTools).not.toContain(ToolNames.WRITE_FILE);
    }
  });

  it('should keep the bare toolset available in non-interactive bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare', '-p', 'test'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).not.toContain(ToolNames.SHELL);
    expect(excludedTools).not.toContain(ToolNames.MONITOR);
    expect(excludedTools).not.toContain(ToolNames.EDIT);
    expect(excludedTools).not.toContain(ToolNames.WRITE_FILE);
  });

  it('should merge approval mode exclusions with settings exclusions in auto-edit mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--approval-mode',
      'auto-edit',
      '-p',
      'test',
    ];
    const argv = await parseArguments();
    const settings: Settings = { tools: { exclude: ['custom_tool'] } };
    const config = await loadCliConfig(settings, argv, undefined, []);

    const excludedTools = config.getPermissionsDeny();
    expect(excludedTools).toContain('custom_tool'); // From settings
    expect(excludedTools).toContain(ToolNames.SHELL); // From approval mode
    expect(excludedTools).toContain(ToolNames.MONITOR); // From approval mode
    expect(excludedTools).not.toContain(ToolNames.EDIT); // Should be allowed in auto-edit
    expect(excludedTools).not.toContain(ToolNames.WRITE_FILE); // Should be allowed in auto-edit
  });

  it('should throw an error for invalid approval mode values in loadCliConfig', async () => {
    // Create a mock argv with an invalid approval mode that bypasses argument parsing validation
    const invalidArgv: Partial<CliArgs> & { approvalMode: string } = {
      approvalMode: 'invalid_mode',
      promptInteractive: '',
      prompt: '',
      yolo: false,
    };

    const settings: Settings = {};
    await expect(
      loadCliConfig(settings, invalidArgv as CliArgs, undefined, []),
    ).rejects.toThrow(
      'Invalid approval mode: invalid_mode. Valid values are: plan, default, auto-edit, auto, yolo',
    );
  });
});

describe('loadCliConfig with allowed-mcp-server-names', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const baseSettings: Settings = {
    mcpServers: {
      server1: { url: 'http://localhost:8080' },
      server2: { url: 'http://localhost:8081' },
      server3: { url: 'http://localhost:8082' },
    },
  };

  it('should allow all MCP servers if the flag is not provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual(baseSettings.mcpServers);
  });

  it('should allow only the specified MCP server', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
    });
  });

  it('should allow multiple specified MCP servers', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
      '--allowed-mcp-server-names',
      'server3',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
      server3: { url: 'http://localhost:8082' },
    });
  });

  it('should handle server names that do not exist', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
      '--allowed-mcp-server-names',
      'server4',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
    });
  });

  it('should allow no MCP servers if the flag is provided but empty', async () => {
    process.argv = ['node', 'script.js', '--allowed-mcp-server-names', ''];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({});
  });

  it('should read allowMCPServers from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      ...baseSettings,
      mcp: { allowed: ['server1', 'server2'] },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
      server2: { url: 'http://localhost:8081' },
    });
  });

  it('should read excludeMCPServers from settings but still return all servers', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      ...baseSettings,
      mcp: { excluded: ['server1', 'server2'] },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    // getMcpServers() now returns all servers, use isMcpServerDisabled() to check status
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
      server2: { url: 'http://localhost:8081' },
      server3: { url: 'http://localhost:8082' },
    });
    expect(config.isMcpServerDisabled('server1')).toBe(true);
    expect(config.isMcpServerDisabled('server2')).toBe(true);
    expect(config.isMcpServerDisabled('server3')).toBe(false);
  });

  it('should apply allowedMcpServers filter but excluded servers are still returned', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      ...baseSettings,
      mcp: {
        excluded: ['server1'],
        allowed: ['server1', 'server2'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    // allowedMcpServers filters which servers are available
    // but excluded servers are still returned by getMcpServers()
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
      server2: { url: 'http://localhost:8081' },
    });
    expect(config.isMcpServerDisabled('server1')).toBe(true);
    expect(config.isMcpServerDisabled('server2')).toBe(false);
  });

  it('should prioritize mcp server flag if set', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      ...baseSettings,
      mcp: {
        excluded: ['server1'],
        allowed: ['server2'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080' },
    });
  });

  it('should prioritize CLI flag over both allowed and excluded settings', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server2',
      '--allowed-mcp-server-names',
      'server3',
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      ...baseSettings,
      mcp: {
        allowed: ['server1', 'server2'], // Should be ignored
        excluded: ['server3'], // Should be ignored
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getMcpServers()).toEqual({
      server2: { url: 'http://localhost:8081' },
      server3: { url: 'http://localhost:8082' },
    });
  });
});

describe('loadCliConfig with --mcp-config', () => {
  const baseSettings: Settings = {
    mcpServers: {
      'settings-server': { url: 'http://localhost:9000' },
    },
  };

  it('should parse inline JSON with mcpServers wrapper', async () => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'cli-server': { command: 'node', args: ['server.js'] },
      },
    });
    process.argv = ['node', 'script.js', '--mcp-config', mcpConfig];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv);

    const mcpServers = config.getMcpServers() ?? {};
    expect(mcpServers['cli-server']).toEqual({
      command: 'node',
      args: ['server.js'],
    });
    // Settings server should still be present
    expect(mcpServers['settings-server']).toEqual({
      url: 'http://localhost:9000',
    });
  });

  it('should parse inline JSON without wrapper', async () => {
    const mcpConfig = JSON.stringify({
      'direct-server': { url: 'http://localhost:8080' },
    });
    process.argv = ['node', 'script.js', '--mcp-config', mcpConfig];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv);

    const mcpServers = config.getMcpServers() ?? {};
    expect(mcpServers['direct-server']).toEqual({
      url: 'http://localhost:8080',
    });
  });

  it('should override settings file servers with same name', async () => {
    const mcpConfig = JSON.stringify({
      'settings-server': { url: 'http://localhost:8888' }, // Override
    });
    process.argv = ['node', 'script.js', '--mcp-config', mcpConfig];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv);

    // CLI config should override settings
    const mcpServers = config.getMcpServers() ?? {};
    expect(mcpServers['settings-server']).toEqual({
      url: 'http://localhost:8888',
    });
  });

  it('should work with --allowed-mcp-server-names filter', async () => {
    const mcpConfig = JSON.stringify({
      server1: { url: 'http://localhost:8081' },
      server2: { url: 'http://localhost:8082' },
    });
    process.argv = [
      'node',
      'script.js',
      '--mcp-config',
      mcpConfig,
      '--allowed-mcp-server-names',
      'server1',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv);

    // Only server1 should be allowed
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8081' },
    });
  });

  it('should handle empty mcp-config gracefully', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(baseSettings, argv);

    // Should only have settings server
    expect(config.getMcpServers()).toEqual({
      'settings-server': { url: 'http://localhost:9000' },
    });
  });
});

describe('loadCliConfig model selection', () => {
  const originalArgv = process.argv;
  const authEnvKeys = [
    'QWEN_OAUTH',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'QWEN_MODEL',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_API_KEY',
    'GOOGLE_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
  ] as const;

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    for (const key of authEnvKeys) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('selects a model from settings.json if provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        model: {
          name: 'qwen3-coder-plus',
        },
      },
      argv,
      undefined,
      [],
    );

    expect(config.getModel()).toBe('qwen3-coder-plus');
  });

  it('uses the default Qwen model if nothing is set', async () => {
    process.argv = ['node', 'script.js']; // No model set.
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        // No model set.
      },
      argv,
      undefined,
      [],
    );

    expect(config.getModel()).toBe(DEFAULT_QWEN_MODEL);
  });

  it('always prefers model from argvs', async () => {
    process.argv = [
      'node',
      'script.js',
      '--auth-type',
      'openai',
      '--model',
      'qwen3-coder-plus',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        model: {
          name: 'qwen3-coder-flash',
        },
      },
      argv,
      undefined,
      [],
    );

    expect(config.getModel()).toBe('qwen3-coder-plus');
  });

  it('selects the model from argvs if provided', async () => {
    process.argv = [
      'node',
      'script.js',
      '--auth-type',
      'openai',
      '--model',
      'qwen3-coder-plus',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      {
        // No model provided via settings.
      },
      argv,
      undefined,
      [],
    );

    expect(config.getModel()).toBe('qwen3-coder-plus');
  });
});

describe('loadCliConfig folderTrust', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be false when folderTrust is false', async () => {
    process.argv = ['node', 'script.js'];
    const settings: Settings = {
      security: {
        folderTrust: {
          enabled: false,
        },
      },
    };
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getFolderTrust()).toBe(false);
  });

  it('should be true when folderTrust is true', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      security: {
        folderTrust: {
          enabled: true,
        },
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getFolderTrust()).toBe(true);
  });

  it('should be false by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getFolderTrust()).toBe(false);
  });
});

describe('loadCliConfig allowPrivateNetworkHooks', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be false by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getAllowPrivateNetworkHooks()).toBe(false);
  });

  it('should pass through security.allowPrivateNetworkHooks from settings', async () => {
    process.argv = ['node', 'script.js'];
    const settings: Settings = {
      security: {
        allowPrivateNetworkHooks: true,
      },
    };
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getAllowPrivateNetworkHooks()).toBe(true);
  });

  it('should be false in bare mode even when enabled in settings', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const settings: Settings = {
      security: {
        allowPrivateNetworkHooks: true,
      },
    };
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getAllowPrivateNetworkHooks()).toBe(false);
  });
});

describe('loadCliConfig with includeDirectories', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    vi.spyOn(process, 'cwd').mockReturnValue(
      path.resolve(path.sep, 'home', 'user', 'project'),
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should combine and resolve paths from settings and CLI arguments', async () => {
    const mockCwd = path.resolve(path.sep, 'home', 'user', 'project');
    process.argv = [
      'node',
      'script.js',
      '--include-directories',
      `${path.resolve(path.sep, 'cli', 'path1')},${path.join(mockCwd, 'cli', 'path2')}`,
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      context: {
        includeDirectories: [
          path.resolve(path.sep, 'settings', 'path1'),
          path.join(os.homedir(), 'settings', 'path2'),
          path.join(mockCwd, 'settings', 'path3'),
        ],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    const expected = [
      mockCwd,
      path.resolve(path.sep, 'cli', 'path1'),
      path.join(mockCwd, 'cli', 'path2'),
      path.resolve(path.sep, 'settings', 'path1'),
      path.join(os.homedir(), 'settings', 'path2'),
      path.join(mockCwd, 'settings', 'path3'),
    ];
    expect(config.getWorkspaceContext().getDirectories()).toEqual(
      expect.arrayContaining(expected),
    );
    expect(config.getWorkspaceContext().getDirectories()).toHaveLength(
      expected.length,
    );
  });

  it('ignores ambient roots and LSP for a host-managed provisional workspace', async () => {
    const mockCwd = path.resolve(path.sep, 'home', 'user', 'project');
    process.argv = [
      'node',
      'script.js',
      '--experimental-lsp',
      '--include-directories',
      path.resolve(path.sep, 'cli', 'path1'),
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      context: {
        includeDirectories: [path.resolve(path.sep, 'settings', 'path1')],
        loadFromIncludeDirectories: true,
      },
    };

    await loadCliConfig(
      settings,
      argv,
      mockCwd,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { provisionalWorkspace: true },
    );

    expect(mockConfigConstructorParams).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetDir: mockCwd,
        provisionalWorkspace: true,
        includeDirectories: [],
        loadMemoryFromIncludeDirectories: false,
        lsp: { enabled: false },
      }),
    );
    expect(NativeLspService).not.toHaveBeenCalled();
  });

  it('should ignore implicit startup context inputs in bare mode', async () => {
    const mockCwd = path.resolve(path.sep, 'home', 'user', 'project');
    const cliPath = path.resolve(path.sep, 'cli', 'path1');
    const settingsPath = path.resolve(path.sep, 'settings', 'path1');

    process.argv = [
      'node',
      'script.js',
      '--bare',
      '--include-directories',
      cliPath,
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      context: {
        includeDirectories: [settingsPath],
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getWorkspaceContext().getDirectories()).toEqual([
      mockCwd,
      cliPath,
    ]);
  });

  it('should default managed-memory toggles to enabled when not in bare mode', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);

    expect(config.getManagedAutoMemoryEnabled()).toBe(true);
    expect(config.getManagedAutoDreamEnabled()).toBe(true);
    expect(config.getAutoSkillEnabled()).toBe(false);
  });

  it('autoSkillConfirm: defaults to true when unset', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);

    expect(config.getAutoSkillConfirmEnabled()).toBe(true);
  });

  it('autoSkillConfirm: passes memory.autoSkillConfirm: false through to config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      memory: {
        autoSkillConfirm: false,
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getAutoSkillConfirmEnabled()).toBe(false);
  });

  it('should force minimal startup behavior in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        core: [ToolNames.WEB_FETCH],
        allowed: [ToolNames.WEB_FETCH],
        exclude: [ToolNames.ASK_USER_QUESTION],
      },
      hooks: {
        PreToolUse: [],
      } as Record<string, unknown>,
      memory: {
        enableManagedAutoMemory: true,
      },
      security: {
        allowedHttpHookUrls: ['https://hooks.example.com/*'],
      },
      mcp: {
        allowed: ['test-server'],
      },
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        },
      },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getCoreTools()).toEqual([
      ToolNames.READ_FILE,
      ToolNames.EDIT,
      ToolNames.NOTEBOOK_EDIT,
      ToolNames.SHELL,
    ]);
    expect(config.getDisableAllHooks()).toBe(true);
    expect(config.getManagedAutoMemoryEnabled()).toBe(false);
    expect(config.getManagedAutoDreamEnabled()).toBe(false);
    expect(config.getAutoSkillEnabled()).toBe(false);
    expect(config.getToolDiscoveryCommand()).toBeUndefined();
    expect(config.getToolCallCommand()).toBeUndefined();
    expect(config.getMcpServers()).toEqual({});
    expect(config.isLspEnabled()).toBe(false);
  });

  it('should ignore coreTools overrides in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare', '--core-tools', 'web_fetch'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);

    expect(config.getCoreTools()).toEqual([
      ToolNames.READ_FILE,
      ToolNames.EDIT,
      ToolNames.NOTEBOOK_EDIT,
      ToolNames.SHELL,
    ]);
  });

  it('should preserve plansDirectory in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      plansDirectory: './project-plans',
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getPlansDir()).toContain('project-plans');
  });
});

describe('loadCliConfig safe mode', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    vi.spyOn(process, 'cwd').mockReturnValue(
      path.resolve(path.sep, 'home', 'user', 'project'),
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should strip settings-sourced permissions in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      permissions: {
        allow: ['Bash(*)'],
        ask: ['Edit'],
        deny: ['ReadFile'],
        autoMode: { hints: { allow: ['everything'] } },
      },
      tools: {
        allowed: ['ShellTool'],
        exclude: ['WriteFile'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getPermissionsAllow()).toEqual([]);
    expect(config.getPermissionsAsk()).toEqual([]);
    // mergedDeny should not contain settings-sourced rules.
    // Non-interactive mode exclusions (run_shell_command, monitor, edit,
    // write_file) are expected since no prompt/interactive flag was passed.
    expect(config.getPermissionsDeny()).not.toContain('WriteFile');
    expect(config.getAutoModeSettings()).toEqual({});
  });

  it('should ignore settings-sourced coreTools in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        core: [ToolNames.WEB_FETCH],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getCoreTools()).toBeUndefined();
  });

  it('should ignore settings-sourced allowedTools in safe mode but keep argv ones', async () => {
    process.argv = [
      'node',
      'script.js',
      '--safe-mode',
      '--allowed-tools',
      'ReadFile',
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        allowed: ['ShellTool'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getPermissionsAllow()).toContain('ReadFile');
    expect(config.getPermissionsAllow()).not.toContain('ShellTool');
  });

  it('should ignore settings-sourced approvalMode in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings = {
      tools: {
        approvalMode: 'yolo',
      },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
  });

  it('should force DEFAULT approval mode in bare mode regardless of settings', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings = {
      tools: {
        approvalMode: 'yolo',
      },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
  });

  it('should ignore settings-sourced disabled slash commands in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      slashCommands: {
        disabled: ['/review', '/bug'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getDisabledSlashCommands()).toEqual([]);
  });

  it('should ignore settings-sourced disabledTools in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        disabled: ['WebFetch', 'ReadFile'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getDisabledTools().size).toBe(0);
  });

  it('should pass settings.tools.visible into visibleTools', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        visible: ['web_fetch', 'monitor'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getVisibleTools()).toEqual(new Set(['web_fetch', 'monitor']));
  });

  it('should default visibleTools to empty when settings.tools.visible is absent', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getVisibleTools().size).toBe(0);
  });

  it('should ignore settings-sourced visibleTools in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        visible: ['web_fetch'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getVisibleTools().size).toBe(0);
  });

  it('should ignore settings-sourced visibleTools in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        visible: ['web_fetch'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getVisibleTools().size).toBe(0);
  });

  it('should normalise settings.tools.visible entries (trim, dedupe, filter)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        visible: [
          '  web_fetch  ',
          'web_fetch',
          '',
          'monitor',
        ] as unknown as string[],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getVisibleTools()).toEqual(new Set(['web_fetch', 'monitor']));
  });

  it('should respect safe mode via QWEN_CODE_SAFE_MODE env var', async () => {
    vi.stubEnv('QWEN_CODE_SAFE_MODE', 'true');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      permissions: {
        allow: ['Bash(*)'],
        autoMode: { hints: { allow: ['everything'] } },
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getPermissionsAllow()).toEqual([]);
    expect(config.getAutoModeSettings()).toEqual({});
    expect(config.isSafeMode()).toBe(true);
  });
});

describe('loadCliConfig registry allowlist wiring (#9827)', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    vi.spyOn(process, 'cwd').mockReturnValue(
      path.resolve(path.sep, 'home', 'user', 'project'),
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes settings.permissions.allow as the registry allowlist', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      permissions: {
        allow: ['ReadFile', 'Shell'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getRegistryAllowList()).toEqual(['ReadFile', 'Shell']);
  });

  it('does not treat --allowed-tools as a registry allowlist', async () => {
    process.argv = ['node', 'script.js', '--allowed-tools', 'ReadFile'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);

    // Auto-approval grant only — the full toolset stays registered
    expect(config.getPermissionsAllow()).toContain('ReadFile');
    expect(config.getRegistryAllowList()).toEqual([]);
  });

  it('does not treat the legacy tools.allowed key as a registry allowlist', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        allowed: ['ShellTool'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getPermissionsAllow()).toContain('ShellTool');
    expect(config.getRegistryAllowList()).toEqual([]);
  });

  it('strips the registry allowlist in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      permissions: {
        allow: ['ReadFile'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getRegistryAllowList()).toEqual([]);
  });

  it('strips the registry allowlist in bare mode', async () => {
    // Mirror of the safe-mode test: bare mode drops settings
    // `permissions.allow` from the merged allow rules, so an allowlist
    // activated from the same settings would run with zero in-force
    // membership rules and strip the bare registry's minimal toolset.
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      permissions: {
        allow: ['ReadFile'],
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getRegistryAllowList()).toEqual([]);
  });
});

describe('loadCliConfig chatCompression', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should pass chatCompression settings to the core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      model: {
        chatCompression: {
          imageTokenEstimate: 1234,
          maxRecentFilesToRetain: 7,
        },
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getChatCompression()).toEqual({
      imageTokenEstimate: 1234,
      maxRecentFilesToRetain: 7,
    });
  });

  it('should have undefined chatCompression if not in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getChatCompression()).toBeUndefined();
  });
});

describe('loadCliConfig useRipgrep', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be true by default when useRipgrep is not set in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseRipgrep()).toBe(true);
  });

  it('should be false when useRipgrep is set to false in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { useRipgrep: false } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseRipgrep()).toBe(false);
  });

  it('should be true when useRipgrep is explicitly set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { useRipgrep: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseRipgrep()).toBe(true);
  });
});

describe('loadCliConfig useBuiltinRipgrep', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be true by default when useBuiltinRipgrep is not set in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseBuiltinRipgrep()).toBe(true);
  });

  it('should be false when useBuiltinRipgrep is set to false in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { useBuiltinRipgrep: false } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseBuiltinRipgrep()).toBe(false);
  });

  it('should be true when useBuiltinRipgrep is explicitly set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { useBuiltinRipgrep: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getUseBuiltinRipgrep()).toBe(true);
  });
});

describe('loadCliConfig workflowsEnabled', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', undefined);
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be disabled by default when workflowsEnabled is not set in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.isWorkflowsEnabled()).toBe(false);
  });

  // The regression this whole setting exists to prevent: `workflowsEnabled`
  // was declared on ConfigParameters and read by isWorkflowsEnabled(), but
  // loadCliConfig never wrote it — so the setting was a dead switch and the
  // env var was the only way in.
  it('should be enabled when workflowsEnabled is set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { workflowsEnabled: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.isWorkflowsEnabled()).toBe(true);
  });

  it('should let the QWEN_CODE_DISABLE_WORKFLOWS kill switch override a true setting', async () => {
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '1');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { workflowsEnabled: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.isWorkflowsEnabled()).toBe(false);
  });

  it('should let QWEN_CODE_ENABLE_WORKFLOWS enable workflows when the setting is false', async () => {
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '1');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { tools: { workflowsEnabled: false } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.isWorkflowsEnabled()).toBe(true);
  });
});

describe('screenReader configuration', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should use screenReader value from settings if CLI flag is not present (settings true)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      ui: { accessibility: { screenReader: true } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getScreenReader()).toBe(true);
  });

  it('should use screenReader value from settings if CLI flag is not present (settings false)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      ui: { accessibility: { screenReader: false } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getScreenReader()).toBe(false);
  });

  it('should prioritize --screen-reader CLI flag (true) over settings (false)', async () => {
    process.argv = ['node', 'script.js', '--screen-reader'];
    const argv = await parseArguments();
    const settings: Settings = {
      ui: { accessibility: { screenReader: false } },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getScreenReader()).toBe(true);
  });

  it('should be false by default when no flag or setting is present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {};
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getScreenReader()).toBe(false);
  });
});

describe('loadCliConfig tool exclusions', () => {
  const originalArgv = process.argv;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.stdin.isTTY = true;
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should not exclude interactive tools in interactive mode without YOLO', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getPermissionsDeny()).not.toContain('run_shell_command');
    expect(config.getPermissionsDeny()).not.toContain('replace');
    expect(config.getPermissionsDeny()).not.toContain('write_file');
  });

  it('should not exclude interactive tools in interactive mode with YOLO', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--yolo'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getPermissionsDeny()).not.toContain('run_shell_command');
    expect(config.getPermissionsDeny()).not.toContain('replace');
    expect(config.getPermissionsDeny()).not.toContain('write_file');
  });

  it('should exclude interactive tools in non-interactive mode without YOLO', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getPermissionsDeny()).toContain('run_shell_command');
    expect(config.getPermissionsDeny()).toContain('edit');
    expect(config.getPermissionsDeny()).toContain('write_file');
  });

  it('should not exclude interactive tools in non-interactive mode with YOLO', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '-p', 'test', '--yolo'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getPermissionsDeny()).not.toContain('run_shell_command');
    expect(config.getPermissionsDeny()).not.toContain('replace');
    expect(config.getPermissionsDeny()).not.toContain('write_file');
  });
});

describe('loadCliConfig interactive', () => {
  const originalArgv = process.argv;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be interactive if isTTY and no prompt', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(true);
  });

  it('should be interactive if prompt-interactive is set', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '--prompt-interactive', 'test'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(true);
  });

  it('should not be interactive if not isTTY and no prompt', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(false);
  });

  it('should not be interactive if prompt is set', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--prompt', 'test'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(false);
  });

  it('should not be interactive if positional prompt words are provided with other flags', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--model', 'gemini-1.5-pro', 'Hello'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(false);
  });

  it('should not be interactive if positional prompt words are provided with multiple flags', async () => {
    process.stdin.isTTY = true;
    process.argv = [
      'node',
      'script.js',
      '--model',
      'gemini-1.5-pro',
      '--yolo',
      'Hello world',
    ];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(false);
    // Verify the question is preserved for one-shot execution
    expect(argv.prompt).toBe('Hello world');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should be interactive if no positional prompt words are provided with flags', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--model', 'gemini-1.5-pro'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.isInteractive()).toBe(true);
  });
});

describe('loadCliConfig approval mode', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.argv = ['node', 'script.js']; // Reset argv for each test
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should default to AUTO approval mode when no flags are set', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.AUTO);
  });

  it('should set PLAN approval mode when --approval-mode=plan', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'plan'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.PLAN);
  });

  it('should set YOLO approval mode when --yolo flag is used', async () => {
    process.argv = ['node', 'script.js', '--yolo'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.YOLO);
  });

  it('should set YOLO approval mode when -y flag is used', async () => {
    process.argv = ['node', 'script.js', '-y'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.YOLO);
  });

  it('should set DEFAULT approval mode when --approval-mode=default', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'default'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
  });

  it('should set AUTO_EDIT approval mode when --approval-mode=auto-edit', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'auto-edit'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.AUTO_EDIT);
  });

  it('should set YOLO approval mode when --approval-mode=yolo', async () => {
    process.argv = ['node', 'script.js', '--approval-mode', 'yolo'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.YOLO);
  });

  it('should use approval mode from settings when CLI flags are not provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    // Using string value to test normalization
    const settings = { tools: { approvalMode: 'plan' } } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.PLAN);
  });

  it('should normalize approval mode values from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings = {
      tools: { approvalMode: 'auto_edit' },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.AUTO_EDIT);
  });

  it('should normalize legacy autoedit approval mode from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings = {
      tools: { approvalMode: 'autoedit' },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.AUTO_EDIT);
  });

  it('should throw when approval mode in settings is invalid', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings = {
      tools: { approvalMode: 'invalid_mode' },
    } as unknown as Settings;
    await expect(loadCliConfig(settings, argv, undefined, [])).rejects.toThrow(
      'Invalid approval mode: invalid_mode. Valid values are: plan, default, auto-edit, auto, yolo',
    );
  });

  it('should prioritize --approval-mode over --yolo when both would be valid (but validation prevents this)', async () => {
    // Note: This test documents the intended behavior, but in practice the validation
    // prevents both flags from being used together
    process.argv = ['node', 'script.js', '--approval-mode', 'default'];
    const argv = await parseArguments();
    // Manually set yolo to true to simulate what would happen if validation didn't prevent it
    argv.yolo = true;
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
  });

  it('should fall back to --yolo behavior when --approval-mode is not set', async () => {
    process.argv = ['node', 'script.js', '--yolo'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.YOLO);
  });

  // --- Untrusted Folder Scenarios ---
  describe('when folder is NOT trusted', () => {
    beforeEach(() => {
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: false,
        source: 'file',
      });
    });

    it('should override default AUTO mode to DEFAULT', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
    });

    it('should override --approval-mode=yolo to DEFAULT', async () => {
      process.argv = ['node', 'script.js', '--approval-mode', 'yolo'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
    });

    it('should override --approval-mode=auto-edit to DEFAULT', async () => {
      process.argv = ['node', 'script.js', '--approval-mode', 'auto-edit'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
    });

    it('should override --yolo flag to DEFAULT', async () => {
      process.argv = ['node', 'script.js', '--yolo'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
    });

    it('should remain DEFAULT when --approval-mode=default', async () => {
      process.argv = ['node', 'script.js', '--approval-mode', 'default'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.DEFAULT);
    });

    it('should allow PLAN approval mode in untrusted folders', async () => {
      process.argv = ['node', 'script.js', '--approval-mode', 'plan'];
      const argv = await parseArguments();
      const config = await loadCliConfig({}, argv, undefined, []);
      expect(config.getApprovalMode()).toBe(ServerConfig.ApprovalMode.PLAN);
    });
  });
});

describe('loadCliConfig fileFiltering', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.argv = ['node', 'script.js']; // Reset argv for each test
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const testCases: Array<{
    property: keyof NonNullable<
      NonNullable<Settings['context']>['fileFiltering']
    >;
    getter: (config: ServerConfig.Config) => boolean;
    value: boolean;
  }> = [
    {
      property: 'enableFuzzySearch',
      getter: (c) => c.getFileFilteringEnableFuzzySearch(),
      value: true,
    },
    {
      property: 'enableFuzzySearch',
      getter: (c) => c.getFileFilteringEnableFuzzySearch(),
      value: false,
    },
    {
      property: 'respectGitIgnore',
      getter: (c) => c.getFileFilteringRespectGitIgnore(),
      value: true,
    },
    {
      property: 'respectGitIgnore',
      getter: (c) => c.getFileFilteringRespectGitIgnore(),
      value: false,
    },
    {
      property: 'respectQwenIgnore',
      getter: (c) => c.getFileFilteringRespectQwenIgnore(),
      value: true,
    },
    {
      property: 'respectQwenIgnore',
      getter: (c) => c.getFileFilteringRespectQwenIgnore(),
      value: false,
    },
    {
      property: 'enableRecursiveFileSearch',
      getter: (c) => c.getEnableRecursiveFileSearch(),
      value: true,
    },
    {
      property: 'enableRecursiveFileSearch',
      getter: (c) => c.getEnableRecursiveFileSearch(),
      value: false,
    },
  ];

  it.each(testCases)(
    'should pass $property from settings to config when $value',
    async ({ property, getter, value }) => {
      const settings: Settings = {
        context: {
          fileFiltering: { [property]: value },
        },
      };
      const argv = await parseArguments();
      const config = await loadCliConfig(settings, argv, undefined, []);
      expect(getter(config)).toBe(value);
    },
  );

  it('should pass customIgnoreFiles from settings to config', async () => {
    const settings: Settings = {
      context: {
        fileFiltering: { customIgnoreFiles: ['.cursorignore'] },
      },
    };
    const argv = await parseArguments();
    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getFileFilteringOptions().customIgnoreFiles).toEqual([
      '.cursorignore',
    ]);
    expect(config.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
  });
});

describe('Output format', () => {
  it('should default to TEXT', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getOutputFormat()).toBe(OutputFormat.TEXT);
  });

  it('should use the format from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { output: { format: OutputFormat.JSON } },
      argv,
      undefined,
      [],
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.JSON);
  });

  it('should use stream-json format from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { output: { format: OutputFormat.STREAM_JSON } },
      argv,
      undefined,
      [],
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.STREAM_JSON);
  });

  it('should prioritize the format from argv', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'json'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { output: { format: OutputFormat.JSON } },
      argv,
      undefined,
      [],
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.JSON);
  });

  it('should prioritize argv over a differing settings format', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'text'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { output: { format: OutputFormat.STREAM_JSON } },
      argv,
      undefined,
      [],
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.TEXT);
  });

  it('should error on invalid --output-format argument', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'yaml'];
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();
    await expect(parseArguments()).rejects.toThrow('process.exit called');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Invalid values:'),
    );
    mockExit.mockRestore();
  });
});

describe('parseArguments with positional prompt', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('should throw an error when both a positional prompt and the --prompt flag are used', async () => {
    process.argv = [
      'node',
      'script.js',
      'positional',
      'prompt',
      '--prompt',
      'test prompt',
    ];

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockWriteStderrLine.mockClear();

    await expect(parseArguments()).rejects.toThrow('process.exit called');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both a positional prompt and the --prompt (-p) flag together',
      ),
    );

    mockExit.mockRestore();
  });

  it('should correctly parse a positional prompt to query field', async () => {
    process.argv = ['node', 'script.js', 'positional', 'prompt'];
    const argv = await parseArguments();
    expect(argv.query).toBe('positional prompt');
    // Since no explicit prompt flags are set and query doesn't start with @, should map to prompt (one-shot)
    expect(argv.prompt).toBe('positional prompt');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should correctly parse a prompt from the --prompt flag', async () => {
    process.argv = ['node', 'script.js', '--prompt', 'test prompt'];
    const argv = await parseArguments();
    expect(argv.prompt).toBe('test prompt');
  });
});

describe('Telemetry configuration via environment variables', () => {
  it('should prioritize QWEN_TELEMETRY_ENABLED over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_ENABLED', 'true');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: false } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('should prioritize QWEN_TELEMETRY_TARGET over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_TARGET', 'gcp');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { target: 'local' },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryTarget()).toBe('gcp');
  });

  it('should throw when QWEN_TELEMETRY_TARGET is invalid', async () => {
    vi.stubEnv('QWEN_TELEMETRY_TARGET', 'bogus');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { target: 'gcp' },
    } as unknown as Settings;
    await expect(loadCliConfig(settings, argv, undefined, [])).rejects.toThrow(
      /Invalid telemetry configuration: .*Invalid telemetry target/i,
    );
    vi.unstubAllEnvs();
  });

  it('should prioritize QWEN_TELEMETRY_OTLP_ENDPOINT over settings and default env var', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://default.env.com');
    vi.stubEnv('QWEN_TELEMETRY_OTLP_ENDPOINT', 'http://gemini.env.com');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { otlpEndpoint: 'http://settings.com' },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryOtlpEndpoint()).toBe('http://gemini.env.com');
  });

  it('should prioritize QWEN_TELEMETRY_OTLP_PROTOCOL over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_OTLP_PROTOCOL', 'http');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { otlpProtocol: 'grpc' } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryOtlpProtocol()).toBe('http');
  });

  it('should prioritize QWEN_TELEMETRY_LOG_PROMPTS over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_LOG_PROMPTS', 'false');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { logPrompts: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
  });

  it('should prioritize QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES', 'true');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { includeSensitiveSpanAttributes: false },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(true);
  });

  it('should prioritize QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH', '131072');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { sensitiveSpanAttributeMaxLength: 65_536 },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetrySensitiveSpanAttributeMaxLength()).toBe(131_072);
  });

  it('should prioritize QWEN_TELEMETRY_OUTFILE over settings', async () => {
    vi.stubEnv('QWEN_TELEMETRY_OUTFILE', '/gemini/env/telemetry.log');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { outfile: '/settings/telemetry.log' },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryOutfile()).toBe('/gemini/env/telemetry.log');
  });

  it('should use settings value when QWEN_TELEMETRY_ENABLED is not set', async () => {
    vi.stubEnv('QWEN_TELEMETRY_ENABLED', undefined);
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = { telemetry: { enabled: true } };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('should use settings value when QWEN_TELEMETRY_TARGET is not set', async () => {
    vi.stubEnv('QWEN_TELEMETRY_TARGET', undefined);
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const settings: Settings = {
      telemetry: { target: 'local' },
    } as unknown as Settings;
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getTelemetryTarget()).toBe('local');
  });

  it("should treat QWEN_TELEMETRY_ENABLED='1' as true", async () => {
    vi.stubEnv('QWEN_TELEMETRY_ENABLED', '1');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it("should treat QWEN_TELEMETRY_ENABLED='0' as false", async () => {
    vi.stubEnv('QWEN_TELEMETRY_ENABLED', '0');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { telemetry: { enabled: true } },
      argv,
      undefined,
      [],
    );
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it("should treat QWEN_TELEMETRY_LOG_PROMPTS='1' as true", async () => {
    vi.stubEnv('QWEN_TELEMETRY_LOG_PROMPTS', '1');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
  });

  it("should treat QWEN_TELEMETRY_LOG_PROMPTS='false' as false", async () => {
    vi.stubEnv('QWEN_TELEMETRY_LOG_PROMPTS', 'false');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { telemetry: { logPrompts: true } },
      argv,
      undefined,
      [],
    );
    expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
  });

  it("should treat QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES='1' as true", async () => {
    vi.stubEnv('QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES', '1');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig({}, argv, undefined, []);
    expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(true);
  });

  it("should treat QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES='false' as false", async () => {
    vi.stubEnv('QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES', 'false');
    process.argv = ['node', 'script.js'];
    const argv = await parseArguments();
    const config = await loadCliConfig(
      { telemetry: { includeSensitiveSpanAttributes: true } },
      argv,
      undefined,
      [],
    );
    expect(config.getTelemetryIncludeSensitiveSpanAttributes()).toBe(false);
  });
});

describe('sandbox image resolution precedence', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    delete process.env['QWEN_SANDBOX_IMAGE'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env['QWEN_SANDBOX_IMAGE'];
  });

  it('uses --sandbox-image over env and settings', async () => {
    vi.stubEnv('QWEN_SANDBOX_IMAGE', 'env-image');
    process.argv = [
      'node',
      'script.js',
      '--sandbox',
      '--sandbox-image',
      'cli-image',
    ];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        sandbox: true,
        sandboxImage: 'settings-image',
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getSandbox()?.image).toBe('cli-image');
  });

  it('uses QWEN_SANDBOX_IMAGE over tools.sandboxImage', async () => {
    vi.stubEnv('QWEN_SANDBOX_IMAGE', 'env-image');
    process.argv = ['node', 'script.js', '--sandbox'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        sandbox: true,
        sandboxImage: 'settings-image',
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getSandbox()?.image).toBe('env-image');
  });

  it('uses tools.sandboxImage when cli and env are absent', async () => {
    process.argv = ['node', 'script.js', '--sandbox'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        sandbox: true,
        sandboxImage: 'settings-image',
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getSandbox()?.image).toBe('settings-image');
  });

  it('falls back to package default image when no explicit source is provided', async () => {
    process.argv = ['node', 'script.js', '--sandbox'];
    const argv = await parseArguments();
    const settings: Settings = {
      tools: {
        sandbox: true,
      },
    };
    const config = await loadCliConfig(settings, argv, undefined, []);
    expect(config.getSandbox()?.image).toBe('pkg-default-image');
  });
});

describe('loadCliConfig runtimeOutputDir', () => {
  const originalArgv = process.argv;
  const originalRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];

  beforeEach(() => {
    process.argv = ['node', 'script.js'];
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    Storage.setRuntimeBaseDir(null);
    if (originalRuntimeEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should set runtime base dir from settings with absolute path', async () => {
    const runtimeDir = path.resolve('custom', 'runtime');
    const argv = await parseArguments();
    const settings: Settings = {
      advanced: { runtimeOutputDir: runtimeDir },
    };
    await loadCliConfig(settings, argv);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('should resolve relative runtimeOutputDir against cwd', async () => {
    const argv = await parseArguments();
    const settings: Settings = {
      advanced: { runtimeOutputDir: '.qwen' },
    };
    const cwd = path.resolve('workspace', 'my-project');
    await loadCliConfig(settings, argv, cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.qwen'));
  });

  it('should not set runtime base dir when runtimeOutputDir is absent', async () => {
    const argv = await parseArguments();
    const settings: Settings = {};
    await loadCliConfig(settings, argv);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });

  it('should let QWEN_RUNTIME_DIR env var take priority over settings', async () => {
    const envDir = path.resolve('from-env');
    const settingsDir = path.resolve('from-settings');
    process.env['QWEN_RUNTIME_DIR'] = envDir;
    const argv = await parseArguments();
    const settings: Settings = {
      advanced: { runtimeOutputDir: settingsDir },
    };
    await loadCliConfig(settings, argv);
    // getRuntimeBaseDir checks env var first at call time
    expect(Storage.getRuntimeBaseDir()).toBe(envDir);
  });

  it('should reset runtime base dir on subsequent load when runtimeOutputDir is absent', async () => {
    const argv = await parseArguments();
    const firstRuntimeDir = path.resolve('first', 'runtime');
    await loadCliConfig(
      { advanced: { runtimeOutputDir: firstRuntimeDir } },
      argv,
    );
    expect(Storage.getRuntimeBaseDir()).toBe(firstRuntimeDir);

    await loadCliConfig({}, argv);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalQwenDir());
  });
});

describe('loadCliConfig plansDirectory', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('should resolve relative plansDirectory against cwd', async () => {
    const argv = await parseArguments();
    const cwd = path.resolve('workspace', 'my-project');
    const settings: Settings = {
      plansDirectory: './project-plans',
    };

    const config = await loadCliConfig(settings, argv, cwd);

    expect(config.getPlansDir()).toBe(path.join(cwd, 'project-plans'));
    expect(config.getPlanFilePath()).toContain(path.join(cwd, 'project-plans'));
  });

  it('should reject plansDirectory values outside cwd', async () => {
    const argv = await parseArguments();
    const cwd = path.resolve('workspace', 'my-project');
    const settings: Settings = {
      plansDirectory: '../plans',
    };

    await expect(loadCliConfig(settings, argv, cwd)).rejects.toThrow(
      'plansDirectory must resolve within the project root',
    );
  });
});

describe('loadCliConfig skills.directories', () => {
  beforeEach(() => {
    process.argv = ['node', 'script.js'];
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should filter non-string and whitespace-only entries and trim valid ones', async () => {
    const argv = await parseArguments();
    const settings: Settings = {
      skills: {
        directories: [
          '  ~/my-skills  ',
          '',
          '   ',
          42 as unknown as string,
          null as unknown as string,
          '/abs/skills',
        ],
      },
    };

    const config = await loadCliConfig(settings, argv);

    expect(config.getCustomSkillDirs()).toEqual(['~/my-skills', '/abs/skills']);
  });

  it('should return empty array when skills.directories is not set', async () => {
    const argv = await parseArguments();

    const config = await loadCliConfig({}, argv);

    expect(config.getCustomSkillDirs()).toEqual([]);
  });

  it('should return empty array when skills.directories is a non-array value', async () => {
    const argv = await parseArguments();
    const settings = {
      skills: {
        directories: 'all',
      },
    } as unknown as Settings;

    const config = await loadCliConfig(settings, argv);

    expect(config.getCustomSkillDirs()).toEqual([]);
  });

  it('should ignore skills.directories in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = {
      skills: { directories: ['~/my-skills', '/abs/skills'] },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getCustomSkillDirs()).toEqual([]);
  });

  it('should ignore skills.directories in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = {
      skills: { directories: ['~/my-skills', '/abs/skills'] },
    };

    const config = await loadCliConfig(settings, argv, undefined, []);

    expect(config.getCustomSkillDirs()).toEqual([]);
  });
});

describe('loadCliConfig skills.disabledLevels', () => {
  beforeEach(() => {
    process.argv = ['node', 'script.js'];
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes valid disabled skill levels to core and ignores invalid values', async () => {
    const argv = await parseArguments();
    const settings: Settings = {
      skills: {
        disabledLevels: ['bundled', 'invalid', 42 as unknown as string, 'user'],
      },
    };

    const config = await loadCliConfig(settings, argv);

    expect(config.getDisabledSkillLevels()).toEqual(
      new Set(['bundled', 'user']),
    );
  });

  it('keeps every skill level enabled by default', async () => {
    const argv = await parseArguments();

    const config = await loadCliConfig({}, argv);

    expect(config.getDisabledSkillLevels()).toEqual(new Set());
  });

  it('ignores skills.disabledLevels in safe mode', async () => {
    process.argv = ['node', 'script.js', '--safe-mode'];
    const argv = await parseArguments();
    const settings: Settings = { skills: { disabledLevels: ['bundled'] } };

    const config = await loadCliConfig(settings, argv);

    expect(config.getDisabledSkillLevels()).toEqual(new Set());
  });

  it('ignores skills.disabledLevels in bare mode', async () => {
    process.argv = ['node', 'script.js', '--bare'];
    const argv = await parseArguments();
    const settings: Settings = { skills: { disabledLevels: ['bundled'] } };

    const config = await loadCliConfig(settings, argv);

    expect(config.getDisabledSkillLevels()).toEqual(new Set());
  });
});
