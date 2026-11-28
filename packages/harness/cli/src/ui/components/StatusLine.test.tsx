/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, StatusLineCommandInput } from '@qwen-code/core';
import { emptySnapshotSource } from '../../../../core/src/test-utils/listed-model.js';

const executeStatusLineCommand = vi.fn(async () => 'rendered status');
let c4RepoStatus: {
  tags: string[];
  status: string;
  soft_status: string;
} | null = null;

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    executeStatusLineCommand,
    getC4RepoService: () => ({
      getC4RepoStatus: () => c4RepoStatus,
      getMergedC4RepoStatusSync: () => c4RepoStatus,
    }),
  };
});

const { renderWithProviders, cleanup } = await import(
  '../../test-utils/render.js'
);
const { createMockConfig, createMockSettings } = await import(
  '../../test-utils/mockConfig.js'
);
const { UIStateContext, useUIState } = await import(
  '../contexts/UIStateContext.js'
);
const { StatusLine } = await import('./StatusLine.js');
const { StatusLineDataContext } = await import(
  '../contexts/StatusLineDataContext.js'
);
// Read the setup agent's promised field list straight from core so the two
// cannot drift: a field documented there but not wired up here is exactly the
// defect this test exists to prevent.
const { StatusLineSetupAgent } = await import(
  '../../../../core/src/agents/builtin/statusline-setup-agent.js'
);

import type { UIState } from '../contexts/UIStateContext.js';
import type { HistoryItem } from '../types.js';

const COMMAND = 'echo hello';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return createMockConfig({
    getModelProviderManager: emptySnapshotSource.getModelProviderManager,
    getSessionId: vi.fn(() => 'sess-1'),
    getModelRequestIdentity: vi.fn().mockReturnValue({ sessionId: 'sess-1' }),
    getTargetDir: vi.fn(() => '/work'),
    getProjectRoot: vi.fn(() => '/work'),
    getActiveSessionTranscriptPath: vi.fn(() => '/work/sess-1.jsonl'),
    getCliVersion: vi.fn(() => '9.9.9'),
    getSessionAgent: vi.fn(() => undefined),
    getPermissionMode: vi.fn(() => 'acceptEdits'),
    getEffectiveContextWindow: vi.fn(() => 1000),
    getWorktreeSettings: vi.fn(() => undefined),
    isAllHooksDisabled: vi.fn(() => false),
    getWorkspaceContext: vi.fn(() => ({
      getDirectories: () => ['/work', '/other'],
    })),
    topicState: { getTopic: () => 'Refactor the parser' },
    ...overrides,
  } as unknown as Partial<Config>);
}

function assistantMessage(id: number): HistoryItem {
  return { id, type: 'gemini', text: `reply ${id}` } as HistoryItem;
}

/** `renderWithProviders`' base UI state carries no session stats. */
const SESSION_STATS = {
  sessionId: 'sess-1',
  sessionStartTime: new Date(0),
  lastPromptTokenCount: 100,
  promptCount: 1,
  stats: {
    files: { totalLinesAdded: 3, totalLinesRemoved: 1 },
    models: {
      ultimate: { tokens: { prompt: 500, candidates: 250 } },
    },
  },
};

/**
 * Wraps StatusLine in its own UIState provider so a test can push new UIState
 * identities — `renderWithProviders`' own `rerender` reuses the UIState it
 * captured on first render.
 */
const Harness: React.FC<{ patch: Partial<UIState> }> = ({ patch }) => {
  const base = useUIState();
  const value = useMemo(
    () =>
      ({
        ...base,
        sessionStats: SESSION_STATS,
        currentModel: 'ultimate',
        ...patch,
      }) as unknown as UIState,
    [base, patch],
  );
  return (
    <UIStateContext.Provider value={value}>
      <StatusLine />
    </UIStateContext.Provider>
  );
};

/** The payload of the most recent status line execution. */
function lastInput(): StatusLineCommandInput {
  const calls = executeStatusLineCommand.mock.calls as unknown as Array<
    [unknown, StatusLineCommandInput]
  >;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1];
}

/** Recursively collect every key present in an emitted payload. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) keysOf(child, into);
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    keysOf(child, into);
  }
  return into;
}

/** Every field name the `/statusline` setup agent promises to scripts. */
function promisedFieldNames(): string[] {
  const prompt = (
    StatusLineSetupAgent as (context: unknown) => {
      promptConfig: { systemPrompt: string };
    }
  )({ config: { getDefaultShellToolName: () => 'Bash' } }).promptConfig
    .systemPrompt;
  const start = prompt.indexOf('receive the following JSON input via stdin');
  const end = prompt.indexOf('You can use this JSON data in your command');
  return [
    ...new Set(
      [...prompt.slice(start, end).matchAll(/"([a-z_]+)"\s*:/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

describe('StatusLine', () => {
  beforeEach(() => {
    executeStatusLineCommand.mockClear();
    c4RepoStatus = null;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('refresh triggers', () => {
    it('refreshes when additional data changes, but not for equal values', async () => {
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const view = (message: string, revision: number) => (
        <StatusLineDataContext.Provider
          value={{
            fingerprint: JSON.stringify({ message, revision }),
            buildInput: (input) => ({
              ...input,
              session_name: `${message}-${revision}`,
            }),
          }}
        >
          <Harness patch={{ history: [] }} />
        </StatusLineDataContext.Provider>
      );
      const { rerender, waitUntilReady } = await renderWithProviders(
        view('first', 1),
        { settings, config: makeConfig() },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );
      executeStatusLineCommand.mockClear();

      // A polling result with the same values must not spawn another process.
      rerender(view('first', 1));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(executeStatusLineCommand).not.toHaveBeenCalled();

      // Product data can change without another assistant message.
      rerender(view('next', 1));
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalledTimes(1),
      );
      expect(lastInput().session_name).toBe('next-1');
      executeStatusLineCommand.mockClear();

      rerender(view('next', 2));
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalledTimes(1),
      );
      expect(lastInput().session_name).toBe('next-2');
      executeStatusLineCommand.mockClear();

      // Removing the transformation restores the public input.
      rerender(
        <StatusLineDataContext.Provider value={undefined}>
          <Harness patch={{ history: [] }} />
        </StatusLineDataContext.Provider>,
      );
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalledTimes(1),
      );
      expect(lastInput().session_name).toBe('Refactor the parser');
    });

    it('does not re-execute the command when unrelated UI state churns', async () => {
      // Regression guard: `doUpdate` used to depend on the whole `uiState`
      // object, which changes at least once a second. That gave the effect
      // watching `doUpdate` a new identity every render and spawned the user's
      // shell command per render, bypassing the 300ms debounce entirely.
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const { rerender, waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [] }} />,
        { settings, config: makeConfig() },
      );
      await waitUntilReady();

      const afterMount = executeStatusLineCommand.mock.calls.length;

      for (let tick = 1; tick <= 20; tick++) {
        rerender(<Harness patch={{ history: [], elapsedTime: tick }} />);
      }
      await waitUntilReady();

      expect(executeStatusLineCommand.mock.calls.length).toBe(afterMount);
    });

    it('re-executes when the permission mode changes', async () => {
      // The payload carries permission_mode so scripts can show "you are in
      // bypassPermissions". Without a trigger of its own it would keep showing
      // the previous mode until the next assistant message.
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const { rerender, waitUntilReady } = await renderWithProviders(
        <Harness patch={{ showPermissionModeIndicator: 'default' }} />,
        { settings, config: makeConfig() },
      );
      await waitUntilReady();
      executeStatusLineCommand.mockClear();

      rerender(<Harness patch={{ showPermissionModeIndicator: 'yolo' }} />);
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalledTimes(1),
      );
    });

    it('re-executes once when the assistant produces a new message', async () => {
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const { rerender, waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [] }} />,
        { settings, config: makeConfig() },
      );
      await waitUntilReady();
      executeStatusLineCommand.mockClear();

      const history = [assistantMessage(1)];
      rerender(<Harness patch={{ history }} />);
      // Re-render a few more times with the same history — the debounce must
      // collapse these into the single update the new message earned.
      for (let tick = 1; tick <= 5; tick++) {
        rerender(<Harness patch={{ history, elapsedTime: tick }} />);
      }
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalledTimes(1),
      );
    });
  });

  describe('rendering', () => {
    it('renders each output line on its own row', async () => {
      // Ink's `truncate` wrap measures the whole string as a single line, so
      // rendering multi-line output through one <Text> collapsed everything
      // into one truncated row and line 2+ was never visible.
      executeStatusLineCommand.mockResolvedValueOnce('first line\nsecond line');
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const { waitUntilReady, lastFrame } = await renderWithProviders(
        <Harness patch={{ history: [] }} />,
        { settings, config: makeConfig() },
      );
      await waitUntilReady();
      await vi.waitFor(() => {
        const frame = lastFrame({ allowEmpty: true });
        expect(frame).toContain('first line');
        expect(frame).toContain('second line');
      });
    });
  });

  describe('disableAllHooks', () => {
    it('gates rendering and execution on the same predicate', async () => {
      // If the render gate and the execution gate disagree, the component keeps
      // the custom branch (which has no output to show) while `doUpdate` bails
      // out — an empty status line rather than the intended fallback. Config's
      // `isAllHooksDisabled()` is a broader flag that is also true when the
      // hooks subsystem is off, so it must NOT be what gates the status line.
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const config = makeConfig({
        isAllHooksDisabled: vi.fn(() => true),
      } as unknown as Partial<Config>);

      const { waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [assistantMessage(1)] }} />,
        { settings, config },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );
    });

    it('never spawns the command and falls back to the default status line', async () => {
      const settings = createMockSettings({
        merged: {
          statusLine: { type: 'command', command: COMMAND },
          disableAllHooks: true,
        },
      });
      const { rerender, waitUntilReady, lastFrame } = await renderWithProviders(
        <Harness patch={{ history: [] }} />,
        {
          settings,
          config: makeConfig(),
        },
      );
      const disabledFrame = lastFrame({ allowEmpty: true });

      rerender(<Harness patch={{ history: [assistantMessage(1)] }} />);
      await waitUntilReady();

      expect(executeStatusLineCommand).not.toHaveBeenCalled();
      cleanup();

      // Falling back to the built-in bar keeps a working status line with no
      // subprocess, rather than leaving a blank row — so the rendered output
      // must match a session that has no statusLine configured at all.
      const { lastFrame: unconfiguredFrame } = await renderWithProviders(
        <Harness patch={{ history: [] }} />,
        {
          settings: createMockSettings(),
          config: makeConfig(),
        },
      );
      expect(disabledFrame).toBe(unconfiguredFrame({ allowEmpty: true }));
    });
  });

  describe('injected payload', () => {
    it('populates every field the setup agent promises', async () => {
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const config = makeConfig({
        getSessionAgent: vi.fn(() => 'reviewer'),
      } as unknown as Partial<Config>);
      const { waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [assistantMessage(1)] }} />,
        { settings, config },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );

      const input = lastInput();
      // session_id must come from the same source as transcript_path. Core's
      // module-level `sessionId` constant is fixed at import time and goes
      // stale after a resume or /clear, which would hand scripts a payload
      // whose two session identifiers disagree.
      expect(input.session_id).toBe('sess-1');
      expect(input.transcript_path).toContain('sess-1');
      expect(input.session_name).toBe('Refactor the parser');
      expect(input.permission_mode).toBe('acceptEdits');
      expect(input.version).toBe('9.9.9');
      expect(input.workspace.added_dirs).toEqual(['/work', '/other']);
      expect(input.agent).toEqual({ name: 'reviewer' });
      // `total_input_tokens` is the current context occupancy, not a session
      // total, so it tracks lastPromptTokenCount rather than the cumulative
      // per-model stats. `total_output_tokens` is intentionally not emitted.
      expect(input.context_window?.total_input_tokens).toBe(100);
      expect(input.context_window?.total_output_tokens).toBeUndefined();
    });

    it('reports the originating project as project_dir inside a worktree', async () => {
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const config = makeConfig({
        getTargetDir: vi.fn(() => '/work/.worktrees/feature'),
        getProjectRoot: vi.fn(() => '/work/.worktrees/feature'),
        getActiveSessionTranscriptPath: vi.fn(
          () => '/work/projects/sess-1.jsonl',
        ),
        getWorktreeSettings: vi.fn(() => ({
          name: 'feature',
          path: '/work/.worktrees/feature',
          baseSha: 'abc',
          originalCwd: '/work',
          worktreeBranch: 'feature',
          originalBranch: 'main',
        })),
      } as unknown as Partial<Config>);
      const { waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [assistantMessage(1)] }} />,
        { settings, config },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );

      const input = lastInput();
      expect(input.workspace.current_dir).toBe('/work/.worktrees/feature');
      expect(input.workspace.project_dir).toBe('/work');
      expect(input.transcript_path).toBe('/work/projects/sess-1.jsonl');
      expect(input.worktree).toEqual({
        name: 'feature',
        path: '/work/.worktrees/feature',
        branch: 'feature',
        original_cwd: '/work',
        original_branch: 'main',
      });
    });

    it('emits every field the setup agent promises when all sources have values', async () => {
      // This is the regression guard for the original defect: the setup agent's
      // prompt promised session_name / added_dirs / version / agent / worktree,
      // the builder supported all of them, and only this call site failed to
      // pass them — so scripts the wizard wrote rendered blank segments.
      // Checking the prompt against the *builder* would not have caught that;
      // it has to be checked against what this component sends. This is also
      // what keeps `total_output_tokens` out of the prompt now that it is no
      // longer emitted.
      c4RepoStatus = {
        tags: ['C4'],
        status: 'STILLA_ENABLED',
        soft_status: 'C4',
      };

      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const config = makeConfig({
        getTargetDir: vi.fn(() => '/work/.worktrees/feature'),
        getSessionAgent: vi.fn(() => 'reviewer'),
        getWorktreeSettings: vi.fn(() => ({
          name: 'feature',
          path: '/work/.worktrees/feature',
          baseSha: 'abc',
          originalCwd: '/work',
          worktreeBranch: 'feature',
          originalBranch: 'main',
        })),
      } as unknown as Partial<Config>);

      const { waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [assistantMessage(1)] }} />,
        { settings, config },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );
      expect(lastInput().cost).toEqual({
        total_lines_added: 3,
        total_lines_removed: 1,
      });

      const emitted = keysOf(lastInput());
      const promisedButMissing = promisedFieldNames().filter(
        (name) => !emitted.has(name),
      );
      expect(promisedButMissing).toEqual([]);
    });

    it('omits the optional blocks whose sources are empty', async () => {
      const settings = createMockSettings({
        merged: { statusLine: { type: 'command', command: COMMAND } },
      });
      const config = makeConfig({
        getSessionAgent: vi.fn(() => undefined),
        topicState: { getTopic: () => undefined },
        getWorkspaceContext: vi.fn(() => ({ getDirectories: () => [] })),
      } as unknown as Partial<Config>);
      const { waitUntilReady } = await renderWithProviders(
        <Harness patch={{ history: [assistantMessage(1)] }} />,
        { settings, config },
      );
      await waitUntilReady();
      await vi.waitFor(() =>
        expect(executeStatusLineCommand).toHaveBeenCalled(),
      );

      const input = lastInput();
      expect(input).not.toHaveProperty('session_name');
      expect(input).not.toHaveProperty('agent');
      expect(input).not.toHaveProperty('worktree');
      expect(input.workspace).not.toHaveProperty('added_dirs');
    });
  });
});
