import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport'
import { registerSystemCoreHandlers } from './system'

function createGetGitBranchHandler() {
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

  registerSystemCoreHandlers(server, deps)

  const handler = handlers.get(RPC_CHANNELS.git.GET_BRANCH)
  if (!handler) {
    throw new Error('GET_BRANCH handler not registered')
  }
  return handler
}

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

describe('registerSystemCoreHandlers GET_BRANCH', () => {
  it('returns the current branch name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-git-branch-'))
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }
    try {
      git(dir, 'init -b feature/test-branch')
      git(dir, 'config user.name Test')
      git(dir, 'config user.email test@example.com')
      git(dir, 'commit --allow-empty -m initial')

      const getGitBranch = createGetGitBranchHandler()

      await expect(getGitBranch(ctx, dir)).resolves.toBe('feature/test-branch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for detached HEAD', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-git-branch-'))
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }
    try {
      git(dir, 'init')
      git(dir, 'config user.name Test')
      git(dir, 'config user.email test@example.com')
      git(dir, 'commit --allow-empty -m initial')
      const commit = git(dir, 'rev-parse HEAD')
      git(dir, `checkout --detach ${commit}`)

      const getGitBranch = createGetGitBranchHandler()

      await expect(getGitBranch(ctx, dir)).resolves.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
