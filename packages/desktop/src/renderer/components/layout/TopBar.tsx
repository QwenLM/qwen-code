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
  loadState,
  onRefreshGitStatus,
  statusLabel,
}: {
  activeProject: DesktopProject | null;
  activeSessionTitle: string | null;
  loadState: LoadState;
  onRefreshGitStatus: () => void;
  statusLabel: string;
}) {
  const title =
    activeSessionTitle || activeProject?.name || 'Qwen Code Desktop';
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
        <button className="topbar-more" type="button" aria-label="More">
          ...
        </button>
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
