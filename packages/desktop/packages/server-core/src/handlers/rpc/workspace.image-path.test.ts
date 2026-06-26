import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  addWorkspace: mock(() => null),
  setActiveWorkspace: mock(() => {}),
  updateWorkspaceRemoteServer: mock(() => {}),
}))

const { registerWorkspaceCoreHandlers } = await import('./workspace')

function createWorkspaceImageHandlers() {
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
        process: async (buffer: Buffer) => buffer,
      },
    },
  }

  registerWorkspaceCoreHandlers(server, deps)

  const readImage = handlers.get(RPC_CHANNELS.workspace.READ_IMAGE)
  const writeImage = handlers.get(RPC_CHANNELS.workspace.WRITE_IMAGE)

  if (!readImage || !writeImage) {
    throw new Error('workspace image handlers not registered')
  }

  return { readImage, writeImage }
}

describe('workspace image path boundaries', () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'qwen-workspace-image-'))
    workspaceRoot = join(rootDir, 'workspace')
    outsideDir = join(rootDir, 'outside')
    mkdirSync(workspaceRoot)
    mkdirSync(outsideDir)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    workspaceRoot = ''
  })

  it('returns null for missing optional images inside the workspace', async () => {
    const { readImage } = createWorkspaceImageHandlers()

    await expect(readImage({ clientId: 'c1', workspaceId: null, webContentsId: null }, 'workspace-1', 'missing.svg')).resolves.toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects image reads that escape through a symlink', async () => {
    const outsideImage = join(outsideDir, 'icon.svg')
    writeFileSync(outsideImage, '<svg></svg>')
    symlinkSync(outsideImage, join(workspaceRoot, 'icon.svg'), 'file')

    const { readImage } = createWorkspaceImageHandlers()

    await expect(readImage({ clientId: 'c1', workspaceId: null, webContentsId: null }, 'workspace-1', 'icon.svg')).rejects.toThrow(
      'outside workspace directory',
    )
  })

  it('rejects image writes that escape through a symlinked parent directory', async () => {
    const outsideImage = join(outsideDir, 'icon.svg')
    symlinkSync(outsideDir, join(workspaceRoot, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')

    const { writeImage } = createWorkspaceImageHandlers()

    await expect(
      writeImage(
        { clientId: 'c1', workspaceId: null, webContentsId: null },
        'workspace-1',
        'linked-outside/icon.svg',
        Buffer.from('<svg></svg>').toString('base64'),
        'image/svg+xml',
      ),
    ).rejects.toThrow('outside workspace directory')

    expect(existsSync(outsideImage)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects image writes through a broken final symlink', async () => {
    const outsideImage = join(outsideDir, 'created.svg')
    symlinkSync(outsideImage, join(workspaceRoot, 'icon.svg'), 'file')

    const { writeImage } = createWorkspaceImageHandlers()

    await expect(
      writeImage(
        { clientId: 'c1', workspaceId: null, webContentsId: null },
        'workspace-1',
        'icon.svg',
        Buffer.from('<svg></svg>').toString('base64'),
        'image/svg+xml',
      ),
    ).rejects.toThrow('outside workspace directory')

    expect(existsSync(outsideImage)).toBe(false)
  })

  it('allows overwriting an image when the workspace root is a symlink', async () => {
    const linkedWorkspaceRoot = join(rootDir, 'workspace-link')
    symlinkSync(workspaceRoot, linkedWorkspaceRoot, process.platform === 'win32' ? 'junction' : 'dir')
    workspaceRoot = linkedWorkspaceRoot

    const realImage = join(rootDir, 'workspace', 'icon.svg')
    writeFileSync(realImage, '<svg>old</svg>')

    const { writeImage } = createWorkspaceImageHandlers()

    await writeImage(
      { clientId: 'c1', workspaceId: null, webContentsId: null },
      'workspace-1',
      'icon.svg',
      Buffer.from('<svg>new</svg>').toString('base64'),
      'image/svg+xml',
    )

    expect(readFileSync(realImage, 'utf8')).toBe('<svg>new</svg>')
  })
})
