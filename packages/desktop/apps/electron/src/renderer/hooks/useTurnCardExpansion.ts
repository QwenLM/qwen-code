/**
 * Hook for persisting TurnCard expanded/collapsed state across session switches.
 *
 * Stores expansion state in a single localStorage key as a bounded LRU map
 * (max 100 sessions). Only expanded IDs are stored since collapsed is the default.
 *
 * Shape: { [sessionId]: { turns: string[], groups: string[], lastAccessed: number } }
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import * as storage from '@/lib/local-storage'

const MAX_SESSIONS = 100

/** Entry for a single session's expansion state */
interface ExpansionEntry {
  turns: string[]
  groups: string[]
  lastAccessed: number
}

/** Full map stored in localStorage */
type ExpansionMap = Record<string, ExpansionEntry>

/**
 * Read the full expansion map from localStorage.
 * Returns empty object on parse failure.
 */
function readMap(): ExpansionMap {
  return storage.get<ExpansionMap>(storage.KEYS.turnCardExpansion, {})
}

/**
 * Write the expansion map to localStorage, pruning to MAX_SESSIONS
 * by dropping the oldest entries (lowest lastAccessed).
 */
function writeMap(map: ExpansionMap): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_SESSIONS) {
    // Sort by lastAccessed ascending, keep only the most recent MAX_SESSIONS
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
    const pruned: ExpansionMap = {}
    const keep = entries.slice(entries.length - MAX_SESSIONS)
    for (const [key, value] of keep) {
      pruned[key] = value
    }
    storage.set(storage.KEYS.turnCardExpansion, pruned)
  } else {
    storage.set(storage.KEYS.turnCardExpansion, map)
  }
}

/**
 * Persist TurnCard expansion state for the given session.
 * Returns controlled state + callbacks to pass to TurnCard components.
 */
export function useTurnCardExpansion(sessionId: string | undefined) {
  // Initialize state from localStorage for this session
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.turns) : new Set()
  })

  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(() => {
    if (!sessionId) return new Set()
    const map = readMap()
    const entry = map[sessionId]
    return entry ? new Set(entry.groups) : new Set()
  })

  // Track sessionId so we can save/restore on session switch
  const prevSessionIdRef = useRef(sessionId)

  // When sessionId changes, save current state and load new session's state
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return

    // Load the new session's expansion state from localStorage
    if (sessionId) {
      const map = readMap()
      const entry = map[sessionId]
      setExpandedTurns(entry ? new Set(entry.turns) : new Set())
      setExpandedActivityGroups(entry ? new Set(entry.groups) : new Set())
    } else {
      setExpandedTurns(new Set())
      setExpandedActivityGroups(new Set())
    }

    prevSessionIdRef.current = sessionId
  }, [sessionId])

  // Persist to localStorage whenever expansion state changes.
  // Uses a ref to avoid stale closures and only writes when we have a valid session.
  const expandedTurnsRef = useRef(expandedTurns)
  const expandedGroupsRef = useRef(expandedActivityGroups)
  expandedTurnsRef.current = expandedTurns
  expandedGroupsRef.current = expandedActivityGroups

  useEffect(() => {
    if (!sessionId) return
    const map = readMap()
    const turns = [...expandedTurnsRef.current]
    const groups = [...expandedGroupsRef.current]

    // Only write an entry if there's something expanded; remove entry if empty
    if (turns.length === 0 && groups.length === 0) {
      if (map[sessionId]) {
        delete map[sessionId]
        writeMap(map)
      }
      return
    }

    map[sessionId] = {
      turns,
      groups,
      lastAccessed: Date.now(),
    }
    writeMap(map)
  }, [sessionId, expandedTurns, expandedActivityGroups])

  // Toggle a single turn's expansion state
  const toggleTurn = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  return {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  }
}
