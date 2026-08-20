/**
 * Session file watcher isolation tests.
 *
 * Verifies per-client watcher lifecycle: creation, cleanup, disconnect,
 * and that concurrent clients don't interfere with each other.
 *
 * Uses real temp directories + real fs.watch to avoid mocking fs
 * (which breaks transitive imports that need real fs exports).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { RpcServer, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { RPC_CHANNELS } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Electron mock (needed by transitive imports)
// ---------------------------------------------------------------------------

mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/', quit: () => {}, dock: { setIcon: () => {}, setBadge: () => {} } },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromDataURL: () => ({}) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: {},
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface PushCall {
  channel: string
  target: any
  args: any[]
}

let tempDirs: string[] = []

function makeTempSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-test-'))
  tempDirs.push(dir)
  return dir
}

function createTestHarness(sessionPaths: Map<string, string>) {
  const handlers = new Map<string, Function>()
  const pushCalls: PushCall[] = []

  const server: RpcServer = {
    handle(channel: string, handler: Function) {
      handlers.set(channel, handler as any)
    },
    push(channel: string, target: any, ...args: any[]) {
      pushCalls.push({ channel, target, args })
    },
    async invokeClient() {},
  }

  const deps: HandlerDeps = {
    sessionManager: {
      getSessionPath: (sessionId: string) => sessionPaths.get(sessionId) ?? null,
      waitForInit: async () => {},
      getSessions: () => [],
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store: () => {}, getByState: () => null, remove: () => {}, cleanup: () => {}, dispose: () => {}, size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }

  return { server, deps, handlers, pushCalls }
}

function makeCtx(clientId: string, workspaceId = 'ws-1'): RequestContext {
  return { clientId, workspaceId, webContentsId: null }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session file watcher isolation', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    tempDirs = []
  })

  it('creates independent watchers per client and cleans up on disconnect', async () => {
    const dir1 = makeTempSessionDir()
    const dir2 = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir1], ['s2', dir2]])
    const { server, deps, handlers, pushCalls } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@craft-agent/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!
    const unwatchHandler = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)!

    // Client A watches session s1, Client B watches session s2
    await watchHandler(makeCtx('client-a'), 's1')
    await watchHandler(makeCtx('client-b'), 's2')

    // Trigger a change in s1
    writeFileSync(join(dir1, 'output.txt'), 'hello')

    // Wait for debounce + fs.watch delay
    await new Promise(r => setTimeout(r, 300))

    // Only client-a should have received the notification
    const clientAPushes = pushCalls.filter(p => p.target?.clientId === 'client-a')
    const clientBPushes = pushCalls.filter(p => p.target?.clientId === 'client-b')
    expect(clientAPushes.length).toBeGreaterThanOrEqual(1)
    expect(clientBPushes.length).toBe(0)

    // Verify push target is client-specific, not broadcast
    expect(clientAPushes[0].channel).toBe(RPC_CHANNELS.sessions.FILES_CHANGED)
    expect(clientAPushes[0].target).toEqual({ to: 'client', clientId: 'client-a' })

    // Unwatch client A — should not affect client B
    await unwatchHandler(makeCtx('client-a'))

    // Clear push history
    pushCalls.length = 0

    // Trigger a change in s2
    writeFileSync(join(dir2, 'data.json'), '{}')
    await new Promise(r => setTimeout(r, 300))

    // Client B should still receive notifications
    const clientBAfter = pushCalls.filter(p => p.target?.clientId === 'client-b')
    expect(clientBAfter.length).toBeGreaterThanOrEqual(1)

    // Disconnect cleanup for client B
    cleanupSessionFileWatchForClient('client-b')

    // Double cleanup is a no-op (doesn't throw)
    cleanupSessionFileWatchForClient('client-b')
  })

  it('cleans up previous watcher when same client watches a different session', async () => {
    const dir1 = makeTempSessionDir()
    const dir2 = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir1], ['s2', dir2]])
    const { server, deps, handlers, pushCalls } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@craft-agent/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!

    // Client A watches s1
    await watchHandler(makeCtx('client-a'), 's1')

    // Client A switches to s2 — old watcher should be cleaned up
    await watchHandler(makeCtx('client-a'), 's2')

    // Write to s1 — should NOT trigger notification (old watcher closed)
    writeFileSync(join(dir1, 'old.txt'), 'stale')
    await new Promise(r => setTimeout(r, 300))

    const s1Pushes = pushCalls.filter(p =>
      p.args[0] === 's1' && p.channel === RPC_CHANNELS.sessions.FILES_CHANGED
    )
    expect(s1Pushes.length).toBe(0)

    // Write to s2 — should trigger notification
    writeFileSync(join(dir2, 'new.txt'), 'fresh')
    await new Promise(r => setTimeout(r, 300))

    const s2Pushes = pushCalls.filter(p =>
      p.args[0] === 's2' && p.channel === RPC_CHANNELS.sessions.FILES_CHANGED
    )
    expect(s2Pushes.length).toBeGreaterThanOrEqual(1)

    cleanupSessionFileWatchForClient('client-a')
  })

  it('ignores internal session.jsonl and hidden files', async () => {
    const dir = makeTempSessionDir()
    const sessionPaths = new Map([['s1', dir]])
    const { server, deps, handlers, pushCalls } = createTestHarness(sessionPaths)

    const { registerSessionsHandlers, cleanupSessionFileWatchForClient } = await import('@craft-agent/server-core/handlers/rpc')
    registerSessionsHandlers(server, deps)

    const watchHandler = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)!
    await watchHandler(makeCtx('client-a'), 's1')

    // Write internal files — should be ignored
    writeFileSync(join(dir, 'session.jsonl'), 'log entry')
    writeFileSync(join(dir, '.hidden'), 'secret')
    await new Promise(r => setTimeout(r, 300))

    expect(pushCalls.length).toBe(0)

    // Write a normal file — should trigger notification
    writeFileSync(join(dir, 'result.txt'), 'output')
    await new Promise(r => setTimeout(r, 300))

    expect(pushCalls.length).toBeGreaterThanOrEqual(1)

    cleanupSessionFileWatchForClient('client-a')
  })
})
