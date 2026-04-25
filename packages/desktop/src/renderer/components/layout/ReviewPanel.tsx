/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import type {
  DesktopGitChangedFile,
  DesktopGitDiff,
  DesktopGitDiffHunk,
  DesktopGitReviewTarget,
  DesktopProject,
} from '../../api/client.js';

export function ReviewPanel({
  activeProject,
  commitMessage,
  gitDiff,
  reviewError,
  onCommit,
  onCommitMessageChange,
  onOpenFile,
  onRevertTarget,
  onStageTarget,
}: {
  activeProject: DesktopProject | null;
  commitMessage: string;
  gitDiff: DesktopGitDiff | null;
  reviewError: string | null;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onOpenFile: (filePath: string) => void;
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
  const [activeTab, setActiveTab] = useState('changes');

  if (!project) {
    return (
      <div className="review-summary">
        <div className="empty-row">Open a project to inspect Git status.</div>
      </div>
    );
  }

  const status = project.gitStatus;
  const changedFiles = gitDiff?.files ?? [];
  const tabs = ['changes', 'files', 'artifacts', 'summary'];

  return (
    <div className="review-summary">
      <div className="review-tabs" aria-label="Review sections">
        {tabs.map((tab) => (
          <button
            className={tab === activeTab ? 'review-tab-active' : undefined}
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
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
        <button
          className="secondary-button"
          disabled={changedFiles.length === 0}
          type="button"
          onClick={() => onRevertTarget({ scope: 'all' })}
        >
          Revert All
        </button>
        <button
          className="secondary-button"
          disabled={changedFiles.length === 0}
          type="button"
          onClick={() => onStageTarget({ scope: 'all' })}
        >
          Accept All
        </button>
      </div>
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
              onRevertTarget={onRevertTarget}
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
        <button
          className="primary-button"
          disabled={commitMessage.trim().length === 0}
          type="button"
          onClick={onCommit}
        >
          Commit
        </button>
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
  onRevertTarget,
  onStageTarget,
}: {
  commentDraft: string;
  comments: string[];
  file: DesktopGitChangedFile;
  isInitiallyOpen: boolean;
  onAddComment: () => void;
  onCommentDraftChange: (comment: string) => void;
  onOpenFile: (filePath: string) => void;
  onRevertTarget: (target: DesktopGitReviewTarget) => void;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
}) {
  const fileTarget = { scope: 'file' as const, filePath: file.path };

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
        <button
          className="secondary-button"
          type="button"
          onClick={() => onOpenFile(file.path)}
        >
          Open
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => onRevertTarget(fileTarget)}
        >
          Revert File
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => onStageTarget(fileTarget)}
        >
          Accept File
        </button>
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
              onRevertTarget={onRevertTarget}
              onStageTarget={onStageTarget}
            />
          ))}
        </div>
      )}
      <div className="review-comment-box">
        <label>
          <span>Comment</span>
          <textarea
            aria-label={`Review comment for ${file.path}`}
            placeholder="Add review note for this file"
            rows={2}
            value={commentDraft}
            onChange={(event) => onCommentDraftChange(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={commentDraft.trim().length === 0}
          type="button"
          onClick={onAddComment}
        >
          Add Comment
        </button>
        {comments.length > 0 ? (
          <ul className="review-comments">
            {comments.map((comment, index) => (
              <li key={`${file.path}-${index}`}>{comment}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

function DiffHunkReview({
  file,
  hunk,
  onRevertTarget,
  onStageTarget,
}: {
  file: DesktopGitChangedFile;
  hunk: DesktopGitDiffHunk;
  onRevertTarget: (target: DesktopGitReviewTarget) => void;
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
        <button
          className="secondary-button"
          type="button"
          onClick={() => onRevertTarget(hunkTarget)}
        >
          Revert Hunk
        </button>
        <button
          className="secondary-button"
          disabled={hunk.source === 'staged'}
          type="button"
          onClick={() => onStageTarget(hunkTarget)}
        >
          {hunk.source === 'staged' ? 'Accepted' : 'Accept Hunk'}
        </button>
      </div>
      <pre>{hunk.lines.join('\n') || 'No textual hunk available.'}</pre>
    </section>
  );
}

function formatHunkSource(source: DesktopGitDiffHunk['source']): string {
  if (source === 'staged') {
    return 'Accepted';
  }
  if (source === 'untracked') {
    return 'New file';
  }

  return 'Pending';
}
