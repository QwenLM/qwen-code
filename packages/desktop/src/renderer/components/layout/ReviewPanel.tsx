/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, type ReactNode } from 'react';
import type {
  DesktopGitChangedFile,
  DesktopGitDiff,
  DesktopGitDiffHunk,
  DesktopGitReviewTarget,
  DesktopProject,
} from '../../api/client.js';
import {
  CloseIcon,
  CommentIcon,
  CommitIcon,
  DiffIcon,
  FolderIcon,
  OpenThreadIcon,
  PaperclipIcon,
  RefreshIcon,
  SlidersIcon,
  StageIcon,
  TrashIcon,
} from './SidebarIcons.js';

type RequestDiscard = (
  target: DesktopGitReviewTarget,
  title: string,
  description: string,
) => void;

interface DiscardConfirmation {
  target: DesktopGitReviewTarget;
  title: string;
  description: string;
}

type ReviewTabId = 'changes' | 'files' | 'artifacts' | 'summary';

export function ReviewPanel({
  activeProject,
  commitMessage,
  gitDiff,
  reviewError,
  onClose,
  onCommit,
  onCommitMessageChange,
  onOpenFile,
  onRefreshGitStatus,
  onRevertTarget,
  onStageTarget,
}: {
  activeProject: DesktopProject | null;
  commitMessage: string;
  gitDiff: DesktopGitDiff | null;
  reviewError: string | null;
  onClose?: () => void;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onOpenFile: (filePath: string) => void;
  onRefreshGitStatus: () => void;
  onRevertTarget: (target: DesktopGitReviewTarget) => void;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
}) {
  return (
    <section
      className="panel panel-review"
      aria-label="Changes"
      data-testid="review-panel"
    >
      <div className="panel-header">
        <h3>Changes</h3>
        <div className="panel-header-actions">
          <button
            aria-label="Refresh Git"
            className="topbar-icon-button"
            data-testid="review-refresh-git"
            disabled={!activeProject}
            title="Refresh Git"
            type="button"
            onClick={onRefreshGitStatus}
          >
            <RefreshIcon />
            <span className="sr-only">Refresh Git</span>
          </button>
          {onClose ? (
            <button
              aria-label="Close Changes"
              className="topbar-icon-button"
              title="Close Changes"
              type="button"
              onClick={onClose}
            >
              <CloseIcon />
              <span className="sr-only">Close Changes</span>
            </button>
          ) : null}
        </div>
      </div>
      <ReviewSummary
        commitMessage={commitMessage}
        gitDiff={gitDiff}
        project={activeProject}
        reviewError={reviewError}
        onCommit={onCommit}
        onCommitMessageChange={onCommitMessageChange}
        onOpenFile={onOpenFile}
        onRevertTarget={onRevertTarget}
        onStageTarget={onStageTarget}
      />
    </section>
  );
}

function ReviewSummary({
  commitMessage,
  gitDiff,
  onCommit,
  onCommitMessageChange,
  onOpenFile,
  onRevertTarget,
  onStageTarget,
  project,
  reviewError,
}: {
  commitMessage: string;
  gitDiff: DesktopGitDiff | null;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onOpenFile: (filePath: string) => void;
  onRevertTarget: (target: DesktopGitReviewTarget) => void;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
  project: DesktopProject | null;
  reviewError: string | null;
}) {
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    {},
  );
  const [reviewComments, setReviewComments] = useState<
    Record<string, string[]>
  >({});
  const [discardConfirmation, setDiscardConfirmation] =
    useState<DiscardConfirmation | null>(null);
  const [activeTab, setActiveTab] = useState<ReviewTabId>('changes');

  if (!project) {
    return (
      <div className="review-summary">
        <div className="empty-row">Open a project to inspect Git status.</div>
      </div>
    );
  }

  const status = project.gitStatus;
  const changedFiles = gitDiff?.files ?? [];
  const tabs: Array<{
    icon: ReactNode;
    id: ReviewTabId;
    label: string;
  }> = [
    { id: 'changes', label: 'Changes', icon: <DiffIcon /> },
    { id: 'files', label: 'Files', icon: <FolderIcon /> },
    { id: 'artifacts', label: 'Artifacts', icon: <PaperclipIcon /> },
    { id: 'summary', label: 'Summary', icon: <SlidersIcon /> },
  ];
  const requestDiscard: RequestDiscard = (target, title, description) => {
    setDiscardConfirmation({ target, title, description });
  };
  const confirmDiscard = () => {
    if (!discardConfirmation) {
      return;
    }

    onRevertTarget(discardConfirmation.target);
    setDiscardConfirmation(null);
  };

  return (
    <div className="review-summary">
      <div className="review-tabs" aria-label="Review sections">
        {tabs.map((tab) => (
          <ReviewTabButton
            active={tab.id === activeTab}
            icon={tab.icon}
            id={tab.id}
            key={tab.id}
            label={tab.label}
            onClick={() => setActiveTab(tab.id)}
          />
        ))}
      </div>
      <dl className="runtime-details runtime-details-compact">
        <div>
          <dt>Branch</dt>
          <dd>{status.branch || 'Not available'}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{status.modified}</dd>
        </div>
        <div>
          <dt>Staged</dt>
          <dd>{status.staged}</dd>
        </div>
        <div>
          <dt>Untracked</dt>
          <dd>{status.untracked}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{changedFiles.length}</dd>
        </div>
        {status.error ? (
          <div>
            <dt>Git</dt>
            <dd className="error-text">{status.error}</dd>
          </div>
        ) : null}
      </dl>
      <div className="review-actions">
        <ReviewActionButton
          label="Discard All"
          title="Discard all local changes"
          variant="danger"
          disabled={changedFiles.length === 0}
          onClick={() =>
            requestDiscard(
              { scope: 'all' },
              'Discard all local changes?',
              'This removes unstaged edits and untracked files from the active project.',
            )
          }
        >
          <TrashIcon />
        </ReviewActionButton>
        <ReviewActionButton
          label="Stage All"
          title="Stage all changes"
          disabled={changedFiles.length === 0}
          onClick={() => onStageTarget({ scope: 'all' })}
        >
          <StageIcon />
        </ReviewActionButton>
      </div>
      {discardConfirmation ? (
        <div
          aria-live="polite"
          className="review-discard-confirm"
          data-testid="discard-confirmation"
        >
          <div>
            <strong>{discardConfirmation.title}</strong>
            <p>{discardConfirmation.description}</p>
          </div>
          <div className="review-discard-confirm-actions">
            <button
              aria-label="Cancel Discard"
              className="secondary-button"
              type="button"
              onClick={() => setDiscardConfirmation(null)}
            >
              Cancel
            </button>
            <button
              aria-label="Confirm Discard"
              className="secondary-button secondary-button-danger"
              type="button"
              onClick={confirmDiscard}
            >
              Discard Changes
            </button>
          </div>
        </div>
      ) : null}
      <div className="changed-files">
        {changedFiles.length === 0 ? (
          <div className="empty-row">No changes</div>
        ) : (
          changedFiles.map((file, index) => (
            <ChangedFileReview
              key={file.path}
              commentDraft={commentDrafts[file.path] ?? ''}
              comments={reviewComments[file.path] ?? []}
              file={file}
              isInitiallyOpen={changedFiles.length === 1 || index === 0}
              onAddComment={() => {
                const comment = (commentDrafts[file.path] ?? '').trim();
                if (!comment) {
                  return;
                }
                setReviewComments((current) => ({
                  ...current,
                  [file.path]: [...(current[file.path] ?? []), comment],
                }));
                setCommentDrafts((current) => ({
                  ...current,
                  [file.path]: '',
                }));
              }}
              onCommentDraftChange={(comment) =>
                setCommentDrafts((current) => ({
                  ...current,
                  [file.path]: comment,
                }))
              }
              onOpenFile={onOpenFile}
              onRequestDiscard={requestDiscard}
              onStageTarget={onStageTarget}
            />
          ))
        )}
      </div>
      <div className="commit-box">
        <input
          aria-label="Commit message"
          placeholder="Commit message"
          value={commitMessage}
          onChange={(event) => onCommitMessageChange(event.target.value)}
        />
        <ReviewActionButton
          label="Commit"
          title={
            commitMessage.trim().length === 0
              ? 'Enter a commit message to commit'
              : 'Commit staged changes'
          }
          variant="primary"
          disabled={commitMessage.trim().length === 0}
          onClick={onCommit}
        >
          <CommitIcon />
        </ReviewActionButton>
      </div>
      {reviewError ? <p className="error-text">{reviewError}</p> : null}
    </div>
  );
}

function ChangedFileReview({
  commentDraft,
  comments,
  file,
  isInitiallyOpen,
  onAddComment,
  onCommentDraftChange,
  onOpenFile,
  onRequestDiscard,
  onStageTarget,
}: {
  commentDraft: string;
  comments: string[];
  file: DesktopGitChangedFile;
  isInitiallyOpen: boolean;
  onAddComment: () => void;
  onCommentDraftChange: (comment: string) => void;
  onOpenFile: (filePath: string) => void;
  onRequestDiscard: RequestDiscard;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
}) {
  const fileTarget = { scope: 'file' as const, filePath: file.path };
  const canStageFile = file.unstaged || file.untracked || !file.staged;
  const [isCommentEditorOpen, setIsCommentEditorOpen] = useState(false);
  const commentDraftTrimmed = commentDraft.trim();
  const handleCommentAction = () => {
    if (!isCommentEditorOpen) {
      setIsCommentEditorOpen(true);
      return;
    }

    if (!commentDraftTrimmed) {
      return;
    }

    onAddComment();
    setIsCommentEditorOpen(false);
  };
  const handleCancelComment = () => {
    onCommentDraftChange('');
    setIsCommentEditorOpen(false);
  };

  return (
    <details data-testid={`changed-file-${file.path}`} open={isInitiallyOpen}>
      <summary>
        <span>{file.path}</span>
        <small>
          {file.status} · {file.hunks.length} hunk
          {file.hunks.length === 1 ? '' : 's'}
        </small>
      </summary>
      <div className="file-review-actions">
        <ReviewActionButton
          label="Open"
          title={`Open ${file.path}`}
          onClick={() => onOpenFile(file.path)}
        >
          <OpenThreadIcon />
        </ReviewActionButton>
        <ReviewActionButton
          label="Discard File"
          title={`Discard changes in ${file.path}`}
          variant="danger"
          onClick={() =>
            onRequestDiscard(
              fileTarget,
              `Discard changes in ${file.path}?`,
              'This removes local changes for this file from the active project.',
            )
          }
        >
          <TrashIcon />
        </ReviewActionButton>
        <ReviewActionButton
          label={canStageFile ? 'Stage File' : 'Staged File'}
          title={canStageFile ? `Stage ${file.path}` : `${file.path} is staged`}
          disabled={!canStageFile}
          onClick={() => onStageTarget(fileTarget)}
        >
          <StageIcon />
        </ReviewActionButton>
      </div>
      {file.hunks.length === 0 ? (
        <pre>{file.diff || 'No textual diff available.'}</pre>
      ) : (
        <div className="diff-hunks">
          {file.hunks.map((hunk) => (
            <DiffHunkReview
              key={hunk.id}
              file={file}
              hunk={hunk}
              onRequestDiscard={onRequestDiscard}
              onStageTarget={onStageTarget}
            />
          ))}
        </div>
      )}
      <div
        className={
          isCommentEditorOpen
            ? 'review-comment-box review-comment-box-open'
            : 'review-comment-box review-comment-box-collapsed'
        }
        data-testid="review-comment-box"
      >
        {comments.length > 0 ? (
          <ul className="review-comments">
            {comments.map((comment, index) => (
              <li key={`${file.path}-${index}`}>{comment}</li>
            ))}
          </ul>
        ) : null}
        {!isCommentEditorOpen && comments.length === 0 ? (
          <span className="review-comment-prompt">Review note</span>
        ) : null}
        {isCommentEditorOpen ? (
          <label data-testid="review-comment-editor">
            <span>Comment</span>
            <textarea
              aria-label={`Review comment for ${file.path}`}
              placeholder="Add review note for this file"
              rows={2}
              value={commentDraft}
              onChange={(event) => onCommentDraftChange(event.target.value)}
            />
          </label>
        ) : null}
        <div className="review-comment-actions">
          <ReviewActionButton
            label="Add Comment"
            title={
              isCommentEditorOpen
                ? 'Add review comment'
                : `Add review note for ${file.path}`
            }
            disabled={isCommentEditorOpen && !commentDraftTrimmed}
            onClick={handleCommentAction}
          >
            <CommentIcon />
          </ReviewActionButton>
          {isCommentEditorOpen ? (
            <ReviewActionButton
              label="Cancel Comment"
              title="Cancel review comment"
              onClick={handleCancelComment}
            >
              <CloseIcon />
            </ReviewActionButton>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function ReviewTabButton({
  active,
  icon,
  id,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  id: ReviewTabId;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`Show ${label}`}
      aria-pressed={active}
      className={active ? 'review-tab-active' : undefined}
      data-testid={`review-tab-${id}`}
      title={label}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span aria-hidden="true">{label}</span>
    </button>
  );
}

function DiffHunkReview({
  file,
  hunk,
  onRequestDiscard,
  onStageTarget,
}: {
  file: DesktopGitChangedFile;
  hunk: DesktopGitDiffHunk;
  onRequestDiscard: RequestDiscard;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
}) {
  const hunkTarget = {
    scope: 'hunk' as const,
    filePath: file.path,
    hunkId: hunk.id,
  };

  return (
    <section className="diff-hunk" data-testid={`diff-hunk-${hunk.id}`}>
      <div className="diff-hunk-header">
        <span>{hunk.header}</span>
        <small>{formatHunkSource(hunk.source)}</small>
      </div>
      <div className="diff-hunk-actions">
        <ReviewActionButton
          label="Discard Hunk"
          title={`Discard hunk in ${file.path}`}
          variant="danger"
          onClick={() =>
            onRequestDiscard(
              hunkTarget,
              `Discard this hunk in ${file.path}?`,
              'This removes the selected local hunk from the active project.',
            )
          }
        >
          <TrashIcon />
        </ReviewActionButton>
        <ReviewActionButton
          label={hunk.source === 'staged' ? 'Staged' : 'Stage Hunk'}
          title={
            hunk.source === 'staged'
              ? 'Hunk is already staged'
              : `Stage hunk in ${file.path}`
          }
          disabled={hunk.source === 'staged'}
          onClick={() => onStageTarget(hunkTarget)}
        >
          <StageIcon />
        </ReviewActionButton>
      </div>
      <pre>{hunk.lines.join('\n') || 'No textual hunk available.'}</pre>
    </section>
  );
}

function ReviewActionButton({
  children,
  disabled,
  label,
  onClick,
  title = label,
  variant = 'secondary',
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  title?: string;
  variant?: 'secondary' | 'danger' | 'primary';
}) {
  const classNames = [
    'review-icon-button',
    variant === 'danger' ? 'review-icon-button-danger' : null,
    variant === 'primary' ? 'review-icon-button-primary' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      aria-label={label}
      className={classNames}
      disabled={disabled}
      title={title}
      type="button"
      onClick={onClick}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function formatHunkSource(source: DesktopGitDiffHunk['source']): string {
  if (source === 'staged') {
    return 'Staged';
  }
  if (source === 'untracked') {
    return 'New file';
  }

  return 'Pending';
}
