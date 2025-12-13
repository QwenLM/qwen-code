/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResumeSessionDialog } from './ResumeSessionDialog.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import type {
  SessionListItem,
  ListSessionsResult,
} from '@qwen-code/qwen-code-core';

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

// Mock SessionService and getGitBranch
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    SessionService: vi.fn().mockImplementation(() => mockSessionService),
    getGitBranch: vi.fn().mockReturnValue('main'),
  };
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

// Default mock session service
let mockSessionService = {
  listSessions: vi.fn().mockResolvedValue({
    items: [],
    hasMore: false,
    nextCursor: undefined,
  } as ListSessionsResult),
};

describe('ResumeSessionDialog', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Loading State', () => {
    it('should show loading state initially', () => {
      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      const output = lastFrame();
      expect(output).toContain('Resume Session');
      expect(output).toContain('Loading sessions...');
    });
  });

  describe('Empty State', () => {
    it('should show "No sessions found" when there are no sessions', async () => {
      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: [],
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('No sessions found');
    });
  });

  describe('Session Display', () => {
    it('should display sessions after loading', async () => {
      const sessions = [
        createMockSession({
          sessionId: 'session-1',
          prompt: 'First session prompt',
          messageCount: 10,
        }),
        createMockSession({
          sessionId: 'session-2',
          prompt: 'Second session prompt',
          messageCount: 5,
        }),
      ];

      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: sessions,
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('First session prompt');
    });

    it('should filter out empty sessions', async () => {
      const sessions = [
        createMockSession({
          sessionId: 'empty-session',
          prompt: '',
          messageCount: 0,
        }),
        createMockSession({
          sessionId: 'valid-session',
          prompt: 'Valid prompt',
          messageCount: 5,
        }),
      ];

      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: sessions,
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Valid prompt');
      // Empty session should be filtered out
      expect(output).not.toContain('empty-session');
    });
  });

  describe('Footer', () => {
    it('should show navigation instructions in footer', async () => {
      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: [createMockSession()],
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('to navigate');
      expect(output).toContain('Enter to select');
      expect(output).toContain('Esc to cancel');
    });

    it('should show branch toggle hint when currentBranch is available', async () => {
      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: [createMockSession()],
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      // Should show B key hint since getGitBranch is mocked to return 'main'
      expect(output).toContain('B');
      expect(output).toContain('toggle branch');
    });
  });

  describe('Terminal Height', () => {
    it('should accept availableTerminalHeight prop', async () => {
      mockSessionService = {
        listSessions: vi.fn().mockResolvedValue({
          items: [createMockSession()],
          hasMore: false,
          nextCursor: undefined,
        } as ListSessionsResult),
      };

      const onSelect = vi.fn();
      const onCancel = vi.fn();

      // Should not throw with availableTerminalHeight prop
      const { lastFrame } = render(
        <KeypressProvider kittyProtocolEnabled={false}>
          <ResumeSessionDialog
            cwd="/test/path"
            onSelect={onSelect}
            onCancel={onCancel}
            availableTerminalHeight={20}
          />
        </KeypressProvider>,
      );

      await wait(100);

      const output = lastFrame();
      expect(output).toContain('Resume Session');
    });
  });
});
