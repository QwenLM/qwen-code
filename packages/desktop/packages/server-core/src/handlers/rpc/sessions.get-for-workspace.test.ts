import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

function createTestHarness() {
  const handlers = new Map<string, HandlerFn>()
  const calls: string[] = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
  }

  const sessionManager = {
    waitForInit: async () => {
      calls.push('waitForInit')
    },
    refreshExternalSessions: async (workspaceId?: string) => {
      calls.push(`refreshExternalSessions:${workspaceId ?? ''}`)
    },
    getSessions: (workspaceId?: string) => {
      calls.push(`getSessions:${workspaceId ?? ''}`)
      return [{ id: 's1', workspaceId, messages: [] }]
    },
  }

  const deps: HandlerDeps = {
    sessionManager: sessionManager as unknown as HandlerDeps['sessionManager'],
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

  registerSessionsHandlers(server, deps)

  const getForWorkspace = handlers.get(RPC_CHANNELS.sessions.GET_FOR_WORKSPACE)
  if (!getForWorkspace) {
    throw new Error('GET_FOR_WORKSPACE handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'current-workspace',
    webContentsId: 101,
  }

  return { getForWorkspace, ctx, calls }
}

describe('registerSessionsHandlers GET_FOR_WORKSPACE', () => {
  it('refreshes external provider sessions before returning workspace sessions', async () => {
    const { getForWorkspace, ctx, calls } = createTestHarness()

    const result = await getForWorkspace(ctx, 'target-workspace')

    expect(calls).toEqual([
      'waitForInit',
      'refreshExternalSessions:target-workspace',
      'getSessions:target-workspace',
    ])
    expect(result).toEqual([{ id: 's1', workspaceId: 'target-workspace', messages: [] }])
  })

  it('can return cached workspace sessions without waiting for external refresh', async () => {
    const { getForWorkspace, ctx, calls } = createTestHarness()

    const result = await getForWorkspace(ctx, 'target-workspace', { refreshExternal: false })

    expect(calls).toEqual([
      'waitForInit',
      'getSessions:target-workspace',
    ])
    expect(result).toEqual([{ id: 's1', workspaceId: 'target-workspace', messages: [] }])
  })
})
