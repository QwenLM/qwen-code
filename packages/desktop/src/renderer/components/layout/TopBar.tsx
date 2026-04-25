/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject } from '../../api/client.js';
import { formatGitStatus } from './formatters.js';
import { StatusPill } from './StatusPill.js';
import type { LoadState } from './types.js';

export function TopBar({
  activeProject,
  activeSessionTitle,
  activeView,
  loadState,
  onRefreshGitStatus,
  onShowChanges,
  onShowChat,
  onShowSettings,
  statusLabel,
}: {
  activeProject: DesktopProject | null;
  activeSessionTitle: string | null;
  activeView: 'chat' | 'changes' | 'settings';
  loadState: LoadState;
  onRefreshGitStatus: () => void;
  onShowChanges: () => void;
  onShowChat: () => void;
  onShowSettings: () => void;
  statusLabel: string;
}) {
  const title = getTopBarTitle(activeView, activeSessionTitle, activeProject);
  const projectLabel = activeProject?.name ?? 'No project selected';

  return (
    <header
      className="topbar"
      aria-label="Workspace status"
      data-testid="workspace-topbar"
    >
      <div className="topbar-title">
        <h2>{title}</h2>
        <span>{projectLabel}</span>
      </div>
      <div className="topbar-center">
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
      <div className="topbar-actions">
        <div className="topbar-nav" aria-label="Workbench views">
          <button
            className={
              activeView === 'chat'
                ? 'topbar-nav-button topbar-nav-button-active'
                : 'topbar-nav-button'
            }
            type="button"
            onClick={onShowChat}
          >
            Chat
          </button>
          <button
            className={
              activeView === 'changes'
                ? 'topbar-nav-button topbar-nav-button-active'
                : 'topbar-nav-button'
            }
            type="button"
            onClick={onShowChanges}
          >
            Changes
          </button>
          <button
            className={
              activeView === 'settings'
                ? 'topbar-nav-button topbar-nav-button-active'
                : 'topbar-nav-button'
            }
            type="button"
            onClick={onShowSettings}
          >
            Settings
          </button>
        </div>
        <button
          className="secondary-button"
          disabled={!activeProject}
          type="button"
          onClick={onRefreshGitStatus}
        >
          Refresh Git
        </button>
        <StatusPill state={loadState.state} />
      </div>
    </header>
  );
}

function getTopBarTitle(
  activeView: 'chat' | 'changes' | 'settings',
  activeSessionTitle: string | null,
  activeProject: DesktopProject | null,
): string {
  if (activeView === 'settings') {
    return 'Settings';
  }

  if (activeView === 'changes') {
    return 'Changes';
  }

  return activeSessionTitle || activeProject?.name || 'Qwen Code Desktop';
}
