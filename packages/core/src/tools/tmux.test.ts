/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockTmux = vi.hoisted(() => ({
  tmuxNewSession: vi.fn(),
  tmuxGetFirstPaneId: vi.fn(),
  tmuxSetOption: vi.fn(),
  tmuxRespawnPane: vi.fn(),
  tmuxPipePane: vi.fn(),
  tmuxSendKeys: vi.fn(),
  tmuxCapturePaneContent: vi.fn(),
  tmuxKillSession: vi.fn(),
  tmuxListPanes: vi.fn(),
  tmuxHasSession: vi.fn(),
  verifyTmux: vi.fn(),
}));
vi.mock('../agents/backends/tmux-commands.js', () => mockTmux);

import type { Config } from '../config/config.js';
import { BackgroundShellRegistry } from '../services/backgroundShellRegistry.js';
import { TmuxTool, TMUX_SERVER_NAME } from './tmux.js';
import type { TmuxToolParams } from './tmux.js';

// Validation/permission/classifier behavior is platform-independent and must
// run everywhere; the suites that exercise create() need the win32 guard.
describe('TmuxTool validation & permissions', () => {
  let registry: BackgroundShellRegistry;
  let mockConfig: Config;
  let tool: TmuxTool;
  // validateToolParamValues rejects every action on win32 before the
  // per-action checks run, so pin a non-Windows platform for the suite —
  // the behavior tested here is platform-independent and must run on the
  // Windows CI job too.
  let platformSpy: ReturnType<typeof vi.spyOn>;

  const buildInvocation = (params: TmuxToolParams) => tool.build(params);

  beforeEach(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.clearAllMocks();
    registry = new BackgroundShellRegistry();
    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getBackgroundShellRegistry: vi.fn().mockReturnValue(registry),
      getSandbox: vi.fn().mockReturnValue(undefined),
      getWorkspaceContext: vi.fn().mockReturnValue({
        isPathWithinWorkspace: vi.fn().mockReturnValue(true),
      }),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(os.tmpdir()),
      },
    } as unknown as Config;
    tool = new TmuxTool(mockConfig);
  });

  afterEach(() => {
    platformSpy.mockRestore();
  });

  describe('validation', () => {
    it('rejects create without command', () => {
      expect(() => tool.build({ action: 'create' })).toThrow(
        /non-empty command/,
      );
    });

    it('rejects send without session_id', () => {
      expect(() => tool.build({ action: 'send', keys: 'x' })).toThrow(
        /session_id/,
      );
    });

    it('rejects send without keys and without enter', () => {
      expect(() => tool.build({ action: 'send', session_id: 'bg_1' })).toThrow(
        /keys/,
      );
      expect(() =>
        tool.build({ action: 'send', session_id: 'bg_1', keys: '' }),
      ).toThrow(/keys/);
    });

    it('rejects capture/kill without session_id', () => {
      expect(() => tool.build({ action: 'capture' })).toThrow(/session_id/);
      expect(() => tool.build({ action: 'kill' })).toThrow(/session_id/);
    });

    it('rejects non-positive numeric options', () => {
      expect(() =>
        tool.build({ action: 'create', command: 'x', cols: 0 }),
      ).toThrow(/cols/);
      expect(() =>
        tool.build({ action: 'capture', session_id: 'bg_1', lines: -1 }),
      ).toThrow(/lines/);
    });

    it('rejects a non-absolute cwd', () => {
      expect(() =>
        tool.build({ action: 'create', command: 'x', cwd: 'relative/dir' }),
      ).toThrow(/absolute/);
    });

    it('rejects a cwd outside the workspace', () => {
      vi.mocked(mockConfig.getWorkspaceContext).mockReturnValue({
        isPathWithinWorkspace: vi.fn().mockReturnValue(false),
      } as never);
      expect(() =>
        tool.build({ action: 'create', command: 'x', cwd: '/elsewhere' }),
      ).toThrow(/not within/);
    });

    it('rejects create on Windows', () => {
      platformSpy.mockReturnValue('win32');
      expect(() => tool.build({ action: 'create', command: 'x' })).toThrow(
        /Windows/,
      );
    });
  });

  describe('permissions', () => {
    it('allows capture and list by default', async () => {
      for (const action of ['capture', 'list'] as const) {
        const invocation = buildInvocation(
          action === 'capture' ? { action, session_id: 'bg_1' } : { action },
        );
        await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
      }
    });

    it('asks for create, send and kill', async () => {
      const cases: TmuxToolParams[] = [
        { action: 'create', command: 'x' },
        { action: 'send', session_id: 'bg_1', keys: 'x' },
        { action: 'kill', session_id: 'bg_1' },
      ];
      for (const params of cases) {
        await expect(
          buildInvocation(params).getDefaultPermission(),
        ).resolves.toBe('ask');
      }
    });

    it('scopes the create grant to the command via Bash rules', async () => {
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
      if (details.type === 'exec') {
        // The anti-bypass bridge evaluates Bash(...) rules against the
        // create call's command — a grant for one command must not
        // auto-approve every later payload.
        expect(details.permissionRules).toEqual(['Bash(x)']);
      }
    });

    it('keeps per-action rules for the non-executing actions', async () => {
      const invocation = buildInvocation({
        action: 'kill',
        session_id: 'bg_1',
      });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
      if (details.type === 'exec') {
        // key:value param-matcher form — parses to a matcher on the call's
        // `action` param, so persisted allow rules actually match.
        expect(details.permissionRules).toEqual(['tmux(action:kill)']);
      }
    });

    it('offers no persisted grant for send', async () => {
      const invocation = buildInvocation({
        action: 'send',
        session_id: 'bg_1',
        keys: 'x',
      });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
      if (details.type === 'exec') {
        // Keystrokes are arbitrary input; a payload-blind grant would
        // auto-approve anything typed into the terminal.
        expect(details.permissionRules).toEqual([]);
        expect(details.hideAlwaysAllow).toBe(true);
      }
    });
  });

  describe('AUTO classifier input', () => {
    it('forwards action, command and keys', () => {
      expect(
        tool.toAutoClassifierInput({
          action: 'send',
          session_id: 'bg_1',
          keys: 'rm -rf /',
        }),
      ).toEqual({ action: 'send', keys: 'rm -rf /' });
    });

    it('includes the working directory for create', () => {
      expect(
        tool.toAutoClassifierInput({
          action: 'create',
          command: 'python3 app.py',
          cwd: '/work/repo',
        }),
      ).toEqual({
        action: 'create',
        command: 'python3 app.py',
        cwd: '/work/repo',
      });
      expect(
        tool.toAutoClassifierInput({
          action: 'create',
          command: 'python3 app.py',
        }),
      ).toEqual({
        action: 'create',
        command: 'python3 app.py',
        cwd: '/test/dir',
      });
    });
  });

  describe('description', () => {
    it('shows the keys payload for send', () => {
      const invocation = buildInvocation({
        action: 'send',
        session_id: 'bg_1',
        keys: 'DROP TABLE users;',
        enter: true,
      });
      const description = invocation.getDescription();
      expect(description).toContain('bg_1');
      expect(description).toContain('DROP TABLE users;');
      expect(description).toContain('+Enter');
    });
  });
});

describe.skipIf(process.platform === 'win32')('TmuxTool', () => {
  let tmpDir: string;
  let registry: BackgroundShellRegistry;
  let mockConfig: Config;
  let tool: TmuxTool;

  const buildInvocation = (params: TmuxToolParams) => {
    const invocation = tool.build(params);
    return invocation;
  };

  const createSession = async (
    params: Partial<TmuxToolParams> = {},
  ): Promise<{ sessionId: string; llmContent: string }> => {
    const invocation = buildInvocation({
      action: 'create',
      command: 'repl.sh',
      ...params,
    });
    const result = await invocation.execute(new AbortController().signal);
    const match = /session_id: (bg_[0-9a-f]+)/.exec(
      result.llmContent as string,
    );
    expect(match).not.toBeNull();
    return { sessionId: match![1]!, llmContent: result.llmContent as string };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-tool-test-'));
    registry = new BackgroundShellRegistry();
    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getBackgroundShellRegistry: vi.fn().mockReturnValue(registry),
      getSandbox: vi.fn().mockReturnValue(undefined),
      getWorkspaceContext: vi.fn().mockReturnValue({
        isPathWithinWorkspace: vi.fn().mockReturnValue(true),
      }),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tmpDir),
      },
    } as unknown as Config;
    tool = new TmuxTool(mockConfig);

    mockTmux.verifyTmux.mockResolvedValue(undefined);
    mockTmux.tmuxNewSession.mockResolvedValue(undefined);
    mockTmux.tmuxGetFirstPaneId.mockResolvedValue('%1');
    mockTmux.tmuxSetOption.mockResolvedValue(undefined);
    mockTmux.tmuxRespawnPane.mockResolvedValue(undefined);
    mockTmux.tmuxPipePane.mockResolvedValue(undefined);
    mockTmux.tmuxSendKeys.mockResolvedValue(undefined);
    mockTmux.tmuxCapturePaneContent.mockResolvedValue('screen text\n');
    mockTmux.tmuxKillSession.mockResolvedValue(undefined);
    mockTmux.tmuxListPanes.mockResolvedValue([
      { paneId: '%1', dead: false, deadStatus: 0 },
    ]);
    mockTmux.tmuxHasSession.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a tmux session and registers a shell task with terminal metadata', async () => {
      const { sessionId } = await createSession({ cwd: '/work' });

      expect(mockTmux.verifyTmux).toHaveBeenCalled();
      expect(mockTmux.tmuxNewSession).toHaveBeenCalledWith(
        `qsh-${sessionId}`,
        { cols: 200, rows: 50 },
        TMUX_SERVER_NAME,
      );
      // remain-on-exit + pipe must be in place before the command starts
      expect(mockTmux.tmuxSetOption).toHaveBeenCalledWith(
        '%1',
        'remain-on-exit',
        'on',
        TMUX_SERVER_NAME,
      );
      const setOptionOrder =
        mockTmux.tmuxSetOption.mock.invocationCallOrder[0]!;
      const pipeOrder = mockTmux.tmuxPipePane.mock.invocationCallOrder[0]!;
      const respawnOrder =
        mockTmux.tmuxRespawnPane.mock.invocationCallOrder[0]!;
      // remain-on-exit AND the pipe must be in place before the command
      // starts, or the exit status / early output is lost.
      expect(setOptionOrder).toBeLessThan(respawnOrder);
      expect(pipeOrder).toBeLessThan(respawnOrder);
      expect(mockTmux.tmuxRespawnPane).toHaveBeenCalledWith(
        '%1',
        `cd '/work' && repl.sh`,
        TMUX_SERVER_NAME,
      );

      const entry = registry.get(sessionId);
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe('shell');
      expect(entry!.status).toBe('running');
      expect(entry!.terminal).toEqual({
        socket: TMUX_SERVER_NAME,
        tmuxSession: `qsh-${sessionId}`,
        paneId: '%1',
      });
      // Output file materialized next to the status sidecar
      expect(fs.existsSync(entry!.outputFile)).toBe(true);
      // pipe-pane streams into the output file
      expect(mockTmux.tmuxPipePane).toHaveBeenCalledWith(
        '%1',
        expect.stringContaining(entry!.outputFile.replace(/'/g, `'\\''`)),
        TMUX_SERVER_NAME,
      );
    });

    it('defaults the working directory to the project root', async () => {
      await createSession();
      expect(mockTmux.tmuxRespawnPane).toHaveBeenCalledWith(
        '%1',
        `cd '/test/dir' && repl.sh`,
        TMUX_SERVER_NAME,
      );
    });

    it('shell-quotes a cwd containing single quotes', async () => {
      await createSession({ cwd: "/work/it's here" });
      expect(mockTmux.tmuxRespawnPane).toHaveBeenCalledWith(
        '%1',
        `cd '/work/it'\\''s here' && repl.sh`,
        TMUX_SERVER_NAME,
      );
    });

    it('clamps oversized cols/rows to the daemon dimension cap', async () => {
      await createSession({ cols: 5000, rows: 5000 });
      expect(mockTmux.tmuxNewSession).toHaveBeenCalledWith(
        expect.any(String),
        { cols: 500, rows: 500 },
        TMUX_SERVER_NAME,
      );
    });

    it('cleans up the tmux session and output file when setup fails midway', async () => {
      mockTmux.tmuxRespawnPane.mockRejectedValue(new Error('boom'));
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Failed to create tmux session/);
      expect(result.error?.message).toMatch(/Failed to create tmux session/);
      expect(mockTmux.tmuxKillSession).toHaveBeenCalled();
      expect(registry.getAll()).toHaveLength(0);
      // no orphaned output file in the session's background-shells dir
      const shellDir = path.join(tmpDir, 'background-shells', 'test-session');
      if (fs.existsSync(shellDir)) {
        expect(fs.readdirSync(shellDir)).toHaveLength(0);
      }
    });

    it('fails fast when the tool sandbox is active', async () => {
      vi.mocked(mockConfig.getSandbox).mockReturnValue({
        command: 'docker',
      } as never);
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/sandbox/);
      expect(mockTmux.tmuxNewSession).not.toHaveBeenCalled();
    });

    it('probes the tracked pane, not the session, when polling status', async () => {
      const { sessionId } = await createSession();
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('running');
      expect(mockTmux.tmuxListPanes).toHaveBeenCalledWith(
        '%1',
        TMUX_SERVER_NAME,
      );
    });

    it('settles the task completed when the pane exits 0 and reclaims the session', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxListPanes.mockResolvedValue([
        { paneId: '%1', dead: true, deadStatus: 0 },
      ]);
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('completed');
      expect(registry.get(sessionId)!.exitCode).toBe(0);
      // remain-on-exit keeps the session alive past the status read; the
      // poller must reclaim it so natural exits don't leak sessions.
      expect(mockTmux.tmuxKillSession).toHaveBeenCalledWith(
        `qsh-${sessionId}`,
        TMUX_SERVER_NAME,
      );
    });

    it('settles the task failed with the pane exit status', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxListPanes.mockResolvedValue([
        { paneId: '%1', dead: true, deadStatus: 3 },
      ]);
      await vi.advanceTimersByTimeAsync(600);
      const entry = registry.get(sessionId)!;
      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('Exit code 3');
    });

    it('settles the task failed when the pane reports no exit status', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxListPanes.mockResolvedValue([
        { paneId: '%1', dead: true, deadStatus: undefined },
      ]);
      await vi.advanceTimersByTimeAsync(600);
      const entry = registry.get(sessionId)!;
      expect(entry.status).toBe('failed');
      expect(entry.error).toMatch(/without reporting a status/);
    });

    it('survives transient probe failures and settles only after repeated ones', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxListPanes
        .mockRejectedValueOnce(new Error('spawn tmux EAGAIN'))
        .mockRejectedValueOnce(new Error('spawn tmux EAGAIN'))
        .mockResolvedValue([{ paneId: '%1', dead: false, deadStatus: 0 }]);
      await vi.advanceTimersByTimeAsync(600 * 3);
      expect(registry.get(sessionId)!.status).toBe('running');

      mockTmux.tmuxListPanes.mockRejectedValue(new Error('gone'));
      await vi.advanceTimersByTimeAsync(600 * 3);
      expect(registry.get(sessionId)!.status).toBe('failed');
      expect(registry.get(sessionId)!.error).toBe(
        'tmux session ended unexpectedly',
      );
    });

    it('kills the tmux session when the task is cancelled externally', async () => {
      const { sessionId } = await createSession();
      registry.requestCancel(sessionId);
      expect(mockTmux.tmuxKillSession).toHaveBeenCalledWith(
        `qsh-${sessionId}`,
        TMUX_SERVER_NAME,
      );
      mockTmux.tmuxListPanes.mockRejectedValue(new Error("can't find session"));
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('cancelled');
    });

    it('does not kill the tmux session when the create call signal is aborted later', async () => {
      const ac = new AbortController();
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      await invocation.execute(ac.signal);
      // The entry owns a decoupled AbortController; the terminal must
      // survive the model abandoning the tool call.
      ac.abort();
      await vi.advanceTimersByTimeAsync(600);
      expect(mockTmux.tmuxKillSession).not.toHaveBeenCalled();
      expect(registry.getAll()).toHaveLength(1);
    });
  });

  describe('send', () => {
    it('sends keys with enter', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'send',
        session_id: sessionId,
        keys: 'hello',
        enter: true,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Keys sent/);
      expect(mockTmux.tmuxSendKeys).toHaveBeenCalledWith(
        '%1',
        'hello',
        { literal: undefined, enter: true },
        TMUX_SERVER_NAME,
      );
    });

    it('sends keys without Enter when enter is not requested', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'send',
        session_id: sessionId,
        keys: 'plain text',
      });
      await invocation.execute(new AbortController().signal);
      expect(mockTmux.tmuxSendKeys).toHaveBeenCalledTimes(1);
      expect(mockTmux.tmuxSendKeys).toHaveBeenCalledWith(
        '%1',
        'plain text',
        { literal: undefined, enter: undefined },
        TMUX_SERVER_NAME,
      );
    });

    it('sends literal keys and Enter as two calls', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'send',
        session_id: sessionId,
        keys: 'C-c',
        literal: true,
        enter: true,
      });
      await invocation.execute(new AbortController().signal);
      expect(mockTmux.tmuxSendKeys).toHaveBeenNthCalledWith(
        1,
        '%1',
        'C-c',
        { literal: true },
        TMUX_SERVER_NAME,
      );
      expect(mockTmux.tmuxSendKeys).toHaveBeenNthCalledWith(
        2,
        '%1',
        'Enter',
        {},
        TMUX_SERVER_NAME,
      );
    });

    it('rejects sending to an unknown or non-terminal task', async () => {
      const invocation = buildInvocation({
        action: 'send',
        session_id: 'bg_00000000',
        keys: 'x',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/No terminal session/);
    });

    it('rejects sending to a registered plain shell task', async () => {
      registry.register({
        shellId: 'bg_plain01',
        command: 'sleep 10',
        cwd: '/test/dir',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputPath: path.join(tmpDir, 'shell-bg_plain01.output'),
      });
      const invocation = buildInvocation({
        action: 'send',
        session_id: 'bg_plain01',
        keys: 'x',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/No terminal session/);
    });

    it('rejects sending to a settled session', async () => {
      const { sessionId } = await createSession();
      registry.complete(sessionId, 0, Date.now());
      const invocation = buildInvocation({
        action: 'send',
        session_id: sessionId,
        keys: 'x',
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/completed/);
    });
  });

  describe('capture', () => {
    it('returns the pane screen without escape codes', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toBe('screen text');
      expect(mockTmux.tmuxCapturePaneContent).toHaveBeenCalledWith(
        '%1',
        TMUX_SERVER_NAME,
        { includeEscapeCodes: false },
      );
    });

    it('passes scrollback lines and clamps them', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
        lines: 500,
      });
      await invocation.execute(new AbortController().signal);
      expect(mockTmux.tmuxCapturePaneContent).toHaveBeenLastCalledWith(
        '%1',
        TMUX_SERVER_NAME,
        { includeEscapeCodes: false, scrollbackLines: 500 },
      );

      const huge = buildInvocation({
        action: 'capture',
        session_id: sessionId,
        lines: 10_000,
      });
      await huge.execute(new AbortController().signal);
      expect(mockTmux.tmuxCapturePaneContent).toHaveBeenLastCalledWith(
        '%1',
        TMUX_SERVER_NAME,
        { includeEscapeCodes: false, scrollbackLines: 2000 },
      );
    });

    it('reports an empty screen explicitly', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxCapturePaneContent.mockResolvedValue('   \n  ');
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/terminal screen is empty/i);
    });

    it('reports a vanished tmux session as a clean error', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxCapturePaneContent.mockRejectedValue(
        new Error("can't find session"),
      );
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Failed to capture/);
      expect(result.error?.message).toMatch(/Failed to capture/);
    });
  });

  describe('list', () => {
    it('lists only terminal-backed tasks', async () => {
      const { sessionId } = await createSession();
      // A plain background shell (no terminal metadata) must not appear.
      registry.register({
        shellId: 'bg_plain01',
        command: 'sleep 10',
        cwd: '/test/dir',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputPath: path.join(tmpDir, 'shell-bg_plain01.output'),
      });
      const invocation = buildInvocation({ action: 'list' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toContain(sessionId);
      expect(result.llmContent).not.toContain('bg_plain01');
    });

    it('reports when there are no terminal sessions', async () => {
      const invocation = buildInvocation({ action: 'list' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toBe('No terminal sessions.');
    });
  });

  describe('kill', () => {
    it('kills the tmux session and settles the entry as cancelled', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'kill',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/killed/);
      expect(mockTmux.tmuxKillSession).toHaveBeenCalledWith(
        `qsh-${sessionId}`,
        TMUX_SERVER_NAME,
      );
      mockTmux.tmuxListPanes.mockRejectedValue(new Error("can't find session"));
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('cancelled');
    });

    it('surfaces a failed kill and leaves the entry retryable', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxKillSession.mockRejectedValue(new Error('server lost'));
      const invocation = buildInvocation({
        action: 'kill',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Failed to kill terminal/);
      expect(result.error?.message).toMatch(/Failed to kill terminal/);
      expect(registry.get(sessionId)!.status).toBe('running');
    });

    it('errors when the session is already settled', async () => {
      const { sessionId } = await createSession();
      registry.complete(sessionId, 0, Date.now());
      const invocation = buildInvocation({
        action: 'kill',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/already completed/);
    });
  });
});
