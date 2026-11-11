/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders as render } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { type Config } from '@qwen-code/core';
import { SessionBrowser, type SessionBrowserProps } from './SessionBrowser.js';
import {
  type SessionInfo,
  type SessionSelectionResult,
} from '../../utils/sessionUtils.js';
import { SettingScope } from '../../config/settings.js';
import { createMockSettings } from '../../test-utils/settings.js';

const inkAppMocks = vi.hoisted(() => ({
  requestTranscriptReplacement: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => inkAppMocks,
  };
});

let testKeyDispatchHandler:
  | ((key: {
      name?: string;
      sequence?: string;
      ctrl?: boolean;
    }) => boolean | void)
  | null = null;

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));

// Mock the component itself to bypass async loading
vi.mock('./SessionBrowser.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./SessionBrowser.js')>();
  const React = await import('react');
  const { ActionHandlerRegistryProvider, useActionHandlerRegistry } =
    await import('../contexts/ActionHandlerRegistry.js');
  const { KeyboardContextProvider } = await import(
    '../contexts/KeyboardContextRegistry.js'
  );
  const { HintRegistryProvider } = await import(
    '../contexts/HintRegistryContext.js'
  );

  /**
   * Bridge component that dispatches keypresses through the action handler
   * registry (similar to useContextRouting but simplified for tests).
   * Tries Dialog context actions and fallbacks for the key.
   */
  /* eslint-disable react/prop-types -- TypeScript handles prop validation */
  const TestKeyDispatch: React.FC<{ children: React.ReactNode }> = ({
    children,
  }) => {
    /* eslint-enable react/prop-types */
    const registry = useActionHandlerRegistry();
    testKeyDispatchHandler = (key): boolean | void => {
      if (!registry) return false;
      // Map key to Dialog context actions (same as contextBindings.ts Dialog block)
      const keyName = key.name ?? '';
      const sequence = key.sequence ?? '';
      const ctrl = key.ctrl ?? false;

      let action: string | undefined;
      if (keyName === 'escape') action = 'dialog:escape';
      else if (keyName === 'return' || keyName === 'enter')
        action = 'dialog:confirm';
      else if (keyName === 'up') action = 'dialog:navigate:up';
      else if (keyName === 'down') action = 'dialog:navigate:down';
      else if (keyName === 'pageup') action = 'scroll:pageUp';
      else if (keyName === 'pagedown') action = 'scroll:pageDown';
      else if (keyName === 'tab') action = 'dialog:tab:next';
      else if (keyName === 'backspace') action = 'edit:deleteLeft';
      else if (ctrl && sequence === '\x03') action = 'app:interrupt';

      if (action) {
        const handled = registry.invokeAction('Dialog', action, key as never);
        if (handled) return true;
      }
      // Fall through to Dialog fallback for rawHandlers (char input, etc.)
      const fallbackHandled = registry.invokeFallback('Dialog', key as never);
      if (fallbackHandled) return true;
      return false;
    };
    return React.createElement(React.Fragment, null, children);
  };

  type TestSessionBrowserProps = SessionBrowserProps & {
    testSessions?: SessionInfo[];
    testAllSessions?: SessionInfo[];
    testAllProjectSessions?: SessionInfo[];
    testError?: string | null;
    testReloadSessionScopes?: () => Promise<void>;
    testSessionsAfterReload?: SessionInfo[];
    testToggleProjectScope?: () => Promise<void>;
    testResolveSelectedSession?: (
      session: SessionInfo,
    ) => Promise<SessionSelectionResult>;
  };

  const TestSessionBrowserContent = (props: TestSessionBrowserProps) => {
    const state = original.useSessionBrowserState(
      props.testSessions || [],
      false, // Not loading
      props.testError || null,
      props.initialSearchQuery,
      props.testAllSessions ?? props.testSessions ?? [],
      props.currentGitBranch,
      props.testAllProjectSessions ?? null,
    );
    const moveSelection = original.useMoveSelection(state);
    const cycleSortOrder = original.useCycleSortOrder(state);
    // useSessionBrowserInput self-registers action handlers on the Dialog context
    const hints = original.useSessionBrowserInput(
      state,
      moveSelection,
      cycleSortOrder,
      props.onResumeSession,
      props.onDeleteSession ??
        (async () => {
          // no-op delete handler for tests that don't care about deletion
        }),
      async () => {
        await props.testReloadSessionScopes?.();
        if (props.testSessionsAfterReload) {
          state.setSessionScopes({
            current: props.testSessionsAfterReload,
            all: props.testSessionsAfterReload,
          });
        }
      },
      props.testToggleProjectScope ??
        (async () => {
          state.selectProjectScope(
            state.projectScope === 'current-repo'
              ? 'all-projects'
              : 'current-repo',
          );
        }),
      props.testResolveSelectedSession ??
        (async (session) => ({
          sessionPath: session.sessionPath ?? '',
          messages: [],
          displayInfo: '',
          sessionInfo: session,
        })),
      props.onExit,
    );

    return React.createElement(
      KeyboardContextProvider,
      null,
      React.createElement(
        HintRegistryProvider,
        null,
        React.createElement(
          TestKeyDispatch,
          null,
          React.createElement(original.SessionBrowserView, {
            state,
            extraHints: hints,
          }),
        ),
      ),
    );
  };

  const TestSessionBrowser = (props: TestSessionBrowserProps) =>
    React.createElement(
      ActionHandlerRegistryProvider,
      null,
      React.createElement(TestSessionBrowserContent, props),
    );

  return {
    ...original,
    SessionBrowser: TestSessionBrowser,
  };
});

// Cast SessionBrowser to a type that includes the test-only props so TypeScript doesn't complain
const TestSessionBrowser = SessionBrowser as unknown as React.FC<
  SessionBrowserProps & {
    testSessions?: SessionInfo[];
    testAllSessions?: SessionInfo[];
    testAllProjectSessions?: SessionInfo[];
    testError?: string | null;
    testReloadSessionScopes?: () => Promise<void>;
    testSessionsAfterReload?: SessionInfo[];
    testToggleProjectScope?: () => Promise<void>;
    testResolveSelectedSession?: (
      session: SessionInfo,
    ) => Promise<SessionSelectionResult>;
  }
>;

const createMockConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    storage: {
      getProjectTempDir: () => '/tmp/test',
    },
    getSessionId: () => 'default-session-id',
    ...overrides,
  }) as Config;

const triggerKey = (
  partialKey: Partial<{
    name: string;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
    cmd: boolean;
    insertable: boolean;
    sequence: string;
  }>,
) => {
  const handler = testKeyDispatchHandler;
  if (!handler) {
    throw new Error('No keypress handler registered');
  }

  const key = {
    name: '',
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: false,
    sequence: '',
    ...partialKey,
  };

  act(() => {
    handler(key);
  });
};

const createSession = (overrides: Partial<SessionInfo>): SessionInfo => ({
  id: 'session-id',
  file: 'session-id',
  fileName: 'session-id.json',
  startTime: new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
  messageCount: 1,
  displayName: 'Test Session',
  firstUserMessage: 'Test Session',
  isCurrentSession: false,
  index: 0,
  ...overrides,
});

describe('SessionBrowser component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-01T12:00:00Z'));
    testKeyDispatchHandler = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows empty state when no sessions exist', async () => {
    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testSessions={[]}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders resumable sessions and filters the current session', async () => {
    const session1 = createSession({
      id: 'abc123',
      file: 'abc123',
      displayName: 'First conversation about cats',
      lastUpdated: '2025-01-01T10:05:00Z',
      messageCount: 2,
      index: 0,
    });
    const session2 = createSession({
      id: 'def456',
      file: 'def456',
      displayName: 'Second conversation about dogs',
      lastUpdated: '2025-01-01T11:30:00Z',
      messageCount: 5,
      isCurrentSession: true,
      index: 1,
    });

    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testSessions={[session1, session2]}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('enters search mode, filters sessions, and renders match snippets', async () => {
    // ... same searchSession setup ...
    const searchSession = createSession({
      id: 'search1',
      file: 'search1',
      displayName: 'Query is here and another query.',
      firstUserMessage: 'Query is here and another query.',
      fullContent: 'Query is here and another query.',
      messages: [
        {
          role: 'user',
          content: 'Query is here and another query.',
        },
      ],
      index: 0,
      lastUpdated: '2025-01-01T12:00:00Z',
    });

    const otherSession = createSession({
      id: 'other',
      file: 'other',
      displayName: 'Nothing interesting here.',
      firstUserMessage: 'Nothing interesting here.',
      fullContent: 'Nothing interesting here.',
      messages: [
        {
          role: 'user',
          content: 'Nothing interesting here.',
        },
      ],
      index: 1,
      lastUpdated: '2025-01-01T10:00:00Z',
    });

    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testSessions={[searchSession, otherSession]}
      />,
    );

    expect(lastFrame()).toContain('Chat Sessions (2, current worktree');

    // Enter search mode.
    triggerKey({ sequence: '/', name: '/' });
    await waitUntilReady();

    await waitFor(() => {
      expect(lastFrame()).toContain('Search:');
    });

    // PTY writes can deliver an ordinary text chunk as one keypress.
    triggerKey({ sequence: 'query', insertable: true });
    await waitUntilReady();

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Chat Sessions (1, current worktree, filtered',
      );
    });
    expect(lastFrame()).toMatchSnapshot();
  });

  it('keeps the session title visible when search results show body match snippets', async () => {
    const titledSession = createSession({
      id: 'title-visible',
      file: 'title-visible',
      displayName: 'hihi',
      firstUserMessage: 'Please say hi to the repo',
      fullContent: 'Please say hi to the repo',
      messages: [{ role: 'user', content: 'Please say hi to the repo' }],
      index: 0,
      lastUpdated: '2025-01-01T12:00:00Z',
    });
    const otherSession = createSession({
      id: 'other',
      file: 'other',
      displayName: 'tttt',
      firstUserMessage: 'No body match here',
      fullContent: 'No body match here',
      messages: [{ role: 'user', content: 'No body match here' }],
      index: 1,
      lastUpdated: '2025-01-01T10:00:00Z',
    });

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        initialSearchQuery="hi"
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[titledSession, otherSession]}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Chat Sessions (1, current worktree, filtered',
      );
    });
    expect(lastFrame()).toContain('hihi');
    expect(lastFrame()).toContain('You:');
  });

  it('applies the initial search query when provided', async () => {
    const searchSession = createSession({
      id: 'search1',
      file: 'search1',
      displayName: 'Resume auth flow',
      firstUserMessage: 'Resume auth flow',
      fullContent: 'Resume auth flow',
      messages: [{ role: 'user', content: 'Resume auth flow' }],
      index: 0,
    });
    const otherSession = createSession({
      id: 'other',
      file: 'other',
      displayName: 'Fix build',
      firstUserMessage: 'Fix build',
      fullContent: 'Fix build',
      messages: [{ role: 'user', content: 'Fix build' }],
      index: 1,
    });

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        initialSearchQuery="auth"
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[searchSession, otherSession]}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Chat Sessions (1, current worktree, filtered',
      );
    });
    expect(lastFrame()).toContain('Resume auth flow');
    expect(lastFrame()).not.toContain('Fix build');
  });

  it('allows navigation and resume when opened with an initial search query', async () => {
    const firstMatch = createSession({
      id: 'first-auth',
      file: 'first-auth',
      displayName: 'Resume auth flow',
      firstUserMessage: 'Resume auth flow',
      fullContent: 'Resume auth flow',
      messages: [{ role: 'user', content: 'Resume auth flow' }],
      index: 0,
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const secondMatch = createSession({
      id: 'second-auth',
      file: 'second-auth',
      displayName: 'Investigate auth timeout',
      firstUserMessage: 'Investigate auth timeout',
      fullContent: 'Investigate auth timeout',
      messages: [{ role: 'user', content: 'Investigate auth timeout' }],
      index: 1,
      lastUpdated: '2025-01-01T12:00:00Z',
    });
    const otherSession = createSession({
      id: 'other',
      file: 'other',
      displayName: 'Fix build',
      firstUserMessage: 'Fix build',
      fullContent: 'Fix build',
      messages: [{ role: 'user', content: 'Fix build' }],
      index: 2,
      lastUpdated: '2024-12-31T12:00:00Z',
    });

    const onResumeSession = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        initialSearchQuery="auth"
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[firstMatch, secondMatch, otherSession]}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Chat Sessions (2, current worktree, filtered',
      );
    });

    triggerKey({ name: 'down', sequence: '[B' });
    await waitUntilReady();

    triggerKey({ name: 'enter', sequence: '\r' });
    await waitUntilReady();

    expect(onResumeSession).toHaveBeenCalledTimes(1);
    expect(onResumeSession).toHaveBeenCalledWith(secondMatch);
  });

  it('handles keyboard navigation and resumes the selected session', async () => {
    const session1 = createSession({
      id: 'one',
      file: 'one',
      displayName: 'First session',
      index: 0,
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const session2 = createSession({
      id: 'two',
      file: 'two',
      displayName: 'Second session',
      index: 1,
      lastUpdated: '2025-01-01T12:00:00Z',
    });

    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testSessions={[session1, session2]}
      />,
    );

    expect(lastFrame()).toContain('Chat Sessions (2, current worktree');

    // Move selection down.
    triggerKey({ name: 'down', sequence: '[B' });
    await waitUntilReady();

    // Press Enter.
    triggerKey({ name: 'enter', sequence: '\r' });
    await waitUntilReady();

    expect(onResumeSession).toHaveBeenCalledTimes(1);
    const [resumedSession] = onResumeSession.mock.calls[0];
    expect(resumedSession).toEqual(session2);
  });

  it('defaults to current worktree and reveals cross-worktree sessions with Ctrl+W', async () => {
    const currentSession = createSession({
      id: 'local',
      file: 'local',
      displayName: 'Current worktree history',
      transcriptProjectRoot: '/repo/current',
      lastUpdated: '2025-01-01T12:00:00Z',
    });
    const crossWorktreeSession = createSession({
      id: 'cross',
      file: 'cross',
      displayName: 'Other worktree history',
      transcriptProjectRoot:
        '/mnt/training/weval_team/personnel/zhenghao.lu/Issac-Gr00t-0112',
      sourceWorktreePath:
        '/mnt/training/weval_team/personnel/zhenghao.lu/Issac-Gr00t-0112',
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const onResumeSession = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[currentSession]}
        testAllSessions={[crossWorktreeSession, currentSession]}
      />,
    );

    expect(lastFrame()).toContain('Chat Sessions (1, current worktree)');
    expect(lastFrame()).toContain('Current worktree history');
    expect(lastFrame()).not.toContain('Other worktree history');
    expect(lastFrame()).toContain('Ctrl+W show all worktrees');
    expect(lastFrame().match(/Ctrl\+W/g)).toHaveLength(1);

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();

    expect(lastFrame()).toContain('Chat Sessions (2, all worktrees)');
    expect(lastFrame()).toContain('Other worktree history');
    expect(lastFrame()).toContain(
      '/mnt/training/weval_team/personnel/zhenghao.lu/Issac-Gr00t-0112',
    );
    expect(lastFrame()).not.toContain('[worktree:');
    expect(lastFrame()).toContain('Ctrl+W show current worktree');
    expect(lastFrame().match(/Ctrl\+W/g)).toHaveLength(1);
    const allWorktreeLines = lastFrame().split('\n');
    const pathIndex = allWorktreeLines.findIndex((line) =>
      line.includes('Path:'),
    );
    const firstSessionIndex = allWorktreeLines.findIndex((line) =>
      line.includes('Other worktree history'),
    );
    expect(pathIndex).toBeGreaterThan(-1);
    expect(pathIndex).toBeLessThan(firstSessionIndex);

    triggerKey({ name: 'enter', sequence: '\r' });
    await waitUntilReady();

    expect(onResumeSession).toHaveBeenCalledWith(crossWorktreeSession);
  });

  it('shows the logical project path instead of a worktree transcript path', async () => {
    const deletedWorktreePath =
      '/repo/project/.qwen/worktrees/deleted-session';
    const worktreeSession = createSession({
      id: 'deleted-worktree-session',
      file: 'deleted-worktree-session',
      displayName: 'Deleted worktree history',
      transcriptProjectRoot: deletedWorktreePath,
      sourceWorktreePath: deletedWorktreePath,
      displayProjectPath: '/repo/project',
    });

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[]}
        testAllSessions={[worktreeSession]}
      />,
    );

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();

    const pathLine = lastFrame()
      .split('\n')
      .find((line) => line.includes('Path:'));
    expect(pathLine).toContain('/repo/project');
    expect(pathLine).not.toContain(deletedWorktreePath);
  });

  it('keeps Ctrl+W available when the current worktree has no resumable sessions', async () => {
    const crossWorktreeSession = createSession({
      id: 'cross-only',
      file: 'cross-only',
      displayName: 'Cross-only history',
      transcriptProjectRoot: '/repo/other',
      sourceWorktreePath: '/repo/other',
    });

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[]}
        testAllSessions={[crossWorktreeSession]}
      />,
    );

    expect(lastFrame()).toContain('No sessions found in the current worktree.');
    expect(lastFrame()).not.toContain('Press Ctrl+W');
    expect(lastFrame().match(/Ctrl\+W/g)).toHaveLength(1);
    expect(lastFrame()).not.toContain('navigate');

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();

    expect(lastFrame()).toContain('Cross-only history');
    expect(lastFrame()).toContain('Chat Sessions (1, all worktrees)');
  });

  it('toggles an exact current-branch filter with Ctrl+B', async () => {
    const mainSession = createSession({
      id: 'main-session',
      file: 'main-session',
      displayName: 'Main branch history',
      gitBranch: 'main',
    });
    const featureSession = createSession({
      id: 'feature-session',
      file: 'feature-session',
      displayName: 'Feature branch history',
      gitBranch: 'feature/demo',
    });
    const unknownBranchSession = createSession({
      id: 'unknown-session',
      file: 'unknown-session',
      displayName: 'Legacy history',
    });

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        currentGitBranch="main"
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[mainSession, featureSession, unknownBranchSession]}
      />,
      { width: 120 },
    );

    expect(lastFrame()).toContain('Ctrl+B only show current branch');
    expect(lastFrame()).toContain('Feature branch history');
    expect(lastFrame()).toContain('Legacy history');

    triggerKey({ name: 'b', sequence: '\x02', ctrl: true });
    await waitUntilReady();

    expect(lastFrame()).toContain(
      'Chat Sessions (1, current worktree, current branch)',
    );
    expect(lastFrame()).toContain('Main branch history');
    expect(lastFrame()).not.toContain('Feature branch history');
    expect(lastFrame()).not.toContain('Legacy history');
    expect(lastFrame()).toContain('Ctrl+B show all branches');

    triggerKey({ name: 'b', sequence: '\x02', ctrl: true });
    await waitUntilReady();
    expect(lastFrame()).toContain('Feature branch history');
  });

  it('shows branch and compact transcript file size metadata', async () => {
    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[
          createSession({
            id: 'metadata',
            file: 'metadata',
            displayName: 'Metadata history',
            gitBranch: 'main',
            fileSize: 1536,
          }),
        ]}
      />,
      { width: 120 },
    );

    expect(lastFrame()).toContain('Metadata history');
    expect(lastFrame()).toContain('now · main · 1.5 KB');
  });

  it('shows HEAD exactly like a regular recorded branch', async () => {
    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[
          createSession({
            id: 'head-metadata',
            file: 'head-metadata',
            displayName: 'Detached or unresolved branch history',
            gitBranch: 'HEAD',
            fileSize: 2048,
          }),
        ]}
      />,
      { width: 80 },
    );

    expect(lastFrame()).toContain('Detached or unresolved branch history');
    expect(lastFrame()).toContain('now · HEAD · 2 KB');
  });

  it('omits unavailable branch metadata without extra separators', async () => {
    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[
          createSession({
            id: 'missing-branch',
            file: 'missing-branch',
            displayName: 'Legacy branchless history',
            fileSize: 3072,
          }),
        ]}
      />,
      { width: 80 },
    );

    expect(lastFrame()).toContain('Legacy branchless history');
    expect(lastFrame()).toContain('now · 3 KB');
    expect(lastFrame()).not.toContain('·  ·');
  });

  it('leaves a blank line before the first session and between items', async () => {
    const firstSession = createSession({
      id: 'spaced-first',
      file: 'spaced-first',
      displayName: 'First spaced history',
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const secondSession = createSession({
      id: 'spaced-second',
      file: 'spaced-second',
      displayName: 'Second spaced history',
      lastUpdated: '2025-01-01T12:00:00Z',
    });

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[firstSession, secondSession]}
      />,
      { width: 80 },
    );

    const lines = lastFrame().split('\n');
    const firstTitleIndex = lines.findIndex((line) =>
      line.includes('First spaced history'),
    );
    const secondTitleIndex = lines.findIndex((line) =>
      line.includes('Second spaced history'),
    );

    expect(lines[firstTitleIndex - 1]?.trim()).toBe('');
    expect(lines[firstTitleIndex + 1]).toContain('1 message');
    expect(lines[firstTitleIndex + 2]?.trim()).toBe('');
    expect(secondTitleIndex).toBe(firstTitleIndex + 3);
  });

  it('keeps worktree scope latent while all-project sessions are visible', async () => {
    const localSession = createSession({
      id: 'local-project',
      file: 'local-project',
      displayName: 'Local project history',
      transcriptProjectRoot: '/repo/current',
    });
    const crossWorktreeSession = createSession({
      id: 'cross-project',
      file: 'cross-project',
      displayName: 'Cross worktree history',
      transcriptProjectRoot: '/repo/other-worktree',
      sourceWorktreePath: '/repo/other-worktree',
    });
    const unrelatedSession = createSession({
      id: 'unrelated-project',
      file: 'unrelated-project',
      displayName: 'Unrelated project history',
      transcriptProjectRoot: '/other/project',
    });

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[localSession]}
        testAllSessions={[crossWorktreeSession, localSession]}
        testAllProjectSessions={[unrelatedSession]}
      />,
      { width: 120 },
    );

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();
    expect(lastFrame()).toContain('Cross worktree history');

    triggerKey({ name: 'a', sequence: '\x01', ctrl: true });
    await waitUntilReady();
    expect(lastFrame()).toContain('Chat Sessions (1, all projects)');
    expect(lastFrame()).toContain('Unrelated project history');
    expect(lastFrame()).toContain('/other/project');

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();
    expect(lastFrame()).toContain('Unrelated project history');
    expect(lastFrame()).not.toContain('Local project history');

    triggerKey({ name: 'a', sequence: '\x01', ctrl: true });
    await waitUntilReady();
    expect(lastFrame()).toContain('Chat Sessions (1, current worktree)');
    expect(lastFrame()).toContain('Local project history');
    expect(lastFrame()).not.toContain('Cross worktree history');
  });

  it('labels empty search results with the all-projects scope', async () => {
    const unrelatedSession = createSession({
      id: 'search-all-projects',
      file: 'search-all-projects',
      displayName: 'Unrelated project history',
      transcriptProjectRoot: '/other/project',
    });
    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[]}
        testAllProjectSessions={[unrelatedSession]}
      />,
    );

    triggerKey({ name: 'a', sequence: '\x01', ctrl: true });
    await waitUntilReady();
    triggerKey({ sequence: '/', name: '/' });
    triggerKey({ sequence: 'missing', insertable: true });
    await waitUntilReady();

    expect(lastFrame()).toContain(
      "No sessions found matching 'missing' in all projects.",
    );
  });

  it('returns from Space preview without losing the selected list position', async () => {
    const firstSession = createSession({
      id: 'preview-first',
      file: 'preview-first',
      sessionPath: '/transcripts/preview-first.jsonl',
      displayName: 'First preview history',
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const secondSession = createSession({
      id: 'preview-second',
      file: 'preview-second',
      sessionPath: '/transcripts/preview-second.jsonl',
      displayName: 'Second preview history',
      lastUpdated: '2025-01-01T12:00:00Z',
    });
    const resolved: SessionSelectionResult = {
      sessionPath: secondSession.sessionPath!,
      messages: [],
      displayInfo: 'preview',
      sessionInfo: secondSession,
    };
    const resolveSelectedSession = vi.fn().mockResolvedValue(resolved);
    const onResumeSession = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[firstSession, secondSession]}
        testResolveSelectedSession={resolveSelectedSession}
      />,
    );

    expect(inkAppMocks.requestTranscriptReplacement).not.toHaveBeenCalled();

    triggerKey({ name: 'down', sequence: '[B' });
    await waitUntilReady();
    triggerKey({ name: 'space', sequence: ' ' });

    await waitFor(() => {
      expect(lastFrame()).toContain('Chat Preview');
      expect(lastFrame()).toContain('Second preview history');
      expect(lastFrame()).toContain('Enter resume');
    });
    expect(resolveSelectedSession).toHaveBeenCalledTimes(1);
    expect(resolveSelectedSession).toHaveBeenCalledWith(
      secondSession,
      expect.any(AbortSignal),
    );
    expect(inkAppMocks.requestTranscriptReplacement).toHaveBeenCalledTimes(1);

    triggerKey({ name: 'escape', sequence: '\x1b' });
    await waitUntilReady();
    expect(lastFrame()).toContain('Chat Sessions (2, current worktree)');
    expect(inkAppMocks.requestTranscriptReplacement).toHaveBeenCalledTimes(2);

    triggerKey({ name: 'enter', sequence: '\r' });
    await waitUntilReady();
    expect(onResumeSession).toHaveBeenCalledWith(secondSession);
  });

  it('releases the preview resume lease when Escape closes the preview', async () => {
    const session = createSession({
      id: 'preview-lease',
      file: 'preview-lease',
      sessionPath: '/transcripts/preview-lease.jsonl',
      displayName: 'Lease preview',
    });
    const finish = vi.fn();
    const resolved: SessionSelectionResult = {
      sessionPath: session.sessionPath!,
      messages: [],
      displayInfo: 'preview',
      sessionInfo: session,
      resumeAttempt: {
        finish,
      } as unknown as SessionSelectionResult['resumeAttempt'],
    };
    const resolveSelectedSession = vi.fn().mockResolvedValue(resolved);

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[session]}
        testResolveSelectedSession={resolveSelectedSession}
      />,
    );

    triggerKey({ name: 'space', sequence: ' ' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Enter resume');
    });
    expect(finish).not.toHaveBeenCalled();

    triggerKey({ name: 'escape', sequence: '\x1b' });
    await waitUntilReady();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it.each(['escape', 'unmount'] as const)(
    'aborts a pending preview on %s and releases a late result',
    async (action) => {
      const session = createSession({
        id: 'preview-late',
        file: 'preview-late',
        sessionPath: '/transcripts/preview-late.jsonl',
        displayName: 'Late preview',
      });
      const finish = vi.fn();
      const resolved: SessionSelectionResult = {
        sessionPath: session.sessionPath!,
        messages: [],
        displayInfo: 'preview',
        sessionInfo: session,
        resumeAttempt: {
          finish,
        } as unknown as SessionSelectionResult['resumeAttempt'],
      };
      let resolvePreview!: (value: SessionSelectionResult) => void;
      const resolveSelectedSession = vi.fn(
        (_session: SessionInfo, _signal?: AbortSignal) =>
          new Promise<SessionSelectionResult>((resolve) => {
            resolvePreview = resolve;
          }),
      );

      const { waitUntilReady, unmount } = await render(
        <TestSessionBrowser
          config={createMockConfig()}
          onResumeSession={vi.fn()}
          onDeleteSession={vi.fn().mockResolvedValue(undefined)}
          onExit={vi.fn()}
          testSessions={[session]}
          testResolveSelectedSession={resolveSelectedSession}
        />,
      );

      triggerKey({ name: 'space', sequence: ' ' });
      await waitFor(() => {
        expect(resolveSelectedSession).toHaveBeenCalledTimes(1);
      });
      if (action === 'escape') {
        triggerKey({ name: 'escape', sequence: '\x1b' });
        await waitUntilReady();
      } else {
        await act(async () => {
          unmount();
        });
      }
      expect(resolveSelectedSession.mock.calls[0]?.[1]?.aborted).toBe(true);

      await act(async () => {
        resolvePreview(resolved);
      });
      await waitFor(() => {
        expect(finish).toHaveBeenCalledTimes(1);
      });
    },
  );

  it('re-resolves when an expired preview result is confirmed', async () => {
    const session = createSession({
      id: 'preview-expired',
      file: 'preview-expired',
      sessionPath: '/transcripts/preview-expired.jsonl',
      displayName: 'Expired preview',
    });
    const finish = vi.fn();
    const resolved: SessionSelectionResult = {
      sessionPath: session.sessionPath!,
      messages: [],
      displayInfo: 'preview',
      sessionInfo: session,
      resumeAttempt: {
        finish,
        signal: { aborted: true },
      } as unknown as SessionSelectionResult['resumeAttempt'],
    };
    const resolveSelectedSession = vi.fn().mockResolvedValue(resolved);
    const onResumeSession = vi.fn();

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[session]}
        testResolveSelectedSession={resolveSelectedSession}
      />,
    );

    triggerKey({ name: 'space', sequence: ' ' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Enter resume');
    });
    triggerKey({ name: 'enter', sequence: '\r' });

    // 失效的预览 attempt 不能再交给恢复流程，由承接方重新解析。
    expect(onResumeSession).toHaveBeenCalledWith(session);
    expect(onResumeSession.mock.calls[0]).toHaveLength(1);
  });

  it('reuses the resolved Space preview when Enter resumes', async () => {
    const session = createSession({
      id: 'preview-resume',
      file: 'preview-resume',
      sessionPath: '/transcripts/preview-resume.jsonl',
      displayName: 'Preview then resume',
    });
    const finish = vi.fn();
    const resolved: SessionSelectionResult = {
      resumeAttempt: {
        finish,
        signal: new AbortController().signal,
      } as unknown as SessionSelectionResult['resumeAttempt'],
      sessionPath: session.sessionPath!,
      messages: [],
      displayInfo: 'preview',
      sessionInfo: session,
    };
    const resolveSelectedSession = vi.fn().mockResolvedValue(resolved);
    const onResumeSession = vi.fn();

    const { lastFrame, unmount } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[session]}
        testResolveSelectedSession={resolveSelectedSession}
      />,
    );

    triggerKey({ name: 'space', sequence: ' ' });
    await waitFor(() => {
      expect(resolveSelectedSession).toHaveBeenCalledTimes(1);
      expect(lastFrame()).toContain('Enter resume');
    });
    triggerKey({ name: 'enter', sequence: '\r' });

    expect(resolveSelectedSession).toHaveBeenCalledTimes(1);
    expect(onResumeSession).toHaveBeenCalledWith(session, resolved);
    await act(async () => {
      unmount();
    });
    expect(resolveSelectedSession.mock.calls[0]?.[1]?.aborted).toBe(false);
    expect(finish).not.toHaveBeenCalled();
  });

  it('reveals secondary shortcuts on demand with ?', async () => {
    const session = createSession({
      id: 'local',
      file: 'local',
      displayName: 'Local history',
    });

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[session]}
      />,
    );

    expect(lastFrame()).toContain('? for shortcuts');
    expect(lastFrame()).not.toContain('s sort');
    expect(lastFrame()).not.toContain('x delete');

    triggerKey({
      name: '/',
      sequence: '\x1b[47:63;2u',
      shift: true,
    });
    await waitUntilReady();

    const helpLine = lastFrame()
      .split('\n')
      .find((line) => line.includes('s sort'));
    expect(helpLine).toContain('s sort · r reverse');
    expect(helpLine).toContain('x delete');
    expect(helpLine).toContain('g/G first/last');
    expect(helpLine).toContain('u/d half-page');
    expect(helpLine).toContain('? hide shortcuts');
    expect(lastFrame()).not.toContain('? for shortcuts');

    triggerKey({ name: '?', sequence: '?' });
    await waitUntilReady();

    expect(lastFrame()).toContain('? for shortcuts');
    expect(lastFrame()).not.toContain('s sort');
  });

  it('keeps metadata visible below long CJK titles', async () => {
    const longTitle =
      '执行 MCP elicitation idle timeout CLI 验收。必须严格按顺序完成以下步骤：'.repeat(
        3,
      );
    const crossWorktreeSessions = Array.from({ length: 20 }, (_, index) =>
      createSession({
        id: `cross-${index}`,
        file: `cross-${index}`,
        displayName:
          index % 3 === 0 ? `Short title ${index}` : `${longTitle} ${index}`,
        transcriptProjectRoot: `/very/long/worktree/path/${index}`,
        sourceWorktreePath: `/very/long/worktree/path/${index}`,
        gitBranch: `feature/long-title-${index}`,
        fileSize: 2048,
        lastUpdated: new Date(Date.UTC(2025, 0, 20 - index)).toISOString(),
      }),
    );

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[]}
        testAllSessions={crossWorktreeSessions}
      />,
      { width: 80 },
    );

    triggerKey({ name: 'w', sequence: '\x17', ctrl: true });
    await waitUntilReady();

    const lines = lastFrame().split('\n');
    const listStartIndex = lines.findIndex((line) =>
      line.includes('Short title 0'),
    );
    const listEndIndex = lines.findIndex(
      (line, index) => index > listStartIndex && line.trim() === '▼',
    );
    const renderedRows = lines.slice(listStartIndex, listEndIndex);
    const titleRows = renderedRows.filter((_, index) => index % 3 === 0);
    const metadataRows = renderedRows.filter((_, index) => index % 3 === 1);
    const gapRows = renderedRows.filter((_, index) => index % 3 === 2);

    expect(titleRows).toHaveLength(3);
    expect(metadataRows).toHaveLength(3);
    expect(gapRows).toHaveLength(3);
    for (const metadataRow of metadataRows) {
      expect(metadataRow).toContain('feature/long-title-');
      expect(metadataRow).toContain('2 KB');
    }
    for (const gapRow of gapRows) {
      expect(gapRow.trim()).toBe('');
    }
    expect(titleRows.some((row) => row.trimEnd().endsWith('…'))).toBe(true);
    expect(lastFrame()).not.toContain('[worktree:');
  });

  it('filters the current session and focuses the first resumable session', async () => {
    const currentSession = createSession({
      id: 'current',
      file: 'current',
      displayName: 'Current session',
      isCurrentSession: true,
      index: 0,
      lastUpdated: '2025-01-02T12:00:00Z',
    });
    const otherSession = createSession({
      id: 'other',
      file: 'other',
      displayName: 'Other session',
      isCurrentSession: false,
      index: 1,
      lastUpdated: '2025-01-01T12:00:00Z',
    });

    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testSessions={[currentSession, otherSession]}
      />,
    );

    expect(lastFrame()).not.toContain('Current session');
    expect(lastFrame()).toContain('Other session');

    triggerKey({ name: 'enter', sequence: '\r' });
    await waitUntilReady();
    expect(onResumeSession).toHaveBeenCalledWith(otherSession);
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('reloads session scopes after deleting the selected session', async () => {
    const session = createSession({
      id: 'delete-me',
      file: 'delete-me',
      displayName: 'Delete this session',
    });
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const reloadSessionScopes = vi.fn().mockResolvedValue(undefined);

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onExit={vi.fn()}
        testSessions={[session]}
        testReloadSessionScopes={reloadSessionScopes}
      />,
    );

    triggerKey({ name: 'x', sequence: 'x' });
    expect(onDeleteSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(lastFrame()).toContain('Delete session “Delete this session”?');
    });

    triggerKey({ name: 'enter', sequence: '\r' });

    await waitFor(() => {
      expect(onDeleteSession).toHaveBeenCalledWith(session);
      expect(reloadSessionScopes).toHaveBeenCalledTimes(1);
    });
    expect(onDeleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      reloadSessionScopes.mock.invocationCallOrder[0],
    );
  });

  it('keeps a valid selection after deleting the last session', async () => {
    const firstSession = createSession({
      id: 'keep-session',
      file: 'keep-session',
      displayName: 'Keep session',
    });
    const lastSession = createSession({
      id: 'delete-last-session',
      file: 'delete-last-session',
      displayName: 'Delete last session',
    });
    const onResumeSession = vi.fn();

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={onResumeSession}
        onDeleteSession={vi.fn().mockResolvedValue(undefined)}
        onExit={vi.fn()}
        testSessions={[firstSession, lastSession]}
        testSessionsAfterReload={[firstSession]}
      />,
    );

    triggerKey({ name: 'down' });
    triggerKey({ name: 'x', sequence: 'x' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Delete session “Delete last session”?');
    });
    triggerKey({ name: 'enter', sequence: '\r' });

    await waitFor(() => {
      expect(lastFrame()).not.toContain('Delete last session');
    });
    triggerKey({ name: 'enter', sequence: '\r' });

    expect(onResumeSession).toHaveBeenCalledWith(firstSession);
  });

  it('executes deletion only once for repeated confirmation keys', async () => {
    const session = createSession({
      id: 'delete-once',
      file: 'delete-once',
      displayName: 'Delete once',
    });
    let resolveDelete!: () => void;
    const deletion = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const onDeleteSession = vi.fn().mockReturnValue(deletion);
    const { lastFrame, unmount } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onExit={vi.fn()}
        testSessions={[session]}
      />,
    );

    triggerKey({ name: 'x', sequence: 'x' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Delete session “Delete once”?');
    });
    triggerKey({ name: 'enter', sequence: '\r' });
    triggerKey({ name: 'enter', sequence: '\r' });

    expect(onDeleteSession).toHaveBeenCalledOnce();
    resolveDelete();
    await waitFor(() => {
      expect(lastFrame()).not.toContain('Deleting session');
      expect(lastFrame()).not.toContain('Delete session “Delete once”?');
    });
    unmount();
  });

  it('keeps deletion progress and failure visible when Esc is pressed in flight', async () => {
    const session = createSession({
      id: 'delete-in-flight',
      file: 'delete-in-flight',
      displayName: 'Delete in flight',
    });
    let rejectDelete!: (error: Error) => void;
    const deletion = new Promise<void>((_resolve, reject) => {
      rejectDelete = reject;
    });
    const onDeleteSession = vi.fn().mockReturnValue(deletion);
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'en' } },
        originalSettings: { ui: { language: 'en' } },
        readOnly: true,
      },
    });
    const { lastFrame, waitUntilReady } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onExit={vi.fn()}
        testSessions={[session]}
      />,
      { settings },
    );

    triggerKey({ name: 'x', sequence: 'x' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Delete session “Delete in flight”?');
    });
    triggerKey({ name: 'enter', sequence: '\r' });
    triggerKey({ name: 'escape', sequence: '\u001b' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Deleting session');
    });

    act(() => {
      settings.setValue(SettingScope.User, 'ui.language', 'zh-CN');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('正在删除会话');
    expect(lastFrame()).toContain('Delete in flight');

    rejectDelete(new Error('EACCES /raw/in-flight.json'));
    await waitFor(() => {
      expect(lastFrame()).toContain(
        '删除会话失败： EACCES /raw/in-flight.json',
      );
    });
    expect(lastFrame()).toContain('Delete in flight');
  });

  it('cancels deletion without changing the list or selection', async () => {
    const session = createSession({
      id: 'keep-me',
      file: 'keep-me',
      displayName: 'Keep this session',
    });
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onExit={vi.fn()}
        testSessions={[session]}
      />,
    );

    triggerKey({ name: 'x', sequence: 'x' });
    await waitFor(() => {
      expect(lastFrame()).toContain('Delete session “Keep this session”?');
    });
    triggerKey({ name: 'escape', sequence: '\u001b' });

    expect(onDeleteSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(lastFrame()).toContain('Keep this session');
      expect(lastFrame()).not.toContain('Delete session “Keep this session”?');
    });
  });

  it('keeps the list selected and shows raw detail when deletion fails', async () => {
    const session = createSession({
      id: 'failed-delete',
      file: 'failed-delete',
      displayName: 'Failed delete session',
    });
    const onDeleteSession = vi
      .fn()
      .mockRejectedValue(new Error('EACCES /raw/transcript.json'));
    const { lastFrame } = await render(
      <TestSessionBrowser
        config={createMockConfig()}
        onResumeSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onExit={vi.fn()}
        testSessions={[session]}
      />,
    );

    triggerKey({ name: 'x', sequence: 'x' });
    triggerKey({ name: 'enter', sequence: '\r' });

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Failed to delete session: EACCES /raw/transcript.json',
      );
    });
    expect(lastFrame()).toContain('Failed delete session');
  });

  it('shows an error state when loading sessions fails', async () => {
    const config = createMockConfig();
    const onResumeSession = vi.fn();
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();

    const { lastFrame } = await render(
      <TestSessionBrowser
        config={config}
        onResumeSession={onResumeSession}
        onDeleteSession={onDeleteSession}
        onExit={onExit}
        testError="storage failure"
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  describe('P1 bilingual layout matrix', () => {
    it.each([
      { locale: 'en' as const, width: 60 },
      { locale: 'en' as const, width: 80 },
      { locale: 'en' as const, width: 120 },
      { locale: 'zh-CN' as const, width: 60 },
      { locale: 'zh-CN' as const, width: 80 },
      { locale: 'zh-CN' as const, width: 120 },
    ])(
      'matches the $locale session layout at $width columns',
      async ({ locale, width }) => {
        const settings = createMockSettings({
          user: {
            path: '/read-only/settings.json',
            settings: { ui: { language: locale } },
            originalSettings: { ui: { language: locale } },
            readOnly: true,
          },
        });
        const session = createSession({
          id: 'raw-session-id',
          file: 'raw-session-id',
          sessionPath: '/tmp/raw-session-id.json',
          displayName: 'Raw session title',
          lastUpdated: '2025-11-01T11:30:00Z',
          messageCount: 7,
        });
        const result = await render(
          <TestSessionBrowser
            config={createMockConfig()}
            onResumeSession={vi.fn()}
            onDeleteSession={vi.fn().mockResolvedValue(undefined)}
            onExit={vi.fn()}
            testSessions={[session]}
          />,
          { settings, width },
        );

        expect(result.lastFrame()).toContain('Raw session title');
        expect(result.lastFrame()).toMatchSnapshot();
        result.unmount();
      },
    );
  });
});
