/**
 * Messaging RPC handlers — UI ↔ Server communication for messaging config and bindings.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

export function registerMessagingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const registry = deps.messagingRegistry
  if (!registry) return

  server.handle(RPC_CHANNELS.messaging.GET_CONFIG, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.getConfig(ctx.workspaceId)
  })

  server.handle(RPC_CHANNELS.messaging.UPDATE_CONFIG, async (ctx, config: Record<string, unknown>) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.updateConfig(ctx.workspaceId, config)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.TEST_TELEGRAM, async (_ctx, token: string) => {
    return registry.testTelegramToken(token)
  })

  server.handle(RPC_CHANNELS.messaging.SAVE_TELEGRAM, async (ctx, token: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.saveTelegramToken(ctx.workspaceId, token)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.DISCONNECT, async (ctx, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.disconnectPlatform(ctx.workspaceId, platform)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.FORGET, async (ctx, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.forgetPlatform(ctx.workspaceId, platform)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.GET_BINDINGS, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.getBindings(ctx.workspaceId)
  })

  server.handle(RPC_CHANNELS.messaging.GENERATE_CODE, async (ctx, sessionId: string, platform: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return registry.generatePairingCode(ctx.workspaceId, sessionId, platform)
  })

  server.handle(RPC_CHANNELS.messaging.UNBIND, async (ctx, sessionId: string, platform?: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    registry.unbindSession(ctx.workspaceId, sessionId, platform)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.UNBIND_BINDING, async (ctx, bindingId: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    return { success: registry.unbindBinding(ctx.workspaceId, bindingId) }
  })

  server.handle(RPC_CHANNELS.messaging.WA_START_CONNECT, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.startWhatsAppConnect(ctx.workspaceId)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.messaging.WA_SUBMIT_PHONE, async (ctx, phoneNumber: string) => {
    if (!ctx.workspaceId) throw new Error('Missing workspaceId')
    await registry.submitWhatsAppPhone(ctx.workspaceId, phoneNumber)
    return { success: true }
  })
}
