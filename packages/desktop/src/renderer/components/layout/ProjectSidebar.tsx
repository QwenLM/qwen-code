/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopProject,
  DesktopSessionSummary,
} from '../../api/client.js';
import {
  BranchIcon,
  CloseIcon,
  FolderIcon,
  FolderPlusIcon,
  ModelIcon,
  NewThreadIcon,
  SearchIcon,
  SlidersIcon,
} from './SidebarIcons.js';
import { ThreadList } from './ThreadList.js';
import { formatSessionDisplayTitle } from './formatters.js';
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
  onOpenModelSettings,
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
  onOpenModelSettings: () => void;
  onOpenSettings: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isSearchOpen]);

  const closeSearch = () => {
    setSearchQuery('');
    setIsSearchOpen(false);
  };

  const toggleSearch = () => {
    if (isSearchOpen) {
      closeSearch();
      return;
    }

    setIsSearchOpen(true);
  };

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
          aria-label="Search"
          aria-pressed={isSearchOpen}
          className={
            isSearchOpen
              ? 'sidebar-action-row sidebar-action-row-active'
              : 'sidebar-action-row'
          }
          title="Search"
          type="button"
          onClick={toggleSearch}
        >
          <SearchIcon />
          <span>Search</span>
        </button>
        <button
          aria-label="Models"
          className="sidebar-action-row"
          title="Models"
          type="button"
          onClick={onOpenModelSettings}
        >
          <ModelIcon />
          <span>Models</span>
        </button>
      </nav>

      <section className="sidebar-section project-navigator">
        <div className="sidebar-section-heading">
          <h2>Projects</h2>
          <div className="sidebar-heading-actions">
            <span className="sidebar-section-count">{projects.length}</span>
            <button
              aria-label="Open Project"
              className="sidebar-heading-icon-button"
              title="Open Project"
              type="button"
              onClick={onChooseWorkspace}
            >
              <FolderPlusIcon />
            </button>
          </div>
        </div>
        {isSearchOpen ? (
          <div className="sidebar-search" data-testid="sidebar-search">
            <SearchIcon className="sidebar-search-icon" />
            <input
              aria-label="Search projects and threads"
              placeholder="Search"
              ref={searchInputRef}
              spellCheck={false}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }}
            />
            <button
              aria-label="Clear Search"
              className="sidebar-search-clear"
              disabled={searchQuery.length === 0}
              title="Clear Search"
              type="button"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
        <ProjectBrowser
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          isDraftSession={isDraftSession}
          projects={projects}
          searchQuery={searchQuery}
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
  searchQuery,
  sessions,
  onSelect,
  onSelectSession,
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  isDraftSession: boolean;
  projects: DesktopProject[];
  searchQuery: string;
  sessions: DesktopSessionSummary[];
  onSelect: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const normalizedQuery = normalizeSearchText(searchQuery);
  const projectRows = useMemo(
    () =>
      projects.map((project) => {
        const meta = getProjectMeta(project);
        const isActiveProject = project.id === activeProjectId;
        const matchingSessions =
          isActiveProject && normalizedQuery
            ? sessions.filter((session) =>
                sessionMatchesSearch(session, normalizedQuery),
              )
            : sessions;
        const showDraftSession =
          isActiveProject &&
          isDraftSession &&
          (!normalizedQuery ||
            normalizeSearchText('New thread draft').includes(normalizedQuery));
        const projectMatches =
          !normalizedQuery ||
          projectMatchesSearch(project, meta, normalizedQuery);
        const threadMatches =
          isActiveProject && (matchingSessions.length > 0 || showDraftSession);

        return {
          isActiveProject,
          matchingSessions,
          meta,
          project,
          showDraftSession,
          visible: projectMatches || threadMatches,
        };
      }),
    [activeProjectId, isDraftSession, normalizedQuery, projects, sessions],
  );
  const visibleProjectRows = projectRows.filter((row) => row.visible);

  if (projects.length === 0) {
    return (
      <div
        className="project-list project-list-grouped"
        aria-label="Projects"
        data-testid="project-list"
      >
        <div className="empty-row">No folder selected</div>
      </div>
    );
  }

  if (visibleProjectRows.length === 0) {
    return (
      <div
        className="project-list project-list-grouped"
        aria-label="Projects"
        data-testid="project-list"
      >
        <div
          className="empty-row sidebar-search-empty"
          data-testid="sidebar-search-empty"
        >
          {normalizedQuery
            ? 'No matching projects or threads'
            : 'No matching projects'}
        </div>
        {normalizedQuery ? null : (
          <ThreadList
            activeSessionId={activeSessionId}
            ariaLabel="Threads"
            className="project-thread-list"
            emptyLabel="No matching threads"
            isDraftSession={false}
            sessions={[]}
            onSelect={onSelectSession}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="project-list project-list-grouped"
      aria-label="Projects"
      data-testid="project-list"
    >
      {visibleProjectRows.map((row) => {
        const {
          isActiveProject,
          matchingSessions,
          meta,
          project,
          showDraftSession,
        } = row;
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
                  emptyLabel={
                    normalizedQuery ? 'No matching threads' : 'No sessions'
                  }
                  isDraftSession={showDraftSession}
                  sessions={matchingSessions}
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

function projectMatchesSearch(
  project: DesktopProject,
  meta: ProjectMeta,
  normalizedQuery: string,
): boolean {
  return searchTextIncludes(
    [
      project.name,
      project.path,
      project.gitBranch,
      project.gitStatus.branch,
      meta.branchLabel,
      meta.branchTitle,
      meta.dirtyLabel,
      meta.dirtyTitle,
      meta.isRepository ? 'git repository' : 'no git',
    ],
    normalizedQuery,
  );
}

function sessionMatchesSearch(
  session: DesktopSessionSummary,
  normalizedQuery: string,
): boolean {
  return searchTextIncludes(
    [
      formatSessionDisplayTitle(session.title),
      session.title,
      session.cwd,
      session.updatedAt,
      session.models?.currentModelId,
    ],
    normalizedQuery,
  );
}

function searchTextIncludes(
  parts: Array<string | null | undefined>,
  normalizedQuery: string,
): boolean {
  return normalizeSearchText(parts.filter(Boolean).join(' ')).includes(
    normalizedQuery,
  );
}

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
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
