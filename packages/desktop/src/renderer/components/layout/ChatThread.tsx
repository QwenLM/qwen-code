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
import type {
  DesktopApprovalMode,
  DesktopAskUserQuestionRequest,
  DesktopModelInfo,
  DesktopPlanEntry,
  DesktopPermissionRequest,
} from '../../../shared/desktopProtocol.js';
import {
  formatRuntimeModelOptionTitle,
  formatRuntimeModelLabel,
  getRuntimeModelProviderStatus,
  groupRuntimeModelOptions,
} from './formatters.js';
import {
  AttachmentIcon,
  ChevronDownIcon,
  CopyIcon,
  DiffIcon,
  FolderPlusIcon,
  ModelIcon,
  RefreshIcon,
  SendIcon,
  SlidersIcon,
  StopIcon,
} from './SidebarIcons.js';

export function ChatThread({
  activeProject,
  activeSessionId,
  chatState,
  draftMode,
  draftModelId,
  gitDiff,
  isDraftSession,
  messageText,
  modelState,
  notice,
  onAskUserQuestionResponse,
  onCopyMessage,
  onModeChange,
  onModelChange,
  onMessageTextChange,
  onChooseWorkspace,
  onOpenModelSettings,
  onOpenFileReference,
  onOpenReview,
  onPermissionResponse,
  onRetryMessage,
  onSendMessage,
  onStopGeneration,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  chatState: ChatState;
  draftMode: DesktopApprovalMode | null;
  draftModelId: string | null;
  gitDiff: DesktopGitDiff | null;
  isDraftSession: boolean;
  messageText: string;
  modelState: ModelState;
  notice: string | null;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onCopyMessage: (message: string) => void;
  onModeChange: (mode: DesktopApprovalMode) => void;
  onModelChange: (modelId: string) => void;
  onMessageTextChange: (message: string) => void;
  onChooseWorkspace: () => void;
  onOpenModelSettings: () => void;
  onOpenFileReference: (filePath: string) => void;
  onOpenReview: () => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onRetryMessage: (message: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
  onStopGeneration: () => void;
}) {
  const canCompose = Boolean(activeProject);
  const disabledReason = activeProject ? null : 'Open a project to start';
  const placeholder = activeProject
    ? `Ask Qwen Code about ${activeProject.name}`
    : 'Open a project to start';
  const hasActiveSession = Boolean(activeSessionId);
  const currentModeId = hasActiveSession
    ? (modelState.modes?.currentModeId ?? fallbackModeOption.id)
    : (draftMode ?? fallbackModeOption.id);
  const modeOptions =
    hasActiveSession && modelState.modes
      ? modelState.modes.availableModes
      : fallbackModeOptions;
  const currentMode =
    modeOptions.find((mode) => mode.id === currentModeId) ?? fallbackModeOption;
  const configuredModelOptions = modelState.configuredModels;
  const draftModelOptions =
    configuredModelOptions.length > 0
      ? configuredModelOptions
      : [fallbackModelOption];
  const modelOptions =
    hasActiveSession && modelState.models?.availableModels.length
      ? modelState.models.availableModels
      : hasActiveSession && configuredModelOptions.length > 0
        ? configuredModelOptions
        : draftModelOptions;
  const requestedModelId = hasActiveSession
    ? (modelState.models?.currentModelId ??
      configuredModelOptions[0]?.modelId ??
      fallbackModelOption.modelId)
    : (draftModelId ??
      configuredModelOptions[0]?.modelId ??
      fallbackModelOption.modelId);
  const currentModel =
    modelOptions.find((model) => model.modelId === requestedModelId) ??
    modelOptions[0] ??
    fallbackModelOption;
  const currentModelId = currentModel.modelId;
  const modelOptionGroups = groupRuntimeModelOptions(modelOptions);
  const currentModelProviderStatus =
    getRuntimeModelProviderStatus(currentModel);
  const currentModelTitle = formatRuntimeModelOptionTitle(currentModel);
  const modelSettingsNeedsKey = currentModelProviderStatus?.state === 'missing';
  const hasTypedMessage = messageText.trim().length > 0;
  const missingKeySendWarning = modelSettingsNeedsKey && hasTypedMessage;
  const missingKeySendWarningTitle =
    'Selected model is missing an API key; sending may fail until configured.';
  const modelSettingsTitle = modelSettingsNeedsKey
    ? 'Configure models - API key missing'
    : 'Configure models';
  const sendTitle = missingKeySendWarning
    ? `Send message - ${missingKeySendWarningTitle}`
    : 'Send message';
  const modeSelectDisabled =
    !activeProject || (hasActiveSession && !modelState.modes);
  const modelSelectDisabled =
    !activeProject ||
    (hasActiveSession
      ? !modelState.models
      : configuredModelOptions.length === 0);

  return (
    <section
      className="panel panel-main"
      aria-label="AI conversation thread"
      data-testid="chat-thread"
    >
      <div className="chat-status-announcement sr-only" aria-live="polite">
        Conversation {chatState.streaming ? 'streaming' : chatState.connection}
      </div>
      <ChatTimeline
        activeProject={activeProject}
        state={chatState}
        activeSessionId={activeSessionId}
        gitDiff={gitDiff}
        isDraftSession={isDraftSession}
        onAskUserQuestionResponse={onAskUserQuestionResponse}
        onCopyMessage={onCopyMessage}
        onOpenFileReference={onOpenFileReference}
        onOpenReview={onOpenReview}
        onPermissionResponse={onPermissionResponse}
        onRetryMessage={onRetryMessage}
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
          rows={2}
          value={messageText}
        />
        <div className="composer-control-row">
          <div className="composer-context" aria-label="Composer context">
            <button
              aria-label="Attach files"
              aria-describedby="composer-attachment-help"
              aria-disabled="true"
              className="composer-icon-button"
              data-testid="composer-attach-button"
              title="Attachments are not available yet"
              type="button"
              onClick={(event) => event.preventDefault()}
            >
              <AttachmentIcon />
            </button>
            <span className="sr-only" id="composer-attachment-help">
              Attachments are not available yet.
            </span>
            <span
              className="composer-chip composer-chip-project"
              title={activeProject?.path ?? disabledReason ?? undefined}
            >
              {activeProject?.name ?? 'No project'}
            </span>
            <span className="composer-chip">
              {activeProject?.gitBranch || 'No branch'}
            </span>
            <label
              className="composer-select-label"
              data-testid="composer-mode-control"
              title={formatModeTitle(currentMode)}
            >
              <span className="sr-only">Permission mode</span>
              <span className="composer-select-shell">
                <SlidersIcon className="composer-select-leading-icon" />
                <select
                  aria-label="Permission mode"
                  disabled={modeSelectDisabled}
                  title={formatModeTitle(currentMode)}
                  value={currentModeId}
                  onChange={(event) =>
                    onModeChange(event.target.value as DesktopApprovalMode)
                  }
                >
                  {modeOptions.map((mode) => (
                    <option
                      key={mode.id}
                      title={formatModeTitle(mode)}
                      value={mode.id}
                    >
                      {formatCompactModeLabel(mode)}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="composer-select-chevron" />
              </span>
            </label>
            <label
              className={
                currentModelProviderStatus
                  ? 'composer-select-label composer-select-label-with-status'
                  : 'composer-select-label'
              }
              data-testid="composer-model-control"
              title={currentModelTitle}
            >
              <span className="sr-only">Model</span>
              <span className="composer-select-shell">
                <ModelIcon className="composer-select-leading-icon" />
                <select
                  aria-label="Model"
                  disabled={modelSelectDisabled}
                  title={currentModelTitle}
                  value={currentModelId}
                  onChange={(event) => onModelChange(event.target.value)}
                >
                  {modelOptionGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option
                          key={model.modelId}
                          title={formatRuntimeModelOptionTitle(model)}
                          value={model.modelId}
                        >
                          {formatRuntimeModelLabel(model)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {currentModelProviderStatus ? (
                  <span
                    aria-label={currentModelProviderStatus.title}
                    className={`composer-model-status-dot composer-model-status-${currentModelProviderStatus.state}`}
                    data-testid="composer-model-provider-status"
                    role="img"
                    title={currentModelProviderStatus.title}
                  />
                ) : null}
                <ChevronDownIcon className="composer-select-chevron" />
              </span>
            </label>
            <button
              aria-label="Configure models"
              className={
                modelSettingsNeedsKey
                  ? 'composer-icon-button composer-model-settings-button composer-model-settings-button-warning'
                  : 'composer-icon-button composer-model-settings-button'
              }
              data-testid="composer-model-settings-button"
              title={modelSettingsTitle}
              type="button"
              onClick={onOpenModelSettings}
            >
              <ModelIcon />
            </button>
          </div>
          <div className="composer-actions">
            {notice ? (
              <span className="composer-context-note">{notice}</span>
            ) : missingKeySendWarning ? (
              <span
                className="composer-context-note composer-context-note-warning"
                data-testid="composer-send-warning"
                title={missingKeySendWarningTitle}
              >
                API key missing
              </span>
            ) : null}
            {!activeProject ? (
              <button
                aria-label="Open Project"
                className="composer-open-project-button"
                data-testid="composer-open-project-button"
                title={disabledReason ?? 'Open Project'}
                type="button"
                onClick={onChooseWorkspace}
              >
                <FolderPlusIcon />
                <span>Open Project</span>
              </button>
            ) : null}
            {!activeSessionId && activeProject && !missingKeySendWarning ? (
              <span className="composer-context-note">New thread</span>
            ) : null}
            <button
              aria-label="Stop"
              className="composer-action-button composer-stop-button"
              disabled={!chatState.streaming}
              title="Stop generation"
              type="button"
              onClick={onStopGeneration}
            >
              <StopIcon />
              <span className="sr-only">Stop</span>
            </button>
            <button
              aria-label="Send"
              className="composer-action-button composer-send-button"
              disabled={!canCompose || messageText.trim().length === 0}
              title={sendTitle}
              type="submit"
            >
              <SendIcon />
              <span className="sr-only">Send</span>
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
  onAskUserQuestionResponse,
  onCopyMessage,
  onOpenFileReference,
  onOpenReview,
  onPermissionResponse,
  onRetryMessage,
  state,
}: {
  activeProject: DesktopProject | null;
  activeSessionId: string | null;
  gitDiff: DesktopGitDiff | null;
  isDraftSession: boolean;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onCopyMessage: (message: string) => void;
  onOpenFileReference: (filePath: string) => void;
  onOpenReview: () => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onRetryMessage: (message: string) => void;
  state: ChatState;
}) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const pendingPermissionId = state.pendingPermission?.requestId ?? '';
  const pendingQuestionId = state.pendingAskUserQuestion?.requestId ?? '';
  const hasPendingPrompt = Boolean(
    state.pendingPermission || state.pendingAskUserQuestion,
  );

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
    return (
      <div className="conversation-empty" data-testid="conversation-empty">
        <span>Open a project to start</span>
      </div>
    );
  }

  if (
    !activeSessionId &&
    !isDraftSession &&
    state.items.length === 0 &&
    !hasPendingPrompt
  ) {
    return (
      <ConversationEmpty
        gitDiff={gitDiff}
        label={`Start a task in ${activeProject.name}`}
        onOpenReview={onOpenReview}
      />
    );
  }

  if (state.items.length === 0 && !hasPendingPrompt) {
    return (
      <ConversationEmpty
        gitDiff={gitDiff}
        label={isDraftSession ? 'New thread ready' : 'Session ready'}
        onOpenReview={onOpenReview}
      />
    );
  }

  let latestUserMessage: string | null = null;

  return (
    <div className="chat-timeline" ref={timelineRef}>
      {state.items.map((item) => {
        const previousUserMessage = latestUserMessage;
        if (item.type === 'message' && item.role === 'user') {
          latestUserMessage = item.text;
        }

        return (
          <TimelineItem
            gitDiff={gitDiff}
            item={item}
            key={item.id}
            previousUserMessage={previousUserMessage}
            onCopyMessage={onCopyMessage}
            onOpenFileReference={onOpenFileReference}
            onOpenReview={onOpenReview}
            onRetryMessage={onRetryMessage}
          />
        );
      })}
      <InlinePendingPrompts
        pendingAskUserQuestion={state.pendingAskUserQuestion}
        pendingPermission={state.pendingPermission}
        onAskUserQuestionResponse={onAskUserQuestionResponse}
        onPermissionResponse={onPermissionResponse}
      />
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
    <div
      className="conversation-empty conversation-empty-stack"
      data-testid="conversation-empty"
    >
      <span>{label}</span>
      <ChangedFilesSummaryCard gitDiff={gitDiff} onOpenReview={onOpenReview} />
    </div>
  );
}

function TimelineItem({
  gitDiff,
  item,
  onCopyMessage,
  onOpenFileReference,
  onOpenReview,
  onRetryMessage,
  previousUserMessage,
}: {
  gitDiff: DesktopGitDiff | null;
  item: ChatTimelineItem;
  onCopyMessage: (message: string) => void;
  onOpenFileReference: (filePath: string) => void;
  onOpenReview: () => void;
  onRetryMessage: (message: string) => void;
  previousUserMessage: string | null;
}) {
  if (item.type === 'message') {
    const fileReferenceSet =
      item.role === 'assistant'
        ? extractFileReferences(item.text)
        : { references: [], hiddenCount: 0 };
    const fileReferences = fileReferenceSet.references;
    const hasChangedFiles = Boolean(gitDiff?.files.length);

    return (
      <article
        aria-label={
          item.role === 'assistant' ? 'Assistant message' : 'User message'
        }
        className={`chat-message chat-message-${item.role}`}
        data-testid={
          item.role === 'assistant' ? 'assistant-message' : undefined
        }
      >
        <p>{item.text}</p>
        {fileReferences.length > 0 ? (
          <ul
            aria-label="Assistant file references"
            className="message-file-references"
            data-testid="assistant-file-references"
          >
            {fileReferences.map((reference) => (
              <li key={reference.label}>
                <button
                  aria-label={`Open ${reference.label}`}
                  title={`Open ${reference.label}`}
                  type="button"
                  onClick={() => onOpenFileReference(reference.path)}
                >
                  {reference.label}
                </button>
              </li>
            ))}
            {fileReferenceSet.hiddenCount > 0 ? (
              <li>
                <span
                  aria-label={`${fileReferenceSet.hiddenCount} more file references`}
                  className="message-file-reference-overflow"
                >
                  +{fileReferenceSet.hiddenCount} more
                </span>
              </li>
            ) : null}
          </ul>
        ) : null}
        {item.role === 'assistant' ? (
          <AssistantMessageActions
            hasChangedFiles={hasChangedFiles}
            message={item.text}
            retryMessage={previousUserMessage}
            onCopyMessage={onCopyMessage}
            onOpenReview={onOpenReview}
            onRetryMessage={onRetryMessage}
          />
        ) : null}
      </article>
    );
  }

  if (item.type === 'tool') {
    return <ToolActivityCard toolCall={item.toolCall} />;
  }

  if (item.type === 'plan') {
    const taskCount = item.entries.length;

    return (
      <article
        aria-label="Plan"
        className="chat-plan"
        data-testid="conversation-plan-card"
      >
        <div className="chat-plan-heading">
          <span className="conversation-activity-label">Plan</span>
          <span className="conversation-plan-count">
            {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
          </span>
        </div>
        <ol>
          {item.entries.map((entry) => (
            <li key={`${entry.content}-${entry.status}`}>
              <span
                className={`conversation-plan-status ${getPlanStatusClass(
                  entry.status,
                )}`}
              >
                {formatPlanStatus(entry.status)}
              </span>
              <span className="conversation-plan-content">{entry.content}</span>
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return <div className="chat-event">{item.label}</div>;
}

function AssistantMessageActions({
  hasChangedFiles,
  message,
  onCopyMessage,
  onOpenReview,
  onRetryMessage,
  retryMessage,
}: {
  hasChangedFiles: boolean;
  message: string;
  onCopyMessage: (message: string) => void;
  onOpenReview: () => void;
  onRetryMessage: (message: string) => void;
  retryMessage: string | null;
}) {
  return (
    <div
      aria-label="Assistant message actions"
      className="message-action-row"
      data-testid="assistant-message-actions"
    >
      <button
        aria-label="Copy Response"
        className="message-action-button"
        title="Copy Response"
        type="button"
        onClick={() => onCopyMessage(message)}
      >
        <CopyIcon />
        <span className="sr-only">Copy Response</span>
      </button>
      <button
        aria-label="Retry Last Prompt"
        className="message-action-button"
        disabled={!retryMessage}
        title="Retry Last Prompt"
        type="button"
        onClick={() => {
          if (retryMessage) {
            onRetryMessage(retryMessage);
          }
        }}
      >
        <RefreshIcon />
        <span className="sr-only">Retry Last Prompt</span>
      </button>
      {hasChangedFiles ? (
        <button
          aria-label="Open Changes"
          className="message-action-button"
          title="Open Changes"
          type="button"
          onClick={onOpenReview}
        >
          <DiffIcon />
          <span className="sr-only">Open Changes</span>
        </button>
      ) : null}
    </div>
  );
}

const MAX_VISIBLE_FILE_REFERENCES = 6;

const FILE_REFERENCE_PATTERN =
  /(?:^|[\s([{"'`])((?:[\w@.-]+\/)*(?:(?:[\w@.-]+\.(?:astro|bash|c|cc|cjs|cpp|css|cts|go|gradle|h|hpp|html|java|js|jsx|json|kt|lock|md|mdx|mjs|mts|py|rs|scss|sh|sql|svelte|swift|toml|ts|tsx|txt|vue|xml|ya?ml|zsh))|(?:Dockerfile|Makefile)(?:\.[\w.-]+)?|(?:\.(?:env(?:\.[\w.-]+)?|gitignore|npmrc)))(?::\d+(?::\d+)?)?)(?=$|[\s)\]},.;:"'`])/giu;

function extractFileReferences(text: string): {
  references: Array<{ label: string; path: string }>;
  hiddenCount: number;
} {
  const references: Array<{ label: string; path: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const label = match[1];
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    references.push({
      label,
      path: stripFileReferenceLine(label),
    });
  }

  return {
    references: references.slice(0, MAX_VISIBLE_FILE_REFERENCES),
    hiddenCount: Math.max(0, references.length - MAX_VISIBLE_FILE_REFERENCES),
  };
}

function stripFileReferenceLine(reference: string): string {
  return reference.replace(/:\d+(?::\d+)?$/u, '');
}

function ToolActivityCard({
  toolCall,
}: {
  toolCall: Extract<ChatTimelineItem, { type: 'tool' }>['toolCall'];
}) {
  const title =
    toolCall.title || formatToolKindTitle(toolCall.kind) || 'Tool activity';
  const kind = toolCall.kind || 'tool';
  const status = toolCall.status || 'running';
  const inputPreview = formatToolInput(toolCall.rawInput);
  const outputPreview = formatToolOutput(toolCall.rawOutput);
  const fileReferences = getToolFileReferences(toolCall);
  const visibleFiles = fileReferences.slice(0, 4);
  const hiddenFileCount = Math.max(0, fileReferences.length - 4);

  return (
    <article
      aria-label="Tool activity"
      className={`conversation-tool-card ${getToolStatusClass(status)}`}
      data-testid="conversation-tool-card"
    >
      <div className="conversation-tool-heading">
        <div>
          <span className="conversation-activity-label">
            {formatToolKindTitle(kind) ?? 'Tool'}
          </span>
          <strong>{title}</strong>
        </div>
        <span className="conversation-tool-status">
          {formatActivityStatus(status)}
        </span>
      </div>
      {inputPreview ? (
        <div className="conversation-tool-section">
          <span className="conversation-tool-section-label">Input</span>
          <pre aria-label="Tool input preview" title={inputPreview}>
            {inputPreview}
          </pre>
        </div>
      ) : null}
      {visibleFiles.length > 0 ? (
        <ul className="conversation-tool-files" aria-label="Referenced files">
          {visibleFiles.map((file) => (
            <li key={`${file.path}:${file.line ?? ''}`} title={file.path}>
              {formatToolFileReference(file)}
            </li>
          ))}
          {hiddenFileCount > 0 ? <li>{hiddenFileCount} more</li> : null}
        </ul>
      ) : null}
      {outputPreview ? (
        <div className="conversation-tool-section conversation-tool-output">
          <span className="conversation-tool-section-label">Result</span>
          <pre aria-label="Tool result preview" title={outputPreview}>
            {outputPreview}
          </pre>
        </div>
      ) : null}
    </article>
  );
}

function InlinePendingPrompts({
  onAskUserQuestionResponse,
  onPermissionResponse,
  pendingAskUserQuestion,
  pendingPermission,
}: {
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  pendingAskUserQuestion: ChatState['pendingAskUserQuestion'];
  pendingPermission: ChatState['pendingPermission'];
}) {
  if (!pendingPermission && !pendingAskUserQuestion) {
    return null;
  }

  return (
    <>
      {pendingPermission ? (
        <CommandApprovalCard
          permission={pendingPermission.request}
          requestId={pendingPermission.requestId}
          onPermissionResponse={onPermissionResponse}
        />
      ) : null}
      {pendingAskUserQuestion ? (
        <AskUserQuestionCard
          questionRequest={pendingAskUserQuestion.request}
          requestId={pendingAskUserQuestion.requestId}
          onAskUserQuestionResponse={onAskUserQuestionResponse}
        />
      ) : null}
    </>
  );
}

function CommandApprovalCard({
  onPermissionResponse,
  permission,
  requestId,
}: {
  onPermissionResponse: (requestId: string, optionId: string) => void;
  permission: DesktopPermissionRequest;
  requestId: string;
}) {
  const toolCall = permission.toolCall;
  const title =
    toolCall.title || formatToolKindTitle(toolCall.kind) || 'Command approval';
  const kind = formatToolKindTitle(toolCall.kind) ?? 'Approval';
  const inputPreview = formatToolInput(toolCall.rawInput);
  const status = formatPendingPromptStatus(
    toolCall.status || 'waiting for approval',
  );

  return (
    <section
      aria-label="Command approval"
      className="conversation-approval-card"
      data-testid="conversation-approval-card"
    >
      <div className="conversation-approval-heading">
        <div>
          <span className="conversation-prompt-label">{kind}</span>
          <strong>{title}</strong>
        </div>
        <span className="conversation-approval-status">{status}</span>
      </div>
      {inputPreview ? (
        <pre
          aria-label="Command to approve"
          className="conversation-approval-command"
          title={inputPreview}
        >
          {inputPreview}
        </pre>
      ) : null}
      <div className="conversation-approval-actions">
        {permission.options.map((option) => (
          <button
            aria-label={option.name}
            className={
              option.kind.startsWith('reject')
                ? 'secondary-button'
                : 'primary-button'
            }
            key={option.optionId}
            onClick={() => onPermissionResponse(requestId, option.optionId)}
            type="button"
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function AskUserQuestionCard({
  onAskUserQuestionResponse,
  questionRequest,
  requestId,
}: {
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  questionRequest: DesktopAskUserQuestionRequest;
  requestId: string;
}) {
  return (
    <section
      aria-label="Question for user"
      className="conversation-approval-card"
      data-testid="conversation-question-card"
    >
      <div className="conversation-approval-heading">
        <div>
          <span className="conversation-prompt-label">Question</span>
          <strong>Input needed</strong>
        </div>
        <span className="conversation-approval-status">Waiting</span>
      </div>
      <div className="conversation-question-list">
        {questionRequest.questions.map((item) => (
          <div key={`${item.header}-${item.question}`}>
            <span className="conversation-question-label">
              {formatQuestionHeader(item.header)}
            </span>
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
      </div>
      <div className="conversation-approval-actions">
        <button
          aria-label="Cancel Question"
          className="secondary-button"
          onClick={() => onAskUserQuestionResponse(requestId, 'cancel')}
          type="button"
        >
          Cancel
        </button>
        <button
          aria-label="Submit Question"
          className="primary-button"
          onClick={() => onAskUserQuestionResponse(requestId, 'proceed_once')}
          type="button"
        >
          Submit
        </button>
      </div>
    </section>
  );
}

function formatToolInput(input: unknown): string | null {
  if (typeof input === 'string') {
    return boundToolPreview(input);
  }

  const record = getRecord(input);
  if (!record) {
    return null;
  }

  for (const key of ['command', 'path', 'filePath', 'pattern', 'query']) {
    const value = getStringField(record, key);
    if (value) {
      return boundToolPreview(value);
    }
  }

  return null;
}

function formatToolOutput(output: unknown): string | null {
  if (typeof output === 'string') {
    return boundToolPreview(output);
  }

  if (typeof output === 'number' || typeof output === 'boolean') {
    return String(output);
  }

  const record = getRecord(output);
  if (!record) {
    return null;
  }

  for (const key of ['output', 'stdout', 'stderr', 'message', 'result']) {
    const value = getStringField(record, key);
    if (value) {
      return boundToolPreview(value);
    }
  }

  const outcome = getStringField(record, 'outcome');
  return outcome ? boundToolPreview(outcome) : null;
}

function getToolFileReferences(
  toolCall: Extract<ChatTimelineItem, { type: 'tool' }>['toolCall'],
): Array<{ path: string; line?: number | null }> {
  const references: Array<{ path: string; line?: number | null }> = [];

  for (const location of toolCall.locations ?? []) {
    if (location.path.trim().length > 0) {
      references.push({ path: location.path, line: location.line });
    }
  }

  const input = getRecord(toolCall.rawInput);
  if (input) {
    const line = getNumberField(input, 'line');
    for (const key of ['path', 'filePath']) {
      const path = getStringField(input, key);
      if (path) {
        references.push({ path, line });
      }
    }

    const paths = input['paths'];
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === 'string' && path.trim().length > 0) {
          references.push({ path });
        }
      }
    }
  }

  return dedupeToolFileReferences(references);
}

function dedupeToolFileReferences(
  references: Array<{ path: string; line?: number | null }>,
): Array<{ path: string; line?: number | null }> {
  const seen = new Set<string>();
  const unique: Array<{ path: string; line?: number | null }> = [];

  for (const reference of references) {
    const key = `${reference.path}:${reference.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(reference);
  }

  return unique;
}

function formatToolFileReference(file: {
  path: string;
  line?: number | null;
}): string {
  return file.line ? `${file.path}:${file.line}` : file.path;
}

function formatToolKindTitle(kind: string | undefined): string | null {
  if (!kind) {
    return null;
  }

  return formatActivityStatus(kind);
}

function formatPendingPromptStatus(status: string): string {
  const normalized = status.replace(/[-_]+/gu, ' ').trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'waiting for approval') {
    return 'Needs approval';
  }

  return formatActivityStatus(status);
}

function formatQuestionHeader(header: string): string {
  const trimmed = header.trim();
  if (!trimmed) {
    return 'Question';
  }

  if (trimmed === trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) {
    return formatActivityStatus(trimmed);
  }

  return trimmed;
}

function formatActivityStatus(value: string): string {
  const normalized = value.replace(/[-_]+/gu, ' ').trim().toLowerCase();
  if (normalized.length === 0) {
    return 'Unknown';
  }

  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function formatPlanStatus(status: DesktopPlanEntry['status']): string {
  return formatActivityStatus(status);
}

function getPlanStatusClass(status: DesktopPlanEntry['status']): string {
  return `conversation-plan-status-${status.replace(/_/gu, '-')}`;
}

function getToolStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('cancel') ||
    normalized.includes('deny')
  ) {
    return 'conversation-tool-card-danger';
  }

  if (
    normalized.includes('complete') ||
    normalized.includes('success') ||
    normalized.includes('done')
  ) {
    return 'conversation-tool-card-complete';
  }

  return 'conversation-tool-card-running';
}

function boundToolPreview(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.length > 240
    ? `${trimmed.slice(0, 237).trimEnd()}...`
    : trimmed;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getNumberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  const visibleFiles = files.slice(0, 3);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);

  return (
    <section
      aria-label="Changed files summary"
      className="conversation-changes-card"
      data-testid="conversation-changes-summary"
    >
      <div className="conversation-changes-heading">
        <div className="conversation-changes-title">
          <span className="conversation-activity-label">Changed files</span>
          <strong>
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </strong>
        </div>
        <div className="conversation-changes-meta">
          <span className="conversation-diff-stat" aria-label="Diff stats">
            <span className="diff-addition">+{stats.additions}</span>
            <span className="diff-deletion">-{stats.deletions}</span>
          </span>
          <button
            aria-label="Review Changes"
            className="conversation-changes-review-button"
            title="Review Changes"
            type="button"
            onClick={onOpenReview}
          >
            <DiffIcon />
            <span>Review</span>
          </button>
        </div>
      </div>
      <ul className="conversation-changes-list" aria-label="Changed files">
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
    return formatChangeStateToken(file.status);
  }

  return states.length > 0
    ? `${formatChangeStateToken(file.status)} · ${states
        .map((state) => formatChangeStateToken(state))
        .join(' + ')}`
    : formatChangeStateToken(file.status);
}

function formatChangeStateToken(state: string): string {
  return formatActivityStatus(state);
}

function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey) {
    return;
  }

  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function formatCompactModeLabel(mode: { name: string }): string {
  return formatCompactRuntimeLabel(mode.name, 22);
}

function formatModeTitle(mode: { name: string; description?: string }): string {
  const name = mode.name.trim();
  const description = mode.description?.trim();

  return description ? `${name} - ${description}` : name;
}

function formatCompactRuntimeLabel(label: string, maxLength: number): string {
  const trimmed = label.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const truncated = trimmed.slice(0, maxLength - 3).replace(/[\s/_-]+$/u, '');

  return `${truncated}...`;
}

const fallbackModelOption: DesktopModelInfo = {
  modelId: 'default',
  name: 'Default model',
};

const fallbackModeOption = {
  id: 'default' as const,
  name: 'Ask before run',
  description: 'Ask before running commands.',
};

const fallbackModeOptions = [
  fallbackModeOption,
  {
    id: 'auto-edit' as const,
    name: 'Auto Edit',
    description: 'Allow edits while keeping command approvals visible.',
  },
  {
    id: 'plan' as const,
    name: 'Plan',
    description: 'Review the plan before changes are applied.',
  },
  {
    id: 'yolo' as const,
    name: 'YOLO',
    description: 'Run without approval prompts.',
  },
];
