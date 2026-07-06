/**
 * createMessagingBootstrap — composable messaging wiring shared by every host.
 *
 * Both hosts (Electron main and the standalone Bun server) MUST go through this
 * helper. Deleting either call site breaks the typecheck of the other — that is
 * the only guardrail keeping the two paths from diverging. Do not construct
 * MessagingGatewayRegistry directly from a host.
 *
 * Shape:
 *   const handle = createMessagingBootstrap({ ... })                  // pre-bootstrapServer
 *   const deps   = { ..., messagingRegistry: handle.registry }        // into createHandlerDeps
 *   sink = handle.wrapSink(baseSink)                                  // into setSessionEventSink
 *   handle.setPublisher(instance.wsServer.push.bind(instance.wsServer))  // post-bootstrap
 *   await handle.initializeWorkspaces(workspaceIds)                   // post-bootstrap
 *   await handle.dispose()                                            // on shutdown
 */

import type { PushTarget } from '@craft-agent/shared/protocol'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type { ISessionManager } from '@craft-agent/server-core/handlers'

import { MessagingGatewayRegistry } from './registry'
import { createFanOutSink, type EventSinkFn } from './event-fanout'
import type { MessagingLogger } from './types'

export type PublishEventFn = (channel: string, target: PushTarget, ...args: unknown[]) => void

export interface MessagingBootstrapOptions {
  sessionManager: ISessionManager
  credentialManager: CredentialManager
  /** Absolute path to the messaging storage directory for the given workspace. */
  getMessagingDir: (workspaceId: string) => string
  /** Optional legacy dir (pre-relocation) for one-shot migration. Headless omits this. */
  getLegacyMessagingDir?: (workspaceId: string) => string | undefined
  logger?: MessagingLogger
  whatsapp: {
    /** Absolute path to the bundled worker.cjs. */
    workerEntry: string
    /**
     * Node binary to spawn. Required for hosts that don't run on Node themselves
     * (i.e. Bun). Defaults to `process.execPath` inside WhatsAppAdapter — correct
     * for Electron (which re-enters as Node via ELECTRON_RUN_AS_NODE) but wrong
     * for Bun, so the Bun host must pass `'node'` or an explicit path.
     */
    nodeBin?: string
    pairingMode?: 'qr' | 'code'
  }
}

export interface MessagingBootstrapHandle {
  /** The concrete registry; pass as `messagingRegistry` in HandlerDeps. */
  readonly registry: MessagingGatewayRegistry
  /**
   * Bind the WS push publisher once `bootstrapServer` has returned and
   * `instance.wsServer` is available. Safe to call before `initializeWorkspaces`.
   */
  setPublisher(push: PublishEventFn): void
  /** Compose the session-event fan-out on top of the base RPC push sink. */
  wrapSink(baseSink: EventSinkFn): EventSinkFn
  /** Initialize the given workspace IDs. Callers filter (e.g. skip `remoteServer`). */
  initializeWorkspaces(workspaceIds: string[]): Promise<void>
  /** Stop all gateways and release resources. Call from the host's shutdown path. */
  dispose(): Promise<void>
}

export function createMessagingBootstrap(opts: MessagingBootstrapOptions): MessagingBootstrapHandle {
  let publisher: PublishEventFn | null = null

  const registry = new MessagingGatewayRegistry({
    sessionManager: opts.sessionManager,
    credentialManager: opts.credentialManager,
    getMessagingDir: opts.getMessagingDir,
    getLegacyMessagingDir: opts.getLegacyMessagingDir,
    logger: opts.logger,
    whatsapp: {
      workerEntry: opts.whatsapp.workerEntry,
      nodeBin: opts.whatsapp.nodeBin,
      pairingMode: opts.whatsapp.pairingMode ?? 'qr',
    },
    publishEvent: (channel, target, ...args) => {
      publisher?.(channel, target, ...args)
    },
  })

  const log = opts.logger?.child({ component: 'bootstrap' })
  log?.info('messaging bootstrap created', {
    event: 'messaging_bootstrap_created',
    workerEntry: opts.whatsapp.workerEntry,
    nodeBin: opts.whatsapp.nodeBin ?? '(host default)',
    pairingMode: opts.whatsapp.pairingMode ?? 'qr',
  })

  return {
    registry,
    setPublisher(push) {
      publisher = push
    },
    wrapSink(baseSink) {
      return createFanOutSink(baseSink, registry.onSessionEvent)
    },
    async initializeWorkspaces(workspaceIds) {
      for (const wsId of workspaceIds) {
        try {
          await registry.initializeWorkspace(wsId)
        } catch (err) {
          log?.error('failed to initialize workspace', {
            event: 'workspace_init_failed',
            workspaceId: wsId,
            error: err,
          })
        }
      }
    },
    async dispose() {
      await registry.stopAll().catch(() => {})
    },
  }
}
