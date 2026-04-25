/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, type Dispatch } from 'react';
import type {
  DesktopGitChangedFile,
  DesktopGitDiff,
  DesktopGitDiffHunk,
  DesktopGitReviewTarget,
  DesktopProject,
} from '../../api/client.js';
import type { ChatState } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import type {
  SettingsAction,
  SettingsState,
} from '../../stores/settingsStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';
import type { LoadState } from './types.js';

export function ReviewPanel({
  activeProject,
  activeSessionId,
  chatState,
  commitMessage,
  gitDiff,
  loadState,
  modelState,
  reviewError,
  sessionError,
  settingsState,
  onAuthenticate,
  onCommit,
  onCommitMessageChange,
  onModeChange,
  onModelChange,
  onOpenFile,
  onRevertTarget,
  onSaveSettings,
  onSettingsDispatch,
  onStageTarget,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  chatState: ChatState;
  commitMessage: string;
  gitDiff: DesktopGitDiff | null;
  loadState: LoadState;
  modelState: ModelState;
  reviewError: string | null;
  sessionError: string | null;
  settingsState: SettingsState;
  onAuthenticate: (methodId: string) => void;
  onCommit: () => void;
  onCommitMessageChange: (message: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onOpenFile: (filePath: string) => void;
  onRevertTarget: (target: DesktopGitReviewTarget) => void;
  onSaveSettings: () => void;
  onSettingsDispatch: Dispatch<SettingsAction>;
  onStageTarget: (target: DesktopGitReviewTarget) => void;
}) {
  return (
    <section
      className="panel panel-side"
      aria-label="Review panel"
      data-testid="review-panel"
    >
      <div className="panel-header">
        <h3>Review</h3>
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
      <RuntimeDetails loadState={loadState} />
      <SessionDetails
        activeSessionId={activeSessionId}
        chatState={chatState}
        modelState={modelState}
        sessionError={sessionError}
        onModeChange={onModeChange}
        onModelChange={onModelChange}
      />
      <SettingsPanel
        state={settingsState}
        onAuthenticate={onAuthenticate}
        onDispatch={onSettingsDispatch}
        onSave={onSaveSettings}
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

  if (!project) {
    return (
      <div className="review-summary">
        <div className="empty-row">Open a project to inspect Git status.</div>
      </div>
    );
  }

  const status = project.gitStatus;
  const changedFiles = gitDiff?.files ?? [];
  return (
    <div className="review-summary">
      <div className="review-tabs" aria-label="Review sections">
        <span>Changes</span>
        <span>Files</span>
        <span>Artifacts</span>
        <span>Summary</span>
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

function RuntimeDetails({ loadState }: { loadState: LoadState }) {
  if (loadState.state === 'loading') {
    return <div className="runtime-row muted">Checking service</div>;
  }

  if (loadState.state === 'error') {
    return <div className="runtime-row error-text">{loadState.message}</div>;
  }

  return (
    <dl className="runtime-details">
      <div>
        <dt>Server</dt>
        <dd>{loadState.status.serverUrl}</dd>
      </div>
      <div>
        <dt>Desktop</dt>
        <dd>{loadState.status.runtime.desktop.version}</dd>
      </div>
      <div>
        <dt>Platform</dt>
        <dd>
          {loadState.status.runtime.platform.type}-
          {loadState.status.runtime.platform.arch}
        </dd>
      </div>
      <div>
        <dt>Node</dt>
        <dd>{loadState.status.runtime.desktop.nodeVersion}</dd>
      </div>
      <div>
        <dt>ACP</dt>
        <dd>
          {loadState.status.runtime.cli.acpReady ? 'Ready' : 'Not started'}
        </dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>{loadState.status.health.uptimeMs} ms</dd>
      </div>
    </dl>
  );
}

function SessionDetails({
  activeSessionId,
  chatState,
  modelState,
  onModeChange,
  onModelChange,
  sessionError,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  modelState: ModelState;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  sessionError: string | null;
}) {
  const currentMode =
    modelState.modes?.currentModeId || chatState.mode || 'default';
  const currentModel =
    modelState.models?.currentModelId || chatState.currentModelId || '';

  return (
    <div className="session-details">
      <div className="panel-header panel-header-inline">
        <h3>Session</h3>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Active</dt>
          <dd>{activeSessionId || 'None'}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>
            {modelState.modes ? (
              <select
                disabled={!activeSessionId || modelState.savingMode}
                value={currentMode}
                onChange={(event) =>
                  onModeChange(event.target.value as DesktopApprovalMode)
                }
              >
                {modelState.modes.availableModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </select>
            ) : (
              currentMode || 'Unknown'
            )}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {modelState.models ? (
              <select
                disabled={!activeSessionId || modelState.savingModel}
                value={currentModel}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelState.models.availableModels.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              currentModel || 'Unknown'
            )}
          </dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>{chatState.availableCommands.length}</dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{chatState.availableSkills.length}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{chatState.latestUsage?.usage?.totalTokens ?? 'Unknown'}</dd>
        </div>
        {sessionError || chatState.error ? (
          <div>
            <dt>Error</dt>
            <dd className="error-text">{sessionError || chatState.error}</dd>
          </div>
        ) : null}
        {modelState.error ? (
          <div>
            <dt>Config</dt>
            <dd className="error-text">{modelState.error}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function SettingsPanel({
  onAuthenticate,
  onDispatch,
  onSave,
  state,
}: {
  onAuthenticate: (methodId: string) => void;
  onDispatch: Dispatch<SettingsAction>;
  onSave: () => void;
  state: SettingsState;
}) {
  const provider = state.form.provider;

  return (
    <div className="settings-panel">
      <div className="panel-header panel-header-inline">
        <h3>Settings</h3>
      </div>
      <div className="settings-form">
        <label>
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) =>
              onDispatch({
                type: 'set_provider',
                provider: event.target.value as 'api-key' | 'coding-plan',
              })
            }
          >
            <option value="api-key">API key</option>
            <option value="coding-plan">Coding Plan</option>
          </select>
        </label>

        {provider === 'coding-plan' ? (
          <label>
            <span>Region</span>
            <select
              value={state.form.codingPlanRegion}
              onChange={(event) =>
                onDispatch({
                  type: 'set_coding_plan_region',
                  region: event.target.value as 'china' | 'global',
                })
              }
            >
              <option value="china">China</option>
              <option value="global">Global</option>
            </select>
          </label>
        ) : (
          <>
            <label>
              <span>Model</span>
              <input
                value={state.form.activeModel}
                onChange={(event) =>
                  onDispatch({
                    type: 'set_active_model',
                    model: event.target.value,
                  })
                }
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                value={state.form.baseUrl}
                onChange={(event) =>
                  onDispatch({
                    type: 'set_base_url',
                    baseUrl: event.target.value,
                  })
                }
              />
            </label>
          </>
        )}

        <label>
          <span>API key</span>
          <input
            autoComplete="off"
            placeholder={
              provider === 'coding-plan'
                ? state.settings?.codingPlan.hasApiKey
                  ? 'Configured'
                  : ''
                : state.settings?.openai.hasApiKey
                  ? 'Configured'
                  : ''
            }
            type="password"
            value={state.form.apiKey}
            onChange={(event) =>
              onDispatch({ type: 'set_api_key', apiKey: event.target.value })
            }
          />
        </label>

        <div className="settings-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => onAuthenticate('qwen-oauth')}
          >
            OAuth
          </button>
          <button
            className="primary-button"
            disabled={state.loading || state.saving}
            type="button"
            onClick={onSave}
          >
            {state.saving ? 'Saving' : 'Save'}
          </button>
        </div>

        {state.settings ? (
          <p className="settings-summary">
            {state.settings.selectedAuthType || 'No auth'} ·{' '}
            {state.settings.model.name || 'No model'}
          </p>
        ) : null}
        {state.error ? <p className="error-text">{state.error}</p> : null}
      </div>
    </div>
  );
}
