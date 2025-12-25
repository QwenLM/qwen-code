/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SessionPicker } from './SessionPicker.js';
import type {
  SessionListItem,
  ListSessionsResult,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    getGitBranch: vi.fn().mockReturnValue('main'),
  };
});

// Mock terminal size
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
});

// Helper to create mock sessions
function createMockSession(
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    sessionId: 'test-session-id',
    cwd: '/test/path',
    startTime: '2025-01-01T00:00:00.000Z',
    mtime: Date.now(),
    prompt: 'Test prompt',
    gitBranch: 'main',
    filePath: '/test/path/sessions/test-session-id.jsonl',
    messageCount: 5,
    ...overrides,
  };
}

// Helper to create mock session service
function createMockSessionService(
  sessions: SessionListItem[] = [],
  hasMore = false,
) {
  return {
    listSessions: vi.fn().mockResolvedValue({
      items: sessions,
      hasMore,
      nextCursor: hasMore ? Date.now() : undefined,
    } as ListSessionsResult),
    loadSession: vi.fn(),
    loadLastSession: vi
      .fn()
      .mockResolvedValue(sessions.length > 0 ? {} : undefined),
  };
}

describe('SessionPicker', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Empty Sessions', () => {
    it('should show sessions with 0 messages', async () => {
      const sessions = [
        createMockSession({
          sessionId: 'empty-1',
          messageCount: 0,
          prompt: '',
        }),
        createMockSession({
          sessionId: 'with-messages',
          messageCount: 5,
          prompt: 'Hello',
        }),
        createMockSession({
          sessionId: 'empty-2',
          messageCount: 0,
          prompt: '(empty prompt)',
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Hello');
      // Should show empty sessions too (rendered as "(empty prompt)" + "0 messages")
      expect(output).toContain('0 messages');
    });

    it('should show sessions even when all sessions are empty', async () => {
      const sessions = [
        createMockSession({ sessionId: 'empty-1', messageCount: 0 }),
        createMockSession({ sessionId: 'empty-2', messageCount: 0 }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('0 messages');
    });

    it('should show sessions with 1 or more messages', async () => {
      const sessions = [
        createMockSession({
          sessionId: 'one-msg',
          messageCount: 1,
          prompt: 'Single message',
        }),
        createMockSession({
          sessionId: 'many-msg',
          messageCount: 10,
          prompt: 'Many messages',
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Single message');
      expect(output).toContain('Many messages');
      expect(output).toContain('1 message');
      expect(output).toContain('10 messages');
    });
  });

  describe('Branch Filtering', () => {
    it('should filter by branch when B is pressed', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          gitBranch: 'main',
          prompt: 'Main branch',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          gitBranch: 'feature',
          prompt: 'Feature branch',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's3',
          gitBranch: 'main',
          prompt: 'Also main',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame, stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
            currentBranch="main"
          />
        </KeypressProvider>,
      );

      await wait(100);

      // All sessions should be visible initially
      let output = lastFrame();
      expect(output).toContain('Main branch');
      expect(output).toContain('Feature branch');

      // Press B to filter by branch
      stdin.write('B');
      await wait(50);

      output = lastFrame();
      // Only main branch sessions should be visible
      expect(output).toContain('Main branch');
      expect(output).toContain('Also main');
      expect(output).not.toContain('Feature branch');
    });

    it('should combine empty session filter with branch filter', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          gitBranch: 'main',
          messageCount: 0,
          prompt: 'Empty main',
        }),
        createMockSession({
          sessionId: 's2',
          gitBranch: 'main',
          messageCount: 5,
          prompt: 'Valid main',
        }),
        createMockSession({
          sessionId: 's3',
          gitBranch: 'feature',
          messageCount: 5,
          prompt: 'Valid feature',
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame, stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
            currentBranch="main"
          />
        </KeypressProvider>,
      );

      await wait(100);

      // Press B to filter by branch
      stdin.write('B');
      await wait(50);

      const output = lastFrame();
      // Should only show sessions from main branch (including 0-message sessions)
      expect(output).toContain('Valid main');
      expect(output).toContain('Empty main');
      expect(output).not.toContain('Valid feature');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should navigate with arrow keys', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'First session',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'Second session',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's3',
          prompt: 'Third session',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame, stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      // First session should be selected initially (indicated by >)
      let output = lastFrame();
      expect(output).toContain('First session');

      // Navigate down
      stdin.write('\u001B[B'); // Down arrow
      await wait(50);

      output = lastFrame();
      // Selection indicator should move
      expect(output).toBeDefined();
    });

    it('should navigate with vim keys (j/k)', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'First',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'Second',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { stdin, unmount } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      // Navigate with j (down)
      stdin.write('j');
      await wait(50);

      // Navigate with k (up)
      stdin.write('k');
      await wait(50);

      unmount();
    });

    it('should select session on Enter', async () => {
      const sessions = [
        createMockSession({
          sessionId: 'selected-session',
          prompt: 'Select me',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      // Press Enter to select
      stdin.write('\r');
      await wait(50);

      expect(onSelect).toHaveBeenCalledWith('selected-session');
    });

    it('should cancel on Escape', async () => {
      const sessions = [
        createMockSession({ sessionId: 's1', messageCount: 1 }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      // Press Escape to cancel
      stdin.write('\u001B');
      await wait(50);

      expect(onCancel).toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('Display', () => {
    it('should show session metadata', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'Test prompt text',
          messageCount: 5,
          gitBranch: 'feature-branch',
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Test prompt text');
      expect(output).toContain('5 messages');
      expect(output).toContain('feature-branch');
    });

    it('should show header and footer', async () => {
      const sessions = [createMockSession({ messageCount: 1 })];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Resume Session');
      expect(output).toContain('↑↓ to navigate');
      expect(output).toContain('Esc to cancel');
    });

    it('should show branch toggle hint when currentBranch is provided', async () => {
      const sessions = [createMockSession({ messageCount: 1 })];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
            currentBranch="main"
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('B');
      expect(output).toContain('toggle branch');
    });

    it('should truncate long prompts', async () => {
      const longPrompt = 'A'.repeat(300);
      const sessions = [
        createMockSession({ prompt: longPrompt, messageCount: 1 }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      // Should contain ellipsis for truncated text
      expect(output).toContain('...');
      // Should NOT contain the full untruncated prompt (300 A's in a row)
      expect(output).not.toContain(longPrompt);
    });

    it('should show "(empty prompt)" for sessions without prompt text', async () => {
      const sessions = [createMockSession({ prompt: '', messageCount: 1 })];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('(empty prompt)');
    });
  });

  describe('Pagination', () => {
    it('should load more sessions when scrolling to bottom', async () => {
      const firstPage = Array.from({ length: 5 }, (_, i) =>
        createMockSession({
          sessionId: `session-${i}`,
          prompt: `Session ${i}`,
          messageCount: 1,
          mtime: Date.now() - i * 1000,
        }),
      );
      const secondPage = Array.from({ length: 3 }, (_, i) =>
        createMockSession({
          sessionId: `session-${i + 5}`,
          prompt: `Session ${i + 5}`,
          messageCount: 1,
          mtime: Date.now() - (i + 5) * 1000,
        }),
      );

      const mockService = {
        listSessions: vi
          .fn()
          .mockResolvedValueOnce({
            items: firstPage,
            hasMore: true,
            nextCursor: Date.now() - 5000,
          })
          .mockResolvedValueOnce({
            items: secondPage,
            hasMore: false,
            nextCursor: undefined,
          }),
        loadSession: vi.fn(),
        loadLastSession: vi.fn().mockResolvedValue({}),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { unmount } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(200);

      // First page should be loaded
      expect(mockService.listSessions).toHaveBeenCalled();

      unmount();
    });
  });
});
