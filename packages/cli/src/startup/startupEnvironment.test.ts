/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const loadSettings = vi.hoisted(() => vi.fn());
import { createCliSettingsService } from '../config/createCliSettingsService.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CONFIG_DIR,
  BRAND_ENV_PREFIX,
  ENV_WORKTREE_HANDLED,
  ENV_WORKTREE_INFO,
  resolveSameRepoTranscriptSession,
  resolveLatestSameRepoTranscriptSession,
} from '@qwen-code/core';
import { ENV_MODEL } from '../config/config.js';
import { createCommand } from '../commands/index.js';
import { handleRootCommand } from './rootCommandHandler.js';
const resolveTerminalCommands = vi.fn(async () => [] as CommandUnknownOpts[]);
import {
  restoreLoadedEnvironment,
  loadEnvironment,
  type SettingSource,
} from '../config/settings.js';
import { createAppPluginFixture } from '../test-utils/appPluginFixture.js';
import type { FrameworkFixture as AppFramework } from '../test-utils/frameworkFixture.js';
import { SettingsService } from '@qwen-code/resource';
const { registerAppPlugins, getAppPluginRegistry } = createAppPluginFixture();
const settingsService = createCliSettingsService();
const parserFramework = {
  getAppPlugins: getAppPluginRegistry,
  start: async () => parserFramework,
  getSettingsService: () => settingsService,
} as unknown as AppFramework;
const declarations = [
  {
    resolveTerminalCommands,
    getTerminalCommands: () =>
      getAppPluginRegistry().getAppPluginTerminalCommands(),
    getRootOptions: () => getAppPluginRegistry().getAppPluginRootOptions(),
  },
];

registerAppPlugins([
  {
    apiVersion: 1,
    id: 'remote-control-parser-fixture',
    initialize: async () => {},
    dispose: async () => {},
    getRootOptions: () => [new Option('--remote-control <id>')],
  },
]);

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  resolveSameRepoTranscriptSession: vi.fn(),
  resolveLatestSameRepoTranscriptSession: vi.fn(),
}));
vi.mock('./rootCommandHandler.js', () => ({ handleRootCommand: vi.fn() }));
vi.mock('../config/createCliSettingsService.js', () => ({
  createCliSettingsService: () => {
    const service = new SettingsService();
    vi.spyOn(service, 'resolve').mockImplementation(
      ({ projectPath, sources }) => loadSettings(projectPath, sources),
    );
    return service;
  },
}));

describe('startup environment project ownership', () => {
  afterAll(() => settingsService.dispose());
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  let tempDir: string;
  let project: string;
  let checkout: string;
  let selected: Awaited<ReturnType<typeof resolveSameRepoTranscriptSession>>;

  beforeEach(() => {
    vi.clearAllMocks();
    loadSettings.mockImplementation(
      (cwd: string = process.cwd(), _sources?: readonly SettingSource[]) => {
        loadEnvironment({}, cwd, () => ({ isTrusted: true, source: 'file' }));
        return { merged: {}, errors: [] };
      },
    );
    tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-startup-env-'));
    project = path.join(tempDir, 'project');
    checkout = path.join(tempDir, 'checkout');
    for (const [cwd, model] of [
      [project, 'project-model'],
      [checkout, 'checkout-model'],
    ]) {
      mkdirSync(path.join(cwd, CONFIG_DIR), { recursive: true });
      writeFileSync(
        path.join(cwd, CONFIG_DIR, '.env'),
        `${ENV_MODEL}=${model}\nCLI_TEST_ENV_SOURCE=${model}\n`,
      );
    }
    process.chdir(checkout);
    for (const key of [
      ENV_MODEL,
      'CLI_TEST_ENV_SOURCE',
      'CLI_TEST_CHECKOUT_ONLY',
      ENV_WORKTREE_HANDLED,
      ENV_WORKTREE_INFO,
      `${BRAND_ENV_PREFIX}SESSION_ID`,
    ]) {
      vi.stubEnv(key, undefined);
    }
    const state = {
      originalCwd: project,
      worktreePath: checkout,
      worktreeCwd: checkout,
      worktreeName: 'checkout',
      worktreeBranch: 'worktree/checkout',
      sessionId: 'source-session',
      lifecycle: 'attached' as const,
      hookBased: true,
    };
    selected = {
      sessionInfo: {
        id: 'source-session',
        file: 'source-session.jsonl',
        fileName: 'source-session.jsonl',
        sessionPath: path.join(
          tempDir,
          'legacy-bucket',
          'source-session.jsonl',
        ),
        startTime: '2026-04-20T00:00:00.000Z',
        lastUpdated: '2026-04-20T00:00:00.000Z',
        messageCount: 0,
        userMessageCount: 0,
        displayName: 'Source session',
        firstUserMessage: '',
        isCurrentSession: false,
        index: 1,
        transcriptProjectRoot: project,
        worktreeSession: state,
      },
      displayInfo: 'Source session',
      sessionPath: path.join(tempDir, 'legacy-bucket', 'source-session.jsonl'),
      messages: [],
      fileHistorySnapshots: [],
    };
    vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValue(selected);
    vi.mocked(resolveLatestSameRepoTranscriptSession).mockResolvedValue(
      selected,
    );
  });

  afterEach(() => {
    restoreLoadedEnvironment();
    process.chdir(originalCwd);
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    process.argv = ['node', 'qwen', ...args];
    const program = await createCommand(
      parserFramework.getSettingsService(),
      declarations,
      parserFramework.start,
    );
    await program.parseAsync(process.argv);
    return vi.mocked(handleRootCommand).mock.calls.at(-1)!;
  }

  it('reads ordinary startup settings once through the Framework resource service', async () => {
    await run(['-p']);
    expect(settingsService.resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectPath: process.cwd() }),
    );
    expect(loadSettings).toHaveBeenCalledOnce();
  });

  it('reuses a command-owned SettingsService when Resume changes roots without a Framework', async () => {
    process.argv = ['node', 'qwen', '--continue', '-p'];
    const program = await createCommand();
    await program.parseAsync(process.argv);

    const calls = loadSettings.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([cwd]) => cwd)).toEqual([process.cwd(), project]);
    expect(settingsService.resolve).not.toHaveBeenCalled();
    expect(vi.mocked(handleRootCommand).mock.calls.at(-1)?.[0].model).toBe(
      'project-model',
    );
  });

  it('loads the launch env before resume discovery, then removes it when the project changes', async () => {
    writeFileSync(
      path.join(checkout, CONFIG_DIR, '.env'),
      `${BRAND_ENV_PREFIX}SESSION_ID=env-session\nCLI_TEST_CHECKOUT_ONLY=1\n`,
    );
    await run(['--continue', '-p']);
    expect(resolveLatestSameRepoTranscriptSession).toHaveBeenCalledWith(
      process.cwd(),
      'env-session',
    );
    expect(process.env['CLI_TEST_CHECKOUT_ONLY']).toBeUndefined();
    expect(vi.mocked(loadSettings).mock.calls.map(([cwd]) => cwd)).toEqual([
      process.cwd(),
      project,
    ]);
  });

  it('keeps an explicit session ID ahead of the launch env during discovery', async () => {
    writeFileSync(
      path.join(checkout, CONFIG_DIR, '.env'),
      `${BRAND_ENV_PREFIX}SESSION_ID=env-session\n`,
    );
    const id = '11111111-1111-4111-8111-111111111111';
    await run(['--continue', '-p', '--session-id', id]);
    expect(resolveLatestSameRepoTranscriptSession).toHaveBeenCalledWith(
      process.cwd(),
      id,
    );
  });

  it.each([
    ['--resume', 'source-session', '-p'],
    ['-rsource-session', '-p'],
    ['--continue', '-i', 'continue working'],
    ['--resume=source-session', '-p', '--fork-session'],
  ])(
    'loads original project env before argument defaults: %j',
    async (...args) => {
      const [argv] = await run(args);
      expect(argv.model).toBe('project-model');
      expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('project-model');
      // 精确选择必须传给后续启动，不能按 UUID 再次选中其他 bucket 副本。
      expect(vi.mocked(handleRootCommand).mock.calls.at(-1)?.[1]).toMatchObject(
        {
          resourceRoot: project,
          resumeSelection: { status: 'fulfilled', value: selected },
        },
      );
    },
  );

  it.each([
    {
      args: ['--resume', 'source-session', '-p'],
      resolve: resolveSameRepoTranscriptSession,
    },
    {
      args: ['--continue', '-p'],
      resolve: resolveLatestSameRepoTranscriptSession,
    },
  ])(
    'preserves a failed resume selection for runtime error handling: $args',
    async ({ args, resolve }) => {
      const failure = new Error('transcript could not be read');
      vi.mocked(resolve).mockRejectedValueOnce(failure);
      const launchRoot = process.cwd();

      const [argv, workspace] = await run(args);

      expect(argv.model).toBe('checkout-model');
      expect(workspace?.resourceRoot).toBe(launchRoot);
      expect(workspace?.resumeSelection).toEqual({
        status: 'rejected',
        reason: failure,
      });
    },
  );

  it.each([false, true])(
    'loads inherited originalCwd env without discovering history (positional=%s)',
    async (positional) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(
        ENV_WORKTREE_INFO,
        JSON.stringify({
          name: 'checkout',
          path: checkout,
          originalCwd: project,
          hookBased: true,
        }),
      );
      const [argv] = await run(
        positional ? ['continue implementing', '-p'] : ['-p'],
      );
      expect(argv.model).toBe('project-model');
      expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
      expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--version', 'commander.version'],
    ['--help', 'commander.helpDisplayed'],
  ])('ignores invalid inherited state for %s', async (flag, code) => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(ENV_WORKTREE_INFO, 'not-json');
    process.argv = ['node', 'qwen', flag];
    const program = await createCommand(
      parserFramework.getSettingsService(),
      declarations,
      parserFramework.start,
    );
    program.configureOutput({ writeOut: () => {} });

    await expect(program.parseAsync(process.argv)).rejects.toMatchObject({
      code,
    });
    expect(handleRootCommand).not.toHaveBeenCalled();
    expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
    expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not interpret external command resume arguments or inherited state (invalid=%s)',
    async (invalidInheritedState) => {
      if (invalidInheritedState) {
        vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
        vi.stubEnv(ENV_WORKTREE_INFO, 'not-json');
      }
      const received: string[] = [];
      resolveTerminalCommands.mockResolvedValueOnce([
        new Command('workspace-export')
          .argument('[args...]')
          .allowUnknownOption()
          .action((args) => {
            received.push(...args);
          }),
      ]);

      await run(['workspace-export', '--resume', 'external-session']);

      expect(received).toEqual(['--resume', 'external-session']);
      expect(handleRootCommand).not.toHaveBeenCalled();
      expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
      expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
      expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('checkout-model');
    },
  );

  it('replaces the discovery environment with the selected project for a positional Resume prompt', async () => {
    writeFileSync(
      path.join(checkout, CONFIG_DIR, '.env'),
      `${ENV_MODEL}=checkout-model\nCLI_TEST_CHECKOUT_ONLY=checkout\n`,
    );
    const [argv, workspace] = await run([
      'continue implementing',
      '--resume',
      'source-session',
      '-p',
    ]);

    expect(argv.model).toBe('project-model');
    expect(process.env['CLI_TEST_CHECKOUT_ONLY']).toBeUndefined();
    expect(workspace).toMatchObject({
      resourceRoot: project,
      resumeSelection: { status: 'fulfilled', value: selected },
    });
  });

  it.each([false, true])(
    'reuses settings for a positional prompt in the same project (resume=%s)',
    async (resume) => {
      selected.sessionInfo.worktreeSession = null;
      selected.sessionInfo.originalCwd = process.cwd();
      selected.sessionInfo.transcriptProjectRoot = process.cwd();

      const [argv] = await run([
        'continue implementing',
        '-p',
        ...(resume ? ['--resume', 'source-session'] : []),
      ]);

      expect(argv.model).toBe('checkout-model');
      expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('checkout-model');
      // 同一归属只读取一次 Settings，避免重复磁盘读取、迁移和告警。
      expect(vi.mocked(loadSettings).mock.calls.map(([cwd]) => cwd)).toEqual([
        process.cwd(),
      ]);
    },
  );

  it('still rejects invalid inherited state for a root positional prompt', async () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(ENV_WORKTREE_INFO, 'not-json');

    await expect(run(['continue implementing', '-p'])).rejects.toThrow(
      /worktree/i,
    );
    expect(handleRootCommand).not.toHaveBeenCalled();
  });

  it('loads original project env after Exit keep when the JSONL remains in a legacy bucket', async () => {
    Object.assign(selected.sessionInfo, {
      originalCwd: project,
      worktreeSession: null,
      transcriptProjectRoot: checkout,
    });

    const [argv] = await run(['--resume', 'source-session', '-p']);

    expect(argv.model).toBe('project-model');
    expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('project-model');
  });

  it.each([false, true])(
    'preserves host environment and explicit CLI priority (positional=%s)',
    async (positional) => {
      vi.stubEnv(ENV_MODEL, 'host-model');
      const [argv] = await run([
        ...(positional ? ['continue implementing'] : []),
        '--resume',
        'source-session',
        '-p',
        '--model',
        'cli-model',
      ]);
      expect(argv.model).toBe('cli-model');
      expect(process.env[ENV_MODEL]).toBe('host-model');
      expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('project-model');
    },
  );

  it.each([
    ['-p'],
    ['--prompt', '--resume'],
    ['--list-models', '--resume', 'source-session'],
  ])(
    'keeps ordinary and external startup out of history discovery: %j',
    async (...args) => {
      const [argv] = await run(args);
      expect(argv.model).toBe('checkout-model');
      expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
      expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--acp', '--resume', 'source-session'],
    ['--acp', 'a positional prompt'],
    ['--sdk'],
  ])('does not bind a host to the launch project: %j', async (...args) => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(ENV_WORKTREE_INFO, '{broken');
    const [argv] = await run(args);
    expect(argv.model).toBeUndefined();
    expect(process.env['CLI_TEST_ENV_SOURCE']).toBeUndefined();
    expect(vi.mocked(loadSettings).mock.calls).toEqual([
      [expect.any(String), ['user']],
    ]);
    expect(vi.mocked(loadSettings).mock.calls[0][0]).not.toBe(checkout);
    expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
    expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
  });

  it('does not resolve resume-looking arguments after the literal separator or in subcommands', async () => {
    for (const args of [
      ['--', '--resume', 'source-session'],
      ['mcp', '--resume', 'source-session'],
    ]) {
      process.argv = ['node', 'qwen', ...args];
      await createCommand(
        parserFramework.getSettingsService(),
        declarations,
        parserFramework.start,
      );
    }
    expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
    expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
    expect(process.env['CLI_TEST_ENV_SOURCE']).toBe('checkout-model');
  });
});
