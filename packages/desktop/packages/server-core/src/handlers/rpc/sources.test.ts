import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

let workspaceRoot = ''

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: () => ({
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: workspaceRoot,
  }),
}))

await import('@craft-agent/shared/agent')
const { registerSourcesHandlers } = await import('./sources')

function createSourcesHandlers() {
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

  const getPermissions = handlers.get(RPC_CHANNELS.sources.GET_PERMISSIONS)
  if (!getPermissions) {
    throw new Error('GET_PERMISSIONS handler not registered')
  }

  return { getPermissions, warnings, errors }
}

describe('source permissions RPC diagnostics', () => {
  it('logs invalid source slugs separately from permissions file read errors', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'source-rpc-permissions-'))
    try {
      const { getPermissions, warnings, errors } = createSourcesHandlers()

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
