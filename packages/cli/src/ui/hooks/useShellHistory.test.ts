/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook, act, waitFor } from '@testing-library/react';
import { useShellHistory } from './useShellHistory.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Storage } from '@qwen-code/qwen-code-core';
import { appendShellHistoryFile } from '../../utils/shell-history-file.js';
import {
  _resetCleanupFunctionsForTest,
  runExitCleanup,
} from '../../utils/cleanup.js';

const testDoubles = vi.hoisted(() => ({
  realAppend: undefined as typeof appendShellHistoryFile | undefined,
  error: vi.fn(),
}));

vi.mock('../../utils/shell-history-file.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/shell-history-file.js')>();
  testDoubles.realAppend = actual.appendShellHistoryFile;
  return {
    ...actual,
    appendShellHistoryFile: vi.fn(actual.appendShellHistoryFile),
  };
});

vi.mock('@qwen-code/qwen-code-core', () => ({
  isNodeError: (err: unknown): err is NodeJS.ErrnoException =>
    typeof err === 'object' && err !== null && 'code' in err,
  createDebugLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: testDoubles.error,
  }),
  Storage: class {},
}));

const PROJECT_ROOT = '/test/project';
let historyFilePath: string;
let historyStorage: Storage;
let scratchDir: string;

function useTestShellHistory() {
  return useShellHistory(PROJECT_ROOT, historyStorage);
}

async function readPersistedHistory(): Promise<string[]> {
  return JSON.parse(await fs.readFile(historyFilePath, 'utf8')) as string[];
}

async function expectPersistedHistory(expected: string[]) {
  await waitFor(async () => {
    expect(await readPersistedHistory()).toEqual(expected);
  });
}

describe('useShellHistory', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCleanupFunctionsForTest();
    scratchDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-tui-shell-history-'),
    );
    historyFilePath = path.join(scratchDir, 'shell_history');
    historyStorage = {
      getHistoryFilePath: () => historyFilePath,
    } as unknown as Storage;
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  it('should initialize and read the history file from the correct path', async () => {
    await fs.writeFile(historyFilePath, 'cmd1\ncmd2');
    const { result } = renderHook(() => useTestShellHistory());

    await waitFor(() => {
      expect(result.current.history).toEqual(['cmd2', 'cmd1']);
    });

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });

    // History is loaded newest-first: ['cmd2', 'cmd1']
    expect(command).toBe('cmd2');
  });

  it('should handle a nonexistent history file gracefully', async () => {
    const existingFile = path.join(scratchDir, 'existing-history');
    await fs.writeFile(existingFile, 'existing');
    const existingStorage = {
      getHistoryFilePath: () => existingFile,
    } as unknown as Storage;
    const { result, rerender } = renderHook(
      ({ storage }) => useShellHistory(PROJECT_ROOT, storage),
      { initialProps: { storage: existingStorage } },
    );
    await waitFor(() => expect(result.current.history).toEqual(['existing']));

    rerender({ storage: historyStorage });
    await waitFor(() => expect(result.current.history).toEqual([]));

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });

    expect(command).toBe(null);
    await expect(fs.access(historyFilePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes rapid additions on the real write path', async () => {
    await fs.writeFile(historyFilePath, 'seed');
    const append = vi.mocked(appendShellHistoryFile);
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    append.mockImplementationOnce(async (file, command) => {
      await firstWaiting;
      return testDoubles.realAppend!(file, command);
    });
    const { result } = renderHook(() => useTestShellHistory());
    await waitFor(() => expect(result.current.history).toEqual(['seed']));

    act(() => result.current.addCommandToHistory('first'));
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    act(() => result.current.addCommandToHistory('second'));
    try {
      expect(append).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      await waitFor(() => expect(append).toHaveBeenCalledTimes(2));
      await Promise.allSettled(append.mock.results.map((entry) => entry.value));
    }
    await expectPersistedHistory(['seed', 'first', 'second']);
  });

  it('does not block a different file while one append is pending', async () => {
    await fs.writeFile(historyFilePath, 'seed-a');
    const otherFile = path.join(scratchDir, 'other_history');
    await fs.writeFile(otherFile, 'seed-b');
    const otherStorage = {
      getHistoryFilePath: () => otherFile,
    } as unknown as Storage;
    const append = vi.mocked(appendShellHistoryFile);
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    append.mockImplementationOnce(async (file, command) => {
      await firstWaiting;
      return testDoubles.realAppend!(file, command);
    });
    const { result, rerender, unmount } = renderHook(
      ({ storage }: { storage: Storage }) =>
        useShellHistory(PROJECT_ROOT, storage),
      { initialProps: { storage: historyStorage } },
    );
    await waitFor(() => expect(result.current.history).toEqual(['seed-a']));
    try {
      act(() => result.current.addCommandToHistory('first-a'));
      await waitFor(() => expect(append).toHaveBeenCalledOnce());

      rerender({ storage: otherStorage });
      await waitFor(() => expect(result.current.history).toEqual(['seed-b']));
      act(() => result.current.addCommandToHistory('second-b'));
      await waitFor(async () => {
        expect(JSON.parse(await fs.readFile(otherFile, 'utf8'))).toEqual([
          'seed-b',
          'second-b',
        ]);
      });
    } finally {
      releaseFirst();
      unmount();
    }
    await expectPersistedHistory(['seed-a', 'first-a']);
  });

  it('logs asynchronous append failures without an unhandled rejection', async () => {
    await fs.writeFile(historyFilePath, 'ordinary file');
    historyFilePath = path.join(historyFilePath, 'shell_history');
    const { result } = renderHook(() => useTestShellHistory());
    await waitFor(() =>
      expect(testDoubles.error).toHaveBeenCalledWith(
        'Error reading history:',
        expect.any(Error),
      ),
    );

    act(() => result.current.addCommandToHistory('cannot persist'));
    await waitFor(() =>
      expect(testDoubles.error).toHaveBeenCalledWith(
        'Error writing shell history:',
        expect.any(Error),
      ),
    );
  });

  it('drains queued writes during exit even after the hook unmounts', async () => {
    await fs.writeFile(historyFilePath, 'seed');
    const append = vi.mocked(appendShellHistoryFile);
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    append.mockImplementationOnce(async (file, command) => {
      await firstWaiting;
      return testDoubles.realAppend!(file, command);
    });
    const { result, unmount } = renderHook(() => useTestShellHistory());
    await waitFor(() => expect(result.current.history).toEqual(['seed']));
    act(() => result.current.addCommandToHistory('before exit'));
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    unmount();

    let completed = false;
    const cleanup = runExitCleanup({
      _testPerFnTimeoutMs: 50,
      _testOverallTimeoutMs: 200,
    }).then(() => {
      completed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
    } finally {
      releaseFirst();
      await cleanup;
    }
    await expect(readPersistedHistory()).resolves.toEqual([
      'seed',
      'before exit',
    ]);
  });

  it('drains a second file appended while exit cleanup is running', async () => {
    const firstFile = historyFilePath;
    const secondFile = path.join(scratchDir, 'second-shell-history');
    await fs.writeFile(firstFile, 'seed-a');
    await fs.writeFile(secondFile, 'seed-b');
    const append = vi.mocked(appendShellHistoryFile);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondWaiting = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    append
      .mockImplementationOnce(async (file, command) => {
        await firstWaiting;
        return testDoubles.realAppend!(file, command);
      })
      .mockImplementationOnce(async (file, command) => {
        await secondWaiting;
        return testDoubles.realAppend!(file, command);
      });
    const first = renderHook(() => useTestShellHistory());
    await waitFor(() =>
      expect(first.result.current.history).toEqual(['seed-a']),
    );
    act(() => first.result.current.addCommandToHistory('command-a'));
    await waitFor(() => expect(append).toHaveBeenCalledOnce());
    first.unmount();

    let completed = false;
    const cleanup = runExitCleanup({
      _testPerFnTimeoutMs: 1000,
      _testOverallTimeoutMs: 2000,
    }).then(() => {
      completed = true;
    });
    try {
      historyFilePath = secondFile;
      const second = renderHook(() => useTestShellHistory());
      await waitFor(() =>
        expect(second.result.current.history).toEqual(['seed-b']),
      );
      act(() => second.result.current.addCommandToHistory('command-b'));
      await waitFor(() => expect(append).toHaveBeenCalledTimes(2));

      releaseFirst();
      await append.mock.results[0]!.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      releaseSecond();
      await cleanup;
      second.unmount();
    } finally {
      releaseFirst();
      releaseSecond();
      await cleanup;
    }
    expect(JSON.parse(await fs.readFile(firstFile, 'utf8'))).toEqual([
      'seed-a',
      'command-a',
    ]);
    expect(JSON.parse(await fs.readFile(secondFile, 'utf8'))).toEqual([
      'seed-b',
      'command-b',
    ]);
  });

  it('should add a command and write to the history file', async () => {
    await fs.writeFile(historyFilePath, 'existing');
    const { result } = renderHook(() => useTestShellHistory());

    await waitFor(() => expect(result.current.history).toEqual(['existing']));

    act(() => {
      result.current.addCommandToHistory('new_command');
    });

    await expectPersistedHistory(['existing', 'new_command']);

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('new_command');
  });

  it('should preserve multi-line commands after reloading history', async () => {
    const multiLineCommand = 'for f in a b; do\n  echo "$f"\ndone';
    await fs.writeFile(historyFilePath, 'existing');

    const { result, unmount } = renderHook(() => useTestShellHistory());
    await waitFor(() => expect(result.current.history).toEqual(['existing']));

    act(() => {
      result.current.addCommandToHistory(multiLineCommand);
    });

    await expectPersistedHistory(['existing', multiLineCommand]);
    unmount();

    const { result: reloaded } = renderHook(() => useTestShellHistory());
    await waitFor(() =>
      expect(reloaded.current.history).toEqual([multiLineCommand, 'existing']),
    );

    let command: string | null = null;
    act(() => {
      command = reloaded.current.getPreviousCommand();
    });
    expect(command).toBe(multiLineCommand);
  });

  it('should load JSON history files in newest-first order', async () => {
    await fs.writeFile(historyFilePath, JSON.stringify(['cmd1', 'cmd2']));
    const { result } = renderHook(() => useTestShellHistory());

    await waitFor(() =>
      expect(result.current.history).toEqual(['cmd2', 'cmd1']),
    );

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd2');

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd1');
  });

  it('should navigate history correctly with previous/next commands', async () => {
    await fs.writeFile(historyFilePath, 'cmd1\ncmd2\ncmd3');
    const { result } = renderHook(() => useTestShellHistory());

    // Wait for history to be loaded: ['cmd3', 'cmd2', 'cmd1']
    await waitFor(() =>
      expect(result.current.history).toEqual(['cmd3', 'cmd2', 'cmd1']),
    );

    let command: string | null = null;

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd3');

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd2');

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd1');

    // Should stay at the oldest command
    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd1');

    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('cmd2');

    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('cmd3');

    // Should return to the "new command" line (represented as empty string)
    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('');
  });

  it('should not add empty or whitespace-only commands to history', async () => {
    await fs.writeFile(historyFilePath, 'existing');
    const { result } = renderHook(() => useTestShellHistory());
    await waitFor(() => expect(result.current.history).toEqual(['existing']));

    act(() => {
      result.current.addCommandToHistory('   ');
      result.current.addCommandToHistory('sentinel');
    });

    await expectPersistedHistory(['existing', 'sentinel']);
  });

  it('should truncate history to MAX_HISTORY_LENGTH (100)', async () => {
    const oldCommands = Array.from({ length: 120 }, (_, i) => `old_cmd_${i}`);
    await fs.writeFile(historyFilePath, oldCommands.join('\n'));

    const { result } = renderHook(() => useTestShellHistory());
    await waitFor(() => expect(result.current.history).toHaveLength(120));

    act(() => {
      result.current.addCommandToHistory('new_cmd');
    });

    await waitFor(() => expect(result.current.history).toHaveLength(100));
    await expectPersistedHistory([...oldCommands.slice(21), 'new_cmd']);
  });

  it('should move an existing command to the top when re-added', async () => {
    await fs.writeFile(historyFilePath, 'cmd1\ncmd2\ncmd3');
    const { result } = renderHook(() => useTestShellHistory());

    // Initial state: ['cmd3', 'cmd2', 'cmd1']
    await waitFor(() =>
      expect(result.current.history).toEqual(['cmd3', 'cmd2', 'cmd1']),
    );

    act(() => {
      result.current.addCommandToHistory('cmd1');
    });

    await expectPersistedHistory(['cmd2', 'cmd3', 'cmd1']);
    expect(result.current.history).toEqual(['cmd1', 'cmd3', 'cmd2']);
  });
});
