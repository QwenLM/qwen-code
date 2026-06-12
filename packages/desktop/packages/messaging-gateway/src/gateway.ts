/**
 * MessagingGateway — orchestrator for messaging platform adapters.
 *
 * Runs in-process alongside SessionManager. Wires adapters, router,
 * renderer, and binding store together. One instance per workspace.
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { PushTarget } from '@craft-agent/shared/protocol'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { BindingStore } from './binding-store'
import { Router } from './router'
import { Commands, type PairingCodeConsumer } from './commands'
import { Renderer, type SessionEvent } from './renderer'
import { PlanTokenRegistry } from './plan-tokens'
import type {
  PlatformAdapter,
  PlatformType,
  IncomingMessage,
  ButtonPress,
  MessagingLogger,
} from './types'

const consoleLogger: MessagingLogger = {
  info: (message, meta) => console.log('[MessagingGateway]', message, meta ?? ''),
  warn: (message, meta) => console.warn('[MessagingGateway]', message, meta ?? ''),
  error: (message, meta) => console.error('[MessagingGateway]', message, meta ?? ''),
  child(context) {
    return {
      info: (message, meta) => console.log('[MessagingGateway]', context, message, meta ?? ''),
      warn: (message, meta) => console.warn('[MessagingGateway]', context, message, meta ?? ''),
      error: (message, meta) => console.error('[MessagingGateway]', context, message, meta ?? ''),
      child: (next) => consoleLogger.child({ ...context, ...next }),
    }
  },
}

export interface GatewayOptions {
  sessionManager: ISessionManager
  workspaceId: string
  /** Absolute path to the messaging storage directory. */
  storageDir: string
  /** Optional legacy directory for one-shot migration of bindings.json. */
  legacyStorageDir?: string
  /** Optional consumer that resolves /pair codes issued elsewhere. */
  pairingConsumer?: PairingCodeConsumer
  /** Fired after any binding mutation (bind/unbind). */
  onBindingChanged?: () => void
  /** Optional logger — defaults to console. Pass a structured host logger in Electron. */
  logger?: MessagingLogger
}

/**
 * Per-plan metadata tracked while a plan approval button is live on a chat.
 * Used to disable the inline keyboard after a tap. Keyed by plan token.
 */
interface PlanMessageRecord {
  bindingId: string
  platform: PlatformType
  channelId: string
  messageId: string
}

interface PendingCompactAccept {
  token: string
  sessionId: string
  bindingId: string
  platform: PlatformType
  channelId: string
  messageId: string
  planPath: string
  createdAt: number
}

const COMPACT_ACCEPT_TTL_MS = 10 * 60 * 1000

export class MessagingGateway {
  private readonly sessionManager: ISessionManager
  private readonly workspaceId: string
  private readonly bindingStore: BindingStore
  private readonly router: Router
  private readonly commands: Commands
  private readonly renderer: Renderer
  private readonly planTokens: PlanTokenRegistry
  private readonly planMessages = new Map<string, PlanMessageRecord>()
  private readonly pendingCompactAccepts = new Map<string, PendingCompactAccept>()
  private readonly adapters = new Map<PlatformType, PlatformAdapter>()
  private readonly log: MessagingLogger
  private started = false

  constructor(opts: GatewayOptions) {
    this.sessionManager = opts.sessionManager
    this.workspaceId = opts.workspaceId
    this.log = (opts.logger ?? consoleLogger).child({
      component: 'gateway',
      workspaceId: opts.workspaceId,
    })
    this.bindingStore = new BindingStore(
      opts.storageDir,
      opts.legacyStorageDir,
      this.log.child({ component: 'binding-store' }),
    )
    if (opts.onBindingChanged) {
      this.bindingStore.onChange(opts.onBindingChanged)
    }
    this.commands = new Commands(
      opts.sessionManager,
      this.bindingStore,
      opts.workspaceId,
      opts.pairingConsumer,
      this.log.child({ component: 'commands' }),
    )
    this.router = new Router(
      opts.sessionManager,
      this.bindingStore,
      this.commands,
      this.log.child({ component: 'router' }),
    )
    this.planTokens = new PlanTokenRegistry()
    this.renderer = new Renderer({
      planTokens: this.planTokens,
      // The renderer hands us the exact binding that sent the message.
      // We must not resolve it ourselves — `findBySession` returns every
      // binding and picking the first Telegram binding attributes the
      // message to the wrong chat whenever the session has more than one.
      recordPlanMessage: (binding, token, messageId) => {
        this.planMessages.set(token, {
          bindingId: binding.id,
          platform: binding.platform,
          channelId: binding.channelId,
          messageId,
        })
      },
    })
  }

  // -------------------------------------------------------------------------
  // Adapter registration
  // -------------------------------------------------------------------------

  registerAdapter(adapter: PlatformAdapter): void {
    const existing = this.adapters.get(adapter.platform)
    if (existing) {
      existing.destroy().catch((err) => {
        this.log.warn('failed to destroy existing adapter during replacement', {
          event: 'adapter_replace_destroy_failed',
          platform: adapter.platform,
          error: err,
        })
      })
    }
    this.adapters.set(adapter.platform, adapter)
    if (this.started) {
      this.wireAdapter(adapter)
    }
  }

  async unregisterAdapter(platform: PlatformType): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter) return
    this.adapters.delete(platform)
    try {
      await adapter.destroy()
      this.log.info('adapter unregistered', {
        event: 'adapter_unregistered',
        platform,
      })
    } catch (err) {
      this.log.error('failed to destroy adapter', {
        event: 'adapter_destroy_failed',
        platform,
        error: err,
      })
    }
  }

  getAdapter(platform: PlatformType): PlatformAdapter | undefined {
    return this.adapters.get(platform)
  }

  hasConnectedAdapter(platform: PlatformType): boolean {
    return this.adapters.get(platform)?.isConnected() ?? false
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const adapter of this.adapters.values()) {
      this.wireAdapter(adapter)
    }
    this.log.info('gateway started', { event: 'gateway_started' })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.destroy()
        this.log.info('adapter stopped', {
          event: 'adapter_stopped',
          platform,
        })
      } catch (err) {
        this.log.error('failed to stop adapter', {
          event: 'adapter_stop_failed',
          platform,
          error: err,
        })
      }
    }
    this.adapters.clear()
  }

  private wireAdapter(adapter: PlatformAdapter): void {
    adapter.onMessage(async (msg: IncomingMessage) => {
      const isCommand = msg.text.trim().startsWith('/')
      if (isCommand) {
        const handled = await this.commands.handleCommand(adapter, msg)
        if (handled) return
      }
      await this.router.route(adapter, msg)
    })

    adapter.onButtonPress(async (press: ButtonPress) => {
      await this.handleButtonPress(adapter.platform, press)
    })

    this.log.info('adapter registered', {
      event: 'adapter_registered',
      platform: adapter.platform,
      capabilities: adapter.capabilities,
    })
  }

  // -------------------------------------------------------------------------
  // Event handling (called by fan-out EventSink)
  // -------------------------------------------------------------------------

  onSessionEvent(channel: string, _target: PushTarget, ...args: any[]): void {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return

    const event = args[0] as SessionEvent | undefined
    if (!event?.sessionId) return

    // If this session has a pending "accept & compact" that is now finishing
    // compaction, dispatch the approval now. Before the fan-out so the
    // renderer's own `info:compaction_complete` path doesn't race.
    if (
      event.type === 'info' &&
      (event as { statusType?: string }).statusType === 'compaction_complete'
    ) {
      void this.finishPendingCompactAccept(event.sessionId)
    }

    const bindings = this.bindingStore.findBySession(event.sessionId)
    if (bindings.length === 0) return

    for (const binding of bindings) {
      const adapter = this.adapters.get(binding.platform)
      if (!adapter || !adapter.isConnected()) continue
      this.renderer.handle(event, binding, adapter).catch((err) => {
        this.log.error('renderer failed to emit event to chat', {
          event: 'renderer_failed',
          sessionId: event.sessionId,
          bindingId: binding.id,
          platform: binding.platform,
          channelId: binding.channelId,
          error: err,
        })
      })
    }
  }

  // -------------------------------------------------------------------------
  // Button handling
  // -------------------------------------------------------------------------

  private async handleButtonPress(platform: PlatformType, press: ButtonPress): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (!adapter) return

    if (press.buttonId.startsWith('bind:')) {
      const sessionId = press.buttonId.slice('bind:'.length)
      const session = await this.sessionManager.getSession(sessionId)
      if (!session) {
        await adapter.sendText(press.channelId, 'Session not found.')
        return
      }

      this.bindingStore.bind(
        this.workspaceId,
        session.id,
        platform,
        press.channelId,
        undefined,
      )

      await adapter.sendText(
        press.channelId,
        `Bound to "${session.name || session.id}"`,
      )
      return
    }

    if (press.buttonId.startsWith('perm:')) {
      if (platform === 'whatsapp') {
        this.log.warn('ignored chat-side permission interaction for WhatsApp', {
          event: 'whatsapp_permission_button_ignored',
          channelId: press.channelId,
          buttonId: press.buttonId,
        })
        await adapter.sendText(
          press.channelId,
          '⏸ Permission required. Approve it in the desktop app to continue.',
        )
        return
      }

      const parts = press.buttonId.split(':')
      const action = parts[1]
      const requestId = parts[2]
      if (!requestId) return

      const binding = this.bindingStore.findByChannel(platform, press.channelId)
      if (!binding) return

      const allowed = action === 'allow'
      this.sessionManager.respondToPermission(
        binding.sessionId,
        requestId,
        allowed,
        false,
      )

      await adapter.sendText(press.channelId, allowed ? '✅ Allowed' : '❌ Denied')
      return
    }

    if (press.buttonId.startsWith('plan:')) {
      await this.handlePlanButton(platform, adapter, press)
      return
    }
  }

  private async handlePlanButton(
    platform: PlatformType,
    adapter: PlatformAdapter,
    press: ButtonPress,
  ): Promise<void> {
    const parts = press.buttonId.split(':')
    const action = parts[1]
    const token = parts[2]
    if (!token || (action !== 'accept' && action !== 'compact')) return

    const entry = this.planTokens.resolve(token)
    if (!entry) {
      await adapter.sendText(
        press.channelId,
        '⚠️ This plan has expired. Retry from the desktop app.',
      )
      return
    }

    // Disable the buttons so the user can't tap twice. Non-fatal if it fails.
    const record = this.planMessages.get(token)
    if (record && adapter.clearButtons) {
      await adapter.clearButtons(record.channelId, record.messageId).catch(() => {})
    }

    this.planTokens.revoke(token)
    this.planMessages.delete(token)

    if (action === 'accept') {
      try {
        await this.sessionManager.acceptPlan(entry.sessionId, entry.planPath)
        await adapter.sendText(press.channelId, '✅ Plan accepted. Agent resuming.')
      } catch (err) {
        this.log.error('acceptPlan failed', {
          event: 'plan_accept_failed',
          sessionId: entry.sessionId,
          error: err,
        })
        await adapter.sendText(
          press.channelId,
          '❌ Couldn\'t accept the plan. Check the desktop app.',
        )
      }
      return
    }

    // action === 'compact': persist the "waiting for compaction" intent, send
    // /compact, and let onSessionEvent → finishPendingCompactAccept dispatch
    // the approval once compaction finishes.
    const binding = this.bindingStore.findByChannel(platform, press.channelId)
    if (!binding) return

    this.pendingCompactAccepts.set(entry.sessionId, {
      token,
      sessionId: entry.sessionId,
      bindingId: binding.id,
      platform,
      channelId: press.channelId,
      messageId: record?.messageId ?? '',
      planPath: entry.planPath,
      createdAt: Date.now(),
    })

    try {
      await this.sessionManager.setPendingPlanExecution(entry.sessionId, entry.planPath)
      await this.sessionManager.sendMessage(entry.sessionId, '/compact')
      await adapter.sendText(
        press.channelId,
        '♻️ Compacting conversation, then executing the plan…',
      )
    } catch (err) {
      this.pendingCompactAccepts.delete(entry.sessionId)
      this.log.error('compact dispatch failed', {
        event: 'plan_compact_failed',
        sessionId: entry.sessionId,
        error: err,
      })
      await adapter.sendText(
        press.channelId,
        '❌ Couldn\'t start compaction. Check the desktop app.',
      )
    }
  }

  private async finishPendingCompactAccept(sessionId: string): Promise<void> {
    const entry = this.pendingCompactAccepts.get(sessionId)
    if (!entry) return
    this.pendingCompactAccepts.delete(sessionId)

    if (Date.now() - entry.createdAt > COMPACT_ACCEPT_TTL_MS) {
      this.log.warn('dropping stale compact-accept entry', {
        event: 'plan_compact_stale',
        sessionId,
      })
      return
    }

    const adapter = this.adapters.get(entry.platform)
    try {
      await this.sessionManager.acceptPlan(sessionId, entry.planPath)
      await this.sessionManager.clearPendingPlanExecution(sessionId)
      if (adapter?.isConnected()) {
        await adapter.sendText(entry.channelId, '✅ Plan executing after compaction.')
      }
    } catch (err) {
      this.log.error('post-compaction acceptPlan failed', {
        event: 'plan_post_compact_accept_failed',
        sessionId,
        error: err,
      })
      if (adapter?.isConnected()) {
        await adapter.sendText(
          entry.channelId,
          '❌ Compaction finished but the plan couldn\'t execute. Check the desktop app.',
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  getBindingStore(): BindingStore {
    return this.bindingStore
  }

  isStarted(): boolean {
    return this.started
  }
}
