import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

let workspaceRoot = ''

const mockGetWorkspaceByNameOrId = mock((workspaceId: string) => ({
  id: workspaceId,
  name: 'Workspace',
  rootPath: workspaceRoot,
}))

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: mockGetWorkspaceByNameOrId,
}))

await import('@craft-agent/shared/agent')
const sharedSources = await import('@craft-agent/shared/sources')
const { registerSourcesHandlers } = await import('./sources')

function createHandlers() {
  const handlers = new Map<string, HandlerFn>()
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
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
        warn: (...args: unknown[]) => warnings.push(args),
        error: (...args: unknown[]) => errors.push(args),
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async (buffer: Buffer) => buffer,
      },
    },
  }

  registerSourcesHandlers(server, deps)

  return { handlers, warnings, errors }
}

describe('registerSourcesHandlers DELETE', () => {
  beforeEach(() => {
    mockGetWorkspaceByNameOrId.mockClear()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'source-rpc-delete-'))
  })

  it('marks invalid source slugs as invalid arguments', async () => {
    const { handlers } = createHandlers()
    const deleteSource = handlers.get(RPC_CHANNELS.sources.DELETE)
    if (!deleteSource) {
      throw new Error('DELETE source handler not registered')
    }
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
  })

  it('rethrows non-slug delete errors without marking them as invalid arguments', async () => {
    const underlyingError = new Error('disk failure')
    const deleteSpy = spyOn(sharedSources, 'deleteSource').mockImplementationOnce(() => {
      throw underlyingError
    })
    const { handlers } = createHandlers()
    const deleteSource = handlers.get(RPC_CHANNELS.sources.DELETE)
    if (!deleteSource) {
      throw new Error('DELETE source handler not registered')
    }
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    try {
      await deleteSource(ctx, 'workspace-1', 'valid-source')
      throw new Error('expected deleteSource to reject')
    } catch (error) {
      expect(error).toBe(underlyingError)
      expect((error as Error & { code?: string }).code).toBeUndefined()
    } finally {
      deleteSpy.mockRestore()
    }
  })
})

describe('source permissions RPC diagnostics', () => {
  it('logs invalid source slugs separately from permissions file read errors', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'source-rpc-permissions-'))
    try {
      const { handlers, warnings, errors } = createHandlers()

      const getPermissions = handlers.get(RPC_CHANNELS.sources.GET_PERMISSIONS)
      if (!getPermissions) {
        throw new Error('GET_PERMISSIONS handler not registered')
      }

      const result = await getPermissions(
        { clientId: 'c1', workspaceId: null, webContentsId: null },
        'workspace-1',
        '../sessions',
      )

      expect(result).toBeNull()
      expect(errors).toHaveLength(0)
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0]?.[0])).toBe('Invalid source slug for permissions:')
      expect(String(warnings[0]?.[1])).toBe('Invalid source slug: "../sessions"')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      workspaceRoot = ''
    }
  })
})
