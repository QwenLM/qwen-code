import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import { registerSessionsHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []

  let tempRoot = ''
  let sessionDirA = ''
  let sessionDirB = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0

    tempRoot = mkdtempSync(join(tmpdir(), 'craft-session-watchers-'))
    sessionDirA = join(tempRoot, 'session-a')
    sessionDirB = join(tempRoot, 'session-b')
    mkdirSync(sessionDirA, { recursive: true })
    mkdirSync(sessionDirB, { recursive: true })

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push(channel, target, ...args) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
    }

    const deps: HandlerDeps = {
      sessionManager: {
        getSessionPath: (sessionId: string) => {
          if (sessionId === 'session-a') return sessionDirA
          if (sessionId === 'session-b') return sessionDirB
          return null
        },
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() { return 0 },
      } as unknown as HandlerDeps['oauthFlowStore'],
    }

    registerSessionsHandlers(server, deps)
  })

  afterEach(() => {
    cleanupSessionFileWatchForClient('client-a')
    cleanupSessionFileWatchForClient('client-b')
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('isolates file change notifications per client watcher', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: 'client-a' }, 'session-a')
    await watch!({ clientId: 'client-b' }, 'session-b')
    await wait(50)

    writeFileSync(join(sessionDirA, 'a.txt'), `a-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b-${Date.now()}`)
    await wait(300)

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === 'client-a')
    const bEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === 'client-b')

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-a')).toBe(true)
    expect(bEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: 'client-a' })

    writeFileSync(join(sessionDirA, 'a.txt'), `a2-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b2-${Date.now()}`)
    await wait(300)

    const aEventsAfter = pushed.filter((evt) => evt.target?.clientId === 'client-a')
    const bEventsAfter = pushed.filter((evt) => evt.target?.clientId === 'client-b')

    expect(aEventsAfter.length).toBe(0)
    expect(bEventsAfter.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)
  })

  it('disconnect cleanup removes watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: 'client-a' }, 'session-a')
    await wait(50)

    cleanupSessionFileWatchForClient('client-a')
    pushed.length = 0

    writeFileSync(join(sessionDirA, 'after-cleanup.txt'), `x-${Date.now()}`)
    await wait(300)

    expect(pushed.length).toBe(0)
  })
})
