/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopProject,
  DesktopSessionSummary,
} from '../../api/client.js';
import {
  FolderIcon,
  FolderPlusIcon,
  NewThreadIcon,
  SlidersIcon,
} from './SidebarIcons.js';
import { ThreadList } from './ThreadList.js';
import type { LoadState } from './types.js';

export function ProjectSidebar({
  activeProject,
  activeProjectId,
  activeSessionId,
  isDraftSession,
  loadState,
  projects,
  sessions,
  onChooseWorkspace,
  onCreateSession,
  onOpenSettings,
  onSelectProject,
  onSelectSession,
}: {
  activeProject: DesktopProject | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  isDraftSession: boolean;
  loadState: LoadState;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  onChooseWorkspace: () => void;
  onCreateSession: () => void;
  onOpenSettings: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <aside
      className="sidebar"
      aria-label="Projects and threads"
      data-testid="project-sidebar"
    >
      <div className="sidebar-toolbar">
        <h1>Projects</h1>
        <div className="sidebar-toolbar-actions">
          <button
            aria-label="Settings"
            className="sidebar-icon-button"
            title="Settings"
            type="button"
            onClick={onOpenSettings}
          >
            <SlidersIcon />
            <span className="sr-only">Settings</span>
          </button>
          <button
            aria-label="New Thread"
            className="sidebar-icon-button"
            disabled={loadState.state !== 'ready' || !activeProject}
            title="New Thread"
            type="button"
            onClick={onCreateSession}
          >
            <NewThreadIcon />
            <span className="sr-only">New Thread</span>
          </button>
          <button
            aria-label="Open Project"
            className="sidebar-icon-button"
            title="Open Project"
            type="button"
            onClick={onChooseWorkspace}
          >
            <FolderPlusIcon />
            <span className="sr-only">Open Project</span>
          </button>
        </div>
      </div>

      <section className="sidebar-section project-navigator">
        <ProjectList
          activeProjectId={activeProjectId}
          projects={projects}
          onSelect={onSelectProject}
        />
      </section>

      <section className="sidebar-section sidebar-section-fill">
        <div className="sidebar-section-heading">
          <h2>Threads</h2>
          <span>{isDraftSession ? sessions.length + 1 : sessions.length}</span>
        </div>
        <ThreadList
          activeSessionId={activeSessionId}
          isDraftSession={isDraftSession}
          sessions={sessions}
          onSelect={onSelectSession}
        />
      </section>
    </aside>
  );
}

function ProjectList({
  activeProjectId,
  projects,
  onSelect,
}: {
  activeProjectId: string | null;
  projects: DesktopProject[];
  onSelect: (projectId: string) => void;
}) {
  if (projects.length === 0) {
    return <div className="empty-row">No folder selected</div>;
  }

  return (
    <div
      className="project-list"
      aria-label="Projects"
      data-testid="project-list"
    >
      {projects.map((project) => (
        <button
          className={
            project.id === activeProjectId
              ? 'project-row project-row-active'
              : 'project-row'
          }
          key={project.id}
          onClick={() => onSelect(project.id)}
          type="button"
        >
          <FolderIcon className="project-row-icon" />
          <span className="project-row-copy">
            <span>{project.name}</span>
            <small>{formatProjectMeta(project)}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function formatProjectMeta(project: DesktopProject): string {
  const status = project.gitStatus;
  const changes = status.modified + status.staged + status.untracked;
  const branch = project.gitBranch || 'No Git branch';

  if (!status.isRepository) {
    return 'No Git repository';
  }

  if (changes > 0) {
    return `${branch} · ${changes} changes`;
  }

  return branch;
}
