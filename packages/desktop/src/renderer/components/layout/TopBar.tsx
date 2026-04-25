/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject } from '../../api/client.js';
import { formatGitStatus } from './formatters.js';
import {
  ChatBubbleIcon,
  DiffIcon,
  RefreshIcon,
  SlidersIcon,
} from './SidebarIcons.js';
import { StatusPill } from './StatusPill.js';
import type { LoadState } from './types.js';

export function TopBar({
  activeProject,
  activeSessionTitle,
  activeView,
  isReviewOpen,
  loadState,
  onRefreshGitStatus,
  onShowReview,
  onShowChat,
  onShowSettings,
  statusLabel,
}: {
  activeProject: DesktopProject | null;
  activeSessionTitle: string | null;
  activeView: 'chat' | 'settings';
  isReviewOpen: boolean;
  loadState: LoadState;
  onRefreshGitStatus: () => void;
  onShowReview: () => void;
  onShowChat: () => void;
  onShowSettings: () => void;
  statusLabel: string;
}) {
  const title = getTopBarTitle(activeView, activeSessionTitle, activeProject);
  const projectLabel = activeProject?.name ?? 'No project selected';
  const changedCount = activeProject ? getChangedCount(activeProject) : 0;
  const reviewLabel = isReviewOpen ? 'Close Changes' : 'Open Changes';

  return (
    <header
      className="topbar"
      aria-label="Workspace status"
      data-testid="workspace-topbar"
    >
      <div className="topbar-title-stack">
        <div className="topbar-title">
          <h2>{title}</h2>
          <span>{projectLabel}</span>
        </div>
        <div className="topbar-meta">
          <span>{statusLabel}</span>
          <span>{activeProject?.gitBranch || 'No Git branch'}</span>
          <span>
            {activeProject
              ? formatGitStatus(activeProject.gitStatus)
              : 'No project'}
          </span>
        </div>
      </div>

      <div className="topbar-actions" aria-label="Workbench actions">
        <button
          aria-label="Conversation"
          aria-pressed={activeView === 'chat' && !isReviewOpen}
          className={
            activeView === 'chat' && !isReviewOpen
              ? 'topbar-icon-button topbar-icon-button-active'
              : 'topbar-icon-button'
          }
          title="Conversation"
          type="button"
          onClick={onShowChat}
        >
          <ChatBubbleIcon />
          <span className="sr-only">Conversation</span>
        </button>
        <button
          aria-label={reviewLabel}
          aria-pressed={isReviewOpen}
          className={
            isReviewOpen
              ? 'topbar-icon-button topbar-icon-button-active'
              : 'topbar-icon-button'
          }
          disabled={!activeProject}
          title={reviewLabel}
          type="button"
          onClick={onShowReview}
        >
          <DiffIcon />
          <span className="topbar-action-badge" aria-hidden="true">
            {changedCount > 0 ? changedCount : ''}
          </span>
          <span className="sr-only">Changes</span>
        </button>
        <button
          aria-label="Refresh Git"
          className="topbar-icon-button"
          disabled={!activeProject}
          title="Refresh Git"
          type="button"
          onClick={onRefreshGitStatus}
        >
          <RefreshIcon />
          <span className="sr-only">Refresh Git</span>
        </button>
        <button
          aria-label="Settings"
          aria-pressed={activeView === 'settings'}
          className={
            activeView === 'settings'
              ? 'topbar-icon-button topbar-icon-button-active'
              : 'topbar-icon-button'
          }
          title="Settings"
          type="button"
          onClick={onShowSettings}
        >
          <SlidersIcon />
          <span className="sr-only">Settings</span>
        </button>
        <StatusPill state={loadState.state} />
      </div>
    </header>
  );
}

function getTopBarTitle(
  activeView: 'chat' | 'settings',
  activeSessionTitle: string | null,
  activeProject: DesktopProject | null,
): string {
  if (activeView === 'settings') {
    return 'Settings';
  }

  return activeSessionTitle || activeProject?.name || 'Qwen Code Desktop';
}

function getChangedCount(project: DesktopProject): number {
  const status = project.gitStatus;
  return status.modified + status.staged + status.untracked;
}
