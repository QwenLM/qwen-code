import { afterEach, describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, StoredSession } from '../types'
import {
  getHeaderMetadataSignature,
  mergeHeaderWithExternalMetadata,
  SessionPersistenceQueue,
  type SessionPersistenceWriter,
} from '../persistence-queue'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
})

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 's1',
    workspaceRootPath: '~/.craft-agent/workspaces/ws',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
    ...overrides,
  }
}

function makeSession(name: string): StoredSession {
  return {
    id: 'serialized-session',
    name,
    workspaceRootPath: '/unused-by-deferred-writer',
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

function createDeferredWriter() {
  const started: StoredSession[] = []
  const completed: StoredSession[] = []
  const releases: Array<() => void> = []
  let active = 0
  let maxActive = 0
  const writer: SessionPersistenceWriter = async (session) => {
    started.push(session)
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active -= 1
    completed.push(session)
  }
  return {
    writer,
    started,
    completed,
    releases,
    get maxActive() {
      return maxActive
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for persistence writer')
}

describe('session persistence header conflict helpers', () => {
  it('uses the configured session writer', async () => {
    const deferred = createDeferredWriter()
    const queue = new SessionPersistenceQueue(0, deferred.writer)
    queue.enqueue(makeSession('candidate'))

    await waitFor(() => deferred.started.length === 1)
    deferred.releases[0]?.()
    await queue.flushAll()

    expect(deferred.completed.map((session) => session.name)).toEqual([
      'candidate',
    ])
  })

  it('serializes timer and strict writes and leaves the strict candidate last', async () => {
    const deferred = createDeferredWriter()
    const queue = new SessionPersistenceQueue(0, deferred.writer)
    queue.enqueue(makeSession('timer'))
    await waitFor(() => deferred.started.length === 1)

    queue.enqueue(makeSession('strict'))
    const strictFlush = queue.flushOrThrow('serialized-session')
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(deferred.maxActive).toBe(1)

    deferred.releases[0]?.()
    await waitFor(() => deferred.started.length === 2)
    deferred.releases[1]?.()
    await strictFlush

    expect(deferred.maxActive).toBe(1)
    expect(deferred.completed.map((session) => session.name)).toEqual([
      'timer',
      'strict',
    ])
  })

  it('waits for timer-started in-flight writes when flushing all', async () => {
    const deferred = createDeferredWriter()
    const queue = new SessionPersistenceQueue(0, deferred.writer)
    queue.enqueue(makeSession('timer'))
    await waitFor(() => deferred.started.length === 1)

    let flushed = false
    const flushAll = queue.flushAll().then(() => {
      flushed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(flushed).toBe(false)

    deferred.releases[0]?.()
    await flushAll
    expect(flushed).toBe(true)
  })

  it('reports the strict candidate error after an earlier best-effort failure', async () => {
    const attempts: string[] = []
    const writer: SessionPersistenceWriter = async (session) => {
      attempts.push(session.name ?? '')
      throw new Error(`${session.name} failed`)
    }
    const queue = new SessionPersistenceQueue(0, writer)
    queue.enqueue(makeSession('timer'))
    await waitFor(() => attempts.length === 1)

    queue.enqueue(makeSession('strict'))
    await expect(queue.flushOrThrow('serialized-session')).rejects.toThrow(
      'strict failed',
    )
    expect(attempts).toEqual(['timer', 'strict'])
  })

  it('lets strict flush observe a timer-started in-flight failure', async () => {
    let rejectWriter: ((error: Error) => void) | undefined
    let started = false
    const writer: SessionPersistenceWriter = async () => {
      started = true
      await new Promise<void>((_resolve, reject) => {
        rejectWriter = reject
      })
    }
    const queue = new SessionPersistenceQueue(0, writer)
    queue.enqueue(makeSession('timer'))
    await waitFor(() => started)

    const strictFlush = queue.flushOrThrow('serialized-session')
    rejectWriter?.(new Error('timer write failed'))

    await expect(strictFlush).rejects.toThrow('timer write failed')
  })

  it('keeps flush and flushAll best-effort for timer-started failures', async () => {
    for (const boundary of ['flush', 'flushAll'] as const) {
      let rejectWriter: ((error: Error) => void) | undefined
      let started = false
      const writer: SessionPersistenceWriter = async () => {
        started = true
        await new Promise<void>((_resolve, reject) => {
          rejectWriter = reject
        })
      }
      const queue = new SessionPersistenceQueue(0, writer)
      queue.enqueue(makeSession('timer'))
      await waitFor(() => started)

      const bestEffort =
        boundary === 'flush'
          ? queue.flush('serialized-session')
          : queue.flushAll()
      rejectWriter?.(new Error(`${boundary} timer write failed`))

      await expect(bestEffort).resolves.toBeUndefined()
    }
  })

  it('metadata signature ignores non-metadata fields', () => {
    const a = makeHeader({ name: 'A', lastUsedAt: 100 })
    const b = makeHeader({ name: 'A', lastUsedAt: 999, messageCount: 42 })

    expect(getHeaderMetadataSignature(a)).toBe(getHeaderMetadataSignature(b))
  })

  it('offers an observable strict flush without changing best-effort flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persistence-strict-flush-'))
    tempRoots.push(root)
    const invalidWorkspaceRoot = join(root, 'workspace-file')
    writeFileSync(invalidWorkspaceRoot, 'not a directory')
    const session = {
      id: 'goal-session',
      workspaceRootPath: invalidWorkspaceRoot,
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession

    const strictQueue = new SessionPersistenceQueue(60_000)
    strictQueue.enqueue(session)
    await expect(strictQueue.flushOrThrow(session.id)).rejects.toThrow()

    const bestEffortQueue = new SessionPersistenceQueue(60_000)
    bestEffortQueue.enqueue(session)
    await expect(bestEffortQueue.flush(session.id)).resolves.toBeUndefined()
  })

  it('metadata signature changes when metadata changes', () => {
    const a = makeHeader({ name: 'A', labels: ['x'] })
    const b = makeHeader({ name: 'B', labels: ['x'] })

    expect(getHeaderMetadataSignature(a)).not.toBe(
      getHeaderMetadataSignature(b),
    )
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      sessionStatus: 'todo',
      hasUnread: true,
      lastReadMessageId: 'm-local',
      messageCount: 99,
      lastUsedAt: 500,
    })

    const disk = makeHeader({
      name: 'Disk Name',
      labels: ['disk'],
      isFlagged: true,
      sessionStatus: 'needs-review',
      permissionMode: 'safe',
      hasUnread: false,
      lastReadMessageId: 'm-disk',
      messageCount: 1,
      lastUsedAt: 50,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.name).toBe('Disk Name')
    expect(merged.labels).toEqual(['disk'])
    expect(merged.isFlagged).toBe(true)
    expect(merged.sessionStatus).toBe('needs-review')
    expect(merged.permissionMode).toBeUndefined()
    expect(merged.hasUnread).toBe(false)
    expect(merged.lastReadMessageId).toBe('m-disk')

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
  })

  it('startup scenario: external metadata differs from local signature', () => {
    const local = makeHeader({ name: 'Local Name', labels: ['local'] })
    const disk = makeHeader({ name: 'External Name', labels: ['external'] })

    const localSig = getHeaderMetadataSignature(local)
    const diskSig = getHeaderMetadataSignature(disk)

    // This is the condition used by persistence queue at startup:
    // no previousSig yet, disk differs from local → preserve external metadata.
    const previousSig: string | undefined = undefined
    const hasExternalMetadataChange =
      diskSig !== localSig &&
      (previousSig === undefined || diskSig !== previousSig)

    expect(hasExternalMetadataChange).toBe(true)

    const merged = mergeHeaderWithExternalMetadata(local, disk)
    expect(merged.name).toBe('External Name')
    expect(merged.labels).toEqual(['external'])
  })
})
