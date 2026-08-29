import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { ChannelBase, ChannelBaseOptions } from './ChannelBase.js';
import type { ChannelWebhookConfig } from './ChannelWebhookTask.js';

export type SenderPolicy = 'allowlist' | 'pairing' | 'open';
export type SessionScope = 'user' | 'thread' | 'chat_thread' | 'single';
export type ChannelType = string;
export type GroupPolicy = 'disabled' | 'allowlist' | 'pairing' | 'open';
export type DmPolicy = 'disabled' | 'open';
export type DispatchMode = 'collect' | 'steer' | 'followup';

export interface ChannelIdentityConfig {
  id?: string;
  displayName?: string;
  description?: string;
}

export interface ChannelRuntimeIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export type ChannelMemoryScopeMode = 'metadata-only';

export interface ChannelMemoryScopeConfig {
  namespace?: string;
  mode?: ChannelMemoryScopeMode;
}

export interface ChannelRuntimeMemoryScope {
  readonly namespace: string;
  readonly mode: ChannelMemoryScopeMode;
}

export interface GroupConfig {
  requireMention?: boolean; // default: true
  dispatchMode?: DispatchMode;
  groupHistoryLimit?: number;
}

export interface BlockStreamingChunkConfig {
  /** Minimum characters before emitting a block. Default: 400. */
  minChars?: number;
  /** Force-emit when buffer exceeds this size. Default: 1000. */
  maxChars?: number;
}

export interface BlockStreamingCoalesceConfig {
  /** Emit buffered text after this many ms of inactivity. Default: 1500. */
  idleMs?: number;
}

export interface ChannelConfig {
  type: ChannelType;
  token: string;
  clientId?: string;
  clientSecret?: string;
  senderPolicy: SenderPolicy;
  allowedUsers: string[];
  /** Channel routing scope. `thread` is retained for existing configurations only. */
  sessionScope: SessionScope;
  /** Retain an owner-scoped catalog of named sessions in daemon-managed mode. */
  multiSession?: boolean;
  cwd: string;
  approvalMode?: string;
  instructions?: string;
  identity?: ChannelIdentityConfig;
  memoryScope?: ChannelMemoryScopeConfig;
  webhooks?: ChannelWebhookConfig;
  model?: string;
  groupPolicy: GroupPolicy; // default: "disabled"
  dmPolicy: DmPolicy; // default: "open"
  groupHistoryLimit?: number;
  groups: Record<string, GroupConfig>; // "*" for defaults, group IDs for overrides

  /** Dispatch mode for concurrent messages. Default: 'steer' (resolved in ChannelBase.handleInbound). */
  dispatchMode?: DispatchMode;

  /** Poll interval in ms for polling adapters. Default: 60000. */
  pollInterval?: number;

  /** Enable block streaming — emit completed blocks as separate messages. */
  blockStreaming?: 'on' | 'off';
  /** Chunk size bounds for block streaming. */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /** Idle coalescing for block streaming. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
}

export interface Attachment {
  /** Content category. */
  type: 'image' | 'file' | 'audio' | 'video';
  /** Base64-encoded data (for images or small files). */
  data?: string;
  /** Absolute path to a local file (for large files saved to disk). */
  filePath?: string;
  /** MIME type (e.g. "image/jpeg", "application/pdf"). */
  mimeType: string;
  /** Original file name from the platform. */
  fileName?: string;
}

export interface Envelope {
  channelName: string;
  senderId: string;
  senderName: string;
  chatId: string;
  chatName?: string;
  text: string;
  /** User-authored text to display when `text` contains model-only context. */
  displayText?: string;
  threadId?: string;
  /** Platform-specific message ID for response correlation. */
  messageId?: string;
  isGroup: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  /** Text of the message being replied to (quoted/referenced message). */
  referencedText?: string;
  /**
   * Stable identifiers (staffId preferred, platform ID fallback) of non-bot
   * members mentioned alongside the bot in a group message, deduplicated and
   * excluding the bot itself. Kept separate from `text` (like `metadata`) so
   * slash-command parsing sees the message body alone; ChannelBase renders it
   * as a `[Mentioned …]` wrapper AFTER prompt sanitization so the delivered
   * format stays uniform regardless of the identifier list length.
   * Rendered only when sender attribution is rendered (group/single-scope,
   * not `alreadyPrefixed`, not a recognized slash command) — self-prefixing
   * adapters must render it themselves. Group history backfill records the
   * message body only; mention IDs are intentionally not persisted.
   */
  mentionedMemberIds?: string[];
  /** Base64-encoded image data (e.g. from WeChat CDN download). */
  imageBase64?: string;
  /** MIME type for the image (e.g. "image/jpeg", "image/png"). */
  imageMimeType?: string;
  /** Structured attachments (images, files, audio, video). */
  attachments?: Attachment[];
  /**
   * Contextual metadata (e.g. issue type, title, URL) kept separate from `text`
   * so slash-command parsing operates on the comment body alone. Appended to
   * the prompt after command parsing, sanitized via sanitizePromptText.
   */
  metadata?: string;
  /**
   * Marks an envelope whose `text` ALREADY carries its `[sender]` attribution, so
   * handleInbound must NOT re-prefix it. Set in two places: on a synthetic
   * collect-mode re-entry (coalesced text already carries each message's prefix), AND
   * by the QQ adapter on a REAL inbound it self-prefixes as `[name]: …`. QQ
   * neutralizes that embedded name with sanitizeSenderName at the source (QQChannel),
   * so the self-prefixed name reaching the prompt is already sanitized — setting this
   * flag does not bypass sanitization.
   */
  alreadyPrefixed?: true;
}

export interface SessionTarget {
  channelName: string;
  senderId: string;
  chatId: string;
  threadId?: string;
  isGroup?: boolean;
}

export interface ObservedChannelIdentity {
  id: string;
  label: string;
}

export interface ObservedChannelContactObservation {
  user: ObservedChannelIdentity;
  group?: ObservedChannelIdentity;
  topic?: ObservedChannelIdentity;
}

export interface ObservedChannelContact extends ObservedChannelIdentity {
  channelName: string;
  lastObservedAt: string;
}

export interface ObservedChannelRelatedContact extends ObservedChannelIdentity {
  lastObservedAt: string;
}

export interface ObservedChannelTopic extends ObservedChannelRelatedContact {
  users: ObservedChannelRelatedContact[];
}

export interface ObservedChannelGroup extends ObservedChannelContact {
  users: ObservedChannelRelatedContact[];
  topics: ObservedChannelTopic[];
}

export interface ObservedChannelContactGraph {
  users: ObservedChannelContact[];
  groups: ObservedChannelGroup[];
}

export interface ChannelPromptOwner {
  kind: 'channel_user';
  id: string;
}

export type UserInputPresentationResult =
  | { kind: 'presented' }
  | { kind: 'handled' }
  | { kind: 'unsupported' };

export type UserInputSettlementReason =
  | 'resolved_outside_presenter'
  | 'cancelled'
  | 'run_cancelled';

export type ChannelUserInputResponse = RequestPermissionResponse & {
  answers?: Record<string, string>;
};

export interface ChannelUserQuestion {
  answerKey: string;
  header: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
  multiSelect: boolean;
}

export interface ChannelUserInputRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  precedingSegmentId?: string;
  questions: ChannelUserQuestion[];
  submitOptionId: string;
  onSettled(listener: (reason: UserInputSettlementReason) => void): () => void;
  respond(response: ChannelUserInputResponse): Promise<boolean>;
}

export interface ChannelOutputSegmentContext {
  channelName: string;
  sessionId: string;
  runId: string;
  segmentId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  messageId?: string;
}

export type ChannelOutputSegmentEndReason =
  | 'response_boundary'
  | 'input_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ChannelProactiveTarget {
  channelName: string;
  type: 'user' | 'chat';
  id: string;
}

export interface ChannelTaskLifecycleBase {
  channelName: string;
  chatId: string;
  sessionId: string;
  messageId?: string;
  runId?: string;
  owner?: ChannelPromptOwner;
  identity: ChannelRuntimeIdentity;
  memoryScope: ChannelRuntimeMemoryScope;
}

/**
 * Whitelist of tool-call fields exposed to lifecycle consumers. Kept explicit
 * (not derived from ToolCallEvent) so a new bridge field can't leak through.
 */
export interface SanitizedToolCallEvent {
  sessionId: string;
  toolCallId: string;
  kind: string;
  title: string;
  status: string;
}

/** 'dropped' = loop was disabled/deleted mid-run (not user-cancelled). */
export type ChannelTaskCancellationReason =
  | 'cancel_command'
  | 'clear'
  | 'steer'
  | 'timeout'
  | 'dropped';

export type ChannelTaskLifecycleEvent =
  | (ChannelTaskLifecycleBase & { type: 'started' })
  /** `chunk` is raw model output — content, not metadata; deliberately unsanitized. */
  | (ChannelTaskLifecycleBase & { type: 'text_chunk'; chunk: string })
  | (ChannelTaskLifecycleBase & {
      type: 'tool_call';
      toolCall: SanitizedToolCallEvent;
    })
  | (ChannelTaskLifecycleBase & {
      type: 'cancelled';
      reason: ChannelTaskCancellationReason;
    })
  | (ChannelTaskLifecycleBase & { type: 'completed' })
  | (ChannelTaskLifecycleBase & {
      type: 'failed';
      error: string;
      /** Where the turn failed: agent generation vs delivery to the platform. */
      phase: 'agent' | 'delivery';
    });

/** Terminal lifecycle event types — exactly one is expected per task. */
export function isTerminalTaskLifecycleType(
  type: ChannelTaskLifecycleEvent['type'],
): type is 'completed' | 'cancelled' | 'failed' {
  return type === 'completed' || type === 'cancelled' || type === 'failed';
}

export interface ChannelMemoryTarget {
  channelName: string;
  chatId: string;
  threadId?: string;
}

export interface ChannelMemoryEntry {
  id: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
}

export interface ChannelMemoryCallbacks {
  readChannelMemory(target: ChannelMemoryTarget): Promise<string>;
  getChannelMemoryRevision?(target: ChannelMemoryTarget): Promise<string>;
  listChannelMemoryEntries(
    target: ChannelMemoryTarget,
  ): Promise<ChannelMemoryEntry[]>;
  addChannelMemoryEntries(
    target: ChannelMemoryTarget,
    texts: readonly string[],
    createdBy?: string,
  ): Promise<{
    changed: boolean;
    added: ChannelMemoryEntry[];
    duplicateIds: string[];
  }>;
  updateChannelMemoryEntry(
    target: ChannelMemoryTarget,
    mutation: { id: string; text: string; expectedText?: string },
  ): Promise<{ changed: boolean; entry?: ChannelMemoryEntry }>;
  removeChannelMemoryEntries(
    target: ChannelMemoryTarget,
    mutation: {
      ids: readonly string[];
      expectedTextById?: Readonly<Record<string, string>>;
    },
  ): Promise<{ changed: boolean; removed: ChannelMemoryEntry[] }>;
  clearChannelMemory(target: ChannelMemoryTarget): Promise<{
    changed: boolean;
  }>;
}

export type ChannelMemoryIntentClassifierResult =
  | {
      intent: 'remember';
      memory: string;
      memories?: never;
      confidence: number;
    }
  | {
      intent: 'remember';
      memory?: never;
      memories: string[];
      confidence: number;
    }
  | { intent: 'list'; targetIds?: string[]; confidence: number }
  | { intent: 'inspect' | 'remove'; targetIds: string[]; confidence: number }
  | {
      intent: 'update';
      targetIds: string[];
      memory: string;
      confidence: number;
    }
  | { intent: 'clear_all' | 'none'; confidence: number };

export interface ChannelMemoryIntentClassifier {
  classifyChannelMemoryIntent(
    text: string,
    entries?: readonly ChannelMemoryEntry[],
  ): Promise<ChannelMemoryIntentClassifierResult>;
}

export type ChannelConfigFieldKind =
  | 'string'
  | 'secret'
  | 'boolean'
  | 'number'
  | 'enum'
  | 'string-list'
  | 'record'
  | 'object';

interface ChannelConfigFieldDescriptorBase {
  key: string;
  label: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  default?: string;
  description?: string;
}

export interface ChannelConfigValueFieldDescriptor
  extends ChannelConfigFieldDescriptorBase {
  kind: 'string' | 'secret';
  required?: boolean;
  envResolvable?: boolean;
  properties?: never;
}

export interface ChannelConfigPlainValueFieldDescriptor
  extends ChannelConfigFieldDescriptorBase {
  kind: 'boolean' | 'string-list' | 'record';
  required?: boolean;
  envResolvable?: never;
  properties?: never;
}

export interface ChannelConfigEnumFieldDescriptor
  extends ChannelConfigFieldDescriptorBase {
  kind: 'enum';
  required?: boolean;
  envResolvable?: never;
  options: ReadonlyArray<{ value: string; label: string }>;
  properties?: never;
}

export interface ChannelConfigNumberFieldDescriptor
  extends ChannelConfigFieldDescriptorBase {
  kind: 'number';
  required?: boolean;
  envResolvable?: never;
  exclusiveMinimum?: number;
  properties?: never;
}

export interface ChannelConfigObjectFieldDescriptor
  extends ChannelConfigFieldDescriptorBase {
  kind: 'object';
  required?: false;
  envResolvable?: never;
  properties: readonly ChannelConfigNestedFieldDescriptor[];
}

export type ChannelConfigNestedFieldDescriptor =
  | (Omit<ChannelConfigValueFieldDescriptor, 'kind' | 'envResolvable'> & {
      kind: Exclude<
        ChannelConfigFieldKind,
        'secret' | 'enum' | 'number' | 'object'
      >;
      envResolvable?: never;
    })
  | (Omit<ChannelConfigEnumFieldDescriptor, 'kind' | 'envResolvable'> & {
      kind: 'enum';
      envResolvable?: never;
    })
  | (Omit<ChannelConfigNumberFieldDescriptor, 'kind' | 'envResolvable'> & {
      kind: 'number';
      envResolvable?: never;
    })
  | ChannelConfigObjectFieldDescriptor;

export type ChannelConfigFieldDescriptor =
  | ChannelConfigValueFieldDescriptor
  | ChannelConfigPlainValueFieldDescriptor
  | ChannelConfigEnumFieldDescriptor
  | ChannelConfigNumberFieldDescriptor
  | ChannelConfigObjectFieldDescriptor;

export interface ChannelManagementDescriptor {
  fields: readonly ChannelConfigFieldDescriptor[];

  /**
   * Cross-field validation applied to the resolved config during managed
   * upserts, after secret updates. Return an error message to reject the
   * update, or undefined to accept it.
   */
  validateConfig?: (
    config: Readonly<Record<string, unknown>>,
  ) => string | undefined;
}

/**
 * A channel plugin registers a channel type and provides a factory
 * to create adapter instances. Both built-in adapters and external
 * plugins conform to this interface.
 */
export interface ChannelPlugin {
  /** Unique channel type ID (e.g., "telegram", "tmcp-dingtalk"). */
  channelType: string;

  /** Human-readable name for CLI output. */
  displayName: string;

  /**
   * Config fields required by this channel type, beyond the shared
   * ChannelConfig fields. Validated at startup.
   */
  requiredConfigFields?: string[];

  /** Optional config fields whose string values may reference environment vars. */
  envResolvableConfigFields?: string[];

  /** Serializable metadata for safe configuration management. */
  management?: ChannelManagementDescriptor;

  /**
   * Default Channel routing scope (applied when config omits sessionScope).
   * `thread` is retained for existing configurations only.
   */
  defaultSessionScope?: SessionScope;

  /** Create a channel adapter instance. */
  createChannel(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ): ChannelBase;
}
