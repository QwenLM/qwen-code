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
  loadState,
  onRefreshGitStatus,
  statusLabel,
}: {
  activeProject: DesktopProject | null;
  loadState: LoadState;
  onRefreshGitStatus: () => void;
  statusLabel: string;
}) {
  return (
    <header
      className="topbar"
      aria-label="Workspace status"
      data-testid="workspace-topbar"
    >
      <div>
        <p className="eyebrow">Local workspace</p>
        <h2>{activeProject?.name || 'Qwen Code Desktop'}</h2>
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
