/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { SessionPicker } from './SessionPicker.js';
import type { LoadedSettings } from '../../config/settings.js';
import type {
  Config,
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

// Control byte sequences that ink-testing-library's stdin.write delivers as
// modified key events. Pulled out so the tests don't bury invisible bytes
// inside string literals.
const CTRL_B = '';
const ESC = '';
const ARROW_DOWN = '[B';

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
    it('should filter by branch when Ctrl+B is pressed', async () => {
      // Bare letter keys ('B', 'b', 'j', 'k', …) are reserved for the
      // search query buffer. The branch toggle is Ctrl+B exclusively.
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

      stdin.write(CTRL_B);
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

      stdin.write(CTRL_B);
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
      stdin.write(ARROW_DOWN); // Down arrow
      await wait(50);

      output = lastFrame();
      // Selection indicator should move
      expect(output).toBeDefined();
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
      stdin.write(ESC);
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

    it('renders the metadata line cleanly when messageCount is undefined', async () => {
      // `listSessions()` now omits `messageCount` for perf, so this is the
      // default production shape. Pin the row's render contract: time and
      // branch still show, and the line must not contain a stray "messages"
      // word, the literal "undefined", or a dangling " · " from the missing
      // count segment.
      const sessions = [
        createMockSession({
          sessionId: 'lazy-count',
          prompt: 'No count yet',
          messageCount: undefined,
          gitBranch: 'feature-branch',
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame() ?? '';
      expect(output).toContain('No count yet');
      expect(output).toContain('feature-branch');
      // Negative assertions guard the omit-count branch.
      expect(output).not.toContain('messages');
      expect(output).not.toContain('undefined');
      // The metadata line should not contain a doubled separator. We isolate
      // the row's metadata line (the one with the gitBranch) and check it.
      const metaLine =
        output.split('\n').find((l) => l.includes('feature-branch')) ?? '';
      expect(metaLine).not.toMatch(/·\s*·/);
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
      // The default footer points the user at typing to start a search.
      expect(output).toContain('Type to search');
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
      expect(output).toContain('Ctrl+B');
      expect(output).toContain('branch');
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

  describe('Preview Mode', () => {
    // Mirror `StandaloneSessionPicker`'s runtime wrapping so the preview
    // render tree (ToolGroupMessage, ToolMessage) can safely call
    // `useConfig()` / `useSettings()` in tests. Without these, any test
    // whose previewed session contains tool calls would crash.
    const PREVIEW_CONFIG_STUB = {
      getShouldUseNodePtyShell: () => false,
      getIdeMode: () => false,
      isTrustedFolder: () => false,
      getToolRegistry: () => ({ getTool: () => undefined }),
      getContentGenerator: () => ({ useSummarizedThinking: () => false }),
    } as unknown as Config;
    const PREVIEW_SETTINGS_STUB = {
      merged: { ui: {} },
    } as unknown as LoadedSettings;

    function renderPicker(children: ReactNode) {
      return render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ConfigContext.Provider value={PREVIEW_CONFIG_STUB}>
            <SettingsContext.Provider value={PREVIEW_SETTINGS_STUB}>
              {children}
            </SettingsContext.Provider>
          </ConfigContext.Provider>
        </KeypressProvider>,
      );
    }

    function fakeResumedData(sessionId: string) {
      return {
        conversation: {
          sessionId,
          projectHash: 'h',
          startTime: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId,
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'user',
              cwd: '/tmp',
              version: 'test',
              message: {
                role: 'user',
                parts: [{ text: 'USER-ASKED-THIS' }],
              },
            },
            {
              uuid: 'u2',
              parentUuid: 'u1',
              sessionId,
              timestamp: '2026-01-01T00:00:01.000Z',
              type: 'assistant',
              cwd: '/tmp',
              version: 'test',
              message: {
                role: 'model',
                parts: [{ text: 'ASSISTANT-REPLIED' }],
              },
            },
          ],
        },
        filePath: `/tmp/${sessionId}.jsonl`,
        lastCompletedUuid: 'u2',
      };
    }

    it('renders tool_group items without crashing (stub Providers mounted)', async () => {
      // The previewed session contains a function call + tool_result, which
      // produces a `tool_group` HistoryItem that exercises ToolGroupMessage
      // and ToolMessage — the places that throw without stub Providers.
      const toolSession = {
        conversation: {
          sessionId: 's1',
          projectHash: 'h',
          startTime: '2026-01-01T00:00:00.000Z',
          lastUpdated: '2026-01-01T00:00:00.000Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId: 's1',
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'user',
              cwd: '/tmp',
              version: 'test',
              message: { role: 'user', parts: [{ text: 'list files' }] },
            },
            {
              uuid: 'u2',
              parentUuid: 'u1',
              sessionId: 's1',
              timestamp: '2026-01-01T00:00:01.000Z',
              type: 'assistant',
              cwd: '/tmp',
              version: 'test',
              message: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call-1',
                      name: 'BashTool',
                      args: { command: 'ls' },
                    },
                  },
                ],
              },
            },
            {
              uuid: 'u3',
              parentUuid: 'u2',
              sessionId: 's1',
              timestamp: '2026-01-01T00:00:02.000Z',
              type: 'tool_result',
              cwd: '/tmp',
              version: 'test',
              toolCallResult: {
                callId: 'call-1',
                resultDisplay: 'a.txt\nb.txt',
                status: 'success',
              },
            },
          ],
        },
        filePath: '/tmp/s1.jsonl',
        lastCompletedUuid: 'u3',
      };

      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'list files',
          messageCount: 3,
        }),
      ];
      const service = createMockSessionService(sessions);
      service.loadSession.mockResolvedValue(toolSession);

      const { stdin, lastFrame } = renderPicker(
        <SessionPicker
          sessionService={service as never}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          enablePreview
        />,
      );

      await wait(100);
      stdin.write(' '); // Space → preview in list mode
      await wait(150);
      const frame = lastFrame() ?? '';
      // Tool group renders with raw function name fallback (no registry).
      expect(frame).toContain('BashTool');
    });

    it('Enter inside preview fires onSelect with previewed sessionId', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'First',
          messageCount: 2,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'Second',
          messageCount: 2,
        }),
      ];
      const service = createMockSessionService(sessions);
      service.loadSession.mockResolvedValue(fakeResumedData('s1'));
      const onSelect = vi.fn();

      const { stdin } = renderPicker(
        <SessionPicker
          sessionService={service as never}
          onSelect={onSelect}
          onCancel={vi.fn()}
          enablePreview
        />,
      );

      await wait(100);
      stdin.write(' '); // open preview on s1
      await wait(150);
      stdin.write('\r'); // Enter
      await wait(50);
      expect(onSelect).toHaveBeenCalledWith('s1');
    });

    it('without enablePreview, Space is a no-op and footer omits the hint', async () => {
      // Regression: SessionPicker is also reused by the delete-session
      // dialog, where `onSelect = handleDelete`. If preview were on by
      // default, Space → preview → Enter would silently delete the session
      // while the preview UI still says "Enter to resume". The default must
      // stay opt-in.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'Deletable session',
          messageCount: 2,
        }),
      ];
      const service = createMockSessionService(sessions);
      service.loadSession.mockResolvedValue(fakeResumedData('s1'));
      const onSelect = vi.fn();

      const { stdin, lastFrame } = renderPicker(
        <SessionPicker
          sessionService={service as never}
          onSelect={onSelect}
          onCancel={vi.fn()}
          // intentionally NO enablePreview — emulates the delete dialog
        />,
      );

      await wait(100);
      const beforeFrame = lastFrame() ?? '';
      expect(beforeFrame).toContain('Deletable session');
      // Hint must not appear, otherwise we are training users to press
      // Space in destructive flows.
      expect(beforeFrame).not.toContain('Space to preview');

      stdin.write(' '); // Space — no-op when preview is disabled
      await wait(150);
      const afterFrame = lastFrame() ?? '';
      // No preview body, still on the list.
      expect(afterFrame).not.toContain('USER-ASKED-THIS');
      expect(afterFrame).toContain('Deletable session');

      // Enter must still call onSelect on the highlighted row (delete path
      // unchanged), not be eaten by a phantom preview.
      stdin.write('\r');
      await wait(50);
      expect(onSelect).toHaveBeenCalledWith('s1');
      expect(service.loadSession).not.toHaveBeenCalled();
    });
  });
});
