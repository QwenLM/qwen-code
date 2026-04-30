import React, { createContext, useContext, useCallback, useRef, useEffect } from 'react'
import { actions, type ActionId } from './definitions'
import type { ActionDefinition, ActionHandler } from './types'
import { isMac } from '@/lib/platform'
import { getKeybindingContext, evaluateWhen } from './keybinding-context'

interface ActionRegistryContextType {
  // Register a handler for an action
  register: (handler: ActionHandler) => () => void

  // Execute an action by ID
  execute: (actionId: ActionId) => void

  // Get the current hotkey for an action (respects user overrides)
  getHotkey: (actionId: ActionId) => string | null

  // Get display string for UI (e.g., "⌘N" on Mac, "Ctrl+N" on Windows)
  getHotkeyDisplay: (actionId: ActionId) => string | null

  // Get action definition
  getAction: (actionId: ActionId) => typeof actions[ActionId]

  // User hotkey overrides (future: load from config)
  userOverrides: Map<ActionId, string | null>
}

const ActionRegistryContext = createContext<ActionRegistryContextType | null>(null)

export function ActionRegistryProvider({ children }: { children: React.ReactNode }) {
  const handlersRef = useRef<Map<ActionId, ActionHandler[]>>(new Map())
  const userOverrides = useRef<Map<ActionId, string | null>>(new Map())

  // Register a handler
  const register = useCallback((handler: ActionHandler) => {
    const handlers = handlersRef.current.get(handler.actionId) || []
    handlers.push(handler)
    handlersRef.current.set(handler.actionId, handlers)

    // Return cleanup function
    return () => {
      const handlers = handlersRef.current.get(handler.actionId) || []
      const index = handlers.indexOf(handler)
      if (index > -1) handlers.splice(index, 1)
    }
  }, [])

  // Execute an action
  const execute = useCallback((actionId: ActionId) => {
    const handlers = handlersRef.current.get(actionId) || []
    for (const handler of handlers) {
      if (!handler.enabled || handler.enabled()) {
        handler.handler()
        break // Only execute first enabled handler
      }
    }
  }, [])

  // Get hotkey for action
  const getHotkey = useCallback((actionId: ActionId): string | null => {
    // Check user overrides first
    if (userOverrides.current.has(actionId)) {
      return userOverrides.current.get(actionId) ?? null
    }
    return actions[actionId].defaultHotkey
  }, [])

  // Get display string
  const getHotkeyDisplay = useCallback((actionId: ActionId): string | null => {
    const hotkey = getHotkey(actionId)
    if (!hotkey) return null
    return formatHotkeyDisplay(hotkey)
  }, [getHotkey])

  // Get action definition
  const getAction = useCallback((actionId: ActionId) => {
    return actions[actionId]
  }, [])

  // Set up global hotkey listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Build context snapshot from DOM state at event time
      const context = getKeybindingContext(e)

      // Check all actions for matching hotkey
      for (const [actionId, action] of Object.entries(actions)) {
        const hotkey = getHotkey(actionId as ActionId)
        if (!hotkey || !matchesHotkey(e, hotkey)) continue

        // Evaluate when-clause against current context
        if (!evaluateWhen((action as ActionDefinition).when, context)) continue

        const handlers = handlersRef.current.get(actionId as ActionId) || []
        for (const handler of handlers) {
          if (!handler.enabled || handler.enabled()) {
            e.preventDefault()
            e.stopPropagation()
            handler.handler()
            return
          }
        }
      }
    }

    // Capture phase for reliable interception
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [getHotkey])

  const value: ActionRegistryContextType = {
    register,
    execute,
    getHotkey,
    getHotkeyDisplay,
    getAction,
    userOverrides: userOverrides.current,
  }

  return (
    <ActionRegistryContext.Provider value={value}>
      {children}
    </ActionRegistryContext.Provider>
  )
}

export function useActionRegistry() {
  const context = useContext(ActionRegistryContext)
  if (!context) {
    throw new Error('useActionRegistry must be used within ActionRegistryProvider')
  }
  return context
}

// ─────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────

function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needsMod = parts.includes('mod')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')

  const modPressed = isMac ? e.metaKey : e.ctrlKey
  const logicalKeyMatches = e.key.toLowerCase() === key

  // Handle special keys via physical code where logical values can vary by layout.
  const specialKeys: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ',': 'Comma',
    '.': 'Period',
    'left': 'ArrowLeft',
    'right': 'ArrowRight',
    'up': 'ArrowUp',
    'down': 'ArrowDown',
    'escape': 'Escape',
    'tab': 'Tab',
  }

  const specialCode = specialKeys[key]

  // Important: for text shortcuts (A-Z/0-9), match logical key only.
  // Mixing in physical code (e.g. KeyQ) causes AZERTY/QWERTZ collisions such as
  // Cmd+A incorrectly matching a Cmd+Q binding.
  const codeMatches = specialCode
    ? e.code === specialCode
    : logicalKeyMatches

  // Check modifier requirements
  const modCorrect = needsMod ? modPressed : !modPressed
  const shiftCorrect = needsShift ? e.shiftKey : !e.shiftKey
  const altCorrect = needsAlt ? e.altKey : !e.altKey

  return codeMatches && modCorrect && shiftCorrect && altCorrect
}

function formatHotkeyDisplay(hotkey: string): string {
  const parts = hotkey.toLowerCase().split('+')

  const symbols = parts.map(part => {
    if (part === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (part === 'shift') return isMac ? '⇧' : 'Shift'
    if (part === 'alt') return isMac ? '⌥' : 'Alt'
    if (part === 'escape') return 'Esc'
    if (part === 'tab') return 'Tab'
    if (part === 'left') return '←'
    if (part === 'right') return '→'
    if (part === '[') return '['
    if (part === ']') return ']'
    return part.toUpperCase()
  })

  return isMac ? symbols.join('') : symbols.join('+')
}
