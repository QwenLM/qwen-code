/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type FormEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopConnectionStatus,
  DesktopGitBranch,
  DesktopGitDiff,
  DesktopProject,
  DesktopSessionSummary,
  DesktopTerminal,
  DesktopUserSettings,
} from '../../api/client.js';
import { chatReducer, createInitialChatState } from '../../stores/chatStore.js';
import { createInitialModelState } from '../../stores/modelStore.js';
import {
  createInitialSettingsState,
  settingsReducer,
} from '../../stores/settingsStore.js';
import { WorkspacePage } from './WorkspacePage.js';
import type { LoadState } from './types.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe('WorkspacePage', () => {
  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it('renders stable workbench landmarks for desktop E2E checks', () => {
    const renderedContainer = renderWorkspace();

    for (const testId of [
      'desktop-workspace',
      'project-sidebar',
      'sidebar-app-actions',
      'workspace-topbar',
      'workspace-grid',
      'chat-thread',
      'terminal-drawer',
      'project-list',
      'thread-list',
    ]) {
      expect(
        renderedContainer.querySelector(`[data-testid="${testId}"]`),
      ).toBeTruthy();
    }
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="settings-page"]'),
    ).toBeNull();
    expect(renderedContainer.querySelector('.sidebar-toolbar')).toBeNull();
    expect(
      renderedContainer.querySelector(
        '[data-testid="sidebar-footer-settings"]',
      ),
    ).toBeTruthy();
    expect(
      [
        ...renderedContainer.querySelectorAll('.sidebar-section-heading h2'),
      ].map((heading) => heading.textContent),
    ).toEqual(['Projects']);
    expect(
      renderedContainer
        .querySelector('[data-testid="project-list"]')
        ?.contains(
          renderedContainer.querySelector('[data-testid="thread-list"]'),
        ),
    ).toBe(true);
    expect(
      renderedContainer
        .querySelector('[data-testid="sidebar-active-project-group"]')
        ?.contains(
          renderedContainer.querySelector('[data-testid="thread-list"]'),
        ),
    ).toBe(true);

    expect(renderedContainer.textContent).toContain('example-workspace');
    expect(renderedContainer.textContent).toContain('main');
    expect(renderedContainer.textContent).toContain('New Thread');
    expect(renderedContainer.textContent).toContain('Search');
    expect(renderedContainer.textContent).toContain('Models');
    expect(
      renderedContainer.querySelector(
        '.sidebar-heading-icon-button[aria-label="Open Project"]',
      ),
    ).toBeTruthy();
    expect(
      [
        ...renderedContainer.querySelectorAll(
          '[data-testid="sidebar-app-actions"] button',
        ),
      ].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['New Thread', 'Search', 'Models']);
    expect(
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent,
    ).not.toContain('src/index.ts');
    expect(
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent,
    ).not.toContain('Threads');
    expect(renderedContainer.textContent).toContain('Terminal');
    expect(renderedContainer.textContent).toContain('Idle');
    expect(renderedContainer.textContent).toContain('No recent command');
    expect(renderedContainer.textContent).not.toContain('No terminal output');
    const topbar = renderedContainer.querySelector(
      '[data-testid="workspace-topbar"]',
    );
    const topbarContext = renderedContainer.querySelector(
      '[data-testid="topbar-context"]',
    );
    expect(topbar).toBeTruthy();
    expect(topbarContext).toBeTruthy();
    expect(topbar?.querySelector('.topbar-meta')).toBeNull();
    expect(
      topbarContext?.querySelectorAll('.topbar-context-item'),
    ).toHaveLength(3);
    expect(
      renderedContainer.querySelector('[data-testid="topbar-branch-trigger"]'),
    ).toBeTruthy();
    expect(topbarContext?.textContent).toContain('Connected');
    expect(topbarContext?.textContent).toContain('main');
    expect(topbarContext?.textContent).toContain('+1 -1');
    expect(
      renderedContainer.querySelector('[data-testid="topbar-diff-stat"]'),
    ).toBeTruthy();
    expect(topbarContext?.textContent).not.toContain('1 modified');
    expect(
      renderedContainer
        .querySelector('[data-testid="topbar-git-status"]')
        ?.getAttribute('title'),
    ).toBe('Git status: 1 modified · 0 staged · 0 untracked · Diff +1 -1');
    expect(
      topbar?.querySelector('[data-testid="topbar-runtime-status"]')
        ?.textContent,
    ).toContain('Ready');
    expect(
      renderedContainer.querySelector('[data-testid="terminal-body"]'),
    ).toBeNull();
    expect(
      renderedContainer
        .querySelector('button[aria-label="Expand Terminal"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      renderedContainer.querySelector(
        '[data-testid="terminal-toggle"] .message-role',
      ),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="terminal-strip-project"]')
        ?.textContent,
    ).toContain('example-workspace');
    expect(renderedContainer.querySelector('.topbar-nav')).toBeNull();
    expect(renderedContainer.querySelector('.chat-header')).toBeNull();
    expect(
      renderedContainer.querySelector('.chat-status-announcement')?.textContent,
    ).toContain('Conversation');
    expect(
      renderedContainer.querySelector('button[aria-label="Open Changes"]'),
    ).toBeTruthy();
    expect(
      topbar?.querySelector('button[aria-label="Refresh Git"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector(
        '[data-testid="conversation-changes-summary"]',
      ),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('1 file changed');
    expect(renderedContainer.textContent).toContain('+1');
    expect(renderedContainer.textContent).toContain('-1');

    act(() => {
      clickButton(renderedContainer, 'Review Changes');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="review-refresh-git"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();

    act(() => {
      clickButton(renderedContainer, 'Conversation');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Expand Terminal');
    });

    expect(
      renderedContainer.querySelector('[data-testid="terminal-body"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('No terminal output');
    expect(
      renderedContainer.querySelector('button[aria-label="Copy Output"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Attach Output"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Send to AI"]'),
    ).toBeNull();
    for (const testId of ['terminal-run-button', 'terminal-input-button']) {
      const button = renderedContainer.querySelector(
        `[data-testid="${testId}"]`,
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.querySelector('svg')).toBeTruthy();
      expect(button?.querySelector('.sr-only')).toBeTruthy();
    }
    expect(
      renderedContainer
        .querySelector('[data-testid="terminal-command-row"]')
        ?.querySelector('[data-testid="terminal-actions"]'),
    ).toBeTruthy();

    act(() => {
      clickButton(renderedContainer, 'Open Changes');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Close Changes"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('src/index.ts');
    expect(renderedContainer.textContent).toContain('Fix parser test');
    expect(renderedContainer.textContent).toContain('Stage Hunk');
    expect(renderedContainer.textContent).toContain('Discard Hunk');
    expect(renderedContainer.textContent).not.toContain('Accept');
    expect(renderedContainer.textContent).not.toContain('Revert');
    const reviewTabs = renderedContainer.querySelectorAll(
      '[data-testid="review-panel"] .review-tabs button',
    );
    expect(reviewTabs).toHaveLength(4);
    for (const tab of reviewTabs) {
      expect(tab.querySelector('svg')).toBeTruthy();
      expect(tab.getAttribute('title')).not.toBe('');
    }
    for (const [label, expectedClass] of [
      ['Discard All', 'review-icon-button-danger'],
      ['Stage All', 'review-icon-button'],
      ['Open', 'review-icon-button'],
      ['Discard File', 'review-icon-button-danger'],
      ['Stage File', 'review-icon-button'],
      ['Discard Hunk', 'review-icon-button-danger'],
      ['Stage Hunk', 'review-icon-button'],
      ['Add Comment', 'review-icon-button'],
      ['Commit', 'review-icon-button-primary'],
    ] as const) {
      const button = [
        ...renderedContainer.querySelectorAll<HTMLButtonElement>(
          '[data-testid="review-panel"] button',
        ),
      ].find((candidate) => candidate.getAttribute('aria-label') === label);
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.classList.contains('review-icon-button')).toBe(true);
      expect(button?.classList.contains(expectedClass)).toBe(true);
      expect(button?.querySelector('svg')).toBeTruthy();
      expect(button?.querySelector('.sr-only')?.textContent).toBe(label);
      expect(button?.getAttribute('title')).not.toBe('');
      expect(
        [...(button?.childNodes ?? [])]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim())
          .join(''),
      ).toBe('');
    }
    expect(
      renderedContainer.querySelector(
        '[aria-label="Review comment for src/index.ts"]',
      ),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Add Comment');
    });

    expect(
      renderedContainer.querySelector(
        '[aria-label="Review comment for src/index.ts"]',
      ),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Cancel Comment"]'),
    ).toBeTruthy();

    act(() => {
      clickButton(renderedContainer, 'Cancel Comment');
    });

    expect(
      renderedContainer.querySelector(
        '[aria-label="Review comment for src/index.ts"]',
      ),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    expect(
      renderedContainer.querySelector('[data-testid="settings-page"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="settings-overlay"]'),
    ).toBeTruthy();
    expect(
      renderedContainer
        .querySelector('.settings-overlay-backdrop')
        ?.getAttribute('tabindex'),
    ).toBe('-1');
    expect(
      renderedContainer
        .querySelector('.settings-overlay-backdrop')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    const settingsCloseButton = renderedContainer.querySelector(
      '[data-testid="settings-close-button"]',
    );
    expect(settingsCloseButton).toBeInstanceOf(HTMLButtonElement);
    expect(settingsCloseButton?.getAttribute('aria-label')).toBe(
      'Close Settings',
    );
    expect(settingsCloseButton?.getAttribute('title')).toBe('Close Settings');
    expect(settingsCloseButton?.textContent?.trim()).toBe('');
    expect(settingsCloseButton?.querySelector('svg')).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="model-config"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="permissions-config"]'),
    ).toBeTruthy();
    const settingsSectionNav = renderedContainer.querySelector(
      '[data-testid="settings-section-nav"]',
    );
    expect(settingsSectionNav).toBeTruthy();
    expect(settingsSectionNav?.getAttribute('aria-label')).toBe(
      'Settings sections',
    );
    expect(
      [...(settingsSectionNav?.querySelectorAll('a') ?? [])].map((link) =>
        link.textContent?.trim(),
      ),
    ).toEqual([
      'Account',
      'Model Providers',
      'Permissions',
      'Tools & MCP',
      'Terminal',
      'Appearance',
      'Advanced',
    ]);
    expect(
      settingsSectionNav
        ?.querySelector('a[href="#settings-permissions"]')
        ?.getAttribute('aria-label'),
    ).toBe('Show Permissions settings');
    expect(
      renderedContainer.querySelector('[data-testid="settings-sections"]'),
    ).toBeTruthy();
    expect(renderedContainer.querySelector('.settings-page-meta')).toBeNull();
    for (const [testId, id] of [
      ['settings-account-section', 'settings-account'],
      ['model-config', 'settings-model-providers'],
      ['permissions-config', 'settings-permissions'],
      ['settings-tools-section', 'settings-tools'],
      ['settings-terminal-section', 'settings-terminal'],
      ['settings-appearance-section', 'settings-appearance'],
      ['settings-advanced-section', 'settings-advanced'],
    ] as const) {
      expect(
        renderedContainer
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute('id'),
      ).toBe(id);
    }
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="terminal-drawer"]'),
    ).toBeTruthy();
    expect(
      renderedContainer
        .querySelector('[data-testid="settings-page"]')
        ?.getAttribute('role'),
    ).toBe('dialog');
    const settingsText =
      renderedContainer.querySelector('[data-testid="settings-page"]')
        ?.textContent ?? '';
    for (const section of [
      'Account',
      'Model Providers',
      'Permissions',
      'Tools & MCP',
      'Terminal',
      'Appearance',
      'Advanced',
    ]) {
      expect(settingsText).toContain(section);
    }
    expect(settingsText).not.toContain(readyStatus.serverUrl);
    expect(settingsText).not.toContain(readyStatus.runtime.desktop.nodeVersion);
    expect(settingsText).not.toContain('ACP');
    expect(settingsText).not.toContain(session.sessionId);
    expect(
      renderedContainer.querySelector('[data-testid="runtime-diagnostics"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Advanced Diagnostics');
    });

    const advancedDiagnostics = renderedContainer.querySelector(
      '[data-testid="advanced-diagnostics"]',
    );
    expect(advancedDiagnostics).toBeTruthy();
    expect(advancedDiagnostics?.textContent).toContain(readyStatus.serverUrl);
    expect(advancedDiagnostics?.textContent).toContain(
      readyStatus.runtime.desktop.nodeVersion,
    );
    expect(advancedDiagnostics?.textContent).toContain('ACP');
    expect(advancedDiagnostics?.textContent).toContain(session.sessionId);

    act(() => {
      clickButton(renderedContainer, 'Close Settings');
    });

    expect(
      renderedContainer.querySelector('[data-testid="settings-page"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="settings-overlay"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="terminal-drawer"]'),
    ).toBeTruthy();
  });

  it('opens model provider settings from the sidebar Models action', () => {
    const renderedContainer = renderWorkspace();
    const modelsButton = renderedContainer.querySelector(
      '[data-testid="sidebar-app-actions"] button[aria-label="Models"]',
    );
    const settingsButton = renderedContainer.querySelector(
      '[data-testid="sidebar-footer-settings"]',
    );
    const modelsIcon = modelsButton?.querySelector('svg')?.innerHTML ?? '';
    const settingsIcon = settingsButton?.querySelector('svg')?.innerHTML ?? '';

    expect(modelsButton).toBeInstanceOf(HTMLButtonElement);
    expect(settingsButton).toBeInstanceOf(HTMLButtonElement);
    expect(modelsIcon).not.toBe('');
    expect(settingsIcon).not.toBe('');
    expect(modelsIcon).not.toBe(settingsIcon);

    act(() => {
      clickButton(renderedContainer, 'Models');
    });

    const settingsPage = renderedContainer.querySelector(
      '[data-testid="settings-page"]',
    );
    const providerSelect = renderedContainer.querySelector(
      '[data-testid="settings-provider-select"]',
    );

    expect(settingsPage).toBeTruthy();
    expect(settingsPage?.getAttribute('data-initial-section')).toBe(
      'settings-model-providers',
    );
    expect(providerSelect).toBeInstanceOf(HTMLSelectElement);
    expect(document.activeElement).toBe(providerSelect);
    expect(
      renderedContainer.querySelector('[data-testid="runtime-diagnostics"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Close Settings');
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const generalSettingsPage = renderedContainer.querySelector(
      '[data-testid="settings-page"]',
    );
    const closeButton = renderedContainer.querySelector(
      '[data-testid="settings-close-button"]',
    );

    expect(generalSettingsPage?.getAttribute('data-initial-section')).toBe(
      'settings-account',
    );
    expect(document.activeElement).toBe(closeButton);
  });

  it('keeps sidebar project metadata compact and structured', () => {
    const longBranchName =
      'desktop-e2e/very-long-branch-name-for-topbar-overflow-check';
    const dirtyProject: DesktopProject = {
      ...project,
      gitBranch: longBranchName,
      gitStatus: {
        ...project.gitStatus,
        branch: longBranchName,
        modified: 12,
        staged: 2,
        untracked: 3,
        clean: false,
      },
    };
    const cleanProject: DesktopProject = {
      ...project,
      id: 'project-clean',
      name: 'clean-workspace',
      gitStatus: {
        ...project.gitStatus,
        clean: true,
        modified: 0,
        staged: 0,
        untracked: 0,
      },
    };
    const renderedContainer = renderWorkspace({
      activeProject: dirtyProject,
      activeProjectId: dirtyProject.id,
      projects: [dirtyProject, cleanProject],
    });
    const projectRows = renderedContainer.querySelectorAll(
      '[data-testid="project-row"]',
    );
    const dirtyRow = projectRows[0];
    const cleanRow = projectRows[1];
    const dirtyBranch = dirtyRow?.querySelector(
      '[data-testid="project-row-branch"]',
    );
    const dirtyBadge = dirtyRow?.querySelector(
      '[data-testid="project-row-dirty"]',
    );

    expect(projectRows).toHaveLength(2);
    expect(dirtyRow?.getAttribute('aria-label')).toBe(
      'example-workspace, desktop-e2e/very-lo..., 17 dirty',
    );
    expect(dirtyRow?.getAttribute('title')).toBe(
      'example-workspace · ' +
        longBranchName +
        ' · 12 modified · 2 staged · 3 untracked',
    );
    expect(dirtyRow?.textContent).toContain('example-workspace');
    expect(dirtyRow?.textContent).toContain('desktop-e2e/very-lo...');
    expect(dirtyRow?.textContent).toContain('17 dirty');
    expect(dirtyRow?.textContent).not.toContain(longBranchName);
    expect(dirtyBranch?.getAttribute('title')).toBe(longBranchName);
    expect(dirtyBranch?.querySelector('svg')).toBeTruthy();
    expect(dirtyBadge?.getAttribute('title')).toBe(
      '12 modified · 2 staged · 3 untracked',
    );
    expect(cleanRow?.textContent).toContain('main');
    expect(
      cleanRow?.querySelector('[data-testid="project-row-dirty"]'),
    ).toBeNull();
  });

  it('filters sidebar projects and active project threads from Search', () => {
    const onChooseWorkspace = vi.fn();
    const cleanProject: DesktopProject = {
      ...project,
      id: 'project-clean',
      name: 'clean-workspace',
      path: '/tmp/clean-workspace',
      gitStatus: {
        ...project.gitStatus,
        clean: true,
        modified: 0,
        staged: 0,
        untracked: 0,
      },
    };
    const reviewSession: DesktopSessionSummary = {
      sessionId: 'session-review',
      title: 'Review README docs',
      cwd: project.path,
      models: { currentModelId: 'qwen-review-model', availableModels: [] },
      updatedAt: '2026-04-25T00:00:01.000Z',
    };
    const renderedContainer = renderWorkspace({
      onChooseWorkspace,
      projects: [project, cleanProject],
      sessions: [session, reviewSession],
    });

    act(() => {
      clickButton(renderedContainer, 'Search');
    });

    const searchInput = renderedContainer.querySelector(
      'input[aria-label="Search projects and threads"]',
    );
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(searchInput);
    expect(
      renderedContainer
        .querySelector('button[aria-label="Search"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    act(() => {
      setInputValue(searchInput as HTMLInputElement, 'review');
    });

    const sidebarText =
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent ?? '';
    const threadRows = renderedContainer.querySelectorAll(
      '[data-testid="thread-row"]',
    );

    expect(threadRows).toHaveLength(1);
    expect(threadRows[0]?.textContent).toContain('Review README docs');
    expect(sidebarText).toContain('example-workspace');
    expect(sidebarText).toContain('Review README docs');
    expect(sidebarText).not.toContain('Fix parser test');
    expect(sidebarText).not.toContain('clean-workspace');

    act(() => {
      clickButton(renderedContainer, 'Clear Search');
    });

    expect((searchInput as HTMLInputElement).value).toBe('');
    expect(
      renderedContainer.querySelectorAll('[data-testid="project-row"]'),
    ).toHaveLength(2);
    expect(
      renderedContainer.querySelectorAll('[data-testid="thread-row"]'),
    ).toHaveLength(2);

    act(() => {
      setInputValue(searchInput as HTMLInputElement, 'no-sidebar-match');
    });

    const emptyRows = renderedContainer.querySelectorAll('.empty-row');
    expect(emptyRows).toHaveLength(1);
    expect(
      renderedContainer.querySelector('[data-testid="sidebar-search-empty"]')
        ?.textContent,
    ).toBe('No matching projects or threads');
    expect(
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent,
    ).not.toContain('No matching threads');

    act(() => {
      (searchInput as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }),
      );
    });

    expect(
      renderedContainer.querySelector('[data-testid="sidebar-search"]'),
    ).toBeNull();
    expect(
      renderedContainer
        .querySelector('button[aria-label="Search"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      renderedContainer.querySelectorAll('[data-testid="project-row"]'),
    ).toHaveLength(2);
    expect(
      renderedContainer.querySelectorAll('[data-testid="thread-row"]'),
    ).toHaveLength(2);

    act(() => {
      (
        renderedContainer.querySelector(
          '.sidebar-heading-icon-button[aria-label="Open Project"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(onChooseWorkspace).toHaveBeenCalledTimes(1);
  });

  it('keeps topbar project context compact and structured', () => {
    const longBranchName =
      'desktop-e2e/very-long-branch-name-for-topbar-overflow-check';
    const dirtyProject: DesktopProject = {
      ...project,
      gitBranch: longBranchName,
      gitStatus: {
        ...project.gitStatus,
        branch: longBranchName,
        modified: 12,
        staged: 2,
        untracked: 3,
        clean: false,
      },
    };
    const renderedContainer = renderWorkspace({
      activeProject: dirtyProject,
      activeProjectId: dirtyProject.id,
      projects: [dirtyProject],
    });
    const topbarContext = renderedContainer.querySelector(
      '[data-testid="topbar-context"]',
    );
    const branchTrigger = renderedContainer.querySelector(
      '[data-testid="topbar-branch-trigger"]',
    );
    const gitStatus = renderedContainer.querySelector(
      '[data-testid="topbar-git-status"]',
    );
    const branchText = branchTrigger?.textContent ?? '';

    expect(branchText).toContain('...');
    expect(branchText.length).toBeLessThanOrEqual(30);
    expect(branchText).not.toContain(longBranchName);
    expect(branchTrigger?.getAttribute('title')).toBe(
      `Branch: ${longBranchName}`,
    );
    expect(branchTrigger?.getAttribute('aria-label')).toBe(
      `Branch ${longBranchName}`,
    );
    expect(gitStatus?.textContent).toBe('+1 -1');
    expect(gitStatus?.querySelector('.diff-addition')?.textContent).toBe('+1');
    expect(gitStatus?.querySelector('.diff-deletion')?.textContent).toBe('-1');
    expect(gitStatus?.getAttribute('title')).toBe(
      'Git status: 12 modified · 2 staged · 3 untracked · Diff +1 -1',
    );
    expect(gitStatus?.getAttribute('aria-label')).toBe(
      'Git status +1 -1: 12 modified · 2 staged · 3 untracked · Diff +1 -1',
    );
    expect(topbarContext?.textContent).not.toContain(longBranchName);
    expect(topbarContext?.textContent).not.toContain('12 modified');
    expect(topbarContext?.textContent).not.toContain('3 untracked');
  });

  it('falls back to compact topbar file counts before diff stats load', () => {
    const dirtyProject: DesktopProject = {
      ...project,
      gitStatus: {
        ...project.gitStatus,
        modified: 12,
        staged: 2,
        untracked: 3,
        clean: false,
      },
    };
    const renderedContainer = renderWorkspace({
      activeProject: dirtyProject,
      activeProjectId: dirtyProject.id,
      gitDiff: null,
      projects: [dirtyProject],
    });
    const gitStatus = renderedContainer.querySelector(
      '[data-testid="topbar-git-status"]',
    );

    expect(gitStatus?.textContent).toBe('15 dirty · 2 staged');
    expect(gitStatus?.getAttribute('title')).toBe(
      'Git status: 12 modified · 2 staged · 3 untracked',
    );
    expect(gitStatus?.getAttribute('aria-label')).toBe(
      'Git status 15 dirty · 2 staged: 12 modified · 2 staged · 3 untracked',
    );
    expect(gitStatus?.querySelector('[data-testid="topbar-diff-stat"]')).toBe(
      null,
    );
  });

  it('moves Git refresh from the topbar into the review drawer', () => {
    const onRefreshProjectGitStatus = vi.fn();
    const renderedContainer = renderWorkspace({ onRefreshProjectGitStatus });
    const topbar = renderedContainer.querySelector(
      '[data-testid="workspace-topbar"]',
    );

    expect(
      topbar?.querySelector('button[aria-label="Refresh Git"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="review-refresh-git"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Open Changes');
    });

    const refreshButton = renderedContainer.querySelector(
      '[data-testid="review-refresh-git"]',
    );
    expect(refreshButton).toBeInstanceOf(HTMLButtonElement);
    expect(refreshButton?.getAttribute('aria-label')).toBe('Refresh Git');
    expect(refreshButton?.getAttribute('title')).toBe('Refresh Git');
    expect(refreshButton?.querySelector('svg')).toBeTruthy();
    expect(refreshButton?.querySelector('.sr-only')?.textContent).toBe(
      'Refresh Git',
    );
    expect(
      topbar?.querySelector('button[aria-label="Refresh Git"]'),
    ).toBeNull();

    act(() => {
      (refreshButton as HTMLButtonElement).click();
    });

    expect(onRefreshProjectGitStatus).toHaveBeenCalledTimes(1);
  });

  it('confirms dirty branch switches from the topbar menu', async () => {
    const branches: DesktopGitBranch[] = [
      { name: 'main', current: true },
      { name: 'feature/safe-switch', current: false },
    ];
    const onListProjectBranches = vi.fn(async () => branches);
    const onCheckoutProjectBranch = vi.fn(async () => undefined);
    const renderedContainer = renderWorkspace({
      onListProjectBranches,
      onCheckoutProjectBranch,
    });

    await act(async () => {
      clickButton(renderedContainer, 'Branch main');
    });

    expect(onListProjectBranches).toHaveBeenCalledTimes(1);
    expect(
      renderedContainer.querySelector('[data-testid="branch-menu"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('feature/safe-switch');

    await act(async () => {
      clickButton(renderedContainer, 'Switch to branch feature/safe-switch');
    });

    expect(
      renderedContainer.querySelector(
        '[data-testid="branch-switch-confirmation"]',
      ),
    ).toBeTruthy();
    expect(onCheckoutProjectBranch).not.toHaveBeenCalled();

    await act(async () => {
      clickButton(renderedContainer, 'Confirm Branch Switch');
    });

    expect(onCheckoutProjectBranch).toHaveBeenCalledWith('feature/safe-switch');
    expect(
      renderedContainer.querySelector('[data-testid="branch-menu"]'),
    ).toBeNull();
  });

  it('creates branches from the compact topbar menu', async () => {
    const branches: DesktopGitBranch[] = [
      { name: 'main', current: true },
      { name: 'feature/safe-switch', current: false },
    ];
    const onListProjectBranches = vi.fn(async () => branches);
    const onCreateProjectBranch = vi.fn(async () => undefined);
    const renderedContainer = renderWorkspace({
      onListProjectBranches,
      onCreateProjectBranch,
    });

    await act(async () => {
      clickButton(renderedContainer, 'Branch main');
    });

    const createForm = renderedContainer.querySelector(
      '[data-testid="branch-create-form"]',
    );
    const input = createForm?.querySelector(
      'input[aria-label="New branch name"]',
    );
    const createButton = createForm?.querySelector('button[type="submit"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(createButton).toBeInstanceOf(HTMLButtonElement);
    expect((createButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'feature/new-task');
    });
    expect((createButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      (createButton as HTMLButtonElement).click();
    });

    expect(onCreateProjectBranch).toHaveBeenCalledWith('feature/new-task');
    expect(
      renderedContainer.querySelector('[data-testid="branch-menu"]'),
    ).toBeNull();
  });

  it('validates compact branch creation names before submitting', async () => {
    const branches: DesktopGitBranch[] = [
      { name: 'main', current: true },
      { name: 'feature/safe-switch', current: false },
    ];
    const onListProjectBranches = vi.fn(async () => branches);
    const onCreateProjectBranch = vi.fn(async () => undefined);
    const renderedContainer = renderWorkspace({
      onListProjectBranches,
      onCreateProjectBranch,
    });

    await act(async () => {
      clickButton(renderedContainer, 'Branch main');
    });

    const createForm = renderedContainer.querySelector(
      '[data-testid="branch-create-form"]',
    );
    const input = createForm?.querySelector(
      'input[aria-label="New branch name"]',
    );
    const createButton = createForm?.querySelector('button[type="submit"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(createButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'main');
    });

    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      renderedContainer.querySelector('[data-testid="branch-create-error"]')
        ?.textContent,
    ).toContain('already exists');

    for (const invalidBranchName of [
      ' feature/leading-space',
      'feature/has space',
      '../escape',
      '-option-looking',
      'feature/name.lock',
    ]) {
      await act(async () => {
        setInputValue(input as HTMLInputElement, invalidBranchName);
      });

      expect((createButton as HTMLButtonElement).disabled).toBe(true);
      expect(
        renderedContainer.querySelector('[data-testid="branch-create-error"]')
          ?.textContent,
      ).not.toBe('');
    }

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'feature/new-task');
    });

    expect(
      renderedContainer.querySelector('[data-testid="branch-create-error"]'),
    ).toBeNull();
    expect((createButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      (createButton as HTMLButtonElement).click();
    });

    expect(onCreateProjectBranch).toHaveBeenCalledTimes(1);
    expect(onCreateProjectBranch).toHaveBeenCalledWith('feature/new-task');
  });

  it('keeps stale create validation out of branch switch confirmation', async () => {
    const branches: DesktopGitBranch[] = [
      { name: 'main', current: true },
      { name: 'feature/safe-switch', current: false },
    ];
    const renderedContainer = renderWorkspace({
      onListProjectBranches: vi.fn(async () => branches),
    });

    await act(async () => {
      clickButton(renderedContainer, 'Branch main');
    });

    const input = renderedContainer.querySelector(
      'input[aria-label="New branch name"]',
    );
    expect(input).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'feature/has space');
    });

    expect(
      renderedContainer.querySelector('[data-testid="branch-create-error"]'),
    ).toBeTruthy();

    await act(async () => {
      clickButton(renderedContainer, 'Switch to branch feature/safe-switch');
    });

    expect(
      renderedContainer.querySelector(
        '[data-testid="branch-switch-confirmation"]',
      ),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="branch-create-error"]'),
    ).toBeNull();
  });

  it('keeps the composer enabled for an active project with no thread', () => {
    const renderedContainer = renderWorkspace({
      activeSessionId: null,
      isDraftSession: false,
      sessions: [],
    });
    const textarea = getMessageTextArea(renderedContainer);
    const permissionMode = renderedContainer.querySelector(
      'select[aria-label="Permission mode"]',
    );
    const permissionControl = renderedContainer.querySelector(
      '[data-testid="composer-mode-control"]',
    );
    const model = renderedContainer.querySelector('select[aria-label="Model"]');
    const modelControl = renderedContainer.querySelector(
      '[data-testid="composer-model-control"]',
    );
    const attachButton = renderedContainer.querySelector(
      '[data-testid="composer-attach-button"]',
    );
    const modelSettingsButton = renderedContainer.querySelector(
      '[data-testid="composer-model-settings-button"]',
    );
    const stopButton = renderedContainer.querySelector(
      'button[aria-label="Stop"]',
    );
    const sendButton = renderedContainer.querySelector(
      'button[aria-label="Send"]',
    );

    expect(textarea.disabled).toBe(false);
    expect(textarea.placeholder).toBe('Ask Qwen Code about example-workspace');
    expect(
      renderedContainer.querySelector('[data-testid="conversation-empty"]')
        ?.textContent,
    ).toContain('Start a task in example-workspace');
    expect(renderedContainer.textContent).toContain(
      'Start a task in example-workspace',
    );
    expect(renderedContainer.textContent).toContain('New thread');
    expect(
      renderedContainer.querySelector(
        '[data-testid="composer-disabled-reason"]',
      ),
    ).toBeNull();
    expect(permissionMode).toBeInstanceOf(HTMLSelectElement);
    expect((permissionMode as HTMLSelectElement).disabled).toBe(true);
    expect(permissionMode?.getAttribute('title')).toBe(
      'Ask before run - Ask before running commands.',
    );
    expect(permissionControl?.getAttribute('title')).toBe(
      'Ask before run - Ask before running commands.',
    );
    expect(
      permissionControl?.querySelector('.composer-select-leading-icon'),
    ).toBeTruthy();
    expect(
      permissionControl?.querySelector('.composer-select-chevron'),
    ).toBeTruthy();
    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect((model as HTMLSelectElement).disabled).toBe(true);
    expect(model?.getAttribute('title')).toBe('Default model');
    expect(modelControl?.getAttribute('title')).toBe('Default model');
    expect(
      modelControl?.querySelector('.composer-select-leading-icon'),
    ).toBeTruthy();
    expect(
      modelControl?.querySelector('.composer-select-chevron'),
    ).toBeTruthy();
    expect(attachButton).toBeInstanceOf(HTMLButtonElement);
    expect((attachButton as HTMLButtonElement).disabled).toBe(false);
    expect(attachButton?.getAttribute('aria-disabled')).toBe('true');
    expect(attachButton?.getAttribute('aria-describedby')).toBe(
      'composer-attachment-help',
    );
    expect(attachButton?.getAttribute('title')).toBe(
      'Attachments are not available yet',
    );
    expect(attachButton?.textContent).not.toContain('+');
    expect(
      renderedContainer.querySelector('#composer-attachment-help')?.textContent,
    ).toContain('Attachments are not available yet.');
    expect(modelSettingsButton).toBeInstanceOf(HTMLButtonElement);
    expect(modelSettingsButton?.getAttribute('aria-label')).toBe(
      'Configure models',
    );
    expect(modelSettingsButton?.getAttribute('title')).toBe('Configure models');
    expect(modelSettingsButton?.querySelector('svg')).toBeTruthy();
    expect(modelSettingsButton?.textContent?.trim()).toBe('');
    for (const [button, title, className] of [
      [stopButton, 'Stop generation', 'composer-stop-button'],
      [sendButton, 'Send message', 'composer-send-button'],
    ] as const) {
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button?.getAttribute('title')).toBe(title);
      expect(button?.querySelector('svg')).toBeTruthy();
      expect(button?.querySelector('.sr-only')).toBeTruthy();
      expect(button?.classList.contains('composer-action-button')).toBe(true);
      expect(button?.classList.contains(className)).toBe(true);
    }
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows saved provider models in the draft composer picker', () => {
    const renderedContainer = renderWorkspace({
      activeSessionId: null,
      isDraftSession: true,
      modelState: {
        ...createInitialModelState(),
        configuredModels: [
          {
            modelId: 'qwen-e2e-cdp',
            name: 'qwen-e2e-cdp',
            description: 'Configured in desktop settings',
          },
          {
            modelId: 'qwen3-coder-next',
            name:
              '[ModelStudio Coding Plan for Global/Intl] ' + 'qwen3-coder-next',
            description: 'Coding Plan global model',
          },
        ],
      },
      sessions: [],
    });
    const model = renderedContainer.querySelector(
      'select[aria-label="Model"]',
    ) as HTMLSelectElement | null;

    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect(model?.disabled).toBe(true);
    expect(model?.value).toBe('qwen-e2e-cdp');
    expect(model?.getAttribute('title')).toBe('qwen-e2e-cdp');
    expect([...(model?.options ?? [])].map((option) => option.value)).toEqual([
      'qwen-e2e-cdp',
      'qwen3-coder-next',
    ]);
    expect(
      [...(model?.querySelectorAll('optgroup') ?? [])].map((group) => ({
        label: group.label,
        values: [...group.querySelectorAll('option')].map(
          (option) => option.value,
        ),
      })),
    ).toEqual([
      { label: 'Saved providers', values: ['qwen-e2e-cdp'] },
      { label: 'Coding Plan', values: ['qwen3-coder-next'] },
    ]);
    expect(model?.options[0]?.textContent).toBe('qwen-e2e-cdp');
    expect(model?.options[1]?.textContent).toBe('qwen3-coder-next');
    expect(model?.options[1]?.title).toBe(
      '[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next',
    );
    expect(renderedContainer.textContent).toContain('New thread');
    expect(renderedContainer.textContent).toContain('qwen-e2e-cdp');
    expect(renderedContainer.textContent).not.toContain('Default model');
    expect(renderedContainer.textContent).not.toContain(
      '[ModelStudio Coding Plan',
    );
  });

  it('opens model provider settings from the composer shortcut', () => {
    const renderedContainer = renderWorkspace({
      activeSessionId: null,
      isDraftSession: false,
      sessions: [],
    });

    act(() => {
      clickButton(renderedContainer, 'Configure models');
    });

    const settingsPage = renderedContainer.querySelector(
      '[data-testid="settings-page"]',
    );
    const providerSelect = renderedContainer.querySelector(
      '[data-testid="settings-provider-select"]',
    );

    expect(settingsPage).toBeTruthy();
    expect(settingsPage?.getAttribute('data-initial-section')).toBe(
      'settings-model-providers',
    );
    expect(providerSelect).toBeInstanceOf(HTMLSelectElement);
    expect(document.activeElement).toBe(providerSelect);
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="runtime-diagnostics"]'),
    ).toBeNull();
    expect(settingsPage?.textContent).not.toContain('sk-desktop-e2e');
  });

  it('shows configured settings models in the active composer picker', () => {
    const onModelChange = vi.fn();
    const renderedContainer = renderWorkspace({
      modelState: {
        ...createInitialModelState(),
        models: {
          currentModelId: 'e2e/qwen-code',
          availableModels: [
            { modelId: 'e2e/qwen-code', name: 'Qwen Code E2E' },
            {
              modelId: 'qwen-e2e-cdp',
              name: 'qwen-e2e-cdp',
              description: 'Configured in desktop settings',
            },
            {
              modelId: 'qwen3-coder-next',
              name:
                '[ModelStudio Coding Plan for Global/Intl] ' +
                'qwen3-coder-next',
              description: 'Coding Plan global model',
            },
          ],
        },
      },
      onModelChange,
    });
    const model = renderedContainer.querySelector('select[aria-label="Model"]');

    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect((model as HTMLSelectElement).disabled).toBe(false);
    expect((model as HTMLSelectElement).value).toBe('e2e/qwen-code');
    expect(
      [...(model as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(['e2e/qwen-code', 'qwen-e2e-cdp', 'qwen3-coder-next']);
    expect(
      [
        ...((model as HTMLSelectElement).querySelectorAll('optgroup') ?? []),
      ].map((group) => ({
        label: group.label,
        values: [...group.querySelectorAll('option')].map(
          (option) => option.value,
        ),
      })),
    ).toEqual([
      { label: 'Active session', values: ['e2e/qwen-code'] },
      { label: 'Saved providers', values: ['qwen-e2e-cdp'] },
      { label: 'Coding Plan', values: ['qwen3-coder-next'] },
    ]);
    expect(renderedContainer.textContent).toContain('qwen-e2e-cdp');
    expect(renderedContainer.textContent).toContain('qwen3-coder-next');
    expect(renderedContainer.textContent).not.toContain(
      '[ModelStudio Coding Plan',
    );
    expect((model as HTMLSelectElement).options[2]?.title).toBe(
      '[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next',
    );
    expect(renderedContainer.textContent).not.toContain('sk-desktop-e2e');

    act(() => {
      setSelectValue(model as HTMLSelectElement, 'qwen-e2e-cdp');
    });

    expect(onModelChange).toHaveBeenCalledWith('qwen-e2e-cdp');
  });

  it('shortens long composer runtime labels while preserving full titles', () => {
    const renderedContainer = renderWorkspace({
      modelState: {
        ...createInitialModelState(),
        modes: {
          currentModeId: 'auto-edit',
          availableModes: [
            {
              id: 'default',
              name: 'Ask before run',
              description: 'Ask before running commands.',
            },
            {
              id: 'auto-edit',
              name: 'Auto edit with long localized permission label for compact',
              description: 'Allow edits while keeping approvals visible.',
            },
          ],
        },
        models: {
          currentModelId: 'provider/very-long-runtime-model',
          availableModels: [
            {
              modelId: 'provider/very-long-runtime-model',
              name: 'provider/very-long-runtime-model-name-for-compact-control',
            },
            {
              modelId: 'qwen3-coder-next',
              name:
                '[ModelStudio Coding Plan for Global/Intl] ' +
                'qwen3-coder-next',
            },
          ],
        },
      },
    });
    const permissionMode = renderedContainer.querySelector(
      'select[aria-label="Permission mode"]',
    ) as HTMLSelectElement | null;
    const model = renderedContainer.querySelector(
      'select[aria-label="Model"]',
    ) as HTMLSelectElement | null;

    expect(permissionMode).toBeInstanceOf(HTMLSelectElement);
    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect(permissionMode?.getAttribute('title')).toBe(
      'Auto edit with long localized permission label for compact - ' +
        'Allow edits while keeping approvals visible.',
    );
    expect(model?.getAttribute('title')).toBe(
      'provider/very-long-runtime-model-name-for-compact-control',
    );
    expect(permissionMode?.options[1]?.textContent).toBe(
      'Auto edit with long...',
    );
    expect(permissionMode?.options[1]?.title).toBe(
      'Auto edit with long localized permission label for compact - ' +
        'Allow edits while keeping approvals visible.',
    );
    expect(model?.options[0]?.textContent).toBe(
      'very-long-runtime-model-name...',
    );
    expect(model?.options[1]?.textContent).toBe('qwen3-coder-next');
    expect(model?.options[1]?.title).toBe(
      '[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next',
    );
    expect(renderedContainer.textContent).not.toContain(
      '[ModelStudio Coding Plan',
    );
  });

  it('shortens settings permissions model labels while preserving titles', () => {
    const onModelChange = vi.fn();
    const renderedContainer = renderWorkspace({
      modelState: {
        ...createInitialModelState(),
        models: {
          currentModelId: 'qwen3-coder-next',
          availableModels: [
            {
              modelId: 'provider/very-long-runtime-model',
              name: 'provider/very-long-runtime-model-name-for-compact-control',
            },
            {
              modelId: 'qwen3.5-plus',
              name: '[ModelStudio Coding Plan] qwen3.5-plus',
            },
            {
              modelId: 'qwen3-coder-next',
              name:
                '[ModelStudio Coding Plan for Global/Intl] ' +
                'qwen3-coder-next',
            },
          ],
        },
      },
      onModelChange,
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const settingsPage = renderedContainer.querySelector(
      '[data-testid="settings-page"]',
    );
    const model = settingsPage?.querySelector(
      'select[aria-label="Thread model"]',
    ) as HTMLSelectElement | null;

    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect(model?.disabled).toBe(false);
    expect(model?.value).toBe('qwen3-coder-next');
    expect(model?.getAttribute('title')).toBe(
      '[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next',
    );
    expect(
      [...(model?.options ?? [])].map((option) => option.textContent),
    ).toEqual([
      'very-long-runtime-model-name...',
      'qwen3.5-plus',
      'qwen3-coder-next',
    ]);
    expect(
      [...(model?.querySelectorAll('optgroup') ?? [])].map((group) => ({
        label: group.label,
        values: [...group.querySelectorAll('option')].map(
          (option) => option.value,
        ),
      })),
    ).toEqual([
      { label: 'Active session', values: ['provider/very-long-runtime-model'] },
      { label: 'Coding Plan', values: ['qwen3.5-plus', 'qwen3-coder-next'] },
    ]);
    expect(model?.options[1]?.title).toBe(
      '[ModelStudio Coding Plan] qwen3.5-plus',
    );
    expect(model?.options[2]?.title).toBe(
      '[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next',
    );
    expect(settingsPage?.textContent).not.toContain('[ModelStudio Coding Plan');

    act(() => {
      setSelectValue(model as HTMLSelectElement, 'qwen3.5-plus');
    });

    expect(onModelChange).toHaveBeenCalledWith('qwen3.5-plus');
  });

  it('shows inline settings validation before saving a model provider', () => {
    const onSaveSettings = vi.fn();
    const renderedContainer = renderWorkspace({
      onSaveSettings,
      settingsState: {
        ...createInitialSettingsState(),
        settings: null,
        form: {
          provider: 'api-key',
          apiKey: '',
          codingPlanRegion: 'china',
          activeModel: 'qwen-plus',
          baseUrl: 'https://example.test/v1',
        },
      },
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const validation = renderedContainer.querySelector(
      '[data-testid="settings-save-validation"]',
    );
    const saveButton = [...renderedContainer.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );

    expect(validation?.textContent).toContain('Enter an API key');
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton?.getAttribute('aria-describedby')).toBe(
      'settings-save-validation',
    );

    act(() => {
      (saveButton as HTMLButtonElement).click();
    });

    expect(onSaveSettings).not.toHaveBeenCalled();
  });

  it('exposes keyboard-focusable provider controls in model settings', () => {
    const onSettingsDispatch = vi.fn();
    const renderedContainer = renderWorkspace({ onSettingsDispatch });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const provider = renderedContainer.querySelector(
      'select[aria-label="Model provider"]',
    );
    const model = renderedContainer.querySelector(
      'input[aria-label="Provider model"]',
    );
    const baseUrl = renderedContainer.querySelector(
      'input[aria-label="Provider base URL"]',
    );
    const apiKey = renderedContainer.querySelector(
      'input[aria-label="Provider API key"]',
    );

    expect(provider).toBeInstanceOf(HTMLSelectElement);
    expect(model).toBeInstanceOf(HTMLInputElement);
    expect(baseUrl).toBeInstanceOf(HTMLInputElement);
    expect(apiKey).toBeInstanceOf(HTMLInputElement);

    (provider as HTMLSelectElement).focus();
    expect(document.activeElement).toBe(provider);

    act(() => {
      setSelectValue(provider as HTMLSelectElement, 'coding-plan');
    });

    expect(onSettingsDispatch).toHaveBeenCalledWith({
      type: 'set_provider',
      provider: 'coding-plan',
    });
  });

  it('renders Coding Plan provider fields with provider-specific validation', () => {
    const renderedContainer = renderWorkspace({
      settingsState: {
        ...createInitialSettingsState(),
        settings: null,
        form: {
          provider: 'coding-plan',
          apiKey: '',
          codingPlanRegion: 'global',
          activeModel: 'qwen-plus',
          baseUrl: 'https://example.test/v1',
        },
      },
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const provider = renderedContainer.querySelector(
      'select[aria-label="Model provider"]',
    );
    const region = renderedContainer.querySelector(
      'select[aria-label="Coding Plan region"]',
    );
    const apiKey = renderedContainer.querySelector(
      'input[aria-label="Provider API key"]',
    );
    const saveButton = [...renderedContainer.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );

    expect(provider).toBeInstanceOf(HTMLSelectElement);
    expect((provider as HTMLSelectElement).value).toBe('coding-plan');
    expect(region).toBeInstanceOf(HTMLSelectElement);
    expect((region as HTMLSelectElement).value).toBe('global');
    expect(apiKey).toBeInstanceOf(HTMLInputElement);
    expect((apiKey as HTMLInputElement).type).toBe('password');
    expect(
      renderedContainer.querySelector('input[aria-label="Provider model"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('input[aria-label="Provider base URL"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector(
        '[data-testid="settings-save-validation"]',
      )?.textContent,
    ).toContain('Enter a Coding Plan API key');
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows settings save when a provider has a saved API key', () => {
    const onSaveSettings = vi.fn();
    const settings = createSettings();
    const renderedContainer = renderWorkspace({
      onSaveSettings,
      settingsState: {
        ...createInitialSettingsState(),
        settings,
        form: {
          provider: 'api-key',
          apiKey: '',
          codingPlanRegion: 'china',
          activeModel: 'qwen-plus',
          baseUrl: 'https://example.test/v1',
        },
      },
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const saveButton = [...renderedContainer.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );

    expect(
      renderedContainer.querySelector(
        '[data-testid="settings-save-validation"]',
      ),
    ).toBeNull();
    expect(saveButton).toBeInstanceOf(HTMLButtonElement);
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      (saveButton as HTMLButtonElement).click();
    });

    expect(onSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('shows compact saved model provider feedback without secrets', () => {
    const savedSettingsState = settingsReducer(createInitialSettingsState(), {
      type: 'save_success',
      settings: createSettings(),
    });
    const renderedContainer = renderWorkspace({
      settingsState: savedSettingsState,
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const status = renderedContainer.querySelector(
      '[data-testid="settings-save-status"]',
    );
    const saveButton = [...renderedContainer.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );
    const settingsText =
      renderedContainer.querySelector('[data-testid="settings-page"]')
        ?.textContent ?? '';
    const apiKey = renderedContainer.querySelector(
      'input[aria-label="Provider API key"]',
    );

    expect(status).toBeTruthy();
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.classList.contains('settings-save-status-saved')).toBe(true);
    expect(status?.textContent).toBe(
      'Saved API key provider · qwen-plus · API key configured',
    );
    expect(saveButton?.getAttribute('aria-describedby')).toBe(
      'settings-save-status',
    );
    expect(apiKey).toBeInstanceOf(HTMLInputElement);
    expect((apiKey as HTMLInputElement).type).toBe('password');
    expect((apiKey as HTMLInputElement).value).toBe('');
    expect(settingsText).not.toContain('sk-desktop-e2e');
  });

  it('shows model provider save failures as inline alerts', () => {
    const loadedSettingsState = settingsReducer(createInitialSettingsState(), {
      type: 'load_success',
      settings: createSettings(),
    });
    const failedSettingsState = settingsReducer(loadedSettingsState, {
      type: 'save_error',
      message: 'Desktop service unavailable.',
    });
    const renderedContainer = renderWorkspace({
      settingsState: failedSettingsState,
    });

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    const status = renderedContainer.querySelector(
      '[data-testid="settings-save-status"]',
    );
    const saveButton = [...renderedContainer.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );

    expect(status).toBeTruthy();
    expect(status?.getAttribute('role')).toBe('alert');
    expect(status?.classList.contains('settings-save-status-error')).toBe(true);
    expect(status?.textContent).toBe(
      'Could not save model provider settings: Desktop service unavailable.',
    );
    expect(saveButton?.getAttribute('aria-describedby')).toBe(
      'settings-save-status',
    );
  });

  it('bounds the inline changed-files summary before opening review', () => {
    const manyFileDiff: DesktopGitDiff = {
      ...gitDiff,
      files: Array.from({ length: 5 }, (_, index) => ({
        ...gitDiff.files[0],
        path: `src/file-${index}.ts`,
      })),
    };
    const renderedContainer = renderWorkspace({ gitDiff: manyFileDiff });
    const summary = renderedContainer.querySelector(
      '[data-testid="conversation-changes-summary"]',
    );
    const rows = summary?.querySelectorAll('ul[aria-label="Changed files"] li');

    expect(summary?.textContent).toContain('5 files changed');
    expect(rows).toHaveLength(4);
    expect(summary?.textContent).toContain('src/file-0.ts');
    expect(summary?.textContent).toContain('src/file-2.ts');
    expect(summary?.textContent).toContain('Modified · Unstaged');
    expect(summary?.textContent).toContain('2 more');
    expect(summary?.textContent).toContain('Open review');
    expect(summary?.textContent).not.toContain('src/file-4.ts');
    expect(summary?.textContent).not.toContain('CHANGED FILES');
    expect(summary?.textContent).not.toContain('MODIFIED · UNSTAGED');
    expect(summary?.querySelector('.message-role')).toBeNull();
    expect(
      summary?.querySelector('button[aria-label="Review Changes"]'),
    ).toBeTruthy();
    expect(
      summary?.querySelector('button[aria-label="Review Changes"]')
        ?.textContent,
    ).toContain('Review');
    expect(
      summary?.querySelector('button[aria-label="Review Changes"] svg'),
    ).toBeTruthy();

    act(() => {
      (
        summary?.querySelector(
          'button[aria-label="Review Changes"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
  });

  it('shows a clear disabled composer reason with no active project', () => {
    const renderedContainer = renderWorkspace({
      activeProject: null,
      activeProjectId: null,
      activeSessionId: null,
      isDraftSession: false,
      projects: [],
      sessions: [],
    });
    const textarea = getMessageTextArea(renderedContainer);

    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe('Open a project to start');
    expect(
      renderedContainer.querySelector('[data-testid="conversation-empty"]')
        ?.textContent,
    ).toBe('Open a project to start');
    expect(
      renderedContainer.querySelector(
        '[data-testid="composer-disabled-reason"]',
      )?.textContent,
    ).toBe('Open a project to start');
    expect(renderedContainer.textContent).toContain('Open a project to start');
  });

  it('submits on Enter and keeps Shift+Enter as a newline path', () => {
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) {
      this.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    };
    const onSendMessage = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    try {
      const renderedContainer = renderWorkspace({
        activeSessionId: null,
        isDraftSession: false,
        messageText: 'hello from keyboard',
        sessions: [],
        onSendMessage,
      });
      const textarea = getMessageTextArea(renderedContainer);
      const sendButton = renderedContainer.querySelector(
        'button[aria-label="Send"]',
      );

      expect(sendButton).toBeInstanceOf(HTMLButtonElement);
      expect((sendButton as HTMLButtonElement).disabled).toBe(false);

      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            shiftKey: true,
          }),
        );
      });

      expect(onSendMessage).not.toHaveBeenCalled();

      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
          }),
        );
      });

      expect(onSendMessage).toHaveBeenCalledTimes(1);
    } finally {
      HTMLFormElement.prototype.requestSubmit = originalRequestSubmit;
    }
  });

  it('renders command approvals inline in the conversation timeline', () => {
    const onPermissionResponse = vi.fn();
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'permission_request',
        requestId: 'permission-1',
        request: {
          sessionId: session.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            kind: 'execute',
            title: 'Run tests',
            status: 'pending',
            rawInput: 'npm test',
          },
          options: [
            {
              optionId: 'approve_once',
              name: 'Approve Once',
              kind: 'allow_once',
            },
            {
              optionId: 'deny',
              name: 'Deny',
              kind: 'reject_once',
            },
          ],
        },
      },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onPermissionResponse,
    });
    const approvalCard = renderedContainer.querySelector(
      '[data-testid="conversation-approval-card"]',
    );

    expect(approvalCard).toBeTruthy();
    expect(approvalCard?.textContent).toContain('Execute');
    expect(approvalCard?.textContent).toContain('Needs approval');
    expect(approvalCard?.textContent).toContain('Run tests');
    expect(approvalCard?.textContent).toContain('npm test');
    expect(approvalCard?.textContent).not.toContain('EXECUTE');
    expect(approvalCard?.textContent).not.toContain('PENDING');
    expect(approvalCard?.querySelector('.message-role')).toBeNull();
    expect(
      approvalCard?.querySelector('.conversation-prompt-label')?.textContent,
    ).toBe('Execute');
    expect(
      approvalCard?.querySelector('.conversation-approval-status')?.textContent,
    ).toBe('Needs approval');
    expect(renderedContainer.querySelector('.permission-strip')).toBeNull();
    expect(renderedContainer.textContent).not.toContain('Permission requested');

    act(() => {
      clickButton(renderedContainer, 'Approve Once');
    });

    expect(onPermissionResponse).toHaveBeenCalledWith(
      'permission-1',
      'approve_once',
    );
  });

  it('renders ask-user-question prompts with restrained product labels', () => {
    const onAskUserQuestionResponse = vi.fn();
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'ask_user_question',
        requestId: 'question-1',
        request: {
          sessionId: session.sessionId,
          questions: [
            {
              header: 'CHOICE',
              question: 'Pick a branch strategy',
              multiSelect: false,
              options: [
                {
                  label: 'Create branch',
                  description: 'Create a focused branch for this work.',
                },
              ],
            },
          ],
          metadata: { source: 'test' },
        },
      },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onAskUserQuestionResponse,
    });
    const questionCard = renderedContainer.querySelector(
      '[data-testid="conversation-question-card"]',
    );
    const questionText = questionCard?.textContent ?? '';

    expect(questionCard).toBeTruthy();
    expect(questionText).toContain('Question');
    expect(questionText).toContain('Input needed');
    expect(questionText).toContain('Waiting');
    expect(questionText).toContain('Choice');
    expect(questionText).toContain('Pick a branch strategy');
    expect(questionText).toContain('Create branch');
    expect(questionText).not.toContain('QUESTION');
    expect(questionText).not.toContain('WAITING');
    expect(questionCard?.querySelector('.message-role')).toBeNull();
    expect(
      questionCard?.querySelector('.conversation-prompt-label')?.textContent,
    ).toBe('Question');
    expect(
      questionCard?.querySelector('.conversation-question-label')?.textContent,
    ).toBe('Choice');

    act(() => {
      clickButton(renderedContainer, 'Submit Question');
    });

    expect(onAskUserQuestionResponse).toHaveBeenCalledWith(
      'question-1',
      'proceed_once',
    );
  });

  it('renders plan activity with restrained product labels', () => {
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'plan',
        entries: [
          {
            content: 'Inspect the opened project',
            status: 'completed',
          },
          {
            content: 'Request command approval',
            status: 'in_progress',
          },
        ],
      },
    });

    const renderedContainer = renderWorkspace({ chatState });
    const planCard = renderedContainer.querySelector(
      '[data-testid="conversation-plan-card"]',
    );
    const planText = planCard?.textContent ?? '';

    expect(planCard).toBeTruthy();
    expect(planText).toContain('Plan');
    expect(planText).toContain('2 tasks');
    expect(planText).toContain('Completed');
    expect(planText).toContain('In progress');
    expect(planText).toContain('Inspect the opened project');
    expect(planText).not.toContain('COMPLETED');
    expect(planText).not.toContain('IN_PROGRESS');
    expect(
      planCard?.querySelector('.conversation-plan-status-completed'),
    ).toBeTruthy();
  });

  it('renders rich tool activity cards with file references', () => {
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'tool_call',
        data: {
          toolCallId: 'internal-tool-123',
          kind: 'execute',
          title: 'Run focused tests',
          status: 'completed',
          rawInput: {
            command: 'npm test -- WorkspacePage.test.tsx',
            sessionId: 'session-should-stay-hidden',
          },
          rawOutput: 'tests passed',
          locations: [{ path: 'src/renderer/WorkspacePage.tsx', line: 42 }],
        },
      },
    });

    const renderedContainer = renderWorkspace({ chatState });
    const toolCard = renderedContainer.querySelector(
      '[data-testid="conversation-tool-card"]',
    );
    const toolText = toolCard?.textContent ?? '';

    expect(toolCard).toBeTruthy();
    expect(toolText).toContain('Execute');
    expect(toolText).toContain('Run focused tests');
    expect(toolText).toContain('Completed');
    expect(toolText).toContain('npm test -- WorkspacePage.test.tsx');
    expect(toolText).toContain('tests passed');
    expect(toolText).toContain('src/renderer/WorkspacePage.tsx:42');
    expect(toolText).toContain('Input');
    expect(toolText).toContain('Result');
    expect(toolText).not.toContain('INPUT');
    expect(toolText).not.toContain('RESULT');
    expect(
      toolCard?.querySelector('pre[aria-label="Tool input preview"]'),
    ).toBeTruthy();
    expect(
      toolCard?.querySelector('pre[aria-label="Tool result preview"]'),
    ).toBeTruthy();
    expect(toolText).not.toContain('internal-tool-123');
    expect(toolText).not.toContain('session-should-stay-hidden');
    expect(renderedContainer.querySelector('.chat-tool')).toBeNull();
  });

  it('renders assistant message actions and clickable file reference chips', () => {
    const onCopyMessage = vi.fn();
    const onOpenReviewFile = vi.fn();
    const onRetryMessage = vi.fn();
    let chatState = chatReducer(createInitialChatState(), {
      type: 'append_user_message',
      content: 'Summarize the project changes',
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text: 'Updated README.md:1 and packages/desktop/src/renderer/App.tsx:12.',
      },
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: { type: 'message_complete' },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onCopyMessage,
      onOpenFileReference: onOpenReviewFile,
      onOpenReviewFile,
      onRetryMessage,
    });
    const assistantMessage = renderedContainer.querySelector(
      '[data-testid="assistant-message"]',
    );
    const userMessage = renderedContainer.querySelector('.chat-message-user');
    const actionRow = renderedContainer.querySelector(
      '[data-testid="assistant-message-actions"]',
    );
    const fileReferences = renderedContainer.querySelector(
      '[data-testid="assistant-file-references"]',
    );

    expect(assistantMessage?.textContent).toContain('README.md:1');
    expect(assistantMessage?.getAttribute('aria-label')).toBe(
      'Assistant message',
    );
    expect(userMessage?.getAttribute('aria-label')).toBe('User message');
    expect(assistantMessage?.querySelector('.message-role')).toBeNull();
    expect(userMessage?.querySelector('.message-role')).toBeNull();
    expect(assistantMessage?.textContent).not.toContain('Assistant message');
    expect(userMessage?.textContent).not.toContain('User message');
    expect(actionRow).toBeTruthy();
    for (const action of actionRow?.querySelectorAll('button') ?? []) {
      expect(action.querySelector('svg')).toBeTruthy();
    }
    expect(fileReferences?.textContent).toContain('README.md:1');
    expect(fileReferences?.textContent).toContain(
      'packages/desktop/src/renderer/App.tsx:12',
    );

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Copy Response"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onCopyMessage).toHaveBeenCalledWith(
      'Updated README.md:1 and packages/desktop/src/renderer/App.tsx:12.',
    );

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Retry Last Prompt"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onRetryMessage).toHaveBeenCalledWith(
      'Summarize the project changes',
    );

    act(() => {
      (
        fileReferences?.querySelector(
          'button[aria-label="Open README.md:1"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onOpenReviewFile).toHaveBeenCalledWith('README.md');

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Open Changes"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
  });

  it('deduplicates and bounds dense assistant file reference chips', () => {
    const onOpenFileReference = vi.fn();
    let chatState = chatReducer(createInitialChatState(), {
      type: 'append_user_message',
      content: 'List the touched files',
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text:
          'Touched README.md:1, README.md:1 again, ' +
          'packages/desktop/src/renderer/App.tsx:12:5, .env.example, ' +
          'Dockerfile, docs/guide.mdx, src/App.vue, Makefile, ' +
          'and config/settings.mts.',
      },
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: { type: 'message_complete' },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onOpenFileReference,
    });
    const fileReferences = renderedContainer.querySelector(
      '[data-testid="assistant-file-references"]',
    );
    const labels = [...(fileReferences?.querySelectorAll('button') ?? [])].map(
      (button) => button.getAttribute('aria-label'),
    );
    const overflow = fileReferences?.querySelector(
      '.message-file-reference-overflow',
    );

    expect(labels).toEqual([
      'Open README.md:1',
      'Open packages/desktop/src/renderer/App.tsx:12:5',
      'Open .env.example',
      'Open Dockerfile',
      'Open docs/guide.mdx',
      'Open src/App.vue',
    ]);
    expect(labels.filter((label) => label === 'Open README.md:1')).toHaveLength(
      1,
    );
    expect(overflow?.textContent).toBe('+2 more');
    expect(overflow?.getAttribute('aria-label')).toBe('2 more file references');

    act(() => {
      (
        fileReferences?.querySelector(
          'button[aria-label="Open packages/desktop/src/renderer/App.tsx:12:5"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(onOpenFileReference).toHaveBeenCalledWith(
      'packages/desktop/src/renderer/App.tsx',
    );
  });

  it('routes terminal output through an attach action', () => {
    const onAttachTerminalOutput = vi.fn();
    const renderedContainer = renderWorkspace({
      onAttachTerminalOutput,
      terminal,
    });

    act(() => {
      clickButton(renderedContainer, 'Expand Terminal');
    });

    const attachButton = renderedContainer.querySelector(
      'button[aria-label="Attach Output"]',
    );
    expect(attachButton).toBeInstanceOf(HTMLButtonElement);
    expect((attachButton as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      clickButton(renderedContainer, 'Attach Output');
    });

    expect(onAttachTerminalOutput).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before discarding review changes', () => {
    const onRevertReviewTarget = vi.fn();
    const renderedContainer = renderWorkspace({ onRevertReviewTarget });

    act(() => {
      clickButton(renderedContainer, 'Open Changes');
    });

    act(() => {
      clickButton(renderedContainer, 'Discard All');
    });

    expect(
      renderedContainer.querySelector('[data-testid="discard-confirmation"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain(
      'Discard all local changes?',
    );
    expect(onRevertReviewTarget).not.toHaveBeenCalled();

    act(() => {
      clickButton(renderedContainer, 'Cancel Discard');
    });

    expect(
      renderedContainer.querySelector('[data-testid="discard-confirmation"]'),
    ).toBeNull();
    expect(onRevertReviewTarget).not.toHaveBeenCalled();

    act(() => {
      clickButton(renderedContainer, 'Discard All');
    });
    act(() => {
      clickButton(renderedContainer, 'Confirm Discard');
    });

    expect(onRevertReviewTarget).toHaveBeenCalledWith({ scope: 'all' });
  });

  it('normalizes noisy session titles in navigation chrome', () => {
    const noisySession: DesktopSessionSummary = {
      sessionId: 'session-noisy-1',
      title:
        'Review /Users/dragon/Documents/qwen-code/packages/desktop/README.md after the failing test in http://127.0.0.1:47891/session session-e2e-deadbeef desktopE2EThreadTitleNoiseToken_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      cwd: project.path,
      updatedAt: '2026-04-25T00:00:01.000Z',
    };
    const untitledSession: DesktopSessionSummary = {
      sessionId: 'session-e2e-deadbeef',
      cwd: project.path,
    };
    const renderedContainer = renderWorkspace({
      activeSessionId: noisySession.sessionId,
      sessions: [noisySession, untitledSession],
    });
    const sidebarText =
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent ?? '';
    const topbarTitle =
      renderedContainer.querySelector('[data-testid="topbar-title"]')
        ?.textContent ?? '';
    const topbarHeading = renderedContainer.querySelector(
      '[data-testid="topbar-title"] h2',
    );
    const firstThreadTitle = renderedContainer.querySelector(
      '[data-testid="thread-row"] .session-row-title',
    );
    const untitledThread = [
      ...renderedContainer.querySelectorAll('[data-testid="thread-row"]'),
    ].find((row) => row.textContent?.includes('Untitled thread'));

    expect(sidebarText).toContain('Review README.md after the failing test');
    expect(sidebarText).toContain('Untitled thread');
    expect(topbarTitle).toContain('Review README.md after the failing test');
    expect(topbarHeading?.textContent).toBe(
      'Review README.md after the failing test',
    );
    expect(firstThreadTitle?.textContent).toBe(
      'Review README.md after the failing test',
    );
    expect(untitledThread?.getAttribute('aria-label')).toBe('Untitled thread');

    for (const noisyText of [
      '/Users/dragon',
      '127.0.0.1',
      'local server',
      'local...',
      'session-e2e-deadbeef',
      'desktopE2EThreadTitleNoiseToken',
    ]) {
      expect(sidebarText).not.toContain(noisyText);
      expect(topbarTitle).not.toContain(noisyText);
    }
  });
});

type WorkspacePageProps = Parameters<typeof WorkspacePage>[0];

function renderWorkspace(
  overrides: Partial<WorkspacePageProps> = {},
): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const props: WorkspacePageProps = {
    activeProject: project,
    activeProjectId: project.id,
    activeSessionId: session.sessionId,
    chatState: createInitialChatState(),
    commitMessage: '',
    gitDiff,
    loadState: readyLoadState,
    messageText: '',
    modelState: createInitialModelState(),
    isDraftSession: false,
    projects: [project],
    reviewError: null,
    sessionError: null,
    sessions: [session],
    settingsState: createInitialSettingsState(),
    statusLabel: 'Connected',
    terminal: null,
    terminalCommand: '',
    terminalError: null,
    terminalInput: '',
    terminalNotice: null,
    chatNotice: null,
    onAskUserQuestionResponse: vi.fn(),
    onAuthenticate: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onClearTerminal: vi.fn(),
    onCommit: vi.fn(),
    onCommitMessageChange: vi.fn(),
    onCopyMessage: vi.fn(),
    onCopyTerminalOutput: vi.fn(),
    onCreateProjectBranch: vi.fn(async () => undefined),
    onCreateSession: vi.fn(),
    onKillTerminal: vi.fn(),
    onMessageTextChange: vi.fn(),
    onModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onOpenFileReference: vi.fn(),
    onPermissionResponse: vi.fn(),
    onRefreshProjectGitStatus: vi.fn(),
    onListProjectBranches: vi.fn(async () => []),
    onCheckoutProjectBranch: vi.fn(async () => undefined),
    onOpenReviewFile: vi.fn(),
    onRevertReviewTarget: vi.fn(),
    onRunTerminalCommand: vi.fn(),
    onSaveSettings: vi.fn(),
    onAttachTerminalOutput: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onSendMessage: (event) => event.preventDefault(),
    onSettingsDispatch: vi.fn(),
    onStageReviewTarget: vi.fn(),
    onStopGeneration: vi.fn(),
    onRetryMessage: vi.fn(),
    onTerminalCommandChange: vi.fn(),
    onTerminalInputChange: vi.fn(),
    onWriteTerminalInput: vi.fn(),
    ...overrides,
  };

  act(() => {
    root?.render(<WorkspacePage {...props} />);
  });

  if (!container) {
    throw new Error('WorkspacePage test container was not created.');
  }

  return container;
}

function getMessageTextArea(
  renderedContainer: HTMLElement,
): HTMLTextAreaElement {
  const textarea = renderedContainer.querySelector(
    'textarea[aria-label="Message"]',
  );
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Message textarea was not rendered.');
  }

  return textarea;
}

function clickButton(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll('button')].find((candidate) => {
    const accessibleLabel =
      candidate.getAttribute('aria-label') || candidate.getAttribute('title');
    return (
      accessibleLabel === text ||
      candidate.textContent?.trim() === text ||
      candidate.textContent?.trim().includes(text)
    );
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }

  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  );
  descriptor?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const project: DesktopProject = {
  id: 'project-1',
  name: 'example-workspace',
  path: '/tmp/example-workspace',
  gitBranch: 'main',
  gitStatus: {
    branch: 'main',
    modified: 1,
    staged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    clean: false,
    isRepository: true,
  },
  lastOpenedAt: 1_774_704_300_000,
};

const session: DesktopSessionSummary = {
  sessionId: 'session-1',
  title: 'Fix parser test',
  cwd: project.path,
};

const terminal: DesktopTerminal = {
  id: 'terminal-1',
  projectId: project.id,
  cwd: project.path,
  command: 'printf terminal-output',
  status: 'exited',
  output: 'terminal-output',
  exitCode: 0,
  signal: null,
  createdAt: '2026-04-25T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:01.000Z',
};

const gitDiff: DesktopGitDiff = {
  ok: true,
  generatedAt: '2026-04-25T00:00:00.000Z',
  diff: 'diff --git a/src/index.ts b/src/index.ts',
  files: [
    {
      path: 'src/index.ts',
      status: 'modified',
      staged: false,
      unstaged: true,
      untracked: false,
      diff: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;',
      hunks: [
        {
          id: 'hunk-1',
          source: 'unstaged',
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-export const value = 1;', '+export const value = 2;'],
        },
      ],
    },
  ],
};

const readyStatus: DesktopConnectionStatus = {
  serverInfo: {
    url: 'http://127.0.0.1:47891',
    token: 'test-token',
  },
  serverUrl: 'http://127.0.0.1:47891',
  health: {
    ok: true,
    service: 'qwen-desktop',
    uptimeMs: 42,
    timestamp: '2026-04-25T00:00:00.000Z',
  },
  runtime: {
    ok: true,
    desktop: {
      version: '0.15.2',
      electronVersion: '41.3.0',
      nodeVersion: '20.19.0',
    },
    cli: {
      path: '/tmp/qwen',
      channel: 'ACP',
      acpReady: true,
    },
    platform: {
      type: 'darwin',
      arch: 'arm64',
      release: '25.0.0',
    },
    auth: {
      status: 'unknown',
      account: null,
    },
  },
};

const readyLoadState: LoadState = {
  state: 'ready',
  status: readyStatus,
};

function createSettings(): DesktopUserSettings {
  return {
    ok: true,
    settingsPath: '/tmp/settings.json',
    provider: 'api-key',
    selectedAuthType: 'openai',
    model: { name: 'qwen-plus' },
    codingPlan: {
      region: 'china',
      hasApiKey: false,
      version: null,
    },
    openai: {
      hasApiKey: true,
      providers: [
        {
          id: 'qwen-plus',
          name: 'Qwen Plus',
          baseUrl: 'https://example.test/v1',
          envKey: 'OPENAI_API_KEY',
        },
      ],
    },
  };
}
