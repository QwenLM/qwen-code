import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const mockGetWorkspaceByNameOrId = mock((workspaceId: string) => ({
  id: workspaceId,
  rootPath: mkdtempSync(join(tmpdir(), 'source-rpc-delete-')),
}))

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: mockGetWorkspaceByNameOrId,
}))

import { registerSourcesHandlers } from './sources'

function createDeleteSourceHandler() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
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

  registerSourcesHandlers(server, deps)

  const handler = handlers.get(RPC_CHANNELS.sources.DELETE)
  if (!handler) {
    throw new Error('DELETE source handler not registered')
  }
  return handler
}

describe('registerSourcesHandlers DELETE', () => {
  beforeEach(() => {
    mockGetWorkspaceByNameOrId.mockClear()
  })

  it('marks invalid source slugs as invalid arguments', async () => {
    const deleteSource = createDeleteSourceHandler()
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    try {
      await deleteSource(ctx, 'workspace-1', '../sessions')
      throw new Error('expected deleteSource to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Invalid source slug: "../sessions"')
      expect((error as Error & { code?: string }).code).toBe('INVALID_ARGUMENT')
    }

    const workspace = mockGetWorkspaceByNameOrId.mock.results[0]?.value as
      | { rootPath?: string }
      | undefined
    if (workspace?.rootPath) {
      rmSync(workspace.rootPath, { recursive: true, force: true })
    }
  })
})
