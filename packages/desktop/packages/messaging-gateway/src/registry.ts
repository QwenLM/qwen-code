/**
 * MessagingGatewayRegistry — owns per-workspace MessagingGateway instances.
 *
 * Responsibilities:
 *   - Satisfies IMessagingGatewayRegistry for the RPC handlers in server-core.
 *   - Acts as a single EventSink consumer fanning session events to the right gateway.
 *   - Owns the in-memory pairing code manager (shared across workspaces; codes are workspace-scoped).
 *   - Owns per-workspace MessagingConfig (messaging/config.json).
 *   - Owns platform adapter lifecycle (initialize/swap/destroy) via CredentialManager.
 *
 * The registry is constructed once, wired into HandlerDeps, then populated with
 * gateways via initializeWorkspace() for every workspace that has messaging enabled.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { PushTarget } from '@craft-agent/shared/protocol'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type {
  ISessionManager,
  IMessagingGatewayRegistry,
  MessagingBindingInfo,
  MessagingConfigInfo,
} from '@craft-agent/server-core/handlers'

import { MessagingGateway } from './gateway'
import { ConfigStore } from './config-store'
import { PairingCodeManager } from './pairing'
import { TelegramAdapter } from './adapters/telegram/index'
import { WhatsAppAdapter, type WhatsAppEvent } from './adapters/whatsapp/index'
import type { SessionEvent } from './renderer'
import type { EventSinkFn } from './event-fanout'
import type {
  ChannelBinding,
  MessagingLogger,
  MessagingPlatformRuntimeInfo,
  PlatformType,
} from './types'

const consoleLogger: MessagingLogger = {
  info: (message, meta) => console.log('[MessagingRegistry]', message, meta ?? ''),
  warn: (message, meta) => console.warn('[MessagingRegistry]', message, meta ?? ''),
  error: (message, meta) => console.error('[MessagingRegistry]', message, meta ?? ''),
  child(context) {
    return {
      info: (message, meta) => console.log('[MessagingRegistry]', context, message, meta ?? ''),
      warn: (message, meta) => console.warn('[MessagingRegistry]', context, message, meta ?? ''),
      error: (message, meta) => console.error('[MessagingRegistry]', context, message, meta ?? ''),
      child: (next) => consoleLogger.child({ ...context, ...next }),
    }
  },
}

export interface MessagingGatewayRegistryOptions {
  sessionManager: ISessionManager
  credentialManager: CredentialManager
  /** Absolute path to the messaging storage directory for the given workspace. */
  getMessagingDir: (workspaceId: string) => string
  /** Optional legacy messaging dir (pre-relocation) for one-shot migration. */
  getLegacyMessagingDir?: (workspaceId: string) => string | undefined
  /** Broadcasts an RPC push event to UI clients. No-op if undefined. */
  publishEvent?: (channel: string, target: PushTarget, ...args: unknown[]) => void
  /** Optional WhatsApp worker config — required to enable the WhatsApp adapter. */
  whatsapp?: {
    /** Absolute path to the worker entry (packaged/unpacked from @craft-agent/messaging-whatsapp-worker). */
    workerEntry: string
    /** Node binary override (defaults to process.execPath with ELECTRON_RUN_AS_NODE). */
    nodeBin?: string
    /** Pairing flow: 'qr' or 'code'. Defaults to 'code' (phone-number based). */
    pairingMode?: 'qr' | 'code'
  }
  /** Optional logger — shared with the gateway and adapters. */
  logger?: MessagingLogger
}

interface WorkspaceState {
  gateway: MessagingGateway
  configStore: ConfigStore
  botUsernames: Partial<Record<PlatformType, string>>
  whatsapp: WhatsAppAdapter | null
  whatsappOffEvent?: () => void
  runtime: Record<PlatformType, MessagingPlatformRuntimeInfo>
}

export class MessagingGatewayRegistry implements IMessagingGatewayRegistry {
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly pairing = new PairingCodeManager()
  private readonly log: MessagingLogger

  constructor(private readonly opts: MessagingGatewayRegistryOptions) {
    this.log = (opts.logger ?? consoleLogger).child({ component: 'registry' })
  }

  // -------------------------------------------------------------------------
  // Public registry lifecycle (called by the app bootstrap)
  // -------------------------------------------------------------------------

  async initializeWorkspace(workspaceId: string): Promise<void> {
    if (this.workspaces.has(workspaceId)) return

    const state = this.bootstrapWorkspace(workspaceId)
    const config = state.configStore.get()
    if (!config.enabled) return

    await state.gateway.start()
    this.log.info('gateway started for workspace', {
      event: 'gateway_started',
      workspaceId,
    })

    if (isPlatformConfigured(config, 'telegram')) {
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
      })
      void this.tryConnectTelegram(workspaceId, state).catch((err) => {
        this.log.error('background Telegram connect failed', {
          event: 'telegram_connect_failed',
          workspaceId,
          error: err,
        })
      })
    }

    if (isPlatformConfigured(config, 'whatsapp')) {
      if (this.hasWhatsAppAuthState(workspaceId)) {
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'connecting',
          lastError: undefined,
        })
        void this.startWhatsAppAdapter(workspaceId, state, { persistConfig: false, reason: 'restore' }).catch((err) => {
          this.log.error('background WhatsApp restore failed', {
            event: 'whatsapp_restore_failed',
            workspaceId,
            error: err,
          })
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: err instanceof Error ? err.message : String(err),
          })
        })
      } else {
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'reconnect_required',
          lastError: 'WhatsApp needs to be linked again.',
        })
      }
    }
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    await state.gateway.stop()
    this.pairing.clearWorkspace(workspaceId)
    this.workspaces.delete(workspaceId)
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.workspaces.values()).map((s) => s.gateway.stop().catch(() => {}))
    await Promise.all(stops)
    this.workspaces.clear()
  }

  get size(): number {
    return this.workspaces.size
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — config
  // -------------------------------------------------------------------------

  getConfig(workspaceId: string): MessagingConfigInfo | null {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    const cfg = state.configStore.get()
    return {
      enabled: cfg.enabled,
      platforms: cfg.platforms as MessagingConfigInfo['platforms'],
      runtime: {
        telegram: cloneRuntime(state.runtime.telegram),
        whatsapp: cloneRuntime(state.runtime.whatsapp),
      },
    }
  }

  async updateConfig(
    workspaceId: string,
    partial: Partial<MessagingConfigInfo>,
  ): Promise<void> {
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    state.configStore.update({
      enabled: partial.enabled,
      platforms: partial.platforms,
    } as never)

    const cfg = state.configStore.get()
    if (!cfg.enabled) {
      await state.gateway.unregisterAdapter('telegram').catch(() => {})
      await state.gateway.unregisterAdapter('whatsapp').catch(() => {})
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      state.whatsapp = null
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
      })
      this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
      })
      return
    }

    for (const platform of ['telegram', 'whatsapp'] as const) {
      const configured = isPlatformConfigured(cfg, platform)
      if (!configured && state.gateway.getAdapter(platform)) {
        await state.gateway.unregisterAdapter(platform).catch(() => {})
      }
      if (!configured && platform === 'whatsapp') {
        state.whatsappOffEvent?.()
        state.whatsappOffEvent = undefined
        state.whatsapp = null
      }
      if (!configured) {
        this.setPlatformRuntime(workspaceId, state, platform, {
          configured: false,
          connected: false,
          state: 'disconnected',
          identity: undefined,
          lastError: undefined,
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — bindings
  // -------------------------------------------------------------------------

  getBindings(workspaceId: string): MessagingBindingInfo[] {
    const state = this.workspaces.get(workspaceId)
    if (!state) return []
    return state.gateway.getBindingStore().getAll().map(toBindingInfo)
  }

  unbindSession(workspaceId: string, sessionId: string, platform?: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const removed = state.gateway
      .getBindingStore()
      .unbindSession(sessionId, platform as PlatformType | undefined)
    if (removed > 0) this.emitBindingChanged(workspaceId)
  }

  unbindBinding(workspaceId: string, bindingId: string): boolean {
    const state = this.workspaces.get(workspaceId)
    if (!state) return false
    const removed = state.gateway.getBindingStore().unbindById(bindingId)
    if (removed) this.emitBindingChanged(workspaceId)
    return removed
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — pairing
  // -------------------------------------------------------------------------

  generatePairingCode(
    workspaceId: string,
    sessionId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string } {
    if (!isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    if (!state.gateway.hasConnectedAdapter(platform)) {
      throw new Error(`${capitalize(platform)} is not connected`)
    }
    const gen = this.pairing.generate(workspaceId, sessionId, platform)
    this.log.info('pairing code generated', {
      event: 'pairing_generated',
      workspaceId,
      sessionId,
      platform,
      expiresAt: gen.expiresAt,
    })
    return {
      code: gen.code,
      expiresAt: gen.expiresAt,
      botUsername: state.botUsernames[platform],
    }
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — platform lifecycle
  // -------------------------------------------------------------------------

  async testTelegramToken(
    token: string,
  ): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }> {
    if (!token || token.trim().length === 0) {
      return { success: false, error: 'Token is empty' }
    }
    try {
      const info = await fetchTelegramBotInfo(token.trim())
      if (!info.ok) {
        return { success: false, error: info.description ?? 'Invalid token' }
      }
      return {
        success: true,
        botName: info.result.first_name ?? info.result.username ?? 'bot',
        botUsername: info.result.username,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      }
    }
  }

  async saveTelegramToken(workspaceId: string, token: string): Promise<void> {
    const trimmed = token.trim()
    if (!trimmed) throw new Error('Token is empty')

    const test = await this.testTelegramToken(trimmed)
    if (!test.success) throw new Error(test.error ?? 'Invalid token')

    await this.opts.credentialManager.set(
      {
        type: 'messaging_bearer',
        workspaceId,
        name: 'telegram',
      },
      { value: trimmed },
    )

    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    state.configStore.update({
      enabled: true,
      platforms: { telegram: { enabled: true } },
    })

    this.setPlatformRuntime(workspaceId, state, 'telegram', {
      configured: true,
      connected: false,
      state: 'connecting',
      lastError: undefined,
    })

    await this.tryConnectTelegram(workspaceId, state)
    await state.gateway.start()
  }

  async disconnectPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform)) return
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    if (platform === 'whatsapp') {
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      if (state.whatsapp) {
        await state.whatsapp.destroy().catch(() => {})
        state.whatsapp = null
      }
    }

    await state.gateway.unregisterAdapter(platform).catch(() => {})
    state.botUsernames[platform] = undefined
    this.pairing.clearWorkspace(workspaceId)

    const currentConfig = state.configStore.get()
    const nextPlatforms = {
      ...currentConfig.platforms,
      [platform]: { enabled: false },
    }
    const anyPlatformEnabled = Object.values(nextPlatforms).some((entry) => entry?.enabled)
    state.configStore.update({
      enabled: anyPlatformEnabled,
      platforms: nextPlatforms,
    })

    if (platform !== 'whatsapp') {
      await this.opts.credentialManager
        .delete({ type: 'messaging_bearer', workspaceId, name: platform })
        .catch(() => {})
    }

    this.setPlatformRuntime(workspaceId, state, platform, {
      configured: false,
      connected: false,
      state: 'disconnected',
      identity: undefined,
      lastError: undefined,
    })
  }

  async forgetPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform)) return
    await this.disconnectPlatform(workspaceId, platform)
    if (platform === 'whatsapp') {
      const authDir = this.getWhatsAppAuthStateDir(workspaceId)
      try {
        rmSync(authDir, { recursive: true, force: true })
        this.log.info('forgot WhatsApp auth state', {
          event: 'whatsapp_auth_forgotten',
          workspaceId,
          authDir,
        })
      } catch (err) {
        this.log.error('failed to forget WhatsApp auth state', {
          event: 'whatsapp_auth_forget_failed',
          workspaceId,
          authDir,
          error: err,
        })
        throw err
      }
    }
  }

  // -------------------------------------------------------------------------
  // WhatsApp — subprocess lifecycle
  // -------------------------------------------------------------------------

  async startWhatsAppConnect(workspaceId: string): Promise<void> {
    const waConfig = this.opts.whatsapp
    if (!waConfig) {
      throw new Error('WhatsApp support is not configured on this server')
    }
    const state = this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
    this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
      configured: true,
      connected: false,
      state: 'connecting',
      lastError: undefined,
    })
    await this.startWhatsAppAdapter(workspaceId, state, { persistConfig: true, reason: 'user_connect' })
  }

  async submitWhatsAppPhone(workspaceId: string, phoneNumber: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state?.whatsapp) {
      throw new Error('WhatsApp not started — call startWhatsAppConnect first')
    }
    const cleaned = phoneNumber.replace(/[^\d]/g, '')
    if (cleaned.length < 8) throw new Error('Phone number looks too short')
    await state.whatsapp.requestPairingCode(cleaned)
  }

  private async startWhatsAppAdapter(
    workspaceId: string,
    state: WorkspaceState,
    options: { persistConfig: boolean; reason: 'restore' | 'user_connect' },
  ): Promise<void> {
    const waConfig = this.opts.whatsapp
    if (!waConfig) {
      throw new Error('WhatsApp support is not configured on this server')
    }

    state.whatsappOffEvent?.()
    state.whatsappOffEvent = undefined
    if (state.whatsapp) {
      await state.whatsapp.destroy().catch(() => {})
      state.whatsapp = null
    }

    const adapter = new WhatsAppAdapter()
    state.whatsapp = adapter
    state.whatsappOffEvent = adapter.onEvent((ev) => this.onWhatsAppEvent(workspaceId, ev))

    // selfChatMode: default ON. Persisted to workspace config so it
    // survives restart and can be toggled later if the user wants pure
    // contact-only routing.
    const persistedCfg = state.configStore.get()
    const selfChatMode = persistedCfg.platforms.whatsapp?.selfChatMode ?? true

    await adapter.initialize({
      workerEntry: waConfig.workerEntry,
      nodeBin: waConfig.nodeBin,
      authStateDir: this.getWhatsAppAuthStateDir(workspaceId),
      pairingMode: waConfig.pairingMode ?? 'code',
      selfChatMode,
      logger: this.log.child({
        component: 'whatsapp-adapter',
        workspaceId,
        platform: 'whatsapp',
      }),
    })

    state.gateway.registerAdapter(adapter)
    if (options.persistConfig) {
      state.configStore.update({
        enabled: true,
        platforms: { whatsapp: { enabled: true, selfChatMode } },
      })
    }
    await state.gateway.start()
    this.log.info('WhatsApp adapter started', {
      event: 'whatsapp_adapter_started',
      workspaceId,
      reason: options.reason,
    })
  }

  private onWhatsAppEvent(workspaceId: string, event: WhatsAppEvent): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.WA_UI_EVENT,
      { to: 'workspace', workspaceId },
      { workspaceId, event },
    )

    switch (event.type) {
      case 'qr':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'reconnect_required',
          lastError: 'QR scan required',
        })
        return
      case 'connected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: true,
          state: 'connected',
          identity: event.name ?? event.jid,
          lastError: undefined,
        })
        return
      case 'disconnected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: event.loggedOut ? 'reconnect_required' : 'disconnected',
          lastError: event.reason,
          identity: undefined,
        })
        return
      case 'unavailable':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'error',
          lastError: event.message,
          identity: undefined,
        })
        return
      case 'error':
        if (!state.runtime.whatsapp.connected) {
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: event.message,
          })
        }
        return
      case 'pairing_code':
        return
    }
  }

  // -------------------------------------------------------------------------
  // EventSink-compatible callback
  // -------------------------------------------------------------------------

  onSessionEvent: EventSinkFn = (channel: string, target: PushTarget, ...args: unknown[]) => {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return

    const event = args[0] as SessionEvent | undefined
    if (!event?.sessionId) return

    const workspaceId =
      'workspaceId' in target ? (target as { workspaceId: string }).workspaceId : undefined
    if (!workspaceId) {
      for (const state of this.workspaces.values()) {
        state.gateway.onSessionEvent(channel, target, ...args)
      }
      return
    }

    const state = this.workspaces.get(workspaceId)
    if (state) state.gateway.onSessionEvent(channel, target, ...args)
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private bootstrapWorkspace(workspaceId: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return existing

    const storageDir = this.opts.getMessagingDir(workspaceId)
    const legacyStorageDir = this.opts.getLegacyMessagingDir?.(workspaceId)
    const baseLog = this.log.child({ workspaceId })
    const configStore = new ConfigStore(
      storageDir,
      legacyStorageDir,
      baseLog.child({ component: 'config-store' }),
    )
    const cfg = configStore.get()
    const gateway = new MessagingGateway({
      sessionManager: this.opts.sessionManager,
      workspaceId,
      storageDir,
      legacyStorageDir,
      logger: baseLog,
      pairingConsumer: {
        canConsume: (platform, senderId) =>
          this.pairing.canConsume(workspaceId, platform, senderId),
        consume: (platform, code) => {
          const entry = this.pairing.consume(workspaceId, platform, code)
          if (!entry) return null
          return { workspaceId: entry.workspaceId, sessionId: entry.sessionId }
        },
      },
      onBindingChanged: () => this.emitBindingChanged(workspaceId),
    })

    const state: WorkspaceState = {
      gateway,
      configStore,
      botUsernames: {},
      whatsapp: null,
      runtime: {
        telegram: createRuntime('telegram', isPlatformConfigured(cfg, 'telegram')),
        whatsapp: createRuntime('whatsapp', isPlatformConfigured(cfg, 'whatsapp')),
      },
    }
    this.workspaces.set(workspaceId, state)
    return state
  }

  private async tryConnectTelegram(workspaceId: string, state: WorkspaceState): Promise<void> {
    const cred = await this.opts.credentialManager
      .get({ type: 'messaging_bearer', workspaceId, name: 'telegram' })
      .catch(() => null)

    if (!cred?.value) {
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: 'Telegram token is missing.',
      })
      return
    }

    await state.gateway.unregisterAdapter('telegram').catch((err) => {
      this.log.warn('unregisterAdapter(telegram) failed (non-fatal)', {
        event: 'telegram_unregister_failed',
        workspaceId,
        error: err,
      })
    })

    try {
      const adapter = new TelegramAdapter()
      await adapter.initialize({
        token: cred.value,
        logger: this.log.child({
          component: 'telegram-adapter',
          workspaceId,
          platform: 'telegram',
        }),
      })

      try {
        const info = await adapter.getBotInfo()
        state.botUsernames.telegram = info?.username
      } catch {
        // non-fatal
      }

      state.gateway.registerAdapter(adapter)
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: true,
        state: 'connected',
        identity: state.botUsernames.telegram,
        lastError: undefined,
      })
    } catch (err) {
      this.log.error('failed to connect Telegram', {
        event: 'telegram_connect_failed',
        workspaceId,
        error: err,
      })
      this.setPlatformRuntime(workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private setPlatformRuntime(
    workspaceId: string,
    state: WorkspaceState,
    platform: PlatformType,
    patch: Partial<MessagingPlatformRuntimeInfo>,
  ): void {
    const previous = state.runtime[platform] ?? createRuntime(platform, false)
    const next: MessagingPlatformRuntimeInfo = {
      ...previous,
      ...patch,
      platform,
      updatedAt: Date.now(),
    }
    state.runtime[platform] = next
    this.emitPlatformStatus(workspaceId, platform, next)
  }

  private emitBindingChanged(workspaceId: string): void {
    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.BINDING_CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private emitPlatformStatus(
    workspaceId: string,
    platform: PlatformType,
    status: MessagingPlatformRuntimeInfo,
  ): void {
    this.opts.publishEvent?.(
      RPC_CHANNELS.messaging.PLATFORM_STATUS,
      { to: 'workspace', workspaceId },
      workspaceId,
      platform,
      cloneRuntime(status),
    )
  }

  private hasWhatsAppAuthState(workspaceId: string): boolean {
    const dir = this.getWhatsAppAuthStateDir(workspaceId)
    if (!existsSync(dir)) return false
    try {
      return readdirSync(dir).some((entry) => !entry.startsWith('.'))
    } catch {
      return false
    }
  }

  private getWhatsAppAuthStateDir(workspaceId: string): string {
    return join(this.opts.getMessagingDir(workspaceId), 'whatsapp-auth')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBindingInfo(b: ChannelBinding): MessagingBindingInfo {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    sessionId: b.sessionId,
    platform: b.platform,
    channelId: b.channelId,
    channelName: b.channelName,
    enabled: b.enabled,
    createdAt: b.createdAt,
  }
}

function isKnownPlatform(p: string): p is PlatformType {
  return p === 'telegram' || p === 'whatsapp'
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

function isPlatformConfigured(
  config: { enabled: boolean; platforms: Record<string, { enabled: boolean } | undefined> },
  platform: PlatformType,
): boolean {
  return Boolean(config.enabled && config.platforms[platform]?.enabled)
}

function createRuntime(platform: PlatformType, configured: boolean): MessagingPlatformRuntimeInfo {
  return {
    platform,
    configured,
    connected: false,
    state: configured ? 'disconnected' : 'disconnected',
    updatedAt: Date.now(),
  }
}

function cloneRuntime(runtime: MessagingPlatformRuntimeInfo): MessagingPlatformRuntimeInfo {
  return { ...runtime }
}

async function fetchTelegramBotInfo(
  token: string,
): Promise<{ ok: boolean; result: { username?: string; first_name?: string }; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
  return (await res.json()) as {
    ok: boolean
    result: { username?: string; first_name?: string }
    description?: string
  }
}
