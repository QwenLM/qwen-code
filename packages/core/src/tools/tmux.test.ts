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

describe('TmuxTool', () => {
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

    it('exposes per-action permission rules in confirmation details', async () => {
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
      if (details.type === 'exec') {
        expect(details.permissionRules).toEqual(['Tmux(create)']);
      }
    });

    it('forwards action, command and keys to the AUTO classifier', () => {
      const input = tool.toAutoClassifierInput({
        action: 'send',
        session_id: 'bg_1',
        keys: 'rm -rf /',
      });
      expect(input).toEqual({ action: 'send', keys: 'rm -rf /' });
    });
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
      const pipeOrder = mockTmux.tmuxPipePane.mock.invocationCallOrder[0]!;
      const respawnOrder =
        mockTmux.tmuxRespawnPane.mock.invocationCallOrder[0]!;
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

    it('cleans up the tmux session when setup fails midway', async () => {
      mockTmux.tmuxRespawnPane.mockRejectedValue(new Error('boom'));
      const invocation = buildInvocation({ action: 'create', command: 'x' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Failed to create tmux session/);
      expect(mockTmux.tmuxKillSession).toHaveBeenCalled();
      expect(registry.getAll()).toHaveLength(0);
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

    it('settles the task completed when the pane exits 0', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxListPanes.mockResolvedValue([
        { paneId: '%1', dead: true, deadStatus: 0 },
      ]);
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('completed');
      expect(registry.get(sessionId)!.exitCode).toBe(0);
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

    it('kills the tmux session when the task is cancelled externally', async () => {
      const { sessionId } = await createSession();
      registry.requestCancel(sessionId);
      expect(mockTmux.tmuxKillSession).toHaveBeenCalledWith(
        `qsh-${sessionId}`,
        TMUX_SERVER_NAME,
      );
      mockTmux.tmuxHasSession.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('cancelled');
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

    it('passes scrollback lines', async () => {
      const { sessionId } = await createSession();
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
        lines: 500,
      });
      await invocation.execute(new AbortController().signal);
      expect(mockTmux.tmuxCapturePaneContent).toHaveBeenCalledWith(
        '%1',
        TMUX_SERVER_NAME,
        { includeEscapeCodes: false, scrollbackLines: 500 },
      );
    });

    it('reports a vanished tmux session as a clean error', async () => {
      const { sessionId } = await createSession();
      mockTmux.tmuxGetFirstPaneId.mockRejectedValue(
        new Error("can't find session"),
      );
      const invocation = buildInvocation({
        action: 'capture',
        session_id: sessionId,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/Failed to capture/);
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
    it('requests cancellation, which kills the tmux session', async () => {
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
      mockTmux.tmuxHasSession.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(registry.get(sessionId)!.status).toBe('cancelled');
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
