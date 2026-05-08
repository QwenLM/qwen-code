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
const BACKSPACE = '';
const ARROW_DOWN = '[B';
const ARROW_UP = '[A';

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

  describe('Search', () => {
    it('substring filters across customTitle, prompt, and gitBranch', async () => {
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'completely unrelated',
          customTitle: 'login bug investigation',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'review login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's3',
          prompt: 'totally different',
          gitBranch: 'feature/login-revamp',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's4',
          prompt: 'unrelated work',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);

      // '/' enters search explicitly so the query starts fresh and
      // shortcut letters in the term (none here) don't get reinterpreted.
      stdin.write('/login');
      await wait(50);

      const output = lastFrame() ?? '';
      // s1 matches via customTitle, s2 via prompt, s3 via gitBranch.
      expect(output).toContain('login bug investigation');
      expect(output).toContain('review login flow');
      expect(output).toContain('feature/login-revamp');
      // The non-matching session must drop out.
      expect(output).not.toContain('unrelated work');
      // The visible search row reflects the active query.
      expect(output).toContain('Search:');
    });

    it('typing a non-shortcut char enters search mode implicitly', async () => {
      // Letters that are not list-mode shortcuts (anything other than j,
      // k, b, B, ' ', '/') seed the search query directly.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'deploy review',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          // Picked so it shares no letters with the typed query 'dep'.
          prompt: 'cluster setup',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('dep');
      await wait(50);

      const output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('deploy review');
      expect(output).not.toContain('cluster setup');
    });

    it('list-mode j/k navigate the list', async () => {
      // vim shortcuts stay live in list mode even though the rest of
      // the alphabet seeds search.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'first',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'second',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();

      const { stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('j'); // selectedIndex 0 -> 1
      await wait(30);
      stdin.write('\r');
      await wait(50);
      expect(onSelect).toHaveBeenLastCalledWith('s2');

      stdin.write('k'); // back to 0
      await wait(30);
      stdin.write('\r');
      await wait(50);
      expect(onSelect).toHaveBeenLastCalledWith('s1');
    });

    it("'b' seeds search; once searching, 'j' appends to the query", async () => {
      // Lowercase letters that aren't list-mode shortcuts ('b' here)
      // implicitly enter search. Once in search mode, j and k lose
      // their nav meaning and behave as regular query characters so
      // titles containing 'j' or 'k' can be searched.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'bjorn config',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'bug investigation',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's3',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      // 'b' implicitly enters search. Both s1 and s2 contain 'b'.
      stdin.write('b');
      await wait(30);
      let output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('bjorn config');
      expect(output).toContain('bug investigation');
      expect(output).not.toContain('unrelated');

      // 'j' inside search appends to the query → "bj" — only s1 still
      // matches. If 'j' were still bound to nav we would see the same
      // 'b'-filtered list (two matches), and selectedIndex would drift
      // instead of the matches narrowing.
      stdin.write('j');
      await wait(50);
      output = lastFrame() ?? '';
      expect(output).toContain('bjorn config');
      expect(output).not.toContain('bug investigation');
    });

    it('list-mode Space without preview enabled is a no-op', async () => {
      // When preview is disabled, the Space-as-preview shortcut never
      // fires; Space is also explicitly skipped from implicit search
      // entry to keep leading whitespace out of the query.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'first',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
            // No `enablePreview` here — preview is disabled, so Space is
            // simply ignored by list mode (the search seed-skip rule
            // also kicks in to keep leading whitespace out of the query).
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write(' ');
      await wait(50);

      const output = lastFrame() ?? '';
      expect(output).toContain('Press / to search');
      expect(output).not.toContain('Search:');
    });

    it('Backspace edits the query; emptying it returns to list mode', async () => {
      // Backspace is an edit op that, when it deletes the final char,
      // also flips back to list mode so the shortcut keymap is
      // immediately available again. Esc remains the explicit exit.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'login bug',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onCancel = vi.fn();

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      stdin.write('/logim');
      await wait(30);
      stdin.write(BACKSPACE);
      await wait(30);
      stdin.write('n');
      await wait(50);

      let output = lastFrame() ?? '';
      expect(output).toContain('login bug');
      expect(output).not.toContain('unrelated');

      // First Esc: exit search back to list, do not cancel.
      stdin.write(ESC);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('login bug');
      expect(output).toContain('unrelated');
      expect(output).toContain('Press / to search');
      expect(onCancel).not.toHaveBeenCalled();

      // Second Esc: now actually cancels.
      stdin.write(ESC);
      await wait(30);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('Backspace in list mode does not spawn a search', async () => {
      // Regression: Backspace's raw byte (DEL, 0x7F) used to slip past
      // the printable-char filter and seed an implicit search with the
      // literal DEL byte, producing a confusing 'No sessions match …'
      // frame in list mode. List-mode Backspace must be inert.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'first',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write(BACKSPACE);
      await wait(50);

      const output = lastFrame() ?? '';
      // Still in list mode — no search frame, no spurious empty match.
      expect(output).toContain('Press / to search');
      expect(output).not.toContain('Search:');
      expect(output).not.toContain('No sessions match');
      // The session list is still rendered untouched.
      expect(output).toContain('first');
    });

    it('search mode suppresses the row highlight', async () => {
      // The "›" selected-prefix and accent color belong to the row
      // the user is about to act on. While they're still typing the
      // query, no row should claim that affordance — the search input
      // owns focus exclusively until ↑↓/Enter commits to the list.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'login bug',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      // Sanity: in list mode the first row is highlighted with '› '.
      let output = lastFrame() ?? '';
      expect(output).toContain('› ');

      // Enter search; the highlight should disappear.
      stdin.write('/login');
      await wait(50);
      output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).not.toContain('› ');

      // Commit (↓ or Enter) reinstates the highlight on the list.
      stdin.write(ARROW_DOWN);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('Filter:');
      expect(output).toContain('› ');
    });

    it('Enter in search commits the filter; second Enter selects', async () => {
      // Defensive UX: the user's typing reflex shouldn't accidentally
      // resume a session. Pressing Enter while still in the search
      // input commits the filter (drops to list, query preserved)
      // and onSelect stays unfired. Only a deliberate second Enter
      // from the list view actually resumes.
      const sessions = [
        createMockSession({
          sessionId: 'first',
          prompt: 'foo',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'matching',
          prompt: 'special-target',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/special');
      await wait(30);

      // First Enter: search → list, query stays applied, no resume.
      stdin.write('\r');
      await wait(30);
      expect(onSelect).not.toHaveBeenCalled();
      const afterFirstEnter = lastFrame() ?? '';
      expect(afterFirstEnter).toContain('Filter:');
      expect(afterFirstEnter).toContain('special-target');

      // Second Enter from list view selects the highlighted row.
      stdin.write('\r');
      await wait(30);
      expect(onSelect).toHaveBeenCalledWith('matching');
    });

    it('Enter in search with no matches stays in search', async () => {
      // Don't drop the user out of the search input on Enter when
      // there's nothing to commit to — they're mid-typo and need
      // to keep editing.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/zzz'); // matches nothing
      await wait(30);
      stdin.write('\r');
      await wait(30);

      const output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('No sessions match');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('↑/↓ from search drops to list mode while keeping the filter', async () => {
      // The post-narrow state: user types to filter, then arrows to
      // pick a row. Once they navigate, the search frame goes away
      // (no more caret, switches to "Filter:" indicator) but the
      // query stays applied so the list remains narrowed and full
      // list-mode shortcuts work on the highlighted row.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'login flow review',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'login bug fix',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'c',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);

      let output = lastFrame() ?? '';
      // In search mode: caret-bearing "Search:" row is visible.
      expect(output).toContain('Search:');

      stdin.write(ARROW_DOWN);
      await wait(50);

      output = lastFrame() ?? '';
      // Now in list mode with filter preserved: the read-only
      // "Filter:" indicator replaces "Search:", but the list is
      // still narrowed to the two login matches.
      expect(output).toContain('Filter:');
      expect(output).not.toContain('Search:');
      expect(output).toContain('login flow review');
      expect(output).toContain('login bug fix');
      expect(output).not.toContain('unrelated');
    });

    it('Space → preview works on the highlighted row in filtered-list', async () => {
      // Once narrowed and out of search, Space should trigger the
      // preview shortcut just like in the unfiltered list — proves
      // the action is mode-independent.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'login flow',
          messageCount: 2,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'unrelated',
          messageCount: 2,
        }),
      ];
      const service = createMockSessionService(sessions);
      service.loadSession.mockResolvedValue({
        conversation: { messages: [] },
        filePath: '/x',
        lastCompletedUuid: null,
      });

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ConfigContext.Provider
            value={
              {
                getShouldUseNodePtyShell: () => false,
                getIdeMode: () => false,
                isTrustedFolder: () => false,
              } as unknown as Config
            }
          >
            <SettingsContext.Provider
              value={
                {
                  merged: {},
                } as unknown as LoadedSettings
              }
            >
              <SessionPicker
                sessionService={service as never}
                onSelect={vi.fn()}
                onCancel={vi.fn()}
                enablePreview
              />
            </SettingsContext.Provider>
          </ConfigContext.Provider>
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);
      stdin.write(ARROW_DOWN); // exits search, cursor on filtered first item
      await wait(30);
      stdin.write(' '); // Space → preview
      await wait(150);

      const frame = lastFrame() ?? '';
      // Preview frame shows session metadata (prompt, message count).
      expect(frame).toContain('login flow');
      // The filter row / list view is replaced by the preview, which
      // does not render the "Search:" or "Filter:" rows.
      expect(frame).not.toContain('Filter:');
    });

    it('Ctrl+B toggles branch in filtered-list', async () => {
      // Branch toggle stays available after narrowing, so users can
      // refine filter axes without losing their query.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          gitBranch: 'main',
          prompt: 'login',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          gitBranch: 'feature',
          prompt: 'login on feature',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
            currentBranch="main"
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);
      stdin.write(ARROW_DOWN); // exit search to filtered-list
      await wait(30);

      // Both still visible (filter='login' matches both).
      let output = lastFrame() ?? '';
      expect(output).toContain('login on feature');

      stdin.write(CTRL_B);
      await wait(50);

      output = lastFrame() ?? '';
      // Branch filter narrows to main; query still applied.
      expect(output).toContain('Filter:');
      expect(output).toContain('login');
      expect(output).not.toContain('login on feature');
    });

    it('Esc in filtered-list clears the query first, then cancels', async () => {
      // Two-stage Esc parity with search mode: pressing Esc once on
      // the filtered list drops the query (returning the unfiltered
      // list) while keeping the picker open; a second Esc finally
      // cancels. Avoids an "I lost my filter AND closed the dialog"
      // surprise from a single accidental keystroke.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onCancel = vi.fn();

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);
      stdin.write(ARROW_DOWN); // → filtered-list with q='login'
      await wait(30);

      let output = lastFrame() ?? '';
      expect(output).toContain('Filter:');

      // First Esc: drop the filter, stay open.
      stdin.write(ESC);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('Press / to search');
      expect(output).toContain('login flow');
      expect(output).toContain('unrelated');
      expect(onCancel).not.toHaveBeenCalled();

      // Second Esc: actually cancel.
      stdin.write(ESC);
      await wait(30);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("'/' from filtered-list preserves the existing query", async () => {
      // Re-focusing search via '/' must not throw away what the user
      // already typed — they typically hit '/' when they want to
      // tweak the filter, not start over. Esc is the explicit clear
      // gesture (covered by the Backspace/Esc test above).
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'unrelated',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);
      stdin.write(ARROW_DOWN); // exit to filtered-list
      await wait(30);

      // Re-press '/' from filtered-list: viewMode flips back to
      // search but the query stays.
      stdin.write('/');
      await wait(30);

      const output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('login');
      // Filter is still applied — non-matches stay filtered out.
      expect(output).not.toContain('unrelated');
    });

    it('↑ at top of unfiltered list also wraps into search', async () => {
      // Same boundary-wrap pattern as the filtered case: a fresh
      // picker (no query yet) lets the user kick off a search just
      // by hitting ↑ from the first row, no '/' required.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'first',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 's2',
          prompt: 'second',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      // Already at index 0 from the initial render; ↑ wraps into search.
      stdin.write(ARROW_UP);
      await wait(50);

      const output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      // No query yet, so the list is unfiltered — both rows visible.
      expect(output).toContain('first');
      expect(output).toContain('second');
    });

    it('↑ at top of filtered-list wraps focus back to search', async () => {
      // fzf-style boundary wrap: the search row is treated as a row
      // above the list, so pressing ↑ when already on the first
      // filtered match returns the user to search-mode editing
      // without needing another '/' keystroke. ↓ at the bottom is
      // intentionally NOT wrapped — that's the loadMore sentinel.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'login bug',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);

      // ↓ from search exits to filtered-list at the first match
      // (selectedIndex was reset to 0 when the query changed, and
      // ↓ no longer advances past it).
      stdin.write(ARROW_DOWN);
      await wait(30);
      let output = lastFrame() ?? '';
      expect(output).toContain('Filter:');

      // ↑ at index 0 wraps focus right back into search.
      stdin.write(ARROW_UP);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).not.toContain('Filter:');
      // Query is preserved so the user is editing the same filter.
      expect(output).toContain('login');
    });

    it('↓ from search lands on the first match, not the second', async () => {
      // Regression: previously ↓ from search did setViewMode('list')
      // *and* advanced selectedIndex, so the user pressed ↓ once and
      // jumped past the first (highest-relevance) match. Now ↓
      // simply commits the focus transition; selectedIndex stays at
      // 0 (already reset by the query-change effect).
      //
      // Inter-key waits are 50ms (not the 30ms used elsewhere): on
      // Windows runners the keypress → useEffect → render chain
      // through `/login` + ARROW_DOWN + Enter consistently exceeded
      // 30ms and dropped the Enter event — the spy never saw the
      // selection. Tests in this file already use 50ms in similar
      // multi-step sequences; align with that.
      const sessions = [
        createMockSession({
          sessionId: 'first-match',
          prompt: 'login flow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'second-match',
          prompt: 'login bug',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);
      const onSelect = vi.fn();

      const { stdin } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={onSelect}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(50);
      stdin.write(ARROW_DOWN); // exit search → first match should be highlighted
      await wait(50);
      stdin.write('\r'); // Enter from list = select highlighted row
      await wait(50);

      expect(onSelect).toHaveBeenCalledWith('first-match');
    });

    it('↑/↓ are a no-op in search when the query matches nothing', async () => {
      // Sentinel for the "phantom mode-switch" glitch: when the
      // current query has zero matches there is no row to land on,
      // so ↑/↓ must not silently flip the picker out of search mode.
      // The user keeps editing the query (or backs up) until the
      // filter actually finds something.
      const sessions = [
        createMockSession({
          sessionId: 's1',
          prompt: 'unrelated work',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      // Type a query that matches nothing.
      stdin.write('/zzznomatch');
      await wait(50);
      let output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('No sessions match');

      // ↑↓ should not exit search.
      stdin.write(ARROW_DOWN);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).not.toContain('Filter:');

      stdin.write(ARROW_UP);
      await wait(30);
      output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).not.toContain('Filter:');
    });

    it('typing in filtered-list re-enters search and appends', async () => {
      // After narrowing → arrow → list, further typing should refine
      // (append to existing query) rather than start a fresh search.
      // Prompts use no spaces so the substring "loginbug" / "loginflow"
      // can match contiguously without colliding with Space-as-preview.
      const sessions = [
        createMockSession({
          sessionId: 'a',
          prompt: 'loginflow',
          messageCount: 1,
        }),
        createMockSession({
          sessionId: 'b',
          prompt: 'loginbug',
          messageCount: 1,
        }),
      ];
      const mockService = createMockSessionService(sessions);

      const { stdin, lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <SessionPicker
            sessionService={mockService as never}
            onSelect={vi.fn()}
            onCancel={vi.fn()}
          />
        </KeypressProvider>,
      );

      await wait(100);
      stdin.write('/login');
      await wait(30);
      stdin.write(ARROW_DOWN);
      await wait(30);
      // Now list-mode + query='login'. Type 'bug' — implicit entry
      // re-enters search and appends, yielding query='loginbug'.
      stdin.write('bug');
      await wait(50);

      const output = lastFrame() ?? '';
      expect(output).toContain('Search:');
      expect(output).toContain('loginbug');
      expect(output).not.toContain('loginflow');
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
