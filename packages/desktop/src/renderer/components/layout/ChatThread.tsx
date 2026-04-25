/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import type {
  DesktopGitChangedFile,
  DesktopGitDiff,
  DesktopProject,
} from '../../api/client.js';
import type { ChatState, ChatTimelineItem } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';

export function ChatThread({
  activeProject,
  activeSessionId,
  chatState,
  gitDiff,
  isDraftSession,
  messageText,
  modelState,
  onAskUserQuestionResponse,
  onModeChange,
  onModelChange,
  onMessageTextChange,
  onOpenReview,
  onPermissionResponse,
  onSendMessage,
  onStopGeneration,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  chatState: ChatState;
  gitDiff: DesktopGitDiff | null;
  isDraftSession: boolean;
  messageText: string;
  modelState: ModelState;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onMessageTextChange: (message: string) => void;
  onOpenReview: () => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
  onStopGeneration: () => void;
}) {
  const canCompose = Boolean(activeProject);
  const disabledReason = activeProject ? null : 'Open a project to start';
  const placeholder = activeProject
    ? `Ask Qwen Code about ${activeProject.name}`
    : 'Open a project to start';
  const currentModeId = modelState.modes?.currentModeId ?? 'default';
  const modeOptions = modelState.modes?.availableModes ?? fallbackModeOptions;
  const currentModelId =
    modelState.models?.currentModelId ?? fallbackModelOption.modelId;
  const modelOptions = modelState.models?.availableModels.length
    ? modelState.models.availableModels
    : [fallbackModelOption];

  return (
    <section
      className="panel panel-main"
      aria-label="AI conversation thread"
      data-testid="chat-thread"
    >
      <div className="panel-header chat-header">
        <h3>Conversation</h3>
        <span>{chatState.streaming ? 'Streaming' : chatState.connection}</span>
      </div>
      <ChatTimeline
        activeProject={activeProject}
        state={chatState}
        activeSessionId={activeSessionId}
        gitDiff={gitDiff}
        isDraftSession={isDraftSession}
        onOpenReview={onOpenReview}
      />
      <PermissionPrompts
        state={chatState}
        onAskUserQuestionResponse={onAskUserQuestionResponse}
        onPermissionResponse={onPermissionResponse}
      />
      <form
        className={canCompose ? 'composer' : 'composer composer-disabled'}
        data-testid="message-composer"
        onSubmit={onSendMessage}
      >
        <textarea
          aria-label="Message"
          disabled={!canCompose}
          onKeyDown={handleComposerKeyDown}
          onChange={(event) => onMessageTextChange(event.target.value)}
          placeholder={placeholder}
          rows={3}
          value={messageText}
        />
        <div className="composer-control-row">
          <div className="composer-context" aria-label="Composer context">
            <button
              aria-label="Attach files"
              className="composer-icon-button"
              disabled
              title="Attach files"
              type="button"
            >
              +
            </button>
            <span
              className="composer-chip composer-chip-project"
              title={activeProject?.path ?? disabledReason ?? undefined}
            >
              {activeProject?.name ?? 'No project'}
            </span>
            <span className="composer-chip">
              {activeProject?.gitBranch || 'No branch'}
            </span>
            <label className="composer-select-label">
              <span className="sr-only">Permission mode</span>
              <select
                aria-label="Permission mode"
                disabled={!activeSessionId || !modelState.modes}
                value={currentModeId}
                onChange={(event) =>
                  onModeChange(event.target.value as DesktopApprovalMode)
                }
              >
                {modeOptions.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="composer-select-label">
              <span className="sr-only">Model</span>
              <select
                aria-label="Model"
                disabled={!activeSessionId || !modelState.models}
                value={currentModelId}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelOptions.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.name || model.modelId}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="composer-actions">
            {disabledReason ? (
              <span className="composer-disabled-reason">{disabledReason}</span>
            ) : null}
            {!activeSessionId && activeProject ? (
              <span className="composer-context-note">New thread</span>
            ) : null}
            <button
              className="secondary-button"
              disabled={!chatState.streaming}
              type="button"
              onClick={onStopGeneration}
            >
              Stop
            </button>
            <button
              className="primary-button"
              disabled={!canCompose || messageText.trim().length === 0}
              type="submit"
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function ChatTimeline({
  activeProject,
  activeSessionId,
  gitDiff,
  isDraftSession,
  onOpenReview,
  state,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  gitDiff: DesktopGitDiff | null;
  isDraftSession: boolean;
  onOpenReview: () => void;
  state: ChatState;
}) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const pendingPermissionId = state.pendingPermission?.requestId ?? '';
  const pendingQuestionId = state.pendingAskUserQuestion?.requestId ?? '';

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    timeline.scrollTop = timeline.scrollHeight;
  }, [
    pendingPermissionId,
    pendingQuestionId,
    state.items.length,
    state.streaming,
  ]);

  if (!activeProject) {
    return <div className="conversation-empty">Open a project to start</div>;
  }

  if (!activeSessionId && !isDraftSession && state.items.length === 0) {
    return (
      <ConversationEmpty
        gitDiff={gitDiff}
        label={`Start a task in ${activeProject.name}`}
        onOpenReview={onOpenReview}
      />
    );
  }

  if (state.items.length === 0) {
    return (
      <ConversationEmpty
        gitDiff={gitDiff}
        label={isDraftSession ? 'New thread ready' : 'Session ready'}
        onOpenReview={onOpenReview}
      />
    );
  }

  return (
    <div className="chat-timeline" ref={timelineRef}>
      {state.items.map((item) => (
        <TimelineItem item={item} key={item.id} />
      ))}
      <ChangedFilesSummaryCard gitDiff={gitDiff} onOpenReview={onOpenReview} />
      <div className="chat-scroll-anchor" aria-hidden="true" />
    </div>
  );
}

function ConversationEmpty({
  gitDiff,
  label,
  onOpenReview,
}: {
  gitDiff: DesktopGitDiff | null;
  label: string;
  onOpenReview: () => void;
}) {
  return (
    <div className="conversation-empty conversation-empty-stack">
      <span>{label}</span>
      <ChangedFilesSummaryCard gitDiff={gitDiff} onOpenReview={onOpenReview} />
    </div>
  );
}

function TimelineItem({ item }: { item: ChatTimelineItem }) {
  if (item.type === 'message') {
    return (
      <article className={`chat-message chat-message-${item.role}`}>
        <div className="message-role">{item.role}</div>
        <p>{item.text}</p>
      </article>
    );
  }

  if (item.type === 'tool') {
    return (
      <article className="chat-tool">
        <div className="message-role">{item.toolCall.kind || 'tool'}</div>
        <strong>{item.toolCall.title || item.toolCall.toolCallId}</strong>
        {item.toolCall.status ? <span>{item.toolCall.status}</span> : null}
      </article>
    );
  }

  if (item.type === 'plan') {
    return (
      <article className="chat-plan">
        <div className="message-role">plan</div>
        <ol>
          {item.entries.map((entry) => (
            <li key={`${entry.content}-${entry.status}`}>
              <span>{entry.status}</span>
              {entry.content}
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return <div className="chat-event">{item.label}</div>;
}

function ChangedFilesSummaryCard({
  gitDiff,
  onOpenReview,
}: {
  gitDiff: DesktopGitDiff | null;
  onOpenReview: () => void;
}) {
  const files = gitDiff?.files ?? [];
  if (files.length === 0) {
    return null;
  }

  const stats = summarizeChangedFiles(files);
  const visibleFiles = files.slice(0, 4);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);

  return (
    <section
      aria-label="Changed files summary"
      className="conversation-changes-card"
      data-testid="conversation-changes-summary"
    >
      <div className="conversation-changes-heading">
        <div>
          <span className="message-role">Changed files</span>
          <strong>
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </strong>
        </div>
        <span className="conversation-diff-stat" aria-label="Diff stats">
          <span className="diff-addition">+{stats.additions}</span>
          <span className="diff-deletion">-{stats.deletions}</span>
        </span>
      </div>
      <ul className="conversation-changes-list">
        {visibleFiles.map((file) => (
          <li key={file.path}>
            <span title={file.path}>{file.path}</span>
            <small>{formatChangedFileState(file)}</small>
          </li>
        ))}
        {hiddenFileCount > 0 ? (
          <li>
            <span>{hiddenFileCount} more</span>
            <small>Open review</small>
          </li>
        ) : null}
      </ul>
      <div className="conversation-changes-actions">
        <button
          aria-label="Review Changes"
          className="secondary-button"
          type="button"
          onClick={onOpenReview}
        >
          Review Changes
        </button>
      </div>
    </section>
  );
}

function summarizeChangedFiles(files: DesktopGitChangedFile[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (totals, file) => {
      const lines =
        file.hunks.length > 0
          ? file.hunks.flatMap((hunk) => hunk.lines)
          : file.diff.split('\n');

      for (const line of lines) {
        if (line.startsWith('+++') || line.startsWith('---')) {
          continue;
        }

        if (line.startsWith('+')) {
          totals.additions += 1;
        } else if (line.startsWith('-')) {
          totals.deletions += 1;
        }
      }

      return totals;
    },
    { additions: 0, deletions: 0 },
  );
}

function formatChangedFileState(file: DesktopGitChangedFile): string {
  const states: string[] = [];
  if (file.staged) {
    states.push('staged');
  }
  if (file.unstaged) {
    states.push('unstaged');
  }
  if (file.untracked) {
    states.push('untracked');
  }

  if (states.length === 1 && states[0] === file.status) {
    return file.status;
  }

  return states.length > 0
    ? `${file.status} · ${states.join(' + ')}`
    : file.status;
}

function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey) {
    return;
  }

  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

const fallbackModelOption = {
  modelId: 'default',
  name: 'Default model',
};

const fallbackModeOptions = [
  {
    id: 'default' as const,
    name: 'Ask before run',
    description: 'Ask before running commands.',
  },
];

function PermissionPrompts({
  onAskUserQuestionResponse,
  onPermissionResponse,
  state,
}: {
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  state: ChatState;
}) {
  const permission = state.pendingPermission;
  const question = state.pendingAskUserQuestion;
  if (!permission && !question) {
    return null;
  }

  return (
    <div className="permission-strip">
      {permission ? (
        <section className="permission-panel">
          <div>
            <span className="message-role">
              {permission.request.toolCall.kind || 'permission'}
            </span>
            <strong>
              {permission.request.toolCall.title ||
                permission.request.toolCall.toolCallId}
            </strong>
          </div>
          <div className="permission-actions">
            {permission.request.options.map((option) => (
              <button
                className={
                  option.kind.startsWith('reject')
                    ? 'secondary-button'
                    : 'primary-button'
                }
                key={option.optionId}
                onClick={() =>
                  onPermissionResponse(permission.requestId, option.optionId)
                }
                type="button"
              >
                {option.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {question ? (
        <section className="permission-panel">
          {question.request.questions.map((item) => (
            <div key={`${item.header}-${item.question}`}>
              <span className="message-role">{item.header}</span>
              <strong>{item.question}</strong>
              {item.options.length > 0 ? (
                <ul className="question-options">
                  {item.options.map((option) => (
                    <li key={`${option.label}-${option.description}`}>
                      {option.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          <div className="permission-actions">
            <button
              className="secondary-button"
              onClick={() =>
                onAskUserQuestionResponse(question.requestId, 'cancel')
              }
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() =>
                onAskUserQuestionResponse(question.requestId, 'proceed_once')
              }
              type="button"
            >
              Submit
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
