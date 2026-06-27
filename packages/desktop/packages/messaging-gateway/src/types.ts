/**
 * Core types for the messaging gateway.
 *
 * Workspace-scoped bindings, platform adapter interface, runtime state, and
 * messaging-stack logging contracts.
 */

// ---------------------------------------------------------------------------
// Platform types
// ---------------------------------------------------------------------------

export type PlatformType = 'telegram' | 'whatsapp'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface MessagingLogContext {
  component?: string
  workspaceId?: string
  sessionId?: string
  platform?: string
  channelId?: string
  bindingId?: string
  event?: string
}

export type MessagingLogMeta = Record<string, unknown>

/**
 * Structured logger used by the messaging stack.
 *
 * Implementations should write structured logs and preserve contextual fields
 * added via `child(...)`.
 */
export interface MessagingLogger {
  info(message: string, meta?: MessagingLogMeta): void
  warn(message: string, meta?: MessagingLogMeta): void
  error(message: string, meta?: MessagingLogMeta): void
  child(context: MessagingLogContext): MessagingLogger
}

// ---------------------------------------------------------------------------
// Runtime platform status
// ---------------------------------------------------------------------------

export type MessagingPlatformRuntimeState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnect_required'
  | 'error'

export interface MessagingPlatformRuntimeInfo {
  platform: PlatformType
  configured: boolean
  connected: boolean
  state: MessagingPlatformRuntimeState
  identity?: string
  lastError?: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Adapter capabilities
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  messageEditing: boolean
  inlineButtons: boolean
  maxButtons: number
  maxMessageLength: number
  markdown: 'v2' | 'whatsapp'
  webhookSupport: boolean
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  platform: PlatformType
  channelId: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  attachments?: IncomingAttachment[]
  replyToMessageId?: string
  timestamp: number
  raw: unknown
}

export interface IncomingAttachment {
  type: 'photo' | 'document' | 'voice' | 'video' | 'audio'
  fileId: string
  fileName?: string
  mimeType?: string
  fileSize?: number
  /**
   * Absolute path on local disk where the adapter has already downloaded the
   * blob. When set, the router wraps it with `readFileAttachment()` and
   * forwards it as a `FileAttachment` to the session. Adapters that emit
   * attachments MUST populate this — attachments without `localPath` are
   * dropped by the router.
   */
  localPath?: string
}

export interface SentMessage {
  platform: PlatformType
  channelId: string
  messageId: string
}

export interface InlineButton {
  id: string
  label: string
  data?: string
}

export interface ButtonPress {
  platform: PlatformType
  channelId: string
  messageId: string
  senderId: string
  buttonId: string
  data?: string
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  token?: string
  webhookUrl?: string
  webhookSecretToken?: string
  /** Optional logger for adapter-level diagnostics. */
  logger?: MessagingLogger
  [key: string]: unknown
}

export interface PlatformAdapter {
  readonly platform: PlatformType
  readonly capabilities: AdapterCapabilities

  initialize(config: PlatformConfig): Promise<void>
  destroy(): Promise<void>
  isConnected(): boolean

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void

  sendText(channelId: string, text: string): Promise<SentMessage>
  editMessage(channelId: string, messageId: string, text: string): Promise<void>
  sendButtons(channelId: string, text: string, buttons: InlineButton[]): Promise<SentMessage>
  sendTyping(channelId: string): Promise<void>
  sendFile(channelId: string, file: Buffer, filename: string, caption?: string): Promise<SentMessage>

  /**
   * Clear the inline keyboard on a previously-sent message. Optional because
   * only platforms with inline-button support (currently Telegram) need it.
   * Errors are the caller's concern — most implementations should swallow
   * "message can't be edited" since it's non-fatal.
   */
  clearButtons?(channelId: string, messageId: string): Promise<void>

  /** Webhook handler for headless server (Telegram only). */
  handleWebhook?(request: Request): Promise<Response>
}

// ---------------------------------------------------------------------------
// Channel binding
// ---------------------------------------------------------------------------

/**
 * How agent output is rendered to the chat.
 *
 * - `streaming` — legacy behaviour: live edits during the final turn, and
 *   every intermediate `text_complete` starts a fresh message. Produces
 *   multiple messages per agent run. Kept for parity with in-app UI.
 * - `progress` — one evolving message per run. Posts a "💭 thinking…"
 *   bubble on first activity, edits it as tools run, replaces it with
 *   the final answer on `complete`. Intermediate assistant text is
 *   dropped. Default for new bindings.
 * - `final_only` — silent until `complete`, then one message with the
 *   final text. Nothing is posted if the run has no final text.
 */
export type ResponseMode = 'streaming' | 'progress' | 'final_only'

export interface BindingConfig {
  /** How outbound agent output is rendered. Default: 'progress' */
  responseMode: ResponseMode
  /**
   * @deprecated Use `responseMode` instead. Retained so persisted configs
   * written by older versions keep validating; the renderer ignores this
   * field when `responseMode` is present.
   */
  streamResponses: boolean
  /** Show compact tool activity summaries. Default: false */
  showToolActivity: boolean
  /** WHERE approval happens (not WHETHER — session mode is authoritative). */
  approvalChannel: 'chat' | 'app'
  /** Telegram edit interval in ms. ~3500ms stays under 20 edits/min. */
  editIntervalMs: number
}

export const DEFAULT_BINDING_CONFIG: BindingConfig = {
  responseMode: 'progress',
  streamResponses: true,
  showToolActivity: false,
  approvalChannel: 'chat',
  editIntervalMs: 3500,
}

export function getDefaultBindingConfig(platform: PlatformType): BindingConfig {
  return {
    ...DEFAULT_BINDING_CONFIG,
    approvalChannel: platform === 'whatsapp' ? 'app' : DEFAULT_BINDING_CONFIG.approvalChannel,
  }
}

export function normalizeBindingConfig(
  platform: PlatformType,
  config?: Partial<BindingConfig>,
): BindingConfig {
  const base = getDefaultBindingConfig(platform)
  const resolvedResponseMode: ResponseMode =
    config?.responseMode ??
    (config?.streamResponses === false ? 'final_only' : config?.streamResponses === true ? 'streaming' : base.responseMode)

  return {
    ...base,
    ...config,
    responseMode: resolvedResponseMode,
    approvalChannel: platform === 'whatsapp' ? 'app' : (config?.approvalChannel ?? base.approvalChannel),
  }
}

export interface ChannelBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: PlatformType
  channelId: string
  channelName?: string
  enabled: boolean
  createdAt: number
  config: BindingConfig
}

// ---------------------------------------------------------------------------
// Gateway config (persisted per workspace)
// ---------------------------------------------------------------------------

export interface MessagingConfig {
  enabled: boolean
  platforms: {
    telegram?: {
      enabled: boolean
    }
    whatsapp?: {
      enabled: boolean
      /**
       * When true, messages sent from other devices on the same WA account
       * to the self-JID (your own number) are routed to a bound session.
       * The worker filters its own echoes via sent-ID tracking + a response
       * prefix. Defaults to `true` when unset — the no-second-phone flow is
       * the expected UX for new users.
       */
      selfChatMode?: boolean
    }
  }
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  enabled: false,
  platforms: {},
}
