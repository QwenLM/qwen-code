/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  checkExhaustive,
  CompressionStatus,
  type Config,
  getDisplayablePromptText,
  getDisplayableUserText,
  getRealUserPromptText,
  getUserTextBlocks,
  getUserPromptFallbackText,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isHiddenUserMessageInDefaultHistory,
  formatApiErrorDisplayMessage,
  getErrorCodeFallbackMessage,
  QODER_PROVIDER_ID,
  resolvePersistedApiErrorDisplay,
  parseAndFormatApiErrorMessage,
  getAssistantTextBlocks,
  type Message,
  listAllProjectTranscriptSessions,
  listSameRepoTranscriptSessionScopes,
  listSameRepoTranscriptSessions,
  resolveSelectedTranscriptSession,
  resolveLatestSameRepoTranscriptSession,
  resolveSameRepoTranscriptSession,
  runLogger,
  TranscriptSessionError,
  type ResolveTranscriptSessionResult,
  type RuntimeConfigEntry,
  type UiLocale,
} from '@qwen-code/core';
import { parseThought } from '@qwen-code/core';
import { MessageType, type HistoryItemWithoutId } from '../ui/types.js';
import {
  projectToolCallDisplay,
  type ToolResultDisplaySource,
} from '../ui/utils/toolDisplayProjection.js';
import { stripReferenceContent } from '../ui/utils/formatters.js';
import { collectSubagentToolResults } from './subagentTraceProjection.js';
import { buildTaskNotificationHistoryItem } from '../ui/components/messages/TaskNotificationMessage.js';
import {
  buildPeerMessageHistoryItem,
  type PeerOriginLike,
} from '../ui/components/messages/PeerMessage.js';

/**
 * Error codes for session-related errors.
 */
export type SessionErrorCode =
  | 'NO_SESSIONS_FOUND'
  | 'INVALID_SESSION_IDENTIFIER';

/**
 * Error thrown for session-related failures.
 * Uses a code field to differentiate between error types.
 */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }

  /**
   * Creates an error for when no sessions exist for the current project.
   */
  static noSessionsFound(): SessionError {
    return new SessionError(
      'NO_SESSIONS_FOUND',
      'No previous sessions found for this project.',
    );
  }

  /**
   * Creates an error for when a session identifier is invalid.
   */
  static invalidSessionIdentifier(
    identifier: string,
    searchDir?: string,
  ): SessionError {
    const dirInfo = searchDir ? ` in ${searchDir}` : '';
    return new SessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Invalid session identifier "${identifier}".\n  Searched for sessions${dirInfo}.\n  Use --list-sessions to see available sessions, then use --continue to load the most recent conversation saved under the current project directory, or use --resume {number} / --resume {uuid} to load a specific conversation.`,
    );
  }
}

/**
 * Represents a text match found during search with surrounding context.
 */
export interface TextMatch {
  /** Text content before the match (with ellipsis if truncated) */
  before: string;
  /** The exact matched text */
  match: string;
  /** Text content after the match (with ellipsis if truncated) */
  after: string;
  /** Role of the message author where the match was found */
  role: 'user' | 'assistant';
}

/**
 * Session information for display and selection purposes.
 */
export interface SessionInfo {
  /** Unique session identifier (transcript filename without .jsonl) */
  id: string;
  /** Transcript filename without extension */
  file: string;
  /** Full filename including .jsonl extension */
  fileName: string;
  /** Absolute transcript path */
  sessionPath?: string;
  /** ISO timestamp when session started */
  startTime: string;
  /** Total number of messages in the session */
  messageCount: number;
  /** Number of user-authored messages when projected by the transcript loader. */
  userMessageCount?: number;
  /** ISO timestamp when session was last updated */
  lastUpdated: string;
  /** Display name for the session (typically first user message) */
  displayName: string;
  /** Cleaned first user message content */
  firstUserMessage: string;
  /** Whether this is the currently active session */
  isCurrentSession: boolean;
  /** Display index in the list */
  index: number;
  /** Leaf summary for the session, when one has been generated */
  summary?: string;
  /** User-set session title (highest priority for display) */
  customTitle?: string;
  /** AI-generated session title */
  aiTitle?: string;
  /** Most recent meaningful user prompt */
  lastPrompt?: string;
  /** Full concatenated content (only loaded when needed for search) */
  fullContent?: string;
  /** Processed messages with normalized roles (only loaded when needed) */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Search result snippets when filtering */
  matchSnippets?: TextMatch[];
  /** Total number of matches found in this session */
  matchCount?: number;
  /** Workspace directories recorded in session state */
  directories?: string[];
  /** The project root that owns this transcript bucket (for writer rebinding on resume). */
  transcriptProjectRoot?: string;
  /** 从既有 Worktree 记录推导的逻辑项目根，与物理 bucket 分离。 */
  originalCwd?: string;
  /** Absolute path to the transcript project directory. */
  transcriptProjectDir?: string;
  /** The worktree path this session came from (for scope attribution). */
  sourceWorktreePath?: string;
  /** Logical project path shown in session pickers, independent of transcript storage. */
  displayProjectPath?: string;
  /** Most recently recorded git branch in the active transcript chain. */
  gitBranch?: string;
  /** Latest worktree lifecycle state folded from the transcript. */
  worktreeSession?:
    | import('@qwen-code/core').TranscriptWorktreeSession
    | null;
  /** Transcript file size in bytes. */
  fileSize?: number;
  /** Whether this session contains /loop command usage. */
  isLoopSession?: boolean;
  /** True when only bounded picker metadata has been loaded. */
  isMetadataOnly?: boolean;
}

/**
 * Result of resolving a session selection argument.
 */
export interface SessionSelectionResult {
  sessionPath: string;
  messages: Message[];
  directories?: string[];
  fileHistorySnapshots?: Array<
    import('@qwen-code/core').FileHistorySnapshot
  >;
  runtimeConfig?: RuntimeConfigEntry;
  displayInfo: string;
  sessionInfo: SessionInfo;
  transcriptReadState?: ResolveTranscriptSessionResult['transcriptReadState'];
  resumeCandidate?: ResolveTranscriptSessionResult['resumeCandidate'];
  resumeAttempt?: ResolveTranscriptSessionResult['resumeAttempt'];
}

/**
 * Cleans and sanitizes message content for display by:
 * - Converting newlines to spaces
 * - Collapsing multiple whitespace to single spaces
 * - Removing non-printable characters (keeping only ASCII 32-126)
 * - Trimming leading/trailing whitespace
 * @param message - The raw message content to clean
 * @returns Sanitized message suitable for display
 */
export const cleanMessage = (message: string): string =>
  message
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]+/g, '') // Non-printable.
    .trim();

/**
 * Extracts the first meaningful user message from conversation messages.
 */
export const extractFirstUserMessage = (
  messages: readonly Message[],
): string => {
  let fallback: string | null = null;

  for (const message of messages) {
    const prompt = getRealUserPromptText(message);
    if (prompt) {
      return cleanMessage(prompt) || 'Empty conversation';
    }

    fallback ??= getUserPromptFallbackText(message);
  }

  return fallback ? cleanMessage(fallback) : 'Empty conversation';
};

/**
 * Formats a timestamp as relative time.
 * @param timestamp - The timestamp to format
 * @param style - 'long' (e.g. "2 hours ago") or 'short' (e.g. "2h")
 */
export const formatRelativeTime = (
  timestamp: string,
  style: 'long' | 'short' = 'long',
  locale: UiLocale = 'en',
): string => {
  const now = new Date();
  const time = new Date(timestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (style === 'short') {
    const suffix =
      locale === 'zh-CN'
        ? {
            now: '现在',
            second: '秒',
            minute: '分钟',
            hour: '小时',
            day: '天',
            month: '个月',
            year: '年',
          }
        : {
            now: 'now',
            second: 's',
            minute: 'm',
            hour: 'h',
            day: 'd',
            month: 'mo',
            year: 'y',
          };
    if (diffSeconds < 1) return suffix.now;
    if (diffSeconds < 60) return `${diffSeconds}${suffix.second}`;
    if (diffMinutes < 60) return `${diffMinutes}${suffix.minute}`;
    if (diffHours < 24) return `${diffHours}${suffix.hour}`;
    if (diffDays < 30) return `${diffDays}${suffix.day}`;
    const diffMonths = Math.floor(diffDays / 30);
    return diffMonths < 12
      ? `${diffMonths}${suffix.month}`
      : `${Math.floor(diffMonths / 12)}${suffix.year}`;
  } else if (locale === 'en') {
    if (diffDays > 0) {
      return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    }
    if (diffHours > 0) {
      return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    }
    if (diffMinutes > 0) {
      return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
    }
    return 'Just now';
  } else {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (diffDays > 0) return formatter.format(-diffDays, 'day');
    if (diffHours > 0) return formatter.format(-diffHours, 'hour');
    if (diffMinutes > 0) return formatter.format(-diffMinutes, 'minute');
    return formatter.format(0, 'second');
  }
};

export interface GetSessionOptions {
  /** Whether to load full message content (needed for search) */
  includeFullContent?: boolean;
}

export interface SessionScopes {
  current: SessionInfo[];
  all: SessionInfo[];
}

function toSessionSelectionResult(
  result: ResolveTranscriptSessionResult,
): SessionSelectionResult {
  return {
    sessionPath: result.sessionPath,
    messages: result.messages,
    directories: result.sessionInfo.directories,
    fileHistorySnapshots: result.fileHistorySnapshots,
    runtimeConfig: result.runtimeConfig,
    displayInfo: result.displayInfo,
    sessionInfo: { ...result.sessionInfo },
    transcriptReadState: result.transcriptReadState,
    resumeCandidate: result.resumeCandidate,
    resumeAttempt: result.resumeAttempt,
  };
}

/**
 * Utility class for session discovery and selection.
 */
export class SessionSelector {
  constructor(private config: Config) {}

  /**
   * Lists independently deduplicated current-worktree and same-repo sessions.
   * Intended for the interactive session picker.
   */
  async listSessionScopes(
    options: GetSessionOptions = {},
  ): Promise<SessionScopes> {
    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: this.config.getSessionArtifactProjectRoot(),
      currentSessionId: this.config.getSessionId(),
      includeFullContent: options.includeFullContent,
      lightweight: options.includeFullContent !== true,
    });

    return {
      current: scopes.current.map((session) => ({ ...session })),
      all: scopes.all.map((session) => ({ ...session })),
    };
  }

  /**
   * Lists all available sessions for the current project.
   */
  async listSessions(options: GetSessionOptions = {}): Promise<SessionInfo[]> {
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: this.config.getSessionArtifactProjectRoot(),
      currentSessionId: this.config.getSessionId(),
      includeFullContent: options.includeFullContent,
    });

    return sessions.map((session) => ({ ...session }));
  }

  /** Lists sessions from every transcript project bucket on demand. */
  async listAllProjectSessions(
    options: GetSessionOptions = {},
  ): Promise<SessionInfo[]> {
    const sessions = await listAllProjectTranscriptSessions({
      currentSessionId: this.config.getSessionId(),
      includeFullContent: options.includeFullContent,
      lightweight: options.includeFullContent !== true,
    });
    return sessions.map((session) => ({ ...session }));
  }

  /** Resolves the exact session selected in the browser by transcript path. */
  async resolveSelectedSession(
    session: SessionInfo,
    signal?: AbortSignal,
  ): Promise<SessionSelectionResult> {
    try {
      if (!session.sessionPath) {
        throw new Error(`Missing session path for session ${session.id}`);
      }
      return toSessionSelectionResult(
        await resolveSelectedTranscriptSession(
          {
            ...session,
            sessionPath: session.sessionPath,
            userMessageCount: session.userMessageCount ?? 0,
          },
          signal,
        ),
      );
    } catch (error) {
      throw new Error(
        `Failed to resolve selected session "${session.id}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Finds a session by identifier (UUID or numeric index).
   *
   * @param identifier - Can be a full UUID or an index number (1-based)
   * @returns Promise resolving to the found SessionInfo
   * @throws Error if the session is not found or identifier is invalid
   */
  async findSession(identifier: string): Promise<SessionInfo> {
    const trimmedIdentifier = identifier.trim();
    const sessions = await this.listSessions();

    if (sessions.length === 0) {
      throw SessionError.noSessionsFound();
    }

    // Try to find by UUID first
    const sessionByUuid = sessions.find(
      (session) => session.id === trimmedIdentifier,
    );
    if (sessionByUuid) {
      return sessionByUuid;
    }

    // Parse as index number (1-based) - only allow numeric indexes
    const index = parseInt(trimmedIdentifier, 10);
    if (
      !isNaN(index) &&
      index.toString() === trimmedIdentifier &&
      index > 0 &&
      index <= sessions.length
    ) {
      return sessions[index - 1];
    }

    throw SessionError.invalidSessionIdentifier(
      trimmedIdentifier,
      this.config.getSessionArtifactProjectRoot(),
    );
  }

  /**
   * Resolves a resume argument to a specific session.
   *
   * @param resumeArg - Can be a full UUID or an index number (1-based)
   * @returns Promise resolving to session selection result
   */
  async resolveSession(resumeArg: string): Promise<SessionSelectionResult> {
    const trimmedResumeArg = resumeArg.trim();
    try {
      const result = await resolveSameRepoTranscriptSession(
        this.config.getSessionArtifactProjectRoot(),
        trimmedResumeArg,
        this.config.getSessionId(),
      );
      return toSessionSelectionResult(result);
    } catch (error) {
      if (error instanceof TranscriptSessionError) {
        // Preserve the detailed error message from core (includes searched buckets/worktrees).
        throw new SessionError(error.code, error.message);
      }

      if (error instanceof SessionError) {
        throw error;
      }

      throw new Error(
        `Failed to resolve session "${trimmedResumeArg}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async resolveLatestSession(): Promise<SessionSelectionResult> {
    try {
      return toSessionSelectionResult(
        await resolveLatestSameRepoTranscriptSession(
          this.config.getSessionArtifactProjectRoot(),
          this.config.getSessionId(),
        ),
      );
    } catch (error) {
      if (error instanceof TranscriptSessionError) {
        throw new SessionError(error.code, error.message);
      }

      if (error instanceof SessionError) {
        throw error;
      }

      throw new Error(
        `Failed to resolve latest session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

function shouldRenderMessageInDefaultHistory(message: {
  type: Message['type'];
  isMeta?: boolean;
  isVisibleInTranscriptOnly?: boolean;
}): boolean {
  return message.type !== 'user'
    ? true
    : !isHiddenUserMessageInDefaultHistory(message);
}

function projectSyntheticInterruptionMessage(
  message: Message,
): HistoryItemWithoutId[] | undefined {
  if (message.type !== 'user') {
    return undefined;
  }

  const textBlocks = getUserTextBlocks(message);
  if (textBlocks.length !== 1) {
    return undefined;
  }

  const text = textBlocks[0];
  if (text === INTERRUPT_MESSAGE) {
    return [{ type: MessageType.INFO, text: 'Request cancelled.' }];
  }

  if (text === INTERRUPT_MESSAGE_FOR_TOOL_USE) {
    return [];
  }

  return undefined;
}

function getAssistantText(
  message: Extract<Message, { type: 'assistant' }>,
): string {
  return message.message.content
    .filter(
      (block): block is typeof block & { type: 'text' } =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

function formatPersistedApiError(
  message: Extract<Message, { type: 'assistant' }>,
  rawError: string,
): string {
  if (message.modelError) {
    return formatApiErrorDisplayMessage(
      message.modelError.providerSource === QODER_PROVIDER_ID
        ? message.displayErrorCode
        : undefined,
      getErrorCodeFallbackMessage(
        message.displayErrorCode,
        message.modelError.kind,
        { ...message.modelError, message: rawError },
      ),
    );
  }
  if (message.errorFallbackMessage?.trim()) {
    return message.errorFallbackMessage;
  }
  const { displayErrorCode, fallbackMessage } = resolvePersistedApiErrorDisplay(
    message,
    rawError,
  );
  if (displayErrorCode !== undefined || fallbackMessage !== undefined) {
    return formatApiErrorDisplayMessage(
      displayErrorCode,
      fallbackMessage ?? rawError,
    );
  }

  return parseAndFormatApiErrorMessage(rawError);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Raw concatenated text of a user message, untrimmed. */
function userMessageText(message: Extract<Message, { type: 'user' }>): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b != null &&
        typeof b === 'object' &&
        'type' in b &&
        b.type === 'text' &&
        'text' in b &&
        typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('');
}

/**
 * The peer origin of a cross-session message, or undefined for anything else.
 *
 * The persisted origin is typed as `{ kind: 'human' | string }`, so the peer
 * fields need a cast to be read back. `transport` rather than `kind` is what
 * distinguishes these from in-process teammate messages, which are not
 * projected here at all.
 */
function crossSessionOrigin(
  origin: { kind: string } | undefined,
): PeerOriginLike | undefined {
  if (origin?.kind !== 'peer') return undefined;
  const peer = origin as { transport?: string } & PeerOriginLike;
  return peer.transport === 'uds' ? peer : undefined;
}

function convertMessageToHistoryItems(
  message: Message,
  toolResultMap?: Map<string, ToolResultDisplaySource>,
): HistoryItemWithoutId[] {
  const uiHistory: HistoryItemWithoutId[] = [];

  const syntheticInterruption = projectSyntheticInterruptionMessage(message);
  if (syntheticInterruption !== undefined) {
    return syntheticInterruption;
  }

  if (
    message.type !== 'attachment' &&
    message.type !== 'progress' &&
    message.type !== 'tool_use_summary' &&
    message.type !== 'tombstone' &&
    !shouldRenderMessageInDefaultHistory(message)
  ) {
    if (message.type === 'user') {
      const rawText = userMessageText(message);
      const peerOrigin = crossSessionOrigin(message.origin);
      // Idle task-notifications are isMeta but should render as ⏺ summary
      if (rawText && message.origin?.kind === 'task-notification') {
        const item = buildTaskNotificationHistoryItem(rawText);
        if (item) uiHistory.push(item);
      } else if (rawText && peerOrigin) {
        // Peer messages are isMeta too, and without this a row that appeared
        // when the message arrived would vanish the moment the session resumed.
        uiHistory.push(
          buildPeerMessageHistoryItem({ text: rawText, origin: peerOrigin }),
        );
      }
    }
    return uiHistory;
  }

  switch (message.type) {
    case 'assistant': {
      if (message.isApiErrorMessage || message.isContentFilteredMessage) {
        // Match the transcript resume projector's extraction exactly: both feed
        // the same resolvePersistedApiErrorDisplay + legacy dedup string-match,
        // so divergent text here would break that comparison.
        const rawError = getAssistantTextBlocks(message).join('').trim();
        if (rawError) {
          uiHistory.push({
            type: MessageType.ERROR,
            text: formatPersistedApiError(message, rawError),
            ...(message.isContentFilteredMessage
              ? { excludedFromContext: true }
              : {}),
          });
        }
        return uiHistory;
      }

      for (const block of message.message.content) {
        if (block.type === 'thinking' && block.thinking.trim()) {
          const thought = parseThought(block.thinking);
          if (!thought) {
            continue;
          }
          uiHistory.push({
            type: 'thinking',
            thought: {
              subject: thought.subject,
              description: thought.description,
            },
          });
        }
      }

      const text = getAssistantText(message);
      if (text.trim()) {
        uiHistory.push({
          type: MessageType.GEMINI,
          text,
        });
      }

      const toolCalls = message.message.content
        .filter(
          (block): block is typeof block & { type: 'tool_use' } =>
            block.type === 'tool_use',
        )
        .map((tool) => {
          const result = toolResultMap?.get(tool.id);
          return projectToolCallDisplay({
            toolUse: {
              id: tool.id,
              name: tool.name,
              mcpInfo: tool.mcpInfo,
              input: tool.input,
            },
            toolResult: result,
          });
        });
      if (toolCalls.length > 0) {
        uiHistory.push({
          type: 'tool_group',
          tools: toolCalls,
        });
      }
      return uiHistory;
    }

    case 'user': {
      if (message.isCompactSummary) {
        return uiHistory;
      }
      const text = getDisplayableUserText(message);
      if (text) {
        uiHistory.push({
          type: MessageType.USER,
          text: stripReferenceContent(text),
        });
      }
      return uiHistory;
    }

    case 'system': {
      // The pipeline writes a `system/compact_boundary` marker right after
      // each compaction so the JSONL transcript is self-describing for resume.
      // Render it back as the same `MessageType.COMPRESSION` item the live
      // run produces, using the structured `compactMetadata` payload — the
      // generic info-line fallback would just print "Conversation compacted"
      // verbatim, which loses the trigger / token deltas the UI normally
      // shows.
      if (message.subtype === 'compact_boundary') {
        const meta = message.compactMetadata;
        uiHistory.push({
          type: MessageType.COMPRESSION,
          compression: {
            isPending: false,
            originalTokenCount: meta?.preTokens ?? null,
            newTokenCount: meta?.postTokens ?? null,
            compressionStatus: CompressionStatus.COMPRESSED,
            trigger: meta?.trigger,
          },
        });
        return uiHistory;
      }

      // Legacy `system/local_command` entries carry the slash invocation as XML
      // tags (<command-name>/foo</command-name>...). Current sessions store the
      // same model-visible context as meta user messages. On resume, render the
      // legacy record back as the user-typed `/command args` line so raw XML tags
      // do not leak into the scrollback.
      if (message.subtype === 'local_command') {
        const parsed = getDisplayablePromptText(message.content);
        if (parsed) {
          uiHistory.push({
            type: MessageType.USER,
            text: parsed,
          });
        }
        return uiHistory;
      }

      // Legacy `system/local_command_output` is wrapped in
      // `<local-command-stdout>...`; strip the wrapper so the resumed scrollback
      // shows the same plain output the user originally saw.
      if (message.subtype === 'local_command_output') {
        const stripped = getDisplayablePromptText(message.content);
        if (stripped) {
          uiHistory.push({
            type: MessageType.INFO,
            text: stripped,
          });
        }
        return uiHistory;
      }

      let messageType: MessageType;
      switch (message.level) {
        case 'info':
          messageType =
            message.subtype === 'error' ||
            message.subtype === 'error_during_execution' ||
            message.subtype === 'error_max_turns'
              ? MessageType.ERROR
              : MessageType.INFO;
          break;
        case 'error':
          messageType = MessageType.ERROR;
          break;
        default:
          checkExhaustive(message.level);
          messageType = MessageType.INFO;
          break;
      }
      if (message.content.trim()) {
        uiHistory.push({
          type: messageType,
          text: message.content,
        });
      }
      return uiHistory;
    }

    case 'attachment':
      // Render queued_command attachments as user messages on resume
      if (message.attachment?.type === 'queued_command') {
        const prompt = message.attachment['prompt'];
        const text =
          typeof prompt === 'string'
            ? prompt.trim()
            : Array.isArray(prompt)
              ? prompt
                  .filter(
                    (b): b is { type: 'text'; text: string } =>
                      b != null &&
                      typeof b === 'object' &&
                      'type' in b &&
                      b.type === 'text' &&
                      'text' in b &&
                      typeof b.text === 'string',
                  )
                  .map((b) => b.text)
                  .join('')
                  .trim()
              : '';
        if (text) {
          // A mid-turn peer message persists as one of these rather than as a
          // user message, so it resumes through here. Without the peer branch it
          // fell to the plain-user case below and redrew the raw
          // `<cross-session-message>` envelope as though the user had typed it.
          const peerOrigin = crossSessionOrigin(
            message.attachment['origin'] as { kind: string } | undefined,
          );
          if (message.attachment['commandMode'] === 'task-notification') {
            const item = buildTaskNotificationHistoryItem(text);
            if (item) uiHistory.push(item);
          } else if (peerOrigin) {
            uiHistory.push(
              buildPeerMessageHistoryItem({
                text,
                origin: peerOrigin,
                ...(asNonEmptyString(message.attachment['displaySummary']) !==
                  undefined && {
                  displaySummary: asNonEmptyString(
                    message.attachment['displaySummary'],
                  ),
                }),
              }),
            );
          } else if (!message.attachment['isMeta']) {
            uiHistory.push({ type: MessageType.USER, text });
          }
        }
      }
      return uiHistory;
    case 'progress':
    case 'tool_use_summary':
    case 'tombstone':
      return uiHistory;

    default:
      checkExhaustive(message);
      return uiHistory;
  }
}

function convertMessagesWith<T>(
  messages: Message[],
  mapItem: (
    item: HistoryItemWithoutId,
    message: Message,
    itemIndex: number,
  ) => T,
  variantLabel: string,
): T[] {
  const toolResultMap = collectSubagentToolResults(messages);

  return messages.flatMap((message) => {
    try {
      return convertMessageToHistoryItems(message, toolResultMap).map(
        (item, itemIndex) => mapItem(item, message, itemIndex),
      );
    } catch (error) {
      const messageInfo =
        message && typeof message === 'object'
          ? `type=${String((message as { type?: unknown }).type)} uuid=${String((message as { uuid?: unknown }).uuid)}`
          : 'non-object message';
      runLogger.debug(
        `[SessionResume] Skipping message that cannot be converted to ${variantLabel} (${messageInfo}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  });
}

export function convertMessagesToHistoryFormats(messages: Message[]): {
  uiHistory: HistoryItemWithoutId[];
} {
  return {
    uiHistory: convertMessagesWith(messages, (item) => item, 'UI history'),
  };
}

export type IdentifiedHistoryItemWithoutId = HistoryItemWithoutId & {
  renderKey: string;
};

/**
 * Projects protocol messages while retaining their stable source UUID for
 * transcript React identity and anchored-window lookup.
 */
export function convertMessagesToIdentifiedHistoryFormats(
  messages: Message[],
): { uiHistory: IdentifiedHistoryItemWithoutId[] } {
  return {
    uiHistory: convertMessagesWith(
      messages,
      (item, message, itemIndex): IdentifiedHistoryItemWithoutId => ({
        ...item,
        renderKey: `${message.uuid}:${itemIndex}`,
      }),
      'identified UI history',
    ),
  };
}
