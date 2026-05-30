import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  initializeWorkspaceSessionsAtom,
  addSessionAtom,
  updateSessionMetaAtom,
  removeSessionAtom,
  extractSessionMeta,
  compareSessionsByFlaggedThenActivityDesc,
  getWorkspaceSessionMetas,
  mergeStableSessionMetaList,
  workspaceSessionMetaCacheAtom,
  workspaceSessionsAtom,
} from '../sessions'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('extractSessionMeta', () => {
  it('keeps messageCount unknown for metadata-only sessions without an explicit count', () => {
    const meta = extractSessionMeta(makeSession({ messages: [] }))

    expect(meta.messageCount).toBeUndefined()
  })

  it('honors explicit zero messageCount for confirmed empty sessions', () => {
    const meta = extractSessionMeta(makeSession({ messages: [], messageCount: 0 }))

    expect(meta.messageCount).toBe(0)
  })

  it('derives messageCount from loaded messages when no explicit count exists', () => {
    const meta = extractSessionMeta(makeSession({
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))

    expect(meta.messageCount).toBe(2)
  })
})

describe('mergeStableSessionMetaList', () => {
  it('refreshes metadata and orders sessions by activity time', () => {
    const previous = [
      extractSessionMeta(makeSession({ id: 'old-a', lastMessageAt: 100 })),
      extractSessionMeta(makeSession({ id: 'old-b', lastMessageAt: 90 })),
    ]
    const incoming = [
      extractSessionMeta(makeSession({ id: 'newer', lastMessageAt: 1000 })),
      extractSessionMeta(makeSession({ id: 'old-b', lastMessageAt: 95, name: 'Updated B' })),
      extractSessionMeta(makeSession({ id: 'old-a', lastMessageAt: 110, name: 'Updated A' })),
    ]

    const merged = mergeStableSessionMetaList(previous, incoming)

    expect(merged.map(session => session.id)).toEqual(['newer', 'old-a', 'old-b'])
    expect(merged[1]?.name).toBe('Updated A')
    expect(merged[2]?.name).toBe('Updated B')
  })

  it('orders flagged sessions before unflagged sessions for display sorting', () => {
    const sessions = [
      extractSessionMeta(makeSession({ id: 'recent', lastMessageAt: 300 })),
      extractSessionMeta(makeSession({ id: 'flagged-old', lastMessageAt: 100, isFlagged: true })),
      extractSessionMeta(makeSession({ id: 'flagged-new', lastMessageAt: 200, isFlagged: true })),
    ]

    const sorted = [...sessions].sort(compareSessionsByFlaggedThenActivityDesc)

    expect(sorted.map(session => session.id)).toEqual(['flagged-new', 'flagged-old', 'recent'])
  })
})

describe('session message loading atoms', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('forceSessionMessagesReloadAtom reloads an empty-but-loaded session', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const normalResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(calls).toEqual([])
    expect(normalResult?.messages).toHaveLength(0)

    const forcedResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId])
    expect(forcedResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('does not mark stale empty-response fallback as loaded', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          if (calls.length === 1) {
            return makeSession({ id, messages: [] })
          }
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('local-1'), msg('local-2', 'assistant')],
    }))

    const firstResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(firstResult?.messages.map((message) => message.id)).toEqual(['local-1', 'local-2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)

    const secondResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId, sessionId])
    expect(secondResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('throws when the backend cannot provide messages for a non-empty session', async () => {
    const store = createStore()
    const sessionId = 'session-1'

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async () => null,
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [],
      messageCount: 2,
    }))

    let error: unknown
    try {
      await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)
  })

  it('marks metadata-empty sessions as loaded when the backend returns no payload', async () => {
    const store = createStore()
    const sessionId = 'session-1'

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async () => null,
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [],
      messageCount: 0,
    }))

    const result = await store.set(ensureSessionMessagesLoadedAtom, sessionId)

    expect(result?.id).toBe(sessionId)
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('does not trust a loaded flag when an existing-looking session has no messages in memory', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            name: 'Existing session',
            messageCount: 2,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      name: 'Existing session',
      messages: [],
      messageCount: 2,
    }))
    store.set(sessionMetaMapAtom, new Map([[
      sessionId,
      extractSessionMeta(makeSession({
        id: sessionId,
        name: 'Existing session',
        messages: [],
        messageCount: 2,
      })),
    ]]))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const result = await store.set(ensureSessionMessagesLoadedAtom, sessionId)

    expect(calls).toEqual([sessionId])
    expect(result?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('preserves an existing metadata title when loaded messages omit the name', async () => {
    const store = createStore()
    const sessionId = 'session-1'

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => makeSession({
          id,
          messages: [msg('m1'), msg('m2', 'assistant')],
          messageCount: 2,
        }),
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [],
      messageCount: 2,
    }))
    store.set(sessionMetaMapAtom, new Map([[
      sessionId,
      extractSessionMeta(makeSession({
        id: sessionId,
        name: 'Qwen generated title',
        messages: [],
        messageCount: 2,
      })),
    ]]))

    const result = await store.set(ensureSessionMessagesLoadedAtom, sessionId)

    expect(result?.name).toBe('Qwen generated title')
    expect(store.get(sessionAtomFamily(sessionId))?.name).toBe('Qwen generated title')
    expect(store.get(sessionMetaMapAtom).get(sessionId)?.name).toBe('Qwen generated title')
  })
})

describe('initializeSessionsAtom', () => {
  it('preserves already-loaded messages when reinitialized from metadata for the same workspace', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(sessionAtomFamily('s1'), makeSession({
      id: 's1',
      workspaceId: 'workspace-1',
      messages: existingMessages,
      name: 'Old title',
    }))
    store.set(sessionIdsAtom, ['s1'])
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(initializeSessionsAtom, [
      makeSession({
        id: 's1',
        workspaceId: 'workspace-1',
        messages: [],
        messageCount: 2,
        name: 'Fresh title',
      }),
    ])

    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(session?.name).toBe('Fresh title')
    expect(store.get(loadedSessionsAtom).has('s1')).toBe(true)
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('Fresh title')
  })

  it('does not preserve messages across different workspaces', () => {
    const store = createStore()

    store.set(sessionAtomFamily('s1'), makeSession({
      id: 's1',
      workspaceId: 'workspace-old',
      messages: [msg('old-message')],
    }))
    store.set(sessionIdsAtom, ['s1'])
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(initializeSessionsAtom, [
      makeSession({
        id: 's1',
        workspaceId: 'workspace-new',
        messages: [],
      }),
    ])

    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages).toEqual([])
    expect(session?.workspaceId).toBe('workspace-new')
    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('does not preserve messages when metadata confirms the session is empty', () => {
    const store = createStore()

    store.set(sessionAtomFamily('s1'), makeSession({
      id: 's1',
      messages: [msg('old-message')],
    }))
    store.set(sessionIdsAtom, ['s1'])
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(initializeSessionsAtom, [
      makeSession({
        id: 's1',
        messages: [],
        messageCount: 0,
      }),
    ])

    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages).toEqual([])
    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })
})

describe('initializeWorkspaceSessionsAtom', () => {
  it('keeps already-loaded sessions from other workspaces cached', () => {
    const store = createStore()
    const cachedMessages = [msg('cached')]

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({
          id: 'session-a',
          workspaceId: 'workspace-a',
          messages: cachedMessages,
        }),
      ],
    })

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-b'],
      sessions: [
        makeSession({
          id: 'session-b',
          workspaceId: 'workspace-b',
          messages: [],
        }),
      ],
    })

    expect(store.get(sessionMetaMapAtom).has('session-a')).toBe(true)
    expect(store.get(sessionMetaMapAtom).has('session-b')).toBe(true)
    expect(store.get(sessionAtomFamily('session-a'))?.messages.map(m => m.id)).toEqual(['cached'])
    expect(store.get(loadedSessionsAtom).has('session-a')).toBe(true)
  })

  it('removes stale sessions only from the refreshed workspace', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 'session-a1', workspaceId: 'workspace-a' }),
        makeSession({ id: 'session-a2', workspaceId: 'workspace-a' }),
      ],
    })
    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-b'],
      sessions: [
        makeSession({ id: 'session-b1', workspaceId: 'workspace-b' }),
      ],
    })

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 'session-a1', workspaceId: 'workspace-a' }),
      ],
    })

    expect(store.get(sessionMetaMapAtom).has('session-a1')).toBe(true)
    expect(store.get(sessionMetaMapAtom).has('session-a2')).toBe(false)
    expect(store.get(sessionMetaMapAtom).has('session-b1')).toBe(true)
  })

  it('keeps each workspace order in the workspace-scoped state', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 'a-old', workspaceId: 'workspace-a', lastMessageAt: 100 }),
        makeSession({ id: 'a-new', workspaceId: 'workspace-a', lastMessageAt: 200 }),
      ],
    })
    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-b'],
      sessions: [
        makeSession({ id: 'b-one', workspaceId: 'workspace-b', lastMessageAt: 500 }),
      ],
    })

    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['a-new', 'a-old'])
    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-b').map(session => session.id))
      .toEqual(['b-one'])
  })

  it('orders refreshed workspace metadata by activity time', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 'a-old', workspaceId: 'workspace-a', lastMessageAt: 100 }),
        makeSession({ id: 'a-new', workspaceId: 'workspace-a', lastMessageAt: 200 }),
      ],
    })

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 'a-added', workspaceId: 'workspace-a', lastMessageAt: 1000 }),
        makeSession({ id: 'a-old', workspaceId: 'workspace-a', lastMessageAt: 700, name: 'Updated old' }),
        makeSession({ id: 'a-new', workspaceId: 'workspace-a', lastMessageAt: 50 }),
      ],
    })

    const metas = getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a')
    expect(metas.map(session => session.id)).toEqual(['a-added', 'a-old', 'a-new'])
    expect(metas[1]?.name).toBe('Updated old')
  })

  it('updates workspace-scoped metadata without reordering existing sessions', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 's1', workspaceId: 'workspace-a', lastMessageAt: 200 }),
        makeSession({ id: 's2', workspaceId: 'workspace-a', lastMessageAt: 100 }),
      ],
    })

    store.set(updateSessionMetaAtom, 's2', { name: 'Updated S2', lastMessageAt: 999 })

    const metas = getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a')
    expect(metas.map(session => session.id)).toEqual(['s1', 's2'])
    expect(metas[1]?.name).toBe('Updated S2')
  })

  it('pins flagged workspace sessions above unflagged sessions without changing group order', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 's1', workspaceId: 'workspace-a', lastMessageAt: 300 }),
        makeSession({ id: 's2', workspaceId: 'workspace-a', lastMessageAt: 200, isFlagged: true }),
        makeSession({ id: 's3', workspaceId: 'workspace-a', lastMessageAt: 100, isFlagged: true }),
        makeSession({ id: 's4', workspaceId: 'workspace-a', lastMessageAt: 50 }),
      ],
    })

    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['s2', 's3', 's1', 's4'])

    store.set(updateSessionMetaAtom, 's4', { isFlagged: true })

    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['s2', 's3', 's4', 's1'])
  })

  it('adds new sessions to the front and removes them from all workspace states', () => {
    const store = createStore()

    store.set(initializeWorkspaceSessionsAtom, {
      workspaceIds: ['workspace-a'],
      sessions: [
        makeSession({ id: 's1', workspaceId: 'workspace-a', lastMessageAt: 200 }),
        makeSession({ id: 's2', workspaceId: 'workspace-a', lastMessageAt: 100 }),
      ],
    })

    store.set(addSessionAtom, makeSession({ id: 's3', workspaceId: 'workspace-a', lastMessageAt: 300 }))
    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['s3', 's1', 's2'])

    store.set(removeSessionAtom, 's1')
    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['s3', 's2'])
  })

  it('keeps the legacy workspace meta cache backed by workspaceSessionsAtom', () => {
    const store = createStore()
    const meta = extractSessionMeta(makeSession({ id: 'cached', workspaceId: 'workspace-a' }))

    store.set(workspaceSessionMetaCacheAtom, new Map([['workspace-a', [meta]]]))

    expect(getWorkspaceSessionMetas(store.get(workspaceSessionsAtom), 'workspace-a').map(session => session.id))
      .toEqual(['cached'])
  })
})

describe('refreshSessionsMetadataAtom', () => {
  it('preserves messages for already-loaded sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    // Pre-populate: session has messages and is marked loaded
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    // Refresh with metadata-only payload (empty messages, like getSessions returns)
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    // Messages should be preserved from the existing atom
    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('preserves existing messages even when loaded tracking is stale', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set<string>())

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', messages: [], messageCount: 2 })],
      loadedSessionIds: new Set<string>(),
    })

    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('marks sessions as unloaded when atom was cleared but loadedSessionIds still tracked them', () => {
    const store = createStore()

    // Session was previously loaded, but its atom was cleared (e.g., by remove + re-add)
    // while loadedSessionsAtom still tracks it. The atom value is null.
    store.set(loadedSessionsAtom, new Set(['s1']))
    // sessionAtomFamily('s1') defaults to null — no store.set needed

    // Refresh — s1 is in loadedSessionIds but current atom is null,
    // so shouldPreserveMessages is false. Since it was in loadedSessionIds,
    // it should be removed so lazy-loading re-fetches messages.
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('removes stale sessions from all atoms', () => {
    const store = createStore()

    // Initialize with two sessions via initializeSessionsAtom
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    expect(store.get(sessionMetaMapAtom).size).toBe(2)
    expect(store.get(sessionIdsAtom)).toContain('s2')

    // Refresh with only s1 — s2 should be removed
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1' })],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom).has('s2')).toBe(false)
    expect(store.get(sessionIdsAtom)).not.toContain('s2')
    expect(store.get(sessionAtomFamily('s2'))).toBe(null)
  })

  it('updates metadata map and returns it', () => {
    const store = createStore()

    const sessions = [
      makeSession({ id: 's1', name: 'First' }),
      makeSession({ id: 's2', name: 'Second' }),
    ]

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })

    // Returned map matches store state
    expect(result.size).toBe(2)
    expect(result.get('s1')?.name).toBe('First')
    expect(result.get('s2')?.name).toBe('Second')

    // Store is consistent
    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.size).toBe(2)
    expect(storeMap.get('s1')?.name).toBe('First')

    // IDs are set
    expect(store.get(sessionIdsAtom)).toHaveLength(2)
  })
})
