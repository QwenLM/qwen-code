import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { CLIENT_OPEN_EXTERNAL } from '@craft-agent/server-core/transport'
import type { RpcServer, HandlerFn, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSystemCoreHandlers } from './system'

function createTestHarness(overrides?: { workspaceId?: string | null }) {
  const handlers = new Map<string, HandlerFn>()
  const invokeClientCalls: Array<{ clientId: string; channel: string; args: any[] }> = []
  const pushCalls: Array<{ channel: string; target: any; args: any[] }> = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args })
    },
    async invokeClient(clientId, channel, ...args) {
      invokeClientCalls.push({ clientId, channel, args })
      return undefined
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }

  registerSystemCoreHandlers(server, deps)

  const openUrl = handlers.get(RPC_CHANNELS.shell.OPEN_URL)
  if (!openUrl) {
    throw new Error('OPEN_URL handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: overrides?.workspaceId ?? 'ws-1',
    webContentsId: 101,
  }

  return { openUrl, ctx, invokeClientCalls, pushCalls }
}

describe('registerSystemCoreHandlers OPEN_URL', () => {
  it('routes craftagents action links internally via deeplink:navigate', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'craftagents://action/new-session?input=sg&send=true')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'client', clientId: 'client-1' },
      args: [{ action: 'new-session', actionParams: { input: 'sg', send: 'true' } }],
    })
  })

  it('routes workspace deep links to workspace target when URL workspace differs', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness({ workspaceId: 'ws-1' })

    await openUrl(ctx, 'craftagents://workspace/ws-2/action/new-session?input=hello')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'workspace', workspaceId: 'ws-2' },
      args: [{ action: 'new-session', actionParams: { input: 'hello' } }],
    })
  })

  it('falls back to client openExternal for craftagents window-mode links', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'craftagents://action/new-session?window=focused')

    expect(pushCalls).toHaveLength(0)
    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['craftagents://action/new-session?window=focused'],
    })
  })

  it('keeps forwarding normal http URLs via client openExternal', async () => {
    const { openUrl, ctx, invokeClientCalls } = createTestHarness()

    await openUrl(ctx, 'https://example.com')

    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['https://example.com'],
    })
  })

  it('rejects unsupported protocols', async () => {
    const { openUrl, ctx } = createTestHarness()

    await expect(openUrl(ctx, 'file:///tmp/test.txt')).rejects.toThrow(
      'Failed to open URL: Only http, https, mailto, craftdocs, craftagents URLs are allowed'
    )
  })
})
