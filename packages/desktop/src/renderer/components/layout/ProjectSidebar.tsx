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
  BranchIcon,
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
      <nav
        className="sidebar-app-actions"
        aria-label="Workspace actions"
        data-testid="sidebar-app-actions"
      >
        <button
          aria-label="New Thread"
          className="sidebar-action-row"
          disabled={loadState.state !== 'ready' || !activeProject}
          title="New Thread"
          type="button"
          onClick={onCreateSession}
        >
          <NewThreadIcon />
          <span>New Thread</span>
        </button>
        <button
          aria-label="Open Project"
          className="sidebar-action-row"
          title="Open Project"
          type="button"
          onClick={onChooseWorkspace}
        >
          <FolderPlusIcon />
          <span>Open Project</span>
        </button>
        <button
          aria-label="Models"
          className="sidebar-action-row"
          title="Models"
          type="button"
          onClick={onOpenSettings}
        >
          <SlidersIcon />
          <span>Models</span>
        </button>
      </nav>

      <section className="sidebar-section project-navigator">
        <div className="sidebar-section-heading">
          <h2>Projects</h2>
          <span>{projects.length}</span>
        </div>
        <ProjectBrowser
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          isDraftSession={isDraftSession}
          projects={projects}
          sessions={sessions}
          onSelect={onSelectProject}
          onSelectSession={onSelectSession}
        />
      </section>
      <div className="sidebar-footer">
        <button
          aria-label="Settings"
          className="sidebar-action-row sidebar-footer-action"
          data-testid="sidebar-footer-settings"
          title="Settings"
          type="button"
          onClick={onOpenSettings}
        >
          <SlidersIcon />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function ProjectBrowser({
  activeProjectId,
  activeSessionId,
  isDraftSession,
  projects,
  sessions,
  onSelect,
  onSelectSession,
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  isDraftSession: boolean;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  onSelect: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  if (projects.length === 0) {
    return (
      <div
        className="project-list project-list-grouped"
        aria-label="Projects"
        data-testid="project-list"
      >
        <div className="empty-row">No folder selected</div>
        <ThreadList
          activeSessionId={activeSessionId}
          ariaLabel="Threads"
          className="project-thread-list"
          isDraftSession={false}
          sessions={[]}
          onSelect={onSelectSession}
        />
      </div>
    );
  }

  return (
    <div
      className="project-list project-list-grouped"
      aria-label="Projects"
      data-testid="project-list"
    >
      {projects.map((project) => {
        const meta = getProjectMeta(project);
        const isActiveProject = project.id === activeProjectId;
        return (
          <div
            className={
              isActiveProject
                ? 'sidebar-project-group sidebar-project-group-active'
                : 'sidebar-project-group'
            }
            data-testid={
              isActiveProject
                ? 'sidebar-active-project-group'
                : 'sidebar-project-group'
            }
            key={project.id}
          >
            <button
              aria-label={formatProjectAriaLabel(project, meta)}
              className={
                isActiveProject
                  ? 'project-row project-row-active'
                  : 'project-row'
              }
              data-testid="project-row"
              onClick={() => onSelect(project.id)}
              title={formatProjectTitle(project, meta)}
              type="button"
            >
              <FolderIcon className="project-row-icon" />
              <span className="project-row-copy">
                <span
                  className="project-row-name"
                  data-testid="project-row-name"
                >
                  {project.name}
                </span>
                <span
                  className="project-row-meta"
                  data-testid="project-row-meta"
                >
                  <span
                    className="project-row-branch"
                    data-testid="project-row-branch"
                    title={meta.branchTitle}
                  >
                    {meta.isRepository ? <BranchIcon /> : null}
                    <span>{meta.branchLabel}</span>
                  </span>
                  {meta.dirtyLabel ? (
                    <span
                      className="project-row-dirty"
                      data-testid="project-row-dirty"
                      title={meta.dirtyTitle ?? undefined}
                    >
                      {meta.dirtyLabel}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
            {isActiveProject ? (
              <div className="project-thread-group">
                <ThreadList
                  activeSessionId={activeSessionId}
                  ariaLabel={`Threads in ${project.name}`}
                  className="project-thread-list"
                  isDraftSession={isDraftSession}
                  sessions={sessions}
                  onSelect={onSelectSession}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface ProjectMeta {
  branchLabel: string;
  branchTitle: string;
  dirtyLabel: string | null;
  dirtyTitle: string | null;
  isRepository: boolean;
}

function getProjectMeta(project: DesktopProject): ProjectMeta {
  const status = project.gitStatus;
  const changes = status.modified + status.staged + status.untracked;

  if (!status.isRepository) {
    return {
      branchLabel: 'No Git',
      branchTitle: 'No Git repository',
      dirtyLabel: null,
      dirtyTitle: null,
      isRepository: false,
    };
  }

  const branch = project.gitBranch || status.branch || 'No branch';

  return {
    branchLabel: shortenBranchLabel(branch),
    branchTitle: branch,
    dirtyLabel: changes > 0 ? `${changes} dirty` : null,
    dirtyTitle:
      changes > 0
        ? `${status.modified} modified · ${status.staged} staged · ${status.untracked} untracked`
        : null,
    isRepository: true,
  };
}

function formatProjectAriaLabel(
  project: DesktopProject,
  meta: ProjectMeta,
): string {
  const parts = [project.name, meta.branchLabel];
  if (meta.dirtyLabel) {
    parts.push(meta.dirtyLabel);
  }

  return parts.join(', ');
}

function formatProjectTitle(
  project: DesktopProject,
  meta: ProjectMeta,
): string {
  const parts = [project.name, meta.branchTitle];
  if (meta.dirtyTitle) {
    parts.push(meta.dirtyTitle);
  }

  return parts.join(' · ');
}

function shortenBranchLabel(branch: string): string {
  const maxLength = 22;
  if (branch.length <= maxLength) {
    return branch;
  }

  return `${branch.slice(0, maxLength - 3).trimEnd()}...`;
}
