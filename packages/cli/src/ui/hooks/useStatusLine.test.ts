/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as child_process from 'child_process';

// --- Mock child_process (auto-mock, then override exec in beforeEach) ---
vi.mock('child_process');

// --- Mock context hooks ---

const mockSettings = {
  merged: {} as Record<string, unknown>,
};
vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: () => mockSettings,
}));

const mockUIState = {
  sessionStats: {
    sessionId: 'test-session',
    lastPromptTokenCount: 100,
    metrics: {
      models: {},
      tools: { totalCalls: 0 },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    },
  },
  currentModel: 'test-model',
  branchName: 'main' as string | undefined,
};
vi.mock('../contexts/UIStateContext.js', () => ({
  useUIState: () => mockUIState,
}));

const mockConfig = {
  getTargetDir: vi.fn(() => '/test/dir'),
  getModel: vi.fn(() => 'test-model'),
  getCliVersion: vi.fn(() => '1.0.0'),
  getContentGeneratorConfig: vi.fn(() => ({ contextWindowSize: 131072 })),
};
vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => mockConfig,
}));

const mockVimMode = {
  vimEnabled: false,
  vimMode: 'INSERT' as string,
};
vi.mock('../contexts/VimModeContext.js', () => ({
  useVimMode: () => mockVimMode,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    createDebugLogger: () => ({
      log: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// --- exec mock state ---

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

let execCallback: ExecCallback;
let lastExecCommand: string | undefined;
let stdinWrittenData: string;
let stdinErrorHandler: ((err: Error) => void) | undefined;
let mockKill: ReturnType<typeof vi.fn>;

function setStatusLineConfig(
  config: { type: string; command: string } | undefined,
) {
  mockSettings.merged = config ? { ui: { statusLine: config } } : {};
}

describe('useStatusLine', () => {
  // Must import dynamically after mocks are set up
  let useStatusLine: typeof import('./useStatusLine.js').useStatusLine;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lastExecCommand = undefined;
    stdinWrittenData = '';
    stdinErrorHandler = undefined;
    mockKill = vi.fn();

    // Set up exec mock implementation
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      _opts: unknown,
      cb: ExecCallback,
    ) => {
      lastExecCommand = cmd;
      execCallback = cb;
      stdinWrittenData = '';
      stdinErrorHandler = undefined;
      return {
        stdin: {
          on: vi.fn((_event: string, handler: (err: Error) => void) => {
            stdinErrorHandler = handler;
          }),
          write: vi.fn((data: string) => {
            stdinWrittenData += data;
            return true;
          }),
          end: vi.fn(),
        },
        kill: mockKill,
        killed: false,
      };
    }) as unknown as typeof child_process.exec);

    // Reset mutable mock state
    setStatusLineConfig(undefined);
    mockUIState.sessionStats.lastPromptTokenCount = 100;
    mockUIState.currentModel = 'test-model';
    mockUIState.branchName = 'main';
    mockUIState.sessionStats.metrics.tools.totalCalls = 0;
    mockUIState.sessionStats.metrics.files.totalLinesAdded = 0;
    mockUIState.sessionStats.metrics.files.totalLinesRemoved = 0;
    mockVimMode.vimEnabled = false;
    mockVimMode.vimMode = 'INSERT';

    // Dynamic import to get fresh module after mocks
    const mod = await import('./useStatusLine.js');
    useStatusLine = mod.useStatusLine;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- getStatusLineConfig validation (tested through the hook) ---

  describe('config validation', () => {
    it('returns null when no statusLine config is set', () => {
      const { result } = renderHook(() => useStatusLine());
      expect(result.current.text).toBeNull();
      expect(child_process.exec).not.toHaveBeenCalled();
    });

    it('returns null when statusLine type is not "command"', () => {
      setStatusLineConfig({ type: 'invalid', command: 'echo hi' });
      const { result } = renderHook(() => useStatusLine());
      expect(result.current.text).toBeNull();
      expect(child_process.exec).not.toHaveBeenCalled();
    });

    it('returns null when command is empty string', () => {
      setStatusLineConfig({ type: 'command', command: '' });
      const { result } = renderHook(() => useStatusLine());
      expect(result.current.text).toBeNull();
      expect(child_process.exec).not.toHaveBeenCalled();
    });

    it('returns null when command is whitespace only', () => {
      setStatusLineConfig({ type: 'command', command: '   ' });
      const { result } = renderHook(() => useStatusLine());
      expect(result.current.text).toBeNull();
      expect(child_process.exec).not.toHaveBeenCalled();
    });
  });

  // --- Command execution ---

  describe('command execution', () => {
    it('executes configured command on mount', () => {
      setStatusLineConfig({ type: 'command', command: 'echo hello' });
      renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledOnce();
      expect(lastExecCommand).toBe('echo hello');
    });

    it('passes correct options to exec', () => {
      setStatusLineConfig({ type: 'command', command: 'echo hello' });
      renderHook(() => useStatusLine());
      const callArgs = vi.mocked(child_process.exec).mock.calls[0];
      const opts = callArgs[1] as {
        cwd: string;
        timeout: number;
        maxBuffer: number;
      };
      expect(opts.cwd).toBe('/test/dir');
      expect(opts.timeout).toBe(5000);
      expect(opts.maxBuffer).toBe(1024 * 10);
    });

    it('returns stdout as text with trailing newline stripped', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo hello' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, 'hello world\n', '');
      });

      expect(result.current.text).toBe('hello world');
    });

    it('returns all lines when stdout has multiple lines', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo lines' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, 'first line\nsecond line\n', '');
      });

      expect(result.current.text).toBe('first line\nsecond line');
    });

    it('preserves empty lines in multi-line output', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo lines' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, '\nline two\n', '');
      });

      expect(result.current.text).toBe('\nline two');
    });

    it('caps output at 2 lines', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo lines' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, 'line1\nline2\nline3\nline4\n', '');
      });

      expect(result.current.text).toBe('line1\nline2');
    });

    it('returns null when command fails', async () => {
      setStatusLineConfig({ type: 'command', command: 'bad-cmd' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(new Error('command not found'), '', '');
      });

      expect(result.current.text).toBeNull();
    });

    it('returns null when stdout is empty', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo -n' });
      const { result } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, '', '');
      });

      expect(result.current.text).toBeNull();
    });
  });

  // --- stdin JSON input ---

  describe('stdin JSON input', () => {
    it('writes JSON to stdin with session context', () => {
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.session_id).toBe('test-session');
      expect(input.version).toBe('1.0.0');
      expect(input.model.display_name).toBe('test-model');
      expect(input.workspace.current_dir).toBe('/test/dir');
    });

    it('includes git branch when available', () => {
      mockUIState.branchName = 'feature/test';
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.git.branch).toBe('feature/test');
    });

    it('omits git when branchName is falsy', () => {
      mockUIState.branchName = undefined;
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.git).toBeUndefined();
    });

    it('includes vim mode when enabled', () => {
      mockVimMode.vimEnabled = true;
      mockVimMode.vimMode = 'NORMAL';
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.vim.mode).toBe('NORMAL');
    });

    it('omits vim when not enabled', () => {
      mockVimMode.vimEnabled = false;
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.vim).toBeUndefined();
    });

    it('includes context window usage data', () => {
      mockUIState.sessionStats.lastPromptTokenCount = 65536;
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.context_window.context_window_size).toBe(131072);
      expect(input.context_window.used_percentage).toBe(50);
      expect(input.context_window.remaining_percentage).toBe(50);
      expect(input.context_window.current_usage).toBe(65536);
    });

    it('includes per-model metrics and aggregated token counts', () => {
      mockUIState.sessionStats.metrics.models = {
        'test-model': {
          api: { totalRequests: 5, totalErrors: 1, totalLatencyMs: 2000 },
          tokens: {
            prompt: 1000,
            candidates: 500,
            total: 1500,
            cached: 200,
            thoughts: 100,
          },
        },
      } as never;
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.metrics.models['test-model'].api.total_requests).toBe(5);
      expect(input.metrics.models['test-model'].api.total_errors).toBe(1);
      expect(input.metrics.models['test-model'].tokens.prompt).toBe(1000);
      expect(input.metrics.models['test-model'].tokens.completion).toBe(500);
      expect(input.metrics.models['test-model'].tokens.cached).toBe(200);
      expect(input.metrics.models['test-model'].tokens.thoughts).toBe(100);
      expect(input.context_window.total_input_tokens).toBe(1000);
      expect(input.context_window.total_output_tokens).toBe(500);
    });

    it('falls back to zero when contextWindowSize is unavailable', () => {
      mockConfig.getContentGeneratorConfig.mockReturnValueOnce(null as never);
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.context_window.context_window_size).toBe(0);
      expect(input.context_window.used_percentage).toBe(0);
    });

    it('falls back to "unknown" when getCliVersion returns empty', () => {
      mockConfig.getCliVersion.mockReturnValueOnce('');
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.version).toBe('unknown');
    });

    it('falls back to model from config when currentModel is empty', () => {
      mockUIState.currentModel = '';
      setStatusLineConfig({ type: 'command', command: 'cat' });
      renderHook(() => useStatusLine());

      const input = JSON.parse(stdinWrittenData);
      expect(input.model.display_name).toBe('test-model');
    });
  });

  // --- Stale generation handling ---

  describe('stale generation', () => {
    it('ignores callback from stale generation and accepts fresh one', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { result, rerender } = renderHook(() => useStatusLine());

      // Capture first callback
      const firstCallback = execCallback;

      // Trigger a state change to cause re-execution
      mockUIState.currentModel = 'new-model';
      rerender();

      // Advance debounce timer — triggers second exec
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Capture second (current) callback
      const secondCallback = execCallback;

      // Resolve the stale first callback — should be ignored
      await act(async () => {
        firstCallback(null, 'stale output\n', '');
      });
      expect(result.current.text).toBeNull();

      // Resolve the fresh second callback — should be accepted
      await act(async () => {
        secondCallback(null, 'fresh output\n', '');
      });
      expect(result.current.text).toBe('fresh output');
    });
  });

  // --- Debouncing ---

  describe('debouncing', () => {
    it('debounces rapid state changes to a single exec', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());

      // Initial mount exec
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // Rapid state changes
      mockUIState.currentModel = 'model-1';
      rerender();
      mockUIState.currentModel = 'model-2';
      rerender();
      mockUIState.currentModel = 'model-3';
      rerender();

      // Before debounce expires, no additional execs
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // After debounce
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Should have exactly one debounced exec (total 2: mount + debounced)
      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });
  });

  // --- Config removal clears output ---

  describe('config removal', () => {
    it('clears output when config is removed', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo hello' });
      const { result, rerender } = renderHook(() => useStatusLine());

      await act(async () => {
        execCallback(null, 'hello\n', '');
      });
      expect(result.current.text).toBe('hello');

      // Remove config
      setStatusLineConfig(undefined);
      rerender();

      expect(result.current.text).toBeNull();
    });

    it('cancels pending debounce and kills child when config is removed', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo hello' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // Trigger a debounced update (timer is pending)
      mockUIState.currentModel = 'new-model';
      rerender();

      // Remove config before debounce fires
      setStatusLineConfig(undefined);
      rerender();

      expect(mockKill).toHaveBeenCalled();

      // Advancing past debounce should not trigger another exec
      const callsBefore = vi.mocked(child_process.exec).mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(vi.mocked(child_process.exec).mock.calls.length).toBe(callsBefore);
    });
  });

  // --- Cleanup on unmount ---

  describe('cleanup', () => {
    it('kills active child process on unmount', () => {
      setStatusLineConfig({ type: 'command', command: 'sleep 10' });
      const { unmount } = renderHook(() => useStatusLine());

      expect(mockKill).not.toHaveBeenCalled();
      unmount();
      expect(mockKill).toHaveBeenCalled();
    });

    it('clears debounce timer on unmount', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender, unmount } = renderHook(() => useStatusLine());

      // Trigger a debounced update
      mockUIState.currentModel = 'new-model';
      rerender();

      // Unmount before debounce fires
      unmount();

      // Advance past debounce — should not cause additional exec
      const callsBefore = vi.mocked(child_process.exec).mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(vi.mocked(child_process.exec).mock.calls.length).toBe(callsBefore);
    });
  });

  // --- stdin error handling ---

  describe('stdin error handling', () => {
    it('silently handles EPIPE errors', () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      renderHook(() => useStatusLine());

      expect(stdinErrorHandler).toBeDefined();
      const epipeError = new Error('EPIPE') as NodeJS.ErrnoException;
      epipeError.code = 'EPIPE';

      // Should not throw
      expect(() => stdinErrorHandler!(epipeError)).not.toThrow();
    });

    it('logs non-EPIPE stdin errors', () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      renderHook(() => useStatusLine());

      expect(stdinErrorHandler).toBeDefined();
      const otherError = new Error('EIO') as NodeJS.ErrnoException;
      otherError.code = 'EIO';

      // Should not throw but should log (we can't easily check debugLog here,
      // but we verify it doesn't crash)
      expect(() => stdinErrorHandler!(otherError)).not.toThrow();
    });
  });

  // --- Command change triggers immediate re-execution ---

  describe('command change', () => {
    it('re-executes immediately when command changes', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo first' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // Resolve first exec
      await act(async () => {
        execCallback(null, 'first\n', '');
      });

      // Change command
      setStatusLineConfig({ type: 'command', command: 'echo second' });
      rerender();

      // Should re-execute immediately (not debounced)
      expect(child_process.exec).toHaveBeenCalledTimes(2);
      expect(lastExecCommand).toBe('echo second');
    });

    it('cancels pending debounce when command changes', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo first' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // Trigger a debounced update
      mockUIState.currentModel = 'new-model';
      rerender();

      // Change command before debounce fires
      setStatusLineConfig({ type: 'command', command: 'echo second' });
      rerender();

      // Immediate re-exec from command change (mount + command change = 2)
      expect(child_process.exec).toHaveBeenCalledTimes(2);

      // Debounce fires but should not cause a third exec (was cleared)
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });
  });

  // --- State change triggers ---

  describe('state change triggers', () => {
    it('triggers update when prompt token count changes', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      mockUIState.sessionStats.lastPromptTokenCount = 200;
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });

    it('triggers update when branch changes', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      mockUIState.branchName = 'feature/new';
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });

    it('triggers update when tool calls change', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      mockUIState.sessionStats.metrics.tools.totalCalls = 5;
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });

    it('triggers update when vim mode is toggled off', async () => {
      mockVimMode.vimEnabled = true;
      mockVimMode.vimMode = 'NORMAL';
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      // Disable vim — effectiveVim changes from 'NORMAL' to undefined
      mockVimMode.vimEnabled = false;
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });

    it('triggers update when file lines change', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());
      expect(child_process.exec).toHaveBeenCalledTimes(1);

      mockUIState.sessionStats.metrics.files.totalLinesAdded = 50;
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(child_process.exec).toHaveBeenCalledTimes(2);
    });
  });

  // --- Process killed on new update ---

  describe('process management', () => {
    it('kills previous process when starting new execution', async () => {
      setStatusLineConfig({ type: 'command', command: 'echo test' });
      const { rerender } = renderHook(() => useStatusLine());

      const firstKill = mockKill;

      // Trigger re-execution via state change
      mockUIState.currentModel = 'new-model';
      rerender();
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      expect(firstKill).toHaveBeenCalled();
    });
  });
});
