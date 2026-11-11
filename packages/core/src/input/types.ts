/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Core input pipeline type definitions.
 *
 * Defines the data structures that flow through the unified input processing
 * pipeline shared by both TUI and SDK paths.
 */

import type { Message } from '../protocol/transcript/message.js';
import type { ModelStreamUserContent } from '../provider/modelStreamRequest.js';
import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../attachments/types.js';
import type { HookCoordinatorAdapter } from '../core/hook-coordinator-types.js';
import type { Config } from '../config/config.js';
import type { DirectSkillActivation } from '../skills/selectedSkillActivation.js';

// ============================================================================
// PastedContent — TUI clipboard paste tracking
// ============================================================================

/**
 * Represents a single paste event captured in the TUI input buffer.
 *
 * - `type: 'text'` — large text pastes collapsed to `[Pasted text #N: M lines]`
 * - `type: 'image'` — clipboard/drag-drop images collapsed to `[Image #N]`;
 *   local-path images may defer base64 materialization until submission
 *
 * Only `type: 'image'` entries participate in the orphan-cleanup logic;
 * text content is eagerly expanded by `expandPastedTextRefs()` before submission.
 */
export type PastedContent = {
  /** Monotonically increasing ID; source of the `[Image #N]` / `[Pasted text #N]` placeholder. */
  id: number;
  type: 'text' | 'image';
  /**
   * text → raw text; image → base64-encoded binary data.
   *
   * A local image may temporarily use an empty string while `sourcePath`
   * points at the bytes to materialize during submission.
   */
  content: string;
  /** Image MIME type, e.g. `'image/png'`. Only set when `type === 'image'`. */
  mediaType?: string;
  /** Display filename shown in the UI. Defaults to `'Pasted image'`. */
  filename?: string;
  /** Resize metadata populated when an image is prepared for the API. */
  dimensions?: {
    originalWidth?: number;
    originalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  /**
   * The image content has already passed API media-limit normalization.
   * Submission can upload it directly without a second decode/resize pass.
   */
  isImageContentPrepared?: boolean;
  /**
   * Stable identity for one deferred local-image preparation.
   *
   * This prevents a background task from writing into a later input after the
   * numeric paste ID has been cleared and reused. It is internal bookkeeping
   * and has no effect on the API payload.
   */
  preparationId?: string;
  /**
   * Original file path for drag-and-drop images.
   * Included in the image metadata message sent to the model.
   */
  sourcePath?: string;
};

// ============================================================================
// CommandMode — how the input should be interpreted
// ============================================================================

export type CommandMode =
  | 'prompt' // Normal LLM prompt (default)
  | 'bash' // Execute as shell command
  | 'task-notification' // Internal task lifecycle message
  | 'orphaned-permission'; // Leftover permission prompt

// ============================================================================
// QueuePriority
// ============================================================================

export type QueuePriority = 'now' | 'next' | 'later';

/** A skill explicitly selected by the user for one input turn. */
export interface SelectedSkillInput {
  name: string;
  arguments?: string;
}

// ============================================================================
// MessageOrigin — tracks where a queued command originated
// ============================================================================

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | {
      kind: 'peer';
      /** Reply handle: a teammate name in-process, a `uds:` address for a peer session. */
      from: string;
      senderTaskId?: string;
      name?: string;
      body?: string;
      /** Set only for messages that arrived over the cross-session transport. */
      transport?: 'uds';
      /** Sender's message id, echoed back on delivery receipts. */
      msgId?: string;
      /** Permission-mode class the sender declared, used for inbound parity. */
      fromMode?: 'bypass' | 'prompting';
      /** Addresses this message already traversed; guards against relay loops. */
      hopChain?: string[];
      /**
       * Files that arrived with this message and were copied into this session.
       *
       * A count rather than the paths: the surfaces that read this disclose
       * *that* files arrived, and `body` deliberately excludes the `@"path"`
       * prefix the model reads, so naming them here would put absolute paths in
       * front of the user as though the peer had typed them.
       */
      attachmentCount?: number;
      /** Sender presented this session's descendant token. Provenance, not auth. */
      selfSent?: boolean;
      /**
       * Whether `from` named a session in the local registry when the message
       * arrived. A snapshot, and not evidence of identity: the registry is
       * written by ordinary processes of this user. Absent on messages from
       * builds that predate it, which is not the same as `false`.
       */
      knownPeer?: boolean;
    }
  | { kind: 'bridge'; sessionId?: string };

// ============================================================================
// QueuedCommand — unit of work in the InputQueue
// ============================================================================

/**
 * A single unit of user input ready for processing.
 *
 * Built by the TUI or SDK session runner and fed into `executeUserInput()`.
 * The first command in a batch carries `pastedContents`; subsequent commands
 * skip attachment extraction (`skipAttachments: true`).
 */
export interface QueuedCommand {
  /**
   * The user's input after text-placeholder expansion.
   * 使用标准用户内容，包含纯文本或只读文本／图片块。
   */
  prompt: ModelStreamUserContent;
  /** UI-only preview for internal peer messages; never included in model content. */
  displaySummary?: string;
  /** UI-only teammate color; never included in model content. */
  displayColor?: string;

  /**
   * The original input *before* `[Pasted text #N]` expansion.
   * Used for ultraplan keyword detection so large pasted blobs don't trigger it.
   */
  preExpansionPrompt?: string;

  /** Local-TUI choice to ignore an UltraCode keyword for this prompt only. */
  suppressWorkflowKeyword?: boolean;

  /** How to interpret the input. Defaults to `'prompt'`. */
  commandMode: CommandMode;

  /** Execution priority when multiple commands are queued. */
  priority?: QueuePriority;

  /** Stable ID for deduplication (e.g. SDK UUID). */
  uuid?: string;

  /**
   * Process-local queue identity used by the producer to recover private
   * command metadata. This value must not be exposed as a user message UUID.
   */
  queueId?: string;

  /**
   * When false, persist the command as user transcript context without
   * triggering or steering an assistant turn.
   */
  shouldQuery?: boolean;

  /**
   * Clipboard image pastes captured in the TUI.
   * Only present on the *first* command in a batch; `undefined` for SDK path.
   */
  pastedContents?: Record<number, PastedContent>;

  /**
   * When `true`, a leading `/` is treated as plain text rather than a slash command.
   * Set by the bridge/SDK when the producer has already resolved slash intent.
   */
  skipSlashCommands?: boolean;

  /** Skills to activate as direct user intent while this command is processed. */
  selectedSkills?: readonly SelectedSkillInput[];

  /**
   * Combined with `skipSlashCommands`: allows known-safe slash commands through
   * even in bridge mode (e.g. `/compact`, `/clear`).
   */
  bridgeOrigin?: boolean;

  /** When `true`, the resulting `UserMessage` is model-visible but not shown to the user. */
  isMeta?: boolean;
  /**
   * Meta text the host wrote to relay a decision the user made in host UI,
   * such as approving denied commands in /permissions. Auto-mode review reads
   * it as the user's own words, unlike other meta text.
   */
  isUserDecision?: boolean;
  /** When `true`, the resulting `UserMessage` is only shown in transcript-style views. */
  isVisibleInTranscriptOnly?: boolean;

  /** Source annotation stamped onto resulting `UserMessage.origin`. */
  origin?: MessageOrigin;

  /** Route this command to a specific sub-agent. */
  targetAgentId?: string;

  /** Session that owns an internally generated task notification. */
  sessionId?: string;

  /**
   * Per-turn identity snapshot inherited by internally generated commands such
   * as background task notifications. Never read from the latest turn.
   */
  customContext?: Readonly<Record<string, string>>;

  /** Source UUID for agent-to-agent messaging. */
  source_uuid?: string;

  /** When true, the Stop hook receives stop_hook_active=true to prevent recursion. */
  stopHookActive?: boolean;
}

// ============================================================================
// ProcessInputRequest — single-command input to processUserInput()
// ============================================================================

/**
 * All inputs required by a single `processUserInput()` invocation.
 */
export interface ProcessInputRequest {
  /**
   * Expanded user input.
   * - `string`: text-only TUI input or SDK plain-text message
   * - 标准只读输入块：SDK 或远端的多模态输入
   */
  input: ModelStreamUserContent;

  /** Pre-expansion value; used for ultraplan keyword detection. */
  preExpansionInput?: string;

  /** Local-TUI choice to ignore an UltraCode keyword for this prompt only. */
  suppressWorkflowKeyword?: boolean;

  /** How to interpret the input. */
  commandMode: CommandMode;

  /**
   * Image pastes from the TUI clipboard.
   * Only present on the first command per batch.
   */
  pastedContents?: Record<number, PastedContent>;

  /** Per-message UUID for deduplication and transcript linking. */
  uuid?: string;

  /** Per-prompt ID shared with the agent loop lifecycle hooks. */
  promptId?: string;

  /** Entry-allocated request-set ID passed to UserPromptSubmit. */
  requestSetId?: string;

  /** Produce a model-visible-only message. */
  isMeta?: boolean;
  /** Produce a transcript-only message that stays hidden in the default live view. */
  isVisibleInTranscriptOnly?: boolean;

  /**
   * Skip `getAttachmentMessages()` entirely.
   * Set to `true` for the 2nd+ command in a batch to avoid duplicate injection.
   */
  skipAttachments?: boolean;

  /** Treat leading `/` as plain text. */
  skipSlashCommands?: boolean;

  /** Skills explicitly selected by the user for this input turn. */
  selectedSkills?: readonly SelectedSkillInput[];

  /** Bridge safety gate: allow only known-safe slash commands through. */
  bridgeOrigin?: boolean;

  /** Diagnostic tag to identify where this request originated. */
  querySource?: string;
}

// ============================================================================
// ProcessInputResult — output from processUserInput()
// ============================================================================

/**
 * The result of processing a single user input through the 6-stage pipeline.
 */
export interface ProcessInputResult {
  /**
   * Messages ready to be appended to the conversation history.
   * May include `UserMessage`, `SystemMessage`, `AttachmentMessage`, etc.
   */
  messages: Message[];

  /** Whether to proceed with an API call (`query()`). False for local commands. */
  shouldQuery: boolean;

  /** Prompt slash-command invocation that produced this model query. */
  commandInvocationId?: string;

  /**
   * Expanded slash-command text used for attachment and JIT context discovery.
   * This is explicit because transcript message order and visibility do not
   * identify which message contains the model-facing expansion.
   */
  attachmentInput?: string;

  /** Optional tool allowlist from slash commands (e.g. `/edit`). */
  allowedTools?: string[];

  /** Model override from slash commands (e.g. `/model`). */
  model?: string;

  /** Effort level override from slash commands (e.g. `/ultrathink`). */
  effort?: string;

  /**
   * Direct output text for local commands that complete without an agent query.
   * Used by headless/SDK callers when `shouldQuery` is false.
   */
  resultText?: string;

  /**
   * Marks `resultText` as an error while keeping the result on the direct-output
   * channel. This is used for pre-query failures that should be rendered like
   * other local command output instead of a generic agent-loop exception.
   */
  resultIsError?: boolean;

  /** Stable machine-readable reason for a direct pre-query error result. */
  terminalReason?: string;

  /** Stable error code exposed as `error_code` in SDK result messages. */
  errorCode?: number | string;

  /**
   * Set when a before-prompt hook stopped the turn with `continue:false`.
   * `shouldQuery` is false in that case; the turn must not be reported as a
   * successfully completed empty answer.
   */
  hookStop?: { stopReason?: string };

  /** Successful direct Skill activations produced while processing this input. */
  skillActivations?: DirectSkillActivation[];

  /**
   * If set, display (or enqueue if `submitNextInput` is true) this text
   * as the next prompt after the current command completes.
   */
  nextInput?: string;
  submitNextInput?: boolean;
}

// ============================================================================
// ProcessInputContext — dependency injection for processUserInput()
// ============================================================================

/**
 * Long-lived dependencies injected into every `processUserInput()` call.
 *
 * Constructed once per session and passed down through `executeUserInput()`.
 */
export interface ProcessInputContext {
  /** Mutable inter-turn attachment state (file cache, memory hashes, etc.). */
  attachmentCtx: AttachmentToolUseContext;

  /** Application configuration (permission mode, model, etc.). */
  config: Config;

  /** Before/after hook lifecycle adapter. */
  hookCoordinator: HookCoordinatorAdapter;

  /** Active session ID (used for image storage paths). */
  sessionId: string;

  /** Current working directory. */
  cwd: string;

  /** Abort signal for the active user turn. */
  signal?: AbortSignal;

  /** Whether this input is the first user turn in the current session. */
  isInitialTurn?: boolean;

  /**
   * Current conversation history snapshot.
   * Read-only; new messages are appended via the result, not mutated here.
   */
  messages: Message[];

  /** External system references (memory manager, plan mode, MCP, etc.). */
  externalContext?: AttachmentExternalContext;

  /**
   * Callback to render a React component in the TUI tool panel.
   * Undefined in the SDK path (no UI).
   */
  setToolJSX?: (jsx: unknown) => void;
}
