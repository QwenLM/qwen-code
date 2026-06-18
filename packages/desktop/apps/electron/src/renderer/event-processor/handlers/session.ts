/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */

import type {
  SessionState,
  ProcessResult,
  CompleteEvent,
  ErrorEvent,
  TypedErrorEvent,
  SourcesChangedEvent,
  LabelsChangedEvent,
  SessionStatusChangedEvent,
  SessionFlaggedEvent,
  SessionUnflaggedEvent,
  SessionArchivedEvent,
  SessionUnarchivedEvent,
  NameChangedEvent,
  PermissionRequestEvent,
  CredentialRequestEvent,
  PlanSubmittedEvent,
  StatusEvent,
  InfoEvent,
  InterruptedEvent,
  TitleGeneratedEvent,
  TitleRegeneratingEvent,
  AsyncOperationEvent,
  WorkingDirectoryChangedEvent,
  PermissionModeChangedEvent,
  SessionModelChangedEvent,
  LLMConnectionChangedEvent,
  UserMessageEvent,
  MessageContentUpdatedEvent,
  MessageAnnotationsUpdatedEvent,
  SessionSharedEvent,
  SessionUnsharedEvent,
  AuthRequestEvent,
  AuthCompletedEvent,
  UsageUpdateEvent,
  AvailableCommandsUpdateEvent,
  Effect,
} from '../types';
import type { Message } from '../../../shared/types';
import { generateMessageId, appendMessage } from '../helpers';

/**
 * Handle complete - agent loop finished
 *
 * Sets isProcessing: false, clears streaming state.
 * Also marks any running tools as complete (fail-safe).
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent,
): ProcessResult {
  const { session } = state;

  // Fail-safe: mark any non-terminal tools as complete.
  // Catches 'executing' (normal) and 'backgrounded' (spurious — e.g. foreground Agent
  // whose result contained agentId:). Genuinely backgrounded tasks have isBackground=true
  // AND a taskId, so they're excluded — task_completed will finalize them.
  const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error']);
  let updatedMessages = session.messages;
  const hasRunningTools = session.messages.some(
    (m) =>
      m.role === 'tool' &&
      !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '') &&
      !(m.isBackground && m.taskId), // Don't force-complete genuine background tasks
  );

  if (hasRunningTools) {
    updatedMessages = session.messages.map((m) => {
      if (
        m.role === 'tool' &&
        !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '') &&
        !(m.isBackground && m.taskId)
      ) {
        return {
          ...m,
          toolStatus: 'completed' as const,
          toolResult: m.toolResult ?? '',
        };
      }
      return m;
    });
  }

  // Clear transient streaming state on assistant messages.
  // After a stop, text_delta events from generator drain can arrive after the
  // interrupted event, creating new assistant messages with isPending/isStreaming
  // still set. The complete event is the final signal that no more events will
  // arrive, so it's the right place to guarantee these flags are cleared.
  updatedMessages = updatedMessages.map((m) =>
    m.role === 'assistant' && (m.isPending || m.isStreaming)
      ? { ...m, isPending: false, isStreaming: false }
      : m,
  );

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined, // Clear any lingering status
        // Update tokenUsage from complete event (for real-time context counter updates)
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
        // Update hasUnread flag from main process (state machine for NEW badge)
        // Only update if explicitly provided - undefined means "don't change"
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  };
}

/**
 * Handle error - simple error event
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent,
): ProcessResult {
  const { session } = state;

  // Fail-safe: Mark any running tools as failed and clear transient streaming state
  const messagesWithFailedTools = session.messages.map((m) => {
    if (
      m.role === 'tool' &&
      m.toolResult === undefined &&
      m.toolStatus !== 'completed' &&
      m.toolStatus !== 'error'
    ) {
      return {
        ...m,
        toolStatus: 'error' as const,
        toolResult: 'Error occurred',
        isError: true,
      };
    }
    if (m.role === 'assistant' && (m.isPending || m.isStreaming)) {
      return { ...m, isPending: false, isStreaming: false };
    }
    return m;
  });

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  };

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined, // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  };
}

/**
 * Handle typed_error - error with structured details
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent,
): ProcessResult {
  const { session } = state;

  // Fail-safe: Mark any running tools as failed and clear transient streaming state
  const messagesWithFailedTools = session.messages.map((m) => {
    if (
      m.role === 'tool' &&
      m.toolResult === undefined &&
      m.toolStatus !== 'completed' &&
      m.toolStatus !== 'error'
    ) {
      return {
        ...m,
        toolStatus: 'error' as const,
        toolResult: 'Error occurred',
        isError: true,
      };
    }
    if (m.role === 'assistant' && (m.isPending || m.isStreaming)) {
      return { ...m, isPending: false, isStreaming: false };
    }
    return m;
  });

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.title
      ? `${event.error.title}: ${event.error.message}`
      : event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    errorActions: event.error.actions?.map((a) => ({
      key: a.key,
      label: a.label,
      action: a.action,
      url: a.url,
      sourceSlug: a.sourceSlug,
    })),
  };

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined, // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  };
}

/**
 * Handle status - status message (e.g., compacting)
 * Stores on session for ProcessingIndicator AND appends as message for TurnCard activity
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent,
): ProcessResult {
  const { session, streaming } = state;

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType,
  };

  const updatedSession = appendMessage(session, statusMessage);

  return {
    state: {
      session: {
        ...updatedSession,
        // Also store on session for ProcessingIndicator
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
        },
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle info - info message (may update existing compacting message)
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent,
): ProcessResult {
  const { session, streaming } = state;

  // If this is a compaction complete, update the existing compacting message and clear currentStatus
  if (event.statusType === 'compaction_complete') {
    const updatedMessages = session.messages.map((m) =>
      m.role === 'status' && m.statusType === 'compacting'
        ? {
            ...m,
            role: 'info' as const,
            content: event.message,
            statusType: 'compaction_complete' as const,
            infoLevel: event.level,
          }
        : m,
    );
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined, // Clear status from ProcessingIndicator
        },
        streaming,
      },
      effects: [],
    };
  }

  // Otherwise, add as new info message
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  };

  return {
    state: {
      session: appendMessage(session, infoMessage),
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle interrupted - agent was interrupted
 * When message is provided, it's a user-initiated stop (shows "Response interrupted")
 * When message is omitted, it's a silent redirect (user sent new message while processing)
 * When queuedMessages is provided, those messages were waiting to be processed and should
 * be restored to the input field (the corresponding user bubbles are removed from the chat).
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent,
): ProcessResult {
  const { session } = state;
  const effects: Effect[] = [];

  // Clear transient streaming state (isPending, isStreaming) and mark running tools as interrupted
  // These fields are not persisted, so this matches the state after a reload
  // Also filter out status messages - they are transient UI state that shouldn't persist after interruption
  // (similar to isPending/isStreaming, and they're not persisted to disk anyway)
  // Also remove queued user messages — they are being restored to the input field
  const updatedMessages = session.messages
    .filter((m) => m.role !== 'status') // Remove transient status messages
    .filter((m) => !m.isQueued) // Remove queued user messages (restored to input)
    .map((m) => {
      // Mark running tools as interrupted
      if (
        m.role === 'tool' &&
        m.toolResult === undefined &&
        m.toolStatus !== 'completed' &&
        m.toolStatus !== 'error'
      ) {
        return {
          ...m,
          toolStatus: 'error' as const,
          toolResult: 'Interrupted',
          isError: true,
        };
      }
      // Clear pending state on assistant messages (transient streaming state)
      if (m.role === 'assistant' && m.isPending) {
        return { ...m, isPending: false, isStreaming: false };
      }
      return m;
    });

  // Only add the "Response interrupted" message if provided (not a silent redirect)
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages;

  // Restore queued message text to the input field
  if (event.queuedMessages && event.queuedMessages.length > 0) {
    effects.push({
      type: 'restore_input',
      text: event.queuedMessages.join('\n\n'),
    });
  }

  return {
    state: {
      session: {
        ...session,
        isProcessing: false,
        messages,
        currentStatus: undefined, // Clear any lingering status
      },
      streaming: null,
    },
    effects,
  };
}

/**
 * Handle title_generated - update session title and clear regenerating state
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        name: event.title,
        // Clear regenerating state - title generation completed
        isRegeneratingTitle: false,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle title_regenerating - set regenerating state for shimmer effect
 * @deprecated Use handleAsyncOperation instead
 */
export function handleTitleRegenerating(
  state: SessionState,
  event: TitleRegeneratingEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        isRegeneratingTitle: event.isRegenerating,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle async_operation - set async operation state for shimmer effect
 * Generic handler for any async operation (sharing, updating share, revoking, title regeneration)
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle working_directory_changed - update session working directory (user-initiated via UI)
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle permission_mode_changed - return effect for parent to handle session options
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent,
): ProcessResult {
  return {
    state,
    effects: [
      {
        type: 'permission_mode_changed',
        sessionId: event.sessionId,
        permissionMode: event.permissionMode,
        previousPermissionMode: event.previousPermissionMode,
        transitionDisplay: event.transitionDisplay,
        modeVersion: event.modeVersion,
        changedAt: event.changedAt,
        changedBy: event.changedBy,
      },
    ],
  };
}

/**
 * Handle session_model_changed - update session model
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: { ...session, model: event.model ?? undefined },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle connection_changed - sync session.llmConnection to renderer state
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        ...(event.supportsBranching !== undefined && {
          supportsBranching: event.supportsBranching,
        }),
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle available_commands_update - sync provider slash commands and skills.
 */
export function handleAvailableCommandsUpdate(
  state: SessionState,
  event: AvailableCommandsUpdateEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        availableCommands: event.availableCommands,
        availableSkills: event.availableSkills,
        availableSkillDetails: event.availableSkillDetails,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle user_message - confirms optimistic user message from backend
 *
 * Three statuses:
 * - 'accepted': Message is being processed (confirms optimistic message)
 * - 'queued': Message was queued during ongoing response (adds if not present, marks as queued)
 * - 'processing': Queued message is now being processed (updates status)
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent,
): ProcessResult {
  const { session, streaming } = state;
  const { message, status } = event;
  const effects: Effect[] = [];

  // Find existing message by ID match (backend ID, optimistic ID, or content+timestamp fallback)
  const existingIndex = session.messages.findIndex(
    (m) =>
      m.role === 'user' &&
      (m.id === message.id ||
        (event.optimisticMessageId && m.id === event.optimisticMessageId) ||
        (m.content === message.content &&
          Math.abs(m.timestamp - message.timestamp) < 5000)),
  );

  let updatedMessages: Message[];
  let preserveProcessingForLateQueuedEvent = false;

  if (status === 'queued') {
    if (existingIndex >= 0 && session.messages[existingIndex]?.isQueued === false) {
      const existingMessage = session.messages[existingIndex];
      updatedMessages = session.messages.map((m, i) => {
        if (i !== existingIndex) return m;
        return {
          ...m,
          ...message,
          id: message.id,
          attachments: message.attachments ?? existingMessage.attachments,
          textElements: message.textElements ?? existingMessage.textElements,
          isPending: false,
          isQueued: false,
        };
      });
      preserveProcessingForLateQueuedEvent = true;
    } else {
      updatedMessages =
        existingIndex >= 0
          ? session.messages.filter((_, i) => i !== existingIndex)
          : session.messages;
      effects.push({
        type: 'queued_input_add',
        message: {
          ...message,
          isPending: false,
          isQueued: true,
        },
        optimisticMessageId: event.optimisticMessageId,
      });
    }

    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          lastMessageAt: Date.now(),
          lastMessageRole: 'user',
          isProcessing: session.isProcessing,
        },
        streaming,
      },
      effects,
    };
  }

  effects.push({
    type: 'queued_input_remove',
    messageId: message.id,
    optimisticMessageId: event.optimisticMessageId,
  });

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex];

    // Update existing message with the backend-authoritative payload.
    // This matters for providers that expand slash commands before persistence:
    // the optimistic bubble may contain "/command args", while the confirmed
    // message contains the full rendered prompt.
    updatedMessages = session.messages.map((m, i) => {
      if (i === existingIndex) {
        return {
          ...m,
          ...message,
          id: message.id, // Use backend's ID as canonical
          attachments: message.attachments ?? existingMessage.attachments,
          textElements: message.textElements ?? existingMessage.textElements,
          isPending: false,
          isQueued: false,
        };
      }
      return m;
    });
  } else {
    // Message not found (e.g., queued message from backend) - add it
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: false,
    };
    updatedMessages = [...session.messages, newMessage];
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user', // Clear plan badge when user responds
        // Set isProcessing when message is accepted/processing (enables multi-window sync)
        isProcessing: preserveProcessingForLateQueuedEvent
          ? session.isProcessing
          : status === 'accepted' || status === 'processing',
      },
      streaming,
    },
    effects,
  };
}

/**
 * Handle message_content_updated - replace a message with the backend-authoritative version.
 */
export function handleMessageContentUpdated(
  state: SessionState,
  event: MessageContentUpdatedEvent,
): ProcessResult {
  const { session, streaming } = state;
  const truncateIndex = event.truncateAfterMessageId
    ? session.messages.findIndex((m) => m.id === event.truncateAfterMessageId)
    : -1;
  const messages = truncateIndex >= 0
    ? session.messages.slice(0, truncateIndex + 1)
    : session.messages;

  return {
    state: {
      session: {
        ...session,
        messages: messages.map((m) =>
          m.id === event.message.id
            ? {
                ...event.message,
                isPending: event.message.isPending ?? m.isPending,
                isQueued: event.message.isQueued ?? m.isQueued,
              }
            : m,
        ),
        lastMessageAt: event.message.timestamp ?? Date.now(),
        lastMessageRole: 'user',
        isProcessing: true,
        currentStatus: undefined,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle message_annotations_updated - update annotations on a specific message.
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        messages: session.messages.map((m) =>
          m.id === event.messageId
            ? { ...m, annotations: event.annotations }
            : m,
        ),
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle sources_changed - update session's enabled sources
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle labels_changed - update session's labels
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_status_changed - update session's sessionStatus (external metadata change or agent tool)
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_flagged - mark session as flagged
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_unflagged - mark session as unflagged
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_archived - mark session as archived
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_unarchived - mark session as unarchived
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, isArchived: false, archivedAt: undefined },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle name_changed - update session name (external metadata change)
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent,
): ProcessResult {
  const { session, streaming } = state;
  return {
    state: {
      session: { ...session, name: event.name },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle permission_request - return effect for parent to handle
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent,
): ProcessResult {
  return {
    state,
    effects: [
      {
        type: 'permission_request',
        request: event.request,
      },
    ],
  };
}

/**
 * Handle credential_request - return effect for parent to handle
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent,
): ProcessResult {
  return {
    state,
    effects: [
      {
        type: 'credential_request',
        request: event.request,
      },
    ],
  };
}

/**
 * Handle plan_submitted - add plan message to session
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_shared - session was shared to viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle session_unshared - session share was revoked
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent,
): ProcessResult {
  const { session, streaming } = state;

  return {
    state: {
      session: {
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle auth_request - add auth-request message to session
 * This is the unified auth flow - execution is paused until auth completes
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent,
): ProcessResult {
  const { session, streaming: _streaming } = state;

  // Add auth-request message to session
  return {
    state: {
      session: {
        ...appendMessage(session, event.message),
        isProcessing: false, // Agent execution is paused
      },
      streaming: null, // Clear any streaming state
    },
    effects: [],
  };
}

/**
 * Handle auth_completed - update auth-request message status
 * The agent will resume via a new user message (sent by session manager)
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent,
): ProcessResult {
  const { session, streaming } = state;

  // Update the auth-request message status
  const updatedMessages = session.messages.map((m) => {
    if (
      m.role === 'auth-request' &&
      m.authRequestId === event.requestId &&
      m.authStatus === 'pending'
    ) {
      return {
        ...m,
        authStatus: event.success
          ? ('completed' as const)
          : event.cancelled
            ? ('cancelled' as const)
            : ('failed' as const),
        authError: event.error,
      };
    }
    return m;
  });

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
      },
      streaming,
    },
    effects: [],
  };
}

/**
 * Handle usage_update - real-time context usage during processing
 * Merges usage update into existing tokenUsage (preserves outputTokens, costUsd, etc.)
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent,
): ProcessResult {
  const { session, streaming } = state;

  // Merge usage update into existing tokenUsage, providing defaults for required fields
  const updatedTokenUsage = {
    inputTokens: event.tokenUsage.inputTokens,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: session.tokenUsage?.contextTokens ?? 0,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && {
      cacheReadTokens: session.tokenUsage.cacheReadTokens,
    }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && {
      cacheCreationTokens: session.tokenUsage.cacheCreationTokens,
    }),
    ...(event.tokenUsage.contextWindow && {
      contextWindow: event.tokenUsage.contextWindow,
    }),
  };

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
      },
      streaming,
    },
    effects: [],
  };
}
