/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import type { DesktopProject } from '../../api/client.js';
import type { ChatState, ChatTimelineItem } from '../../stores/chatStore.js';
import type { ModelState } from '../../stores/modelStore.js';
import type { DesktopApprovalMode } from '../../../shared/desktopProtocol.js';

export function ChatThread({
  activeProject,
  activeSessionId,
  chatState,
  isDraftSession,
  messageText,
  modelState,
  onAskUserQuestionResponse,
  onModeChange,
  onModelChange,
  onMessageTextChange,
  onPermissionResponse,
  onSendMessage,
  onStopGeneration,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  chatState: ChatState;
  isDraftSession: boolean;
  messageText: string;
  modelState: ModelState;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onMessageTextChange: (message: string) => void;
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
        isDraftSession={isDraftSession}
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
  isDraftSession,
  state,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  isDraftSession: boolean;
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
      <div className="conversation-empty">
        Start a task in {activeProject.name}
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="conversation-empty">
        {isDraftSession ? 'New thread ready' : 'Session ready'}
      </div>
    );
  }

  return (
    <div className="chat-timeline" ref={timelineRef}>
      {state.items.map((item) => (
        <TimelineItem item={item} key={item.id} />
      ))}
      <div className="chat-scroll-anchor" aria-hidden="true" />
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
