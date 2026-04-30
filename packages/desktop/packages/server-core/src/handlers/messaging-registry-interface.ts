/**
 * IMessagingGatewayRegistry — abstract interface for messaging gateway access.
 *
 * RPC handlers in server-core program against this interface;
 * the concrete MessagingGatewayRegistry satisfies it at runtime.
 */

export interface MessagingBindingInfo {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  channelId: string
  channelName?: string
  enabled: boolean
  createdAt: number
}

export interface MessagingPlatformRuntimeInfo {
  platform: string
  configured: boolean
  connected: boolean
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
  identity?: string
  lastError?: string
  updatedAt: number
}

export interface MessagingConfigInfo {
  enabled: boolean
  platforms: Record<string, { enabled: boolean } | undefined>
  runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
}

export interface IMessagingGatewayRegistry {
  /** Get bindings for a workspace. */
  getBindings(workspaceId: string): MessagingBindingInfo[]

  /** Get messaging config and runtime state for a workspace. */
  getConfig(workspaceId: string): MessagingConfigInfo | null

  /** Update messaging config for a workspace. */
  updateConfig(workspaceId: string, config: Partial<MessagingConfigInfo>): Promise<void>

  /** Generate a pairing code for binding a session to a chat. */
  generatePairingCode(workspaceId: string, sessionId: string, platform: string): { code: string; expiresAt: number; botUsername?: string }

  /** Unbind all bindings for a session, optionally limited to one platform. */
  unbindSession(workspaceId: string, sessionId: string, platform?: string): void

  /** Unbind one specific binding row by ID. */
  unbindBinding(workspaceId: string, bindingId: string): boolean

  /** Test a Telegram bot token. */
  testTelegramToken(token: string): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>

  /** Save Telegram token and (re)initialize the adapter. */
  saveTelegramToken(workspaceId: string, token: string): Promise<void>

  /** Disable a platform for a workspace, preserving WhatsApp auth state unless forgotten separately. */
  disconnectPlatform(workspaceId: string, platform: string): Promise<void>

  /** Disable a platform and forget its local auth/device state when supported. */
  forgetPlatform(workspaceId: string, platform: string): Promise<void>

  /**
   * Start the WhatsApp connect flow (spawns the worker, emits QR or pairing-code
   * prompts via WA_UI_EVENT). Throws if WhatsApp support is not configured.
   */
  startWhatsAppConnect(workspaceId: string): Promise<void>

  /**
   * Submit a phone number to the running WhatsApp worker to request a pairing
   * code. Must be called after startWhatsAppConnect.
   */
  submitWhatsAppPhone(workspaceId: string, phoneNumber: string): Promise<void>
}
