/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FormEvent } from 'react';
import type { ChatState, ChatTimelineItem } from '../../stores/chatStore.js';

export function ChatThread({
  activeSessionId,
  chatState,
  messageText,
  onAskUserQuestionResponse,
  onMessageTextChange,
  onPermissionResponse,
  onSendMessage,
  onStopGeneration,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  messageText: string;
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onMessageTextChange: (message: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
  onStopGeneration: () => void;
}) {
  return (
    <section
      className="panel panel-main"
      aria-label="AI conversation thread"
      data-testid="chat-thread"
    >
      <div className="panel-header">
        <h3>Conversation</h3>
        <span>{chatState.streaming ? 'Streaming' : chatState.connection}</span>
      </div>
      <ChatTimeline state={chatState} activeSessionId={activeSessionId} />
      <PermissionPrompts
        state={chatState}
        onAskUserQuestionResponse={onAskUserQuestionResponse}
        onPermissionResponse={onPermissionResponse}
      />
      <form className="composer" onSubmit={onSendMessage}>
        <textarea
          aria-label="Message"
          disabled={!activeSessionId}
          onChange={(event) => onMessageTextChange(event.target.value)}
          placeholder={activeSessionId ? 'Message Qwen Code' : ''}
          rows={3}
          value={messageText}
        />
        <div className="composer-actions">
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
            disabled={!activeSessionId || messageText.trim().length === 0}
            type="submit"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function ChatTimeline({
  activeSessionId,
  state,
}: {
  activeSessionId: string | null;
  state: ChatState;
}) {
  if (!activeSessionId) {
    return <div className="conversation-empty">No session selected</div>;
  }

  if (state.items.length === 0) {
    return <div className="conversation-empty">Session ready</div>;
  }

  return (
    <div className="chat-timeline">
      {state.items.map((item) => (
        <TimelineItem item={item} key={item.id} />
      ))}
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
