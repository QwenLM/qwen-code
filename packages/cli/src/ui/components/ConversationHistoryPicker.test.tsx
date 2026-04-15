/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ConversationHistoryPicker } from './ConversationHistoryPicker.js';

const { buildRewindEntries } = vi.hoisted(() => ({
  buildRewindEntries: vi.fn(),
}));

vi.mock('../utils/rewindUtils.js', () => ({
  buildRewindEntries,
}));

const mockTerminalSize = { columns: 80, rows: 24 };

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', {
    value: mockTerminalSize.columns,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'rows', {
    value: mockTerminalSize.rows,
    configurable: true,
  });
  buildRewindEntries.mockResolvedValue([
    {
      key: 'u1',
      kind: 'node',
      label: 'hi',
      timestamp: '2025-01-01T00:00:00.000Z',
      node: {
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        prompt: 'hi',
      },
      codeSummary: {
        hasChanges: false,
        summaryText: 'No code changes',
        detailText: 'The code will be unchanged.',
        changes: [],
      },
    },
    {
      key: 'u2',
      kind: 'node',
      label: 'how are you?',
      timestamp: '2025-01-01T00:01:00.000Z',
      node: {
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:01:00.000Z',
        prompt: 'how are you?',
      },
      codeSummary: {
        hasChanges: true,
        summaryText: 'test.py +5 -0',
        detailText: 'The code will be restored +5 -0 in test.py.',
        changes: [{ path: 'test.py', additions: 5, deletions: 0 }],
        checkpointCommitHash: 'snapshot-1',
      },
    },
    {
      key: 'current',
      kind: 'current',
      label: '(current)',
      codeSummary: {
        hasChanges: false,
        summaryText: 'No code changes',
        detailText: 'The code will be unchanged.',
        changes: [],
      },
    },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConversationHistoryPicker', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
  const config = {} as import('@qwen-code/qwen-code-core').Config;

  it('renders rewind entries and defaults to current', async () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ConversationHistoryPicker
          config={config}
          sessionId="session-1"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />
      </KeypressProvider>,
    );

    await wait(100);

    const output = lastFrame();
    expect(output).toContain('Rewind');
    expect(output).toContain('hi');
    expect(output).toContain('how are you?');
    expect(output).toContain('(current)');
    expect(output).toContain('test.py +5 -0');
    expect(output).toContain('› (current)');
  });

  it('selects the highlighted entry on Enter', async () => {
    const onSelect = vi.fn();

    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ConversationHistoryPicker
          config={config}
          sessionId="session-1"
          onSelect={onSelect}
          onCancel={vi.fn()}
        />
      </KeypressProvider>,
    );

    await wait(100);

    stdin.write('\u001B[A');
    await wait(20);
    stdin.write('\r');
    await wait(20);

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'u2',
        label: 'how are you?',
      }),
    );
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();

    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ConversationHistoryPicker
          config={config}
          sessionId="session-1"
          onSelect={vi.fn()}
          onCancel={onCancel}
        />
      </KeypressProvider>,
    );

    await wait(100);

    stdin.write('\u001B');
    await wait(20);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
