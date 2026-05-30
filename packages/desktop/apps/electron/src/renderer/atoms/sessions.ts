/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */

import { atom } from 'jotai'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
import type { Session, Message } from '../../shared/types'
import { hasSessionContentHint } from '../lib/session-load'

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  workspaceId: string
  /** Last time the session was opened or persisted. Used only as a fallback for legacy sessions without lastMessageAt. */
  lastUsedAt?: number
  lastMessageAt?: number
  isProcessing?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** Permission mode — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  /** Model override for this session */
  model?: string
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
}

type SessionOrderFields = {
  id: string
  lastMessageAt?: number
  lastUsedAt?: number
  createdAt?: number
}

type SessionFlagFields = {
  isFlagged?: boolean
}

export function getSessionOrderTime(session: SessionOrderFields): number {
  return session.lastMessageAt ?? session.lastUsedAt ?? session.createdAt ?? 0
}

export function compareSessionsByActivityDesc(a: SessionOrderFields, b: SessionOrderFields): number {
  const byTime = getSessionOrderTime(b) - getSessionOrderTime(a)
  if (byTime !== 0) return byTime

  const byCreatedAt = (b.createdAt ?? 0) - (a.createdAt ?? 0)
  if (byCreatedAt !== 0) return byCreatedAt

  return a.id.localeCompare(b.id)
}

export function compareSessionsByFlaggedThenActivityDesc<T extends SessionOrderFields & SessionFlagFields>(a: T, b: T): number {
  const byFlagged = Number(Boolean(b.isFlagged)) - Number(Boolean(a.isFlagged))
  if (byFlagged !== 0) return byFlagged

  return compareSessionsByActivityDesc(a, b)
}

export function prioritizeFlaggedSessions<T extends SessionFlagFields>(sessions: T[]): T[] {
  const flagged: T[] = []
  const unflagged: T[] = []

  for (const session of sessions) {
    if (session.isFlagged) {
      flagged.push(session)
    } else {
      unflagged.push(session)
    }
  }

  return [...flagged, ...unflagged]
}

export function mergeStableSessionMetaList(previous: SessionMeta[] | undefined, incoming: SessionMeta[]): SessionMeta[] {
  if (!previous || previous.length === 0) {
    return [...incoming].sort(compareSessionsByActivityDesc)
  }

  const incomingById = new Map(incoming.map(session => [session.id, session]))
  const previouslySeen = previous
    .map(session => incomingById.get(session.id))
    .filter((session): session is SessionMeta => !!session)
  const previousIds = new Set(previous.map(session => session.id))
  const added = incoming.filter(session => !previousIds.has(session.id))

  return [...previouslySeen, ...added].sort(compareSessionsByActivityDesc)
}

function areSessionMetasShallowEqual(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true

  const aKeys = Object.keys(a) as Array<keyof SessionMeta>
  const bKeys = Object.keys(b) as Array<keyof SessionMeta>
  if (aKeys.length !== bKeys.length) return false

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export function areSessionMetaListsEquivalent(a: SessionMeta[] | undefined, b: SessionMeta[]): boolean {
  if (!a || a.length !== b.length) return false

  for (let index = 0; index < a.length; index += 1) {
    if (!areSessionMetasShallowEqual(a[index]!, b[index]!)) return false
  }

  return true
}

export function sessionFromMeta(meta: SessionMeta, workspaceName = ''): Session {
  return {
    ...meta,
    workspaceName,
    lastMessageAt: getSessionOrderTime(meta),
    messages: [],
    isProcessing: meta.isProcessing ?? false,
  } as Session
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

function resolveMessageCount(sessionMessageCount: number | undefined, messages: Message[]): number | undefined {
  if (sessionMessageCount != null) return sessionMessageCount
  return messages.length > 0 ? messages.length : undefined
}

function shouldPreserveExistingMessages(currentSession: Session | null | undefined, nextSession: Session): currentSession is Session {
  return !!currentSession
    && currentSession.workspaceId === nextSession.workspaceId
    && (currentSession.messages?.length ?? 0) > 0
    && (nextSession.messages?.length ?? 0) === 0
    && nextSession.messageCount !== 0
}

function mergeSessionWithoutDroppingMessages(currentSession: Session | null | undefined, nextSession: Session): Session {
  const nextSessionWithTitle = currentSession?.name && !nextSession.name
    ? { ...nextSession, name: currentSession.name }
    : nextSession

  if (!shouldPreserveExistingMessages(currentSession, nextSessionWithTitle)) {
    return nextSessionWithTitle
  }

  return {
    ...nextSessionWithTitle,
    messages: currentSession.messages,
  }
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    messageCount: resolveMessageCount(messageCount, messages),
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  } as SessionMeta
}

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Workspace-scoped session state. This is the source used by the project tree
 * and workspace switcher so each workspace keeps its own metadata and order in
 * memory instead of relying on the currently selected workspace's flat list.
 */
export interface WorkspaceSessionState {
  sessionMetaMap: Map<string, SessionMeta>
  sessionOrder: string[]
  loadedAt?: number
  isRefreshing?: boolean
  error?: string
}

export const workspaceSessionsAtom = atom<Map<string, WorkspaceSessionState>>(new Map())

export function getWorkspaceSessionMetas(
  workspaceSessions: Map<string, WorkspaceSessionState>,
  workspaceId: string | null | undefined,
): SessionMeta[] {
  if (!workspaceId) return []

  const state = workspaceSessions.get(workspaceId)
  if (!state) return []

  const ordered = state.sessionOrder
    .map(sessionId => state.sessionMetaMap.get(sessionId))
    .filter((session): session is SessionMeta => Boolean(session))

  const orderedIds = new Set(ordered.map(session => session.id))
  const missingOrderedSessions = Array.from(state.sessionMetaMap.values())
    .filter(session => !orderedIds.has(session.id))
    .sort(compareSessionsByActivityDesc)

  return prioritizeFlaggedSessions([...ordered, ...missingOrderedSessions])
}

function workspaceStateFromMetas(
  previousState: WorkspaceSessionState | undefined,
  incomingMetas: SessionMeta[],
): WorkspaceSessionState {
  const previousMetas = previousState ? getWorkspaceSessionMetas(new Map([['workspace', previousState]]), 'workspace') : undefined
  const mergedMetas = mergeStableSessionMetaList(previousMetas, incomingMetas)

  if (previousState && areSessionMetaListsEquivalent(previousMetas, mergedMetas)) {
    return previousState
  }

  return {
    ...previousState,
    sessionMetaMap: new Map(mergedMetas.map(session => [session.id, session])),
    sessionOrder: mergedMetas.map(session => session.id),
    loadedAt: Date.now(),
    error: undefined,
  }
}

function upsertWorkspaceSessionMeta(
  previousState: WorkspaceSessionState | undefined,
  meta: SessionMeta,
  position: 'preserve' | 'front' = 'preserve',
): WorkspaceSessionState {
  const previousMap = previousState?.sessionMetaMap ?? new Map<string, SessionMeta>()
  const previousMeta = previousMap.get(meta.id)
  const nextMap = new Map(previousMap)
  nextMap.set(meta.id, meta)

  const previousOrder = previousState?.sessionOrder ?? []
  let nextOrder: string[]
  if (position === 'front') {
    nextOrder = [meta.id, ...previousOrder.filter(id => id !== meta.id)]
  } else if (previousOrder.includes(meta.id)) {
    nextOrder = previousOrder
  } else {
    nextOrder = [...previousOrder, meta.id]
  }

  const nextState: WorkspaceSessionState = {
    ...previousState,
    sessionMetaMap: nextMap,
    sessionOrder: nextOrder,
  }

  if (
    previousState &&
    previousMeta &&
    areSessionMetasShallowEqual(previousMeta, meta) &&
    previousOrder.length === nextOrder.length &&
    previousOrder.every((id, index) => id === nextOrder[index])
  ) {
    return previousState
  }

  return nextState
}

function setWorkspaceState(
  get: Getter,
  set: Setter,
  workspaceId: string | null | undefined,
  incomingMetas: SessionMeta[],
): void {
  if (!workspaceId) return

  const current = get(workspaceSessionsAtom)
  const previousState = current.get(workspaceId)
  const nextState = workspaceStateFromMetas(previousState, incomingMetas)
  if (nextState === previousState) return

  const next = new Map(current)
  next.set(workspaceId, nextState)
  set(workspaceSessionsAtom, next)
}

function upsertMetaInWorkspaceState(
  get: Getter,
  set: Setter,
  meta: SessionMeta,
  position: 'preserve' | 'front' = 'preserve',
): void {
  if (!meta.workspaceId) return

  const current = get(workspaceSessionsAtom)
  const previousState = current.get(meta.workspaceId)
  const nextState = upsertWorkspaceSessionMeta(previousState, meta, position)
  if (nextState === previousState) return

  const next = new Map(current)
  next.set(meta.workspaceId, nextState)
  set(workspaceSessionsAtom, next)
}

function removeMetaFromWorkspaceStates(get: Getter, set: Setter, sessionId: string): void {
  const current = get(workspaceSessionsAtom)
  let changed = false
  const next = new Map(current)

  for (const [workspaceId, state] of current) {
    if (!state.sessionMetaMap.has(sessionId)) continue

    const sessionMetaMap = new Map(state.sessionMetaMap)
    sessionMetaMap.delete(sessionId)
    next.set(workspaceId, {
      ...state,
      sessionMetaMap,
      sessionOrder: state.sessionOrder.filter(id => id !== sessionId),
    })
    changed = true
  }

  if (changed) {
    set(workspaceSessionsAtom, next)
  }
}

function removeWorkspaceScopedMetas(
  get: Getter,
  set: Setter,
  workspaceIdSet: Set<string>,
  keepSessionIds: Set<string>,
): void {
  const current = get(workspaceSessionsAtom)
  let changed = false
  const next = new Map(current)

  for (const [workspaceId, state] of current) {
    let stateChanged = false
    const sessionMetaMap = new Map(state.sessionMetaMap)
    for (const [sessionId, meta] of state.sessionMetaMap) {
      if (!workspaceIdSet.has(meta.workspaceId) || keepSessionIds.has(sessionId)) continue
      sessionMetaMap.delete(sessionId)
      stateChanged = true
    }

    if (stateChanged) {
      next.set(workspaceId, {
        ...state,
        sessionMetaMap,
        sessionOrder: state.sessionOrder.filter(id => sessionMetaMap.has(id)),
      })
      changed = true
    }
  }

  if (changed) {
    set(workspaceSessionsAtom, next)
  }
}

type WorkspaceSessionMetaCacheUpdate =
  | Map<string, SessionMeta[]>
  | ((previous: Map<string, SessionMeta[]>) => Map<string, SessionMeta[]>)

/**
 * Backward-compatible workspace metadata view. New code should prefer
 * workspaceSessionsAtom, but existing callers can keep reading/writing the
 * Map<workspaceId, SessionMeta[]> shape while it is backed by the richer state.
 */
export const workspaceSessionMetaCacheAtom = atom(
  (get) => {
    const workspaceSessions = get(workspaceSessionsAtom)
    const cache = new Map<string, SessionMeta[]>()
    for (const [workspaceId] of workspaceSessions) {
      cache.set(workspaceId, getWorkspaceSessionMetas(workspaceSessions, workspaceId))
    }
    return cache
  },
  (get, set, update: WorkspaceSessionMetaCacheUpdate) => {
    const previousCache = get(workspaceSessionMetaCacheAtom)
    const nextCache = typeof update === 'function' ? update(previousCache) : update
    if (nextCache === previousCache) return

    const current = get(workspaceSessionsAtom)
    const next = new Map(current)
    let changed = false

    for (const [workspaceId, sessions] of nextCache) {
      const previousState = current.get(workspaceId)
      const nextState = workspaceStateFromMetas(previousState, sessions)
      if (nextState !== previousState) {
        next.set(workspaceId, nextState)
        changed = true
      }
    }

    for (const workspaceId of current.keys()) {
      if (!nextCache.has(workspaceId)) {
        next.delete(workspaceId)
        changed = true
      }
    }

    if (changed) {
      set(workspaceSessionsAtom, next)
    }
  },
)

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

function markSessionMessagesLoaded(get: Getter, set: Setter, sessionId: string): void {
  const newLoadedSessions = new Set(get(loadedSessionsAtom))
  newLoadedSessions.add(sessionId)
  set(loadedSessionsAtom, newLoadedSessions)
}

/**
 * Currently active session ID - the session displayed in the main content area
 * This replaces the tab-based session selection
 */
export const activeSessionIdAtom = atom<string | null>(null)

// NOTE: sessionsAtom REMOVED to fix memory leak
// The sessions array with messages was being retained by Jotai's internal state.
// Instead, we now use:
// - sessionMetaMapAtom for listing (lightweight metadata, no messages)
// - sessionAtomFamily(id) for individual session data
// - initializeSessionsAtom for bulk initialization
// - addSessionAtom, removeSessionAtom for individual operations

/**
 * Action atom: update a single session
 * Only triggers re-render in components subscribed to this specific session
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    const existingMeta = get(sessionMetaMapAtom).get(sessionId)
    const existingTitle = currentSession?.name ?? existingMeta?.name
    const nextSession = newSession && !newSession.name && existingTitle
      ? { ...newSession, name: existingTitle }
      : newSession
    set(sessionAtom, nextSession)

    // Also update metadata if session exists
    if (nextSession) {
      const metaMap = get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      const meta = extractSessionMeta(nextSession)
      newMetaMap.set(sessionId, meta)
      set(sessionMetaMapAtom, newMetaMap)
      upsertMetaInWorkspaceState(get, set, meta)
    }
  }
)

/**
 * Action atom: update only session metadata (for list display updates)
 * Doesn't affect the full session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const nextMeta = { ...existing, ...updates }
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, nextMeta)
      set(sessionMetaMapAtom, newMetaMap)
      upsertMetaInWorkspaceState(get, set, nextMeta)
    }
  }
)

/**
 * Action atom: append message to session (for streaming)
 * Optimized to only update the specific session
 * Note: Does NOT update lastMessageAt - caller must handle timestamp updates
 * to avoid session list jumping on intermediate/tool messages
 */
export const appendMessageAtom = atom(
  null,
  (get, set, sessionId: string, message: Message) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (session) {
      set(sessionAtom, {
        ...session,
        messages: [...session.messages, message],
        // Don't update lastMessageAt here - only user messages and final responses should update it
      })
    }
  }
)

/**
 * Action atom: update streaming content for a session
 * For text_delta events - appends to the last streaming message
 */
export const updateStreamingContentAtom = atom(
  null,
  (get, set, sessionId: string, content: string, turnId?: string) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (!session) return

    const messages = [...session.messages]
    const lastMsg = messages[messages.length - 1]

    // Append to existing streaming message
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming &&
        (!turnId || lastMsg.turnId === turnId)) {
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + content,
      }
      set(sessionAtom, { ...session, messages })
    }
  }
)

/**
 * Action atom: initialize sessions from loaded data
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    const previousLoadedSessions = get(loadedSessionsAtom)

    // Clean up stale atom family entries from previous workspace.
    // Without this, switching workspaces leaves orphaned atoms in memory
    // and components subscribed to old session IDs see stale/empty data.
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set(sessions.map(s => s.id))
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
        backgroundTasksAtomFamily.remove(oldId)
      }
    }

    const nextLoadedSessions = new Set<string>()

    // Set individual session atoms. getSessions() returns metadata-only
    // payloads, so preserve any already-loaded messages for sessions that are
    // still present in the same workspace.
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const nextSession = mergeSessionWithoutDroppingMessages(currentSession, session)
      set(sessionAtomFamily(session.id), nextSession)

      const hasMessages = (nextSession.messages?.length ?? 0) > 0
      const incomingHadMessages = (session.messages?.length ?? 0) > 0
      if (incomingHadMessages || (previousLoadedSessions.has(session.id) && hasMessages)) {
        nextLoadedSessions.add(session.id)
      }
    }
    set(loadedSessionsAtom, nextLoadedSessions)

    // Build metadata map
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    const workspaceStates = new Map<string, WorkspaceSessionState>()
    const metasByWorkspace = new Map<string, SessionMeta[]>()
    for (const meta of metaMap.values()) {
      if (!meta.workspaceId) continue
      const workspaceMetas = metasByWorkspace.get(meta.workspaceId) ?? []
      workspaceMetas.push(meta)
      metasByWorkspace.set(meta.workspaceId, workspaceMetas)
    }
    for (const [workspaceId, metas] of metasByWorkspace) {
      workspaceStates.set(workspaceId, workspaceStateFromMetas(undefined, metas))
    }
    set(workspaceSessionsAtom, workspaceStates)

    // Set ordered IDs (sorted by lastMessageAt desc)
    const ids = sessions
      .sort(compareSessionsByActivityDesc)
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // NOTE: Do NOT mark metadata-only sessions as loaded here.
    // Sessions from getSessions() have empty messages: [] to save memory.
    // Already-loaded sessions keep their loaded flag only when their existing
    // messages were preserved above.
    // This reduces initial memory usage from ~500MB to ~50MB for 300+ sessions.
  }
)

/**
 * Action atom: initialize or refresh one workspace without discarding cached
 * sessions/messages for other workspaces.
 */
export const initializeWorkspaceSessionsAtom = atom(
  null,
  (
    get,
    set,
    payload: { workspaceIds: string[]; sessions: Session[] }
  ) => {
    const { workspaceIds, sessions } = payload
    const workspaceIdSet = new Set(workspaceIds.filter(Boolean))
    const nextIdSet = new Set(sessions.map(s => s.id))

    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    const metaMap = get(sessionMetaMapAtom)
    const nextMetaMap = new Map(metaMap)
    const nextWorkspaceMetas: SessionMeta[] = []

    for (const [sessionId, meta] of metaMap) {
      if (!workspaceIdSet.has(meta.workspaceId) || nextIdSet.has(sessionId)) continue

      set(sessionAtomFamily(sessionId), null)
      sessionAtomFamily.remove(sessionId)
      backgroundTasksAtomFamily.remove(sessionId)
      nextMetaMap.delete(sessionId)
      nextLoadedSessions.delete(sessionId)
    }

    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const nextSession = mergeSessionWithoutDroppingMessages(currentSession, session)
      const nextMeta = extractSessionMeta(nextSession)
      set(sessionAtomFamily(session.id), nextSession)
      nextMetaMap.set(session.id, nextMeta)
      nextWorkspaceMetas.push(nextMeta)

      const hasMessages = (nextSession.messages?.length ?? 0) > 0
      const incomingHadMessages = (session.messages?.length ?? 0) > 0
      if (incomingHadMessages || (nextLoadedSessions.has(session.id) && hasMessages)) {
        nextLoadedSessions.add(session.id)
      } else if (currentSession && currentSession.workspaceId !== session.workspaceId) {
        nextLoadedSessions.delete(session.id)
      }
    }

    set(loadedSessionsAtom, nextLoadedSessions)
    set(sessionMetaMapAtom, nextMetaMap)
    removeWorkspaceScopedMetas(get, set, workspaceIdSet, nextIdSet)
    setWorkspaceState(get, set, workspaceIds.find(Boolean), nextWorkspaceMetas)

    const ids = Array.from(nextMetaMap.values())
      .sort(compareSessionsByActivityDesc)
      .map(s => s.id)
    set(sessionIdsAtom, ids)
  }
)

/**
 * Action atom: refresh session metadata after a stale reconnect.
 *
 * Unlike initializeSessionsAtom (which resets everything for workspace switches),
 * this preserves messages for already-loaded sessions and only marks overwritten
 * metadata-only sessions as unloaded for lazy re-fetching.
 *
 * All cross-atom mutations happen inside a single write transaction so that
 * React subscribers see one consistent update instead of intermediate states.
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; workspaceIds?: string[] }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds } = payload
    const workspaceIdSet = payload.workspaceIds
      ? new Set(payload.workspaceIds.filter(Boolean))
      : null

    // Remove stale sessions that no longer exist on the server
    const currentIds = get(sessionIdsAtom)
    const latestIds = new Set(sessions.map(s => s.id))
    for (const staleId of currentIds) {
      if (!latestIds.has(staleId)) {
        if (workspaceIdSet) {
          const meta = get(sessionMetaMapAtom).get(staleId)
          if (!meta || !workspaceIdSet.has(meta.workspaceId)) continue
        }
        set(removeSessionAtom, staleId)
      }
    }

    // Update each session atom, preserving messages for metadata refreshes.
    // The loadedSessionsAtom flag can lag behind when the backend briefly
    // returns empty messages during lazy-load recovery, so the atom's existing
    // non-empty messages are the stronger signal here.
    const unloadedIds: string[] = []
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const nextSession = mergeSessionWithoutDroppingMessages(currentSession, session)
      const hasMessages = (nextSession.messages?.length ?? 0) > 0

      set(sessionAtomFamily(session.id), nextSession)

      // Track sessions that lost their messages so lazy-loading re-fetches them
      if (!hasMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // Remove overwritten sessions from loadedSessionsAtom
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // Build and set metadata map
    const nextMetaMap = workspaceIdSet
      ? new Map(get(sessionMetaMapAtom))
      : new Map<string, SessionMeta>()
    if (workspaceIdSet) {
      for (const [sessionId, meta] of nextMetaMap) {
        if (workspaceIdSet.has(meta.workspaceId) && !latestIds.has(sessionId)) {
          nextMetaMap.delete(sessionId)
        }
      }
    }
    for (const session of sessions) {
      nextMetaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, nextMetaMap)

    const refreshedMetas = sessions.map(session => nextMetaMap.get(session.id)).filter((meta): meta is SessionMeta => Boolean(meta))
    if (workspaceIdSet) {
      removeWorkspaceScopedMetas(get, set, workspaceIdSet, latestIds)
      setWorkspaceState(get, set, payload.workspaceIds?.find(Boolean), refreshedMetas)
    } else {
      const workspaceStates = new Map<string, WorkspaceSessionState>()
      const metasByWorkspace = new Map<string, SessionMeta[]>()
      for (const meta of nextMetaMap.values()) {
        if (!meta.workspaceId) continue
        const workspaceMetas = metasByWorkspace.get(meta.workspaceId) ?? []
        workspaceMetas.push(meta)
        metasByWorkspace.set(meta.workspaceId, workspaceMetas)
      }
      for (const [workspaceId, metas] of metasByWorkspace) {
        workspaceStates.set(workspaceId, workspaceStateFromMetas(undefined, metas))
      }
      set(workspaceSessionsAtom, workspaceStates)
    }

    // Set ordered IDs
    const nextIds = Array.from(nextMetaMap.values())
      .sort(compareSessionsByActivityDesc)
      .map(s => s.id)
    set(sessionIdsAtom, nextIds)

    return nextMetaMap
  }
)

/**
 * Action atom: add a new session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    // Set session atom
    set(sessionAtomFamily(session.id), session)

    // Add to metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    const meta = extractSessionMeta(session)
    newMetaMap.set(session.id, meta)
    set(sessionMetaMapAtom, newMetaMap)
    upsertMetaInWorkspaceState(get, set, meta, 'front')

    // Add to beginning of IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, [session.id, ...ids])

    // Mark as loaded (new sessions are complete - no lazy loading needed)
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.add(session.id)
    set(loadedSessionsAtom, newLoadedSessions)
  }
)

/**
 * Action atom: remove a session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // Clear session atom value first
    set(sessionAtomFamily(sessionId), null)
    // Remove atom from family cache to allow GC of the atom and its stored value
    sessionAtomFamily.remove(sessionId)

    // Remove from metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)
    removeMetaFromWorkspaceStates(get, set, sessionId)

    // Remove from IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // Remove from loaded sessions tracking
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // Clean up additional atom families to prevent memory leaks
    // These store per-session UI state that should be garbage collected
    backgroundTasksAtomFamily.remove(sessionId)
  }
)

/**
 * Action atom: sync React state to per-session atoms
 *
 * This is the key to the hybrid approach:
 * - React state (sessions array) remains the source of truth
 * - This atom syncs changes to per-session atoms automatically
 * - Components using useSession(id) get isolated updates
 * - Jotai's referential equality prevents unnecessary re-renders
 *
 * IMPORTANT: During streaming, the atom is the source of truth.
 * Streaming events (text_delta, tool_start, tool_result) update atoms directly
 * and bypass React state for performance. We must NOT overwrite atoms for
 * sessions that are processing, or we lose streaming data (tool calls, text).
 * Once a "handoff" event (complete, error, etc.) occurs, React state catches up
 * and sync works normally again.
 */
export const syncSessionsToAtomsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    const loadedSessions = get(loadedSessionsAtom)

    // Update each session atom
    for (const session of sessions) {
      const sessionAtom = sessionAtomFamily(session.id)
      const atomSession = get(sessionAtom)

      // CRITICAL: If the atom's session is processing, it has streaming updates
      // that React state doesn't know about yet. Don't overwrite - atom is
      // source of truth during streaming. The handoff event will reconcile.
      if (atomSession?.isProcessing) {
        continue
      }

      // CRITICAL: If session messages were lazy-loaded, atom has full messages
      // but React state may have empty array. Only skip if React would lose messages.
      // Allow sync when React has MORE messages (e.g., user just sent a message).
      if (loadedSessions.has(session.id) && atomSession) {
        const atomMessageCount = atomSession.messages?.length ?? 0
        const reactMessageCount = session.messages?.length ?? 0
        // Skip sync only if React has fewer messages (would lose data)
        if (reactMessageCount < atomMessageCount) {
          continue
        }
      }

      // Only update if the session object is different (referential check)
      // This prevents unnecessary re-renders when the session hasn't changed
      if (atomSession !== session) {
        set(sessionAtom, session)
      }
    }

    // Update metadata map for list display
    // Note: We still update metadata from React state, which is fine because
    // metadata doesn't include messages - the streaming content we're protecting
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      const meta = extractSessionMeta(session)
      // Preserve isProcessing from atom if atom is processing
      // React state may have stale isProcessing: false during streaming
      const atomSession = get(sessionAtomFamily(session.id))
      if (atomSession?.isProcessing) {
        meta.isProcessing = true
      }
      metaMap.set(session.id, meta)
    }
    set(sessionMetaMapAtom, metaMap)

    const workspaceStates = new Map(get(workspaceSessionsAtom))
    let workspaceStatesChanged = false
    const metasByWorkspace = new Map<string, SessionMeta[]>()
    for (const meta of metaMap.values()) {
      if (!meta.workspaceId) continue
      const workspaceMetas = metasByWorkspace.get(meta.workspaceId) ?? []
      workspaceMetas.push(meta)
      metasByWorkspace.set(meta.workspaceId, workspaceMetas)
    }
    for (const [workspaceId, metas] of metasByWorkspace) {
      const previousState = workspaceStates.get(workspaceId)
      const nextState = workspaceStateFromMetas(previousState, metas)
      if (nextState !== previousState) {
        workspaceStates.set(workspaceId, nextState)
        workspaceStatesChanged = true
      }
    }
    if (workspaceStatesChanged) {
      set(workspaceSessionsAtom, workspaceStates)
    }

    // Update ordered IDs (preserve order from React state)
    set(sessionIdsAtom, sessions.map(s => s.id))
  }
)

// loadedSessionsAtom moved up before sessionsAtom (needed for self-syncing)

/**
 * Action atom: Load session messages if not already loaded
 * Returns the loaded session or current session if already loaded.
 * Uses promise deduplication to prevent redundant IPC calls from concurrent requests.
 *
 * IMPORTANT: This only merges messages into the existing session atom.
 * UI state fields (hasUnread, isFlagged, sessionStatus, etc.) are preserved from
 * the in-memory atom, NOT overwritten with potentially stale disk data.
 * This prevents a race condition where optimistic updates (e.g., clearing the
 * NEW badge on session view) get clobbered by async message loading that reads
 * older state from disk.
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // Clear any stale in-flight request so the caller gets a fresh fetch.
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    if (loadedSessions.has(sessionId)) {
      const existingSession = get(sessionAtomFamily(sessionId))
      const existingMeta = get(sessionMetaMapAtom).get(sessionId)
      const visibleMessageCount = existingSession?.messages?.length ?? 0
      const expectedMessageCount = existingMeta?.messageCount ?? existingSession?.messageCount
      const contentHint = hasSessionContentHint(existingMeta ?? existingSession)
      const shouldRefetchEmptyLoadedSession = expectedMessageCount !== 0 && contentHint

      // Already loaded, return current session. If the loaded flag says "ready"
      // but the atom is still empty for a session that looks non-empty, keep
      // loading instead of flashing the empty-chat composer.
      if (visibleMessageCount > 0 || !shouldRefetchEmptyLoadedSession) {
        return existingSession
      }

      const nextLoadedSessions = new Set(loadedSessions)
      nextLoadedSessions.delete(sessionId)
      set(loadedSessionsAtom, nextLoadedSessions)
    }
  }

  // Check if already loading - return existing promise to deduplicate concurrent calls
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // Create the loading promise with all the fetch and update logic
  const loadPromise = (async (): Promise<Session | null> => {
    // Fetch messages from main process
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId)
    if (!loadedSession) {
      const existingSession = get(sessionAtomFamily(sessionId))
      const expectedMessageCount = get(sessionMetaMapAtom).get(sessionId)?.messageCount
        ?? existingSession?.messageCount

      if (expectedMessageCount === 0) {
        markSessionMessagesLoaded(get, set, sessionId)
        return existingSession
      }

      throw new Error(`Messages for session ${sessionId} are unavailable`)
    }

    const existingMeta = get(sessionMetaMapAtom).get(sessionId)
    if (
      (loadedSession.messages?.length ?? 0) === 0
      && hasSessionContentHint(existingMeta)
      && loadedSession.messageCount !== 0
    ) {
      throw new Error(`Messages for session ${sessionId} are still loading`)
    }

    // Merge messages and disk-only fields into existing session, preserving in-memory UI state.
    // The renderer's atom is authoritative for UI fields (hasUnread, isFlagged, etc.)
    // because optimistic updates may have changed them since the disk write.
    // tokenUsage and sessionFolderPath are only returned by getSession() (not getSessions()),
    // so they must be explicitly merged here to be available after app restart.
    const existingSession = get(sessionAtomFamily(sessionId))
    const existingTitle = existingSession?.name ?? existingMeta?.name
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    const mergedSession = existingSession
      ? {
          ...existingSession,
          // CRITICAL: Don't clobber messages if session is actively streaming
          // AND already has messages in the atom. Streaming events update the atom
          // directly and may contain messages the IPC response doesn't know about
          // (race window between IPC request and response).
          // The `messages.length > 0` guard ensures Cmd+R reload works: after reload,
          // the atom starts with messages=[] from getSessions(), so IPC response
          // (which has full history from main process memory) must be used.
          // Also guard against sleep/wake edge case: the server may return
          // empty messages if the session subprocess hasn't finished lazy-loading.
          messages: preservedStaleMessages
            ? existingSession.messages
            : existingSession.isProcessing && existingSession.messages.length > 0
              ? existingSession.messages
              : loadedSession.messages,
          availableCommands: loadedSession.availableCommands ?? existingSession.availableCommands,
          availableSkills: loadedSession.availableSkills ?? existingSession.availableSkills,
          availableSkillDetails: loadedSession.availableSkillDetails ?? existingSession.availableSkillDetails,
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
          sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
          name: loadedSession.name ?? existingTitle,
        }
      : loadedSession.name || !existingTitle
        ? loadedSession
        : { ...loadedSession, name: existingTitle }
    set(sessionAtomFamily(sessionId), mergedSession)

    // Update only lastFinalMessageId in metadata (now computable from loaded messages).
    // Don't replace the full meta entry — other fields are maintained through
    // optimistic updates and IPC events, and may be ahead of disk state.
    const lastFinalMessageId = findLastFinalMessageId(loadedSession.messages)
    if (lastFinalMessageId) {
      const metaMap = get(sessionMetaMapAtom)
      const existingMeta = metaMap.get(sessionId)
      if (existingMeta && existingMeta.lastFinalMessageId !== lastFinalMessageId) {
        const nextMeta = { ...existingMeta, lastFinalMessageId }
        const newMetaMap = new Map(metaMap)
        newMetaMap.set(sessionId, nextMeta)
        set(sessionMetaMapAtom, newMetaMap)
        upsertMetaInWorkspaceState(get, set, nextMeta)
      }
    }

    // Mark as loaded only when we received a fresh payload.
    // If we had to preserve stale in-memory messages because the backend returned
    // an empty array during lazy-load recovery, keep the session reloadable.
    if (!preservedStaleMessages) {
      markSessionMessagesLoaded(get, set, sessionId)
    }

    return mergedSession
  })()

  // Cache the promise before awaiting
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // Always clean up the cache, whether success or failure
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Force-refresh session messages even if the session is currently marked as loaded.
 * Used by reconnect recovery when a session atom is stuck in an empty-but-loaded state.
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

/**
 * Background task for ActiveTasksBar display
 */
export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type */
  type: 'agent' | 'shell'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events) */
  elapsedSeconds: number
  /** Task intent/description */
  intent?: string
}

/**
 * Atom family for tracking active background tasks per session
 * Updated on task_backgrounded, shell_backgrounded, task_progress events
 * Cleared when tasks complete or are killed
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
