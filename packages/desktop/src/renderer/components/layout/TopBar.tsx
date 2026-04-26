/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, type FormEvent } from 'react';
import type { DesktopGitBranch, DesktopProject } from '../../api/client.js';
import { formatGitStatus, formatSessionDisplayTitle } from './formatters.js';
import {
  BranchIcon,
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
  onCheckoutBranch,
  onCreateBranch,
  onListBranches,
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
  onCheckoutBranch: (branchName: string) => Promise<void>;
  onCreateBranch: (branchName: string) => Promise<void>;
  onListBranches: () => Promise<DesktopGitBranch[]>;
  onRefreshGitStatus: () => void;
  onShowReview: () => void;
  onShowChat: () => void;
  onShowSettings: () => void;
  statusLabel: string;
}) {
  const title = getTopBarTitle(activeView, activeSessionTitle, activeProject);
  const projectLabel = activeProject?.name ?? 'No project selected';
  const branchLabel = activeProject?.gitBranch || 'No Git branch';
  const gitStatusLabel = activeProject
    ? formatGitStatus(activeProject.gitStatus)
    : 'No project';
  const changedCount = activeProject ? getChangedCount(activeProject) : 0;
  const reviewLabel = isReviewOpen ? 'Close Changes' : 'Open Changes';
  const canSwitchBranch =
    loadState.state === 'ready' &&
    Boolean(activeProject?.gitStatus.isRepository);

  return (
    <header
      className="topbar"
      aria-label="Workspace status"
      data-testid="workspace-topbar"
    >
      <div className="topbar-title-stack" data-testid="topbar-title-stack">
        <div className="topbar-title" data-testid="topbar-title">
          <h2 title={title}>{title}</h2>
          <span title={projectLabel}>{projectLabel}</span>
        </div>
        <div
          className="topbar-context"
          aria-label="Project context"
          data-testid="topbar-context"
        >
          <span
            className={`topbar-context-item topbar-context-${loadState.state}`}
            aria-label={`Connection ${statusLabel}`}
            title={`Connection: ${statusLabel}`}
          >
            <span className="topbar-context-dot" aria-hidden="true" />
            <span className="topbar-context-text">{statusLabel}</span>
          </span>
          <BranchMenu
            activeBranch={activeProject?.gitBranch ?? null}
            branchLabel={branchLabel}
            canSwitchBranch={canSwitchBranch}
            isDirty={Boolean(activeProject && !activeProject.gitStatus.clean)}
            onCheckoutBranch={onCheckoutBranch}
            onCreateBranch={onCreateBranch}
            onListBranches={onListBranches}
          />
          <span
            className="topbar-context-item"
            aria-label={`Git status ${gitStatusLabel}`}
            title={`Git status: ${gitStatusLabel}`}
          >
            <span className="topbar-context-text">{gitStatusLabel}</span>
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

function BranchMenu({
  activeBranch,
  branchLabel,
  canSwitchBranch,
  isDirty,
  onCheckoutBranch,
  onCreateBranch,
  onListBranches,
}: {
  activeBranch: string | null;
  branchLabel: string;
  canSwitchBranch: boolean;
  isDirty: boolean;
  onCheckoutBranch: (branchName: string) => Promise<void>;
  onCreateBranch: (branchName: string) => Promise<void>;
  onListBranches: () => Promise<DesktopGitBranch[]>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [branches, setBranches] = useState<DesktopGitBranch[]>([]);
  const [newBranchName, setNewBranchName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);

  const closeMenu = () => {
    setIsOpen(false);
    setPendingBranch(null);
    setNewBranchName('');
    setError(null);
  };

  const loadBranches = async () => {
    setIsLoading(true);
    setBranches([]);
    setError(null);
    try {
      setBranches(await onListBranches());
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMenu = () => {
    if (!canSwitchBranch) {
      return;
    }

    if (isOpen) {
      closeMenu();
      return;
    }

    setIsOpen(true);
    void loadBranches();
  };

  const requestCheckout = (branchName: string) => {
    if (branchName === activeBranch || isSwitching) {
      return;
    }

    if (isDirty) {
      setPendingBranch(branchName);
      return;
    }

    void checkoutBranch(branchName);
  };

  const checkoutBranch = async (branchName: string) => {
    setIsSwitching(true);
    setError(null);
    try {
      await onCheckoutBranch(branchName);
      closeMenu();
    } catch (checkoutError) {
      setError(getErrorMessage(checkoutError));
    } finally {
      setIsSwitching(false);
    }
  };

  const branchValidationError = getBranchCreateValidationError(
    newBranchName,
    branches,
  );
  const createDisabled =
    newBranchName.trim().length === 0 ||
    Boolean(branchValidationError) ||
    isCreating ||
    isSwitching;
  const visibleError = pendingBranch ? error : (branchValidationError ?? error);

  const createBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const branchName = newBranchName.trim();
    if (createDisabled) {
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      await onCreateBranch(branchName);
      closeMenu();
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <span className="topbar-branch-control">
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Branch ${branchLabel}`}
        className="topbar-context-item topbar-branch-trigger"
        data-testid="topbar-branch-trigger"
        disabled={!canSwitchBranch}
        title={
          canSwitchBranch
            ? `Branch: ${branchLabel}`
            : `Branch switching unavailable: ${branchLabel}`
        }
        type="button"
        onClick={toggleMenu}
      >
        <BranchIcon />
        <span className="topbar-context-text">{branchLabel}</span>
        <span className="topbar-context-caret" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div
          className="topbar-branch-menu"
          data-testid="branch-menu"
          role="menu"
        >
          {pendingBranch ? (
            <div
              className="branch-switch-confirmation"
              data-testid="branch-switch-confirmation"
            >
              <strong>Switch branch with local changes?</strong>
              <p>
                Uncommitted changes will stay in the worktree. Git will stop the
                switch if they conflict.
              </p>
              <div className="branch-menu-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setPendingBranch(null)}
                >
                  Cancel Branch Switch
                </button>
                <button
                  className="primary-button"
                  disabled={isSwitching}
                  type="button"
                  onClick={() => void checkoutBranch(pendingBranch)}
                >
                  Confirm Branch Switch
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="branch-menu-header">
                <span>Switch branch</span>
                {isDirty ? <em>dirty worktree</em> : <em>clean</em>}
              </div>
              {isLoading ? (
                <p className="branch-menu-status">Loading branches...</p>
              ) : null}
              {!isLoading && branches.length === 0 ? (
                <p className="branch-menu-status">No local branches found.</p>
              ) : null}
              <div className="branch-menu-list">
                {branches.map((branch) => (
                  <button
                    aria-checked={branch.current}
                    aria-label={`Switch to branch ${branch.name}`}
                    className={
                      branch.current
                        ? 'branch-menu-row branch-menu-row-current'
                        : 'branch-menu-row'
                    }
                    data-testid="branch-menu-row"
                    disabled={branch.current || isSwitching}
                    key={branch.name}
                    role="menuitemradio"
                    title={branch.name}
                    type="button"
                    onClick={() => requestCheckout(branch.name)}
                  >
                    <span>{branch.name}</span>
                    {branch.current ? <em>Current</em> : null}
                  </button>
                ))}
              </div>
              <form
                className="branch-create-form"
                data-testid="branch-create-form"
                onSubmit={(event) => void createBranch(event)}
              >
                <label className="branch-create-label">
                  <span>New branch</span>
                  <div className="branch-create-row">
                    <input
                      aria-label="New branch name"
                      className="branch-create-input"
                      disabled={isCreating || isSwitching}
                      placeholder="feature/task-name"
                      type="text"
                      value={newBranchName}
                      onChange={(event) => {
                        setNewBranchName(event.currentTarget.value);
                        setError(null);
                      }}
                    />
                    <button
                      className="secondary-button"
                      disabled={createDisabled}
                      type="submit"
                    >
                      Create Branch
                    </button>
                  </div>
                </label>
              </form>
            </>
          )}

          {visibleError ? (
            <p
              className="branch-menu-error"
              data-testid="branch-create-error"
              role="status"
            >
              {visibleError}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
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

  return activeSessionTitle
    ? formatSessionDisplayTitle(activeSessionTitle)
    : activeProject?.name || 'Qwen Code Desktop';
}

function getChangedCount(project: DesktopProject): number {
  const status = project.gitStatus;
  return status.modified + status.staged + status.untracked;
}

function getBranchCreateValidationError(
  branchName: string,
  branches: DesktopGitBranch[],
): string | null {
  if (branchName.length === 0) {
    return null;
  }

  const trimmed = branchName.trim();
  if (trimmed.length === 0 || trimmed !== branchName) {
    return 'Remove leading or trailing spaces.';
  }

  if (trimmed.length > 160) {
    return 'Use a branch name under 160 characters.';
  }

  if (
    hasWhitespace(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('//') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    trimmed.includes('\\') ||
    trimmed.endsWith('.lock')
  ) {
    return 'Use a valid local branch name.';
  }

  if (branches.some((branch) => branch.name === trimmed)) {
    return 'A local branch with that name already exists.';
  }

  return null;
}

function hasWhitespace(value: string): boolean {
  return value.split('').some((character) => character.trim().length === 0);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Branch operation failed.';
}
