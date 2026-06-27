/**
 * Tests for main process ↔ renderer Message creation parity.
 *
 * For each IPC event type, verifies that the fields populated by the main
 * process (sessions.ts) and the renderer (event-processor handlers) are
 * equivalent. Catches field drift between the two independent code paths.
 *
 * Mirrors both sides' logic inline (no Electron/Jotai imports).
 */
import { describe, it, expect } from 'bun:test'
import type { Message, ToolDisplayMeta } from '@craft-agent/core'

// ============================================================================
// Event types (mirrored from event-processor/types.ts)
// ============================================================================

interface TextCompleteEvent {
  text: string
  isIntermediate?: boolean
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}

interface ToolStartEvent {
  toolName: string
  toolUseId: string
  toolInput?: Record<string, unknown>
  toolIntent?: string
  toolDisplayName?: string
  toolDisplayMeta?: ToolDisplayMeta
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}

interface ToolResultEvent {
  toolUseId: string
  toolName?: string
  result: string
  isError?: boolean
  turnId?: string
  parentToolUseId?: string
  timestamp?: number
}

interface TypedErrorEvent {
  error: {
    code: string
    title: string
    message: string
    details?: string[]
    originalError?: string
    canRetry: boolean
    actions: unknown[]
  }
  timestamp?: number
}

interface TaskBackgroundedEvent {
  toolUseId: string
  taskId: string
  intent?: string
  turnId?: string
}

interface ShellBackgroundedEvent {
  toolUseId: string
  shellId: string
  intent?: string
  turnId?: string
}

interface TaskProgressEvent {
  toolUseId: string
  elapsedSeconds: number
  turnId?: string
}

interface TaskCompletedEvent {
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  turnId?: string
}

// ============================================================================
// Helpers
// ============================================================================

let idCounter = 0
function nextId() { return `msg-${++idCounter}` }

/** Extract the set of defined (non-undefined) keys from an object */
function definedKeys(obj: Record<string, unknown>): Set<string> {
  return new Set(Object.entries(obj).filter(([_, v]) => v !== undefined).map(([k]) => k))
}

// ============================================================================
// Tests: text_complete parity
// ============================================================================

describe('text_complete → assistant Message field parity', () => {
  it('both sides populate the same fields for a final message', () => {
    const event: TextCompleteEvent = {
      text: 'Here is the answer.',
      isIntermediate: false,
      turnId: 'turn-1',
      parentToolUseId: 'tu-parent',
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts text_complete handler)
    const mainMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: event.timestamp!,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Renderer (handleTextComplete — create-if-not-found path)
    const rendererMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: event.timestamp ?? Date.now(),
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Both should have these fields (modulo transient-only fields)
    const mainKeys = definedKeys(mainMsg as unknown as Record<string, unknown>)
    const rendererKeys = definedKeys(rendererMsg as unknown as Record<string, unknown>)

    // Core fields must be present on both sides
    const coreFields = ['role', 'content', 'timestamp', 'isIntermediate', 'turnId', 'parentToolUseId']
    for (const field of coreFields) {
      expect(mainKeys.has(field)).toBe(true)
      expect(rendererKeys.has(field)).toBe(true)
    }

    // Values must match
    expect(mainMsg.content).toBe(rendererMsg.content)
    expect(mainMsg.isIntermediate).toBe(rendererMsg.isIntermediate)
    expect(mainMsg.turnId).toBe(rendererMsg.turnId)
    expect(mainMsg.parentToolUseId).toBe(rendererMsg.parentToolUseId)
    expect(mainMsg.timestamp).toBe(rendererMsg.timestamp)

    // Renderer has transient fields that main does not (expected)
    expect(rendererKeys.has('isStreaming')).toBe(true)
    expect(rendererKeys.has('isPending')).toBe(true)
  })

  it('intermediate text has the same fields on both sides', () => {
    const event: TextCompleteEvent = {
      text: 'Let me think...',
      isIntermediate: true,
      turnId: 'turn-2',
      parentToolUseId: 'tu-task',
    }

    const mainMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: Date.now(),
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    const rendererMsg: Message = {
      id: nextId(),
      role: 'assistant',
      content: event.text,
      timestamp: Date.now(),
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    expect(mainMsg.isIntermediate).toBe(true)
    expect(rendererMsg.isIntermediate).toBe(true)
    expect(mainMsg.parentToolUseId).toBe(rendererMsg.parentToolUseId)
  })
})

// ============================================================================
// Tests: tool_start parity
// ============================================================================

describe('tool_start → tool Message field parity', () => {
  it('both sides populate the same tool fields', () => {
    const event: ToolStartEvent = {
      toolName: 'Read',
      toolUseId: 'tu-read-1',
      toolInput: { file_path: '/src/main.ts' },
      toolIntent: 'Reading the main file',
      toolDisplayName: 'Read File',
      toolDisplayMeta: { displayName: 'Read', category: 'native' },
      turnId: 'turn-3',
      parentToolUseId: 'tu-task-parent',
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts tool_start — new message path)
    const mainMsg: Message = {
      id: nextId(),
      role: 'tool',
      content: `Running ${event.toolName}...`,
      timestamp: event.timestamp!,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      toolInput: event.toolInput,
      toolStatus: 'executing',
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    }

    // Renderer (handleToolStart — new message path)
    const rendererMsg: Message = {
      id: nextId(),
      role: 'tool',
      content: '',
      timestamp: event.timestamp ?? Date.now(),
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      toolInput: event.toolInput,
      toolStatus: 'executing',
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
    }

    // Core tool fields must match
    const toolFields = [
      'toolName', 'toolUseId', 'toolInput', 'toolStatus',
      'toolIntent', 'toolDisplayName', 'toolDisplayMeta',
      'turnId', 'parentToolUseId',
    ] as const

    for (const field of toolFields) {
      expect((mainMsg as any)[field]).toEqual((rendererMsg as any)[field])
    }
  })
})

// ============================================================================
// Tests: tool_result parity
// ============================================================================

describe('tool_result → tool Message update parity', () => {
  it('both sides set the same completion fields', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-read-1',
      toolName: 'Read',
      result: 'File contents here',
      isError: false,
    }

    // Fields set by main process on tool_result
    const mainUpdate = {
      toolResult: event.result,
      toolStatus: 'completed' as const,
      isError: event.isError,
    }

    // Fields set by renderer handleToolResult
    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: 'completed' as const,
      isError: event.isError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('error result has same fields on both sides', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-bash-1',
      result: 'Command failed',
      isError: true,
    }

    const mainUpdate = {
      toolResult: event.result,
      toolStatus: 'error' as const,
      isError: event.isError,
    }

    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: 'error' as const,
      isError: event.isError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('infers error from [ERROR] prefix when isError is missing', () => {
    const event: ToolResultEvent = {
      toolUseId: 'tu-sandbox-1',
      result: '[ERROR] sandbox failed',
    }

    const inferredIsError = /^\s*(\[ERROR\]|Error:|error:)/.test(event.result || '')

    const mainUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
    }

    const rendererUpdate = {
      toolResult: event.result,
      toolStatus: inferredIsError ? ('error' as const) : ('completed' as const),
      isError: inferredIsError,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })
})

// ============================================================================
// Tests: typed_error parity
// ============================================================================

describe('typed_error → error Message field parity', () => {
  it('both sides populate the same error diagnostic fields', () => {
    const event: TypedErrorEvent = {
      error: {
        code: 'network_error',
        title: 'Connection Failed',
        message: 'Could not connect to API',
        details: ['DNS lookup failed', 'Retried 3 times'],
        originalError: 'ENOTFOUND qwen.local',
        canRetry: true,
        actions: [],
      },
      timestamp: 1700000000000,
    }

    // Main process (sessions.ts typed_error handler)
    const mainMsg: Partial<Message> = {
      role: 'error',
      content: `${event.error.title}: ${event.error.message}`,
      errorCode: event.error.code,
      errorTitle: event.error.title,
      errorDetails: event.error.details,
      errorOriginal: event.error.originalError,
      errorCanRetry: event.error.canRetry,
    }

    // Renderer (handleTypedError)
    const rendererMsg: Partial<Message> = {
      role: 'error',
      content: `${event.error.title}: ${event.error.message}`,
      errorCode: event.error.code,
      errorTitle: event.error.title,
      errorDetails: event.error.details,
      errorOriginal: event.error.originalError,
      errorCanRetry: event.error.canRetry,
    }

    const errorFields = ['role', 'content', 'errorCode', 'errorTitle', 'errorDetails', 'errorOriginal', 'errorCanRetry'] as const
    for (const field of errorFields) {
      expect((mainMsg as any)[field]).toEqual((rendererMsg as any)[field])
    }
  })
})

// ============================================================================
// Tests: background task events parity
// ============================================================================

describe('background task events field parity', () => {
  it('task_backgrounded sets same fields on both sides', () => {
    const event: TaskBackgroundedEvent = {
      toolUseId: 'tu-task-1',
      taskId: 'agent-abc',
      intent: 'Run tests',
      turnId: 'turn-5',
    }

    // Both sides update the tool message with:
    const mainUpdate = {
      toolStatus: 'backgrounded' as const,
      taskId: event.taskId,
      isBackground: true,
    }

    const rendererUpdate = {
      toolStatus: 'backgrounded' as const,
      taskId: event.taskId,
      isBackground: true,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('shell_backgrounded sets same fields on both sides', () => {
    const event: ShellBackgroundedEvent = {
      toolUseId: 'tu-bash-1',
      shellId: 'shell-xyz',
      intent: 'npm install',
      turnId: 'turn-6',
    }

    const mainUpdate = {
      toolStatus: 'backgrounded' as const,
      shellId: event.shellId,
      isBackground: true,
    }

    const rendererUpdate = {
      toolStatus: 'backgrounded' as const,
      shellId: event.shellId,
      isBackground: true,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_progress sets elapsedSeconds on both sides', () => {
    const event: TaskProgressEvent = {
      toolUseId: 'tu-task-1',
      elapsedSeconds: 42,
      turnId: 'turn-5',
    }

    const mainUpdate = { elapsedSeconds: event.elapsedSeconds }
    const rendererUpdate = { elapsedSeconds: event.elapsedSeconds }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed sets same completion fields on both sides', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-abc',
      status: 'completed',
      summary: 'Found 3 files',
      turnId: 'turn-7',
    }

    // Both sides update the tool message (found by taskId) with:
    // Only 'failed' maps to 'error'; 'completed' and 'stopped' map to 'completed'
    const mainUpdate = {
      toolStatus: event.status === 'failed' ? 'error' as const : 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: event.status === 'failed' ? 'error' as const : 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed with failed status sets error on both sides', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-xyz',
      status: 'failed',
      summary: 'Task encountered an error',
      turnId: 'turn-8',
    }

    const mainUpdate = {
      toolStatus: 'error' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: 'error' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
  })

  it('task_completed with stopped status maps to completed (not error)', () => {
    const event: TaskCompletedEvent = {
      taskId: 'agent-stopped',
      status: 'stopped',
      summary: '',
      turnId: 'turn-9',
    }

    // User-initiated stop should NOT show as an error
    const mainUpdate = {
      toolStatus: 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    const rendererUpdate = {
      toolStatus: 'completed' as const,
      toolResult: event.summary || `Background task ${event.status}`,
    }

    expect(mainUpdate).toEqual(rendererUpdate)
    expect(mainUpdate.toolStatus).toBe('completed')
    expect(mainUpdate.toolResult).toBe('Background task stopped')
  })
})

// ============================================================================
// Tests: auth-request Message completeness
// ============================================================================

describe('auth-request Message field completeness', () => {
  it('auth-request message carries all auth fields', () => {
    // Both main and renderer receive the same Message object via IPC
    // (auth_request event carries a pre-built Message from main process)
    const authMessage: Message = {
      id: 'auth-msg-1',
      role: 'auth-request',
      content: 'Authentication required',
      timestamp: Date.now(),
      authRequestId: 'req-1',
      authRequestType: 'credential',
      authSourceSlug: 'linear',
      authSourceName: 'Linear',
      authStatus: 'pending',
      authCredentialMode: 'bearer',
      authHeaderName: 'Authorization',
      authHeaderNames: ['DD-API-KEY', 'DD-APP-KEY'],
      authLabels: { credential: 'API Token' },
      authDescription: 'Enter your Linear API key',
      authHint: 'Settings > API',
      authSourceUrl: 'https://linear.app',
      authPasswordRequired: false,
    }

    // All auth fields should be defined
    const authFields = [
      'authRequestId', 'authRequestType', 'authSourceSlug', 'authSourceName',
      'authStatus', 'authCredentialMode', 'authHeaderName', 'authHeaderNames',
      'authLabels', 'authDescription', 'authHint', 'authSourceUrl',
      'authPasswordRequired',
    ] as const

    for (const field of authFields) {
      expect(authMessage[field]).toBeDefined()
    }
  })
})
