/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopProject,
  DesktopSessionSummary,
} from '../../api/client.js';
import { ThreadList } from './ThreadList.js';
import type { LoadState } from './types.js';

export function ProjectSidebar({
  activeProject,
  activeProjectId,
  activeSessionId,
  loadState,
  projects,
  sessions,
  onChooseWorkspace,
  onCreateSession,
  onFocusModelConfig,
  onSelectProject,
  onSelectSession,
}: {
  activeProject: DesktopProject | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  loadState: LoadState;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  onChooseWorkspace: () => void;
  onCreateSession: () => void;
  onFocusModelConfig: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <aside
      className="sidebar"
      aria-label="Projects and threads"
      data-testid="project-sidebar"
    >
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          Q
        </div>
        <div>
          <h1>Qwen Code</h1>
          <p>Desktop</p>
        </div>
      </div>

      <section className="sidebar-section quick-actions">
        <button
          className="primary-button"
          disabled={loadState.state !== 'ready' || !activeProject}
          type="button"
          onClick={onCreateSession}
        >
          New Thread
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={onFocusModelConfig}
        >
          Model Config
        </button>
      </section>

      <section className="sidebar-section">
        <h2>Projects</h2>
        <div className="workspace-path">
          {activeProject?.path || 'No folder selected'}
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={onChooseWorkspace}
        >
          Open Project
        </button>
        <ProjectList
          activeProjectId={activeProjectId}
          projects={projects}
          onSelect={onSelectProject}
        />
      </section>

      <section className="sidebar-section sidebar-section-fill">
        <h2>Threads</h2>
        <ThreadList
          activeSessionId={activeSessionId}
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
    return <div className="empty-row">No recent projects</div>;
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
          <span>{project.name}</span>
          <small>{project.gitBranch || 'No Git branch'}</small>
        </button>
      ))}
    </div>
  );
}
