/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryService } from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { RewindSelector } from './RewindSelector.js';

vi.mock('../hooks/useKeypress.js');
vi.mock('../hooks/useTerminalSize.js');

let activeKeypressHandler: KeypressHandler | null = null;

const createKey = (overrides: Partial<Key>): Key => ({
  name: '',
  sequence: '',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  ...overrides,
});

const pressKey = (overrides: Partial<Key>) => {
  if (!activeKeypressHandler) {
    throw new Error('No active keypress handler');
  }
  const handler = activeKeypressHandler;
  act(() => {
    handler(createKey(overrides));
  });
};

// Two microtask yields are intentional: Ink 7 + React 19 split a render
// pass across two ticks (one to flush state updates into the reconciler,
// a second for the resulting effects to settle). A single Promise.resolve
// drains only the first tick and produces flaky assertions on slow CI.
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const userTurn = (
  id: number,
  text: string,
  promptId?: string,
): HistoryItem => ({
  id,
  type: 'user',
  text,
  promptId,
});

describe('RewindSelector', () => {
  let fileHistoryService: FileHistoryService;

  beforeEach(() => {
    activeKeypressHandler = null;
    fileHistoryService = new FileHistoryService('test-session', false, '/tmp');
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 100, rows: 30 });
    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        activeKeypressHandler = handler;
      }
    });
  });

  it('navigates the pick list with Ctrl+P/N readline aliases', () => {
    const { lastFrame } = render(
      <RewindSelector
        history={[userTurn(1, 'first prompt'), userTurn(2, 'second prompt')]}
        onRewind={vi.fn()}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={false}
        fileHistoryService={fileHistoryService}
      />,
    );

    expect(lastFrame()).toContain('› #2 second prompt');

    pressKey({ name: 'p', sequence: '\u0010', ctrl: true });
    expect(lastFrame()).toContain('› #1 first prompt');

    pressKey({ name: 'n', sequence: '\u000E', ctrl: true });
    expect(lastFrame()).toContain('› #2 second prompt');
  });

  it('navigates the pick list with arrow keys and cancels with Escape', () => {
    const onCancel = vi.fn();

    const { lastFrame } = render(
      <RewindSelector
        history={[userTurn(1, 'first prompt'), userTurn(2, 'second prompt')]}
        onRewind={vi.fn()}
        onCancel={onCancel}
        fileCheckpointingEnabled={false}
        fileHistoryService={fileHistoryService}
      />,
    );

    expect(lastFrame()).toContain('› #2 second prompt');

    pressKey({ name: 'up' });
    expect(lastFrame()).toContain('› #1 first prompt');

    pressKey({ name: 'down' });
    expect(lastFrame()).toContain('› #2 second prompt');

    pressKey({ name: 'escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders restore options with diff stats for the selected turn', async () => {
    vi.spyOn(fileHistoryService, 'getDiffStats').mockResolvedValue({
      filesChanged: ['src/foo.ts', 'src/bar.ts'],
      insertions: 3,
      deletions: 1,
    });

    const { lastFrame } = render(
      <RewindSelector
        history={[
          userTurn(1, 'first prompt', 'prompt-1'),
          userTurn(2, 'second prompt', 'prompt-2'),
        ]}
        onRewind={vi.fn()}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={true}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });
    await flush();

    expect(fileHistoryService.getDiffStats).toHaveBeenCalledWith('prompt-2');
    expect(lastFrame()).toContain('Restore code and conversation');
    expect(lastFrame()).toContain('(+3 -1 in 2 files)');
    expect(lastFrame()).toContain('Restore conversation only');
    expect(lastFrame()).toContain('Restore code only');
    expect(lastFrame()).toContain('Never mind');
  });

  it('returns from restore options to the pick list on Escape', async () => {
    vi.spyOn(fileHistoryService, 'getDiffStats').mockResolvedValue({
      filesChanged: ['src/foo.ts'],
      insertions: 2,
      deletions: 0,
    });

    const { lastFrame } = render(
      <RewindSelector
        history={[
          userTurn(1, 'first prompt', 'prompt-1'),
          userTurn(2, 'second prompt', 'prompt-2'),
        ]}
        onRewind={vi.fn()}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={true}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });
    await flush();
    expect(lastFrame()).toContain('Restore conversation only');

    pressKey({ name: 'escape' });

    expect(lastFrame()).toContain('› #2 second prompt');
    expect(lastFrame()).not.toContain('Restore conversation only');
  });

  it('falls back to conversation-only options when diff stats fail', async () => {
    vi.spyOn(fileHistoryService, 'getDiffStats').mockRejectedValue(
      new Error('diff unavailable'),
    );

    const { lastFrame } = render(
      <RewindSelector
        history={[
          userTurn(1, 'first prompt', 'prompt-1'),
          userTurn(2, 'second prompt', 'prompt-2'),
        ]}
        onRewind={vi.fn()}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={true}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });
    await flush();

    expect(fileHistoryService.getDiffStats).toHaveBeenCalledWith('prompt-2');
    expect(lastFrame()).toContain('Restore conversation only');
    expect(lastFrame()).toContain('Never mind');
    expect(lastFrame()).toContain('File restore is unavailable for this turn');
    expect(lastFrame()).not.toContain('Restore code and conversation');
    expect(lastFrame()).not.toContain('Restore code only');
  });

  it('does not request diff stats when the selected turn has no prompt id', async () => {
    vi.spyOn(fileHistoryService, 'getDiffStats').mockResolvedValue({
      filesChanged: ['src/foo.ts'],
      insertions: 2,
      deletions: 0,
    });

    const { lastFrame } = render(
      <RewindSelector
        history={[userTurn(1, 'first prompt'), userTurn(2, 'second prompt')]}
        onRewind={vi.fn()}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={true}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });
    await flush();

    expect(fileHistoryService.getDiffStats).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Restore conversation only');
    expect(lastFrame()).toContain('Never mind');
    expect(lastFrame()).toContain('File restore is unavailable for this turn');
    expect(lastFrame()).not.toContain('Restore code and conversation');
    expect(lastFrame()).not.toContain('Restore code only');
  });

  it('confirms a conversation-only rewind when checkpointing is disabled', () => {
    const onRewind = vi.fn();

    const { lastFrame } = render(
      <RewindSelector
        history={[userTurn(1, 'first prompt'), userTurn(2, 'second prompt')]}
        onRewind={onRewind}
        onCancel={vi.fn()}
        fileCheckpointingEnabled={false}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });

    expect(lastFrame()).toContain(
      'This will remove all conversation after this turn.',
    );

    pressKey({ sequence: 'y' });

    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'conversation',
    );
  });

  it.each([
    ['n', { sequence: 'n' }],
    ['Escape', { name: 'escape' }],
  ] as const)(
    'returns to the pick list when legacy confirm receives %s',
    (_label, key) => {
      const onRewind = vi.fn();

      const { lastFrame } = render(
        <RewindSelector
          history={[userTurn(1, 'first prompt'), userTurn(2, 'second prompt')]}
          onRewind={onRewind}
          onCancel={vi.fn()}
          fileCheckpointingEnabled={false}
          fileHistoryService={fileHistoryService}
        />,
      );

      pressKey({ name: 'return' });
      expect(lastFrame()).toContain(
        'This will remove all conversation after this turn.',
      );

      pressKey(key);

      expect(onRewind).not.toHaveBeenCalled();
      expect(lastFrame()).toContain('› #2 second prompt');
      expect(lastFrame()).not.toContain(
        'This will remove all conversation after this turn.',
      );
    },
  );

  it('blocks restore-option keypresses while rewind is pending', async () => {
    vi.spyOn(fileHistoryService, 'getDiffStats').mockResolvedValue({
      filesChanged: ['src/foo.ts'],
      insertions: 2,
      deletions: 0,
    });
    const onCancel = vi.fn();
    let resolveRewind: (() => void) | undefined;
    const onRewind = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRewind = resolve;
        }),
    );

    const { lastFrame } = render(
      <RewindSelector
        history={[
          userTurn(1, 'first prompt', 'prompt-1'),
          userTurn(2, 'second prompt', 'prompt-2'),
        ]}
        onRewind={onRewind}
        onCancel={onCancel}
        fileCheckpointingEnabled={true}
        fileHistoryService={fileHistoryService}
      />,
    );

    pressKey({ name: 'return' });
    await flush();

    pressKey({ name: 'return' });
    await flush();

    expect(onRewind).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'both',
    );
    expect(lastFrame()).toContain('Restoring...');

    pressKey({ name: 'escape' });

    expect(onCancel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Restoring...');

    resolveRewind!();
    await flush();
  });
});
