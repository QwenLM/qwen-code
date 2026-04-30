/**
 * Tests for stateless tool matching logic.
 *
 * These tests verify that extractToolStarts() and extractToolResults() produce
 * deterministic output regardless of processing order. This is the core invariant
 * that makes the tool matching pipeline stateless.
 *
 * Key property under test: same SDK messages → same AgentEvents, regardless of order.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  ToolIndex,
  extractToolStarts,
  extractToolResults,
  serializeResult,
  isToolResultError,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
} from '../tool-matching'
import { toolMetadataStore } from '../../interceptor-common'

// ============================================================================
// Test Helpers
// ============================================================================

let idCounter = 0

function resetCounters() {
  idCounter = 0
}

function makeToolUseBlock(
  name: string,
  input: Record<string, unknown> = {},
  id?: string,
): ToolUseBlock {
  return {
    type: 'tool_use',
    id: id ?? `toolu_${++idCounter}`,
    name,
    input,
  }
}

function makeToolResultBlock(
  toolUseId: string,
  content: unknown = 'success',
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }
}

// ============================================================================
// ToolIndex
// ============================================================================

describe('ToolIndex', () => {
  let index: ToolIndex

  beforeEach(() => {
    index = new ToolIndex()
    resetCounters()
  })

  it('registers and looks up tools', () => {
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.getName('toolu_1')).toBe('Read')
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
    expect(index.has('toolu_1')).toBe(true)
  })

  it('returns undefined for unknown tools', () => {
    expect(index.getName('unknown')).toBeUndefined()
    expect(index.getInput('unknown')).toBeUndefined()
    expect(index.has('unknown')).toBe(false)
  })

  it('is idempotent — registering same ID twice keeps first entry', () => {
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    index.register('toolu_1', 'Read', { file_path: '/bar' })
    // First non-empty registration wins
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
  })

  it('upgrades empty input to complete input', () => {
    // Stream events register with empty input first
    index.register('toolu_1', 'Read', {})
    expect(index.getInput('toolu_1')).toEqual({})

    // Assistant message arrives with complete input
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.getInput('toolu_1')).toEqual({ file_path: '/foo' })
  })

  it('is order-independent — same entries regardless of insertion order', () => {
    const indexA = new ToolIndex()
    indexA.register('toolu_1', 'Read', { file_path: '/foo' })
    indexA.register('toolu_2', 'Bash', { command: 'ls' })

    const indexB = new ToolIndex()
    indexB.register('toolu_2', 'Bash', { command: 'ls' })
    indexB.register('toolu_1', 'Read', { file_path: '/foo' })

    expect(indexA.getName('toolu_1')).toBe(indexB.getName('toolu_1'))
    expect(indexA.getName('toolu_2')).toBe(indexB.getName('toolu_2'))
    expect(indexA.getInput('toolu_1')).toEqual(indexB.getInput('toolu_1'))
    expect(indexA.getInput('toolu_2')).toEqual(indexB.getInput('toolu_2'))
  })

  it('tracks size correctly', () => {
    expect(index.size).toBe(0)
    index.register('toolu_1', 'Read', {})
    expect(index.size).toBe(1)
    index.register('toolu_2', 'Bash', {})
    expect(index.size).toBe(2)
    // Re-registering same ID doesn't increase size
    index.register('toolu_1', 'Read', { file_path: '/foo' })
    expect(index.size).toBe(2)
  })
})

// ============================================================================
// extractToolStarts
// ============================================================================

describe('extractToolStarts', () => {
  let toolIndex: ToolIndex
  let emittedIds: Set<string>

  beforeEach(() => {
    toolIndex = new ToolIndex()
    emittedIds = new Set()
    resetCounters()
  })

  it('extracts a single tool_start from one tool_use block', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_read1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'toolu_read1',
      input: { file_path: '/foo.ts' },
      parentToolUseId: undefined,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id (top-level = undefined)', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Grep', {}, 'toolu_1')]
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id (subagent child)', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Grep', {}, 'toolu_child1')]
    const events = extractToolStarts(blocks, 'toolu_task1', toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task1',
    })
  })

  it('extracts multiple tool_starts from one message', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Read', { file_path: '/b.ts' }, 'toolu_2'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_3'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ toolName: 'Read', toolUseId: 'toolu_1' })
    expect(events[1]).toMatchObject({ toolName: 'Read', toolUseId: 'toolu_2' })
    expect(events[2]).toMatchObject({ toolName: 'Grep', toolUseId: 'toolu_3' })
  })

  it('deduplicates stream + assistant events (same tool_use_id)', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    // First call (from stream_event)
    const events1 = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events1).toHaveLength(1)

    // Second call (from assistant message) — same ID, but now with complete input
    const events2 = extractToolStarts(blocks, null, toolIndex, emittedIds)
    // Should re-emit with complete input since input is non-empty
    expect(events2).toHaveLength(1)
    expect(events2[0]).toMatchObject({ toolUseId: 'toolu_1' })
  })

  it('deduplicates when stream had empty input and assistant has full input', () => {
    const streamBlocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]
    const assistantBlocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    // Stream event: empty input
    const events1 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
    expect(events1).toHaveLength(1)
    expect(events1[0]).toMatchObject({ input: {} })

    // Assistant message: full input — should re-emit with complete data
    const events2 = extractToolStarts(assistantBlocks, null, toolIndex, emittedIds)
    expect(events2).toHaveLength(1)
    expect(events2[0]).toMatchObject({ input: { file_path: '/foo.ts' } })
  })

  it('re-emits duplicate empty-input tool_start when metadata arrives late', () => {
    const toolUseId = 'toolu_browser_1'
    const streamBlocks: ContentBlock[] = [
      makeToolUseBlock('mcp__session__browser_open', {}, toolUseId),
    ]

    try {
      // First stream event with empty input and no stored metadata
      const events1 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
      expect(events1).toHaveLength(1)
      expect(events1[0]).toMatchObject({
        toolUseId,
        input: {},
        intent: undefined,
        displayName: undefined,
      })

      // Metadata is captured later by interceptor/store
      toolMetadataStore.set(toolUseId, {
        intent: 'Open the in-app browser window',
        displayName: 'Open Browser',
        timestamp: Date.now(),
      })

      // Duplicate assistant event still has empty input for browser_open,
      // but should re-emit now that metadata is available.
      const events2 = extractToolStarts(streamBlocks, null, toolIndex, emittedIds)
      expect(events2).toHaveLength(1)
      expect(events2[0]).toMatchObject({
        toolUseId,
        input: {},
        intent: 'Open the in-app browser window',
        displayName: 'Open Browser',
      })
    } finally {
      toolMetadataStore.delete(toolUseId)
    }
  })

  it('registers tools in the index', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/foo.ts' }, 'toolu_1'),
    ]

    extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(toolIndex.has('toolu_1')).toBe(true)
    expect(toolIndex.getName('toolu_1')).toBe('Read')
    expect(toolIndex.getInput('toolu_1')).toEqual({ file_path: '/foo.ts' })
  })

  it('extracts intent from _intent field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo', _intent: 'Find usages of foo' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ intent: 'Find usages of foo' })
  })

  it('extracts intent from Bash description field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls', description: 'List files' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ intent: 'List files' })
  })

  it('extracts displayName from _displayName field', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('mcp__craft__search', { _displayName: 'Search Docs', _intent: 'Find docs' }, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events[0]).toMatchObject({ displayName: 'Search Docs' })
  })

  it('passes turnId through to events', () => {
    const blocks: ContentBlock[] = [makeToolUseBlock('Read', {}, 'toolu_1')]
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, 'turn_abc')

    expect(events[0]).toMatchObject({ turnId: 'turn_abc' })
  })

  it('ignores non-tool_use blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' } as ContentBlock,
      makeToolUseBlock('Read', {}, 'toolu_1'),
      { type: 'thinking', thinking: '...' } as ContentBlock,
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ toolName: 'Read' })
  })

  // --- Fallback parent assignment (when SDK parent_tool_use_id is null) ---

  it('assigns fallback parent when SDK parent is null and exactly one Task is active', () => {
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_child1'),
    ]

    // SDK says parent is null, but we have one active Task
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      toolName: 'Grep',
      toolUseId: 'toolu_child1',
      parentToolUseId: 'toolu_task1',  // Fallback assigned
    })
  })

  it('does not assign fallback when SDK provides explicit parent', () => {
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_child2'),
    ]

    // SDK says parent is toolu_task2 (different from activeParents)
    const events = extractToolStarts(blocks, 'toolu_task2', toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task2',  // SDK value takes precedence
    })
  })

  it('does not assign fallback when multiple Tasks are active (ambiguous)', () => {
    const activeParents = new Set(['toolu_taskA', 'toolu_taskB'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_child'),
    ]

    // SDK says null, but multiple Tasks are active — can't safely assign
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,  // Not assigned — ambiguous
    })
  })

  it('does not assign fallback when no Tasks are active', () => {
    const activeParents = new Set<string>()

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      parentToolUseId: undefined,  // No active Tasks
    })
  })

  it('does not self-reference Task tool as its own parent', () => {
    // When a Task tool starts, it should NOT be assigned as its own parent
    const activeParents = new Set(['toolu_task1'])

    const blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'nested' }, 'toolu_task1'),
    ]

    const events = extractToolStarts(blocks, null, toolIndex, emittedIds, undefined, activeParents)

    expect(events[0]).toMatchObject({
      toolName: 'Task',
      toolUseId: 'toolu_task1',
      parentToolUseId: undefined,  // Not self-referencing
    })
  })

  it('activeParentTools parameter is optional (backward compatible)', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('Read', {}, 'toolu_1'),
    ]

    // Call without activeParentTools parameter
    const events = extractToolStarts(blocks, null, toolIndex, emittedIds)

    expect(events[0]).toMatchObject({
      toolName: 'Read',
      parentToolUseId: undefined,
    })
  })
})

// ============================================================================
// extractToolResults
// ============================================================================

describe('extractToolResults', () => {
  let toolIndex: ToolIndex

  beforeEach(() => {
    toolIndex = new ToolIndex()
    resetCounters()
  })

  it('matches tool result by explicit tool_use_id in content block', () => {
    // Register tool first (simulates prior tool_start)
    toolIndex.register('toolu_read1', 'Read', { file_path: '/foo.ts' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_read1', 'file contents here'),
    ]

    const events = extractToolResults(blocks, 'toolu_read1', undefined, toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_read1',
      toolName: 'Read',
      result: 'file contents here',
      isError: false,
    })
  })

  it('matches out-of-order results correctly (no FIFO)', () => {
    // Register Read first, then Grep (order A → B)
    toolIndex.register('toolu_read', 'Read', { file_path: '/foo.ts' })
    toolIndex.register('toolu_grep', 'Grep', { pattern: 'bar' })

    // Grep result arrives FIRST (out of registration order)
    const grepResult: ContentBlock[] = [
      makeToolResultBlock('toolu_grep', '3 matches found'),
    ]
    const grepEvents = extractToolResults(grepResult, 'toolu_task1', undefined, toolIndex)

    expect(grepEvents).toHaveLength(1)
    expect(grepEvents[0]).toMatchObject({
      toolUseId: 'toolu_grep',
      toolName: 'Grep',
      result: '3 matches found',
    })

    // Read result arrives SECOND
    const readResult: ContentBlock[] = [
      makeToolResultBlock('toolu_read', 'file contents'),
    ]
    const readEvents = extractToolResults(readResult, 'toolu_task1', undefined, toolIndex)

    expect(readEvents).toHaveLength(1)
    expect(readEvents[0]).toMatchObject({
      toolUseId: 'toolu_read',
      toolName: 'Read',
      result: 'file contents',
    })
  })

  it('handles multiple tool_result blocks in one message', () => {
    toolIndex.register('toolu_1', 'Read', {})
    toolIndex.register('toolu_2', 'Grep', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'content A'),
      makeToolResultBlock('toolu_2', 'content B'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ toolUseId: 'toolu_1', toolName: 'Read' })
    expect(events[1]).toMatchObject({ toolUseId: 'toolu_2', toolName: 'Grep' })
  })

  it('propagates isError from content block', () => {
    toolIndex.register('toolu_1', 'Bash', { command: 'exit 1' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'command failed', true),
    ]

    const events = extractToolResults(blocks, 'toolu_1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_1',
      isError: true,
    })
  })

  it('sets parentToolUseId from SDK parent_tool_use_id', () => {
    toolIndex.register('toolu_child', 'Read', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_child', 'data'),
    ]

    // SDK says parent is toolu_task1
    const events = extractToolResults(blocks, 'toolu_task1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      parentToolUseId: 'toolu_task1',
    })
  })

  it('sets parentToolUseId to undefined when SDK parent is null', () => {
    toolIndex.register('toolu_1', 'Bash', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'output'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)
    expect(events[0]).toMatchObject({ parentToolUseId: undefined })
  })

  it('falls back to convenience fields when no content blocks', () => {
    toolIndex.register('toolu_1', 'Read', {})

    // No tool_result content blocks, but tool_use_result is present
    const events = extractToolResults([], 'toolu_1', 'file contents', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      toolName: 'Read',
      result: 'file contents',
    })
  })

  it('fallback path does not self-reference parentToolUseId', () => {
    // When content blocks are empty and we fall back to convenience fields,
    // parentToolUseId must NOT equal toolUseId (no self-referencing loop)
    toolIndex.register('toolu_1', 'Read', { file_path: '/foo.ts' })

    // No content blocks — triggers fallback. sdkParentToolUseId = 'toolu_1'
    const events = extractToolResults([], 'toolu_1', 'file contents', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      toolName: 'Read',
      result: 'file contents',
      // parentToolUseId must be undefined, not 'toolu_1' (self-reference)
      parentToolUseId: undefined,
    })
  })

  it('fallback path handles top-level tools without content blocks (sdkParentToolUseId=null)', () => {
    // Top-level tools have null parent_tool_use_id. Without content blocks,
    // the result must still be emitted (not silently dropped).
    const events = extractToolResults([], null, 'some output', toolIndex, 'turn_42')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'fallback-turn_42',
      result: 'some output',
      parentToolUseId: undefined,
    })
  })

  it('fallback path generates stable synthetic ID without turnId', () => {
    // Edge case: no turnId and no sdkParentToolUseId
    const events = extractToolResults([], null, 'result data', toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'fallback-unknown',
      result: 'result data',
    })
  })

  it('handles unknown tool (not in index)', () => {
    // No registration — tool_use_id doesn't exist in index
    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_unknown', 'some result'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_unknown',
      toolName: undefined,
      result: 'some result',
    })
  })

  it('serializes non-string results to JSON', () => {
    toolIndex.register('toolu_1', 'mcp__api', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', { data: [1, 2, 3], status: 'ok' }),
    ]

    const events = extractToolResults(blocks, 'toolu_1', undefined, toolIndex)

    expect(events[0]).toMatchObject({
      result: JSON.stringify({ data: [1, 2, 3], status: 'ok' }, null, 2),
    })
  })

  it('passes turnId through to events', () => {
    toolIndex.register('toolu_1', 'Read', {})

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_1', 'data'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex, 'turn_xyz')
    expect(events[0]).toMatchObject({ turnId: 'turn_xyz' })
  })

  // --- Background event detection ---

  it('detects background Task from agentId in result when run_in_background is true', () => {
    toolIndex.register('toolu_task', 'Task', { _intent: 'Search codebase', run_in_background: true })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_task', 'Done.\nagentId: abc123'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    // Should have tool_result + task_backgrounded
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_task' })
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_task',
      taskId: 'abc123',
      intent: 'Search codebase',
    })
  })

  it('does NOT emit task_backgrounded for foreground Agent with agentId in result', () => {
    // Foreground Agent tool (no run_in_background) — agentId in result should be ignored
    toolIndex.register('toolu_agent', 'Agent', { _intent: 'Explore codebase', prompt: 'Find auth code' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_agent', 'Found auth in /src/auth.ts\nagentId: fg_agent_xyz'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    // Should ONLY have tool_result — no task_backgrounded
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 'toolu_agent' })
  })

  it('detects background Shell from shell_id in result', () => {
    toolIndex.register('toolu_bash', 'Bash', { command: 'npm test', description: 'Run tests' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_bash', 'shell_id: shell_456'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_result' })
    expect(events[1]).toMatchObject({
      type: 'shell_backgrounded',
      toolUseId: 'toolu_bash',
      shellId: 'shell_456',
      intent: 'Run tests',
      command: 'npm test',
    })
  })

  it('detects KillShell events', () => {
    toolIndex.register('toolu_kill', 'KillShell', { shell_id: 'shell_789' })

    const blocks: ContentBlock[] = [
      makeToolResultBlock('toolu_kill', 'Shell killed'),
    ]

    const events = extractToolResults(blocks, null, undefined, toolIndex)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'shell_killed',
      shellId: 'shell_789',
    })
  })
})

// ============================================================================
// Determinism Property — THE KEY INVARIANT
// ============================================================================

describe('Determinism property', () => {
  it('same tool_starts in different order produce same events (modulo emission order)', () => {
    // Process blocks in order A, B, C
    const indexA = new ToolIndex()
    const emittedA = new Set<string>()
    const blocksA: ContentBlock[] = [
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_2'),
      makeToolUseBlock('Bash', { command: 'ls', description: 'List' }, 'toolu_3'),
    ]
    const eventsA = extractToolStarts(blocksA, null, indexA, emittedA)

    // Process blocks in order C, A, B
    const indexB = new ToolIndex()
    const emittedB = new Set<string>()
    const blocksB: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'ls', description: 'List' }, 'toolu_3'),
      makeToolUseBlock('Read', { file_path: '/a.ts' }, 'toolu_1'),
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_2'),
    ]
    const eventsB = extractToolStarts(blocksB, null, indexB, emittedB)

    // Both should produce 3 events with same content (order follows input order)
    expect(eventsA).toHaveLength(3)
    expect(eventsB).toHaveLength(3)

    // Sort by toolUseId for comparison (order-independent)
    const sortById = (events: any[]) => [...events].sort((a, b) => a.toolUseId.localeCompare(b.toolUseId))
    const sortedA = sortById(eventsA)
    const sortedB = sortById(eventsB)

    for (let i = 0; i < 3; i++) {
      expect(sortedA[i].toolName).toBe(sortedB[i].toolName)
      expect(sortedA[i].toolUseId).toBe(sortedB[i].toolUseId)
      expect(sortedA[i].parentToolUseId).toBe(sortedB[i].parentToolUseId)
    }
  })

  it('out-of-order results always match to correct tool by ID', () => {
    // Setup: register tools
    const index = new ToolIndex()
    index.register('toolu_read', 'Read', { file_path: '/foo.ts' })
    index.register('toolu_grep', 'Grep', { pattern: 'bar' })
    index.register('toolu_bash', 'Bash', { command: 'ls' })

    // Results in order: Bash, Read, Grep
    const result1: ContentBlock[] = [makeToolResultBlock('toolu_bash', 'output1')]
    const result2: ContentBlock[] = [makeToolResultBlock('toolu_read', 'output2')]
    const result3: ContentBlock[] = [makeToolResultBlock('toolu_grep', 'output3')]

    const e1 = extractToolResults(result1, null, undefined, index)
    const e2 = extractToolResults(result2, null, undefined, index)
    const e3 = extractToolResults(result3, null, undefined, index)

    // Each result matches its own tool, not FIFO order
    expect(e1[0]).toMatchObject({ toolUseId: 'toolu_bash', toolName: 'Bash', result: 'output1' })
    expect(e2[0]).toMatchObject({ toolUseId: 'toolu_read', toolName: 'Read', result: 'output2' })
    expect(e3[0]).toMatchObject({ toolUseId: 'toolu_grep', toolName: 'Grep', result: 'output3' })

    // Now process in DIFFERENT order: Read, Grep, Bash
    const f1 = extractToolResults(result2, null, undefined, index)
    const f2 = extractToolResults(result3, null, undefined, index)
    const f3 = extractToolResults(result1, null, undefined, index)

    // Same results regardless of order!
    expect(f1[0]).toMatchObject({ toolUseId: 'toolu_read', toolName: 'Read', result: 'output2' })
    expect(f2[0]).toMatchObject({ toolUseId: 'toolu_grep', toolName: 'Grep', result: 'output3' })
    expect(f3[0]).toMatchObject({ toolUseId: 'toolu_bash', toolName: 'Bash', result: 'output1' })
  })

  it('concurrent Tasks: children assigned to correct parent by SDK field, not by timing', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Task1 starts
    const task1Blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'search' }, 'toolu_task1'),
    ]
    extractToolStarts(task1Blocks, null, index, emitted)

    // Task2 starts
    const task2Blocks: ContentBlock[] = [
      makeToolUseBlock('Task', { prompt: 'build' }, 'toolu_task2'),
    ]
    extractToolStarts(task2Blocks, null, index, emitted)

    // Child1 of Task1 starts (SDK says parent = task1)
    const child1Blocks: ContentBlock[] = [
      makeToolUseBlock('Grep', { pattern: 'foo' }, 'toolu_child1'),
    ]
    const child1Events = extractToolStarts(child1Blocks, 'toolu_task1', index, emitted)

    expect(child1Events[0]).toMatchObject({
      toolName: 'Grep',
      parentToolUseId: 'toolu_task1',  // Correct: assigned to Task1
    })

    // Child2 of Task2 starts (SDK says parent = task2)
    const child2Blocks: ContentBlock[] = [
      makeToolUseBlock('Bash', { command: 'npm build' }, 'toolu_child2'),
    ]
    const child2Events = extractToolStarts(child2Blocks, 'toolu_task2', index, emitted)

    expect(child2Events[0]).toMatchObject({
      toolName: 'Bash',
      parentToolUseId: 'toolu_task2',  // Correct: assigned to Task2
    })

    // Results: child2 result arrives with its own tool_use_id
    const child2Result: ContentBlock[] = [
      makeToolResultBlock('toolu_child2', 'build complete'),
    ]
    const resultEvents = extractToolResults(child2Result, 'toolu_task2', undefined, index)

    expect(resultEvents[0]).toMatchObject({
      toolUseId: 'toolu_child2',
      toolName: 'Bash',
      parentToolUseId: 'toolu_task2',
    })
  })
})

// ============================================================================
// Helper function tests
// ============================================================================

describe('serializeResult', () => {
  it('passes through strings', () => {
    expect(serializeResult('hello')).toBe('hello')
  })

  it('serializes objects to JSON', () => {
    expect(serializeResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('returns empty string for null/undefined', () => {
    expect(serializeResult(null)).toBe('')
    expect(serializeResult(undefined)).toBe('')
  })
})

describe('isToolResultError', () => {
  it('detects Error: prefix', () => {
    expect(isToolResultError('Error: file not found')).toBe(true)
  })

  it('detects error: prefix', () => {
    expect(isToolResultError('error: command failed')).toBe(true)
  })

  it('detects [ERROR] prefix', () => {
    expect(isToolResultError('[ERROR] command failed')).toBe(true)
  })

  it('detects is_error flag in object', () => {
    expect(isToolResultError({ is_error: true, message: 'fail' })).toBe(true)
  })

  it('detects error key in object', () => {
    expect(isToolResultError({ error: 'something broke' })).toBe(true)
  })

  it('returns false for normal results', () => {
    expect(isToolResultError('success')).toBe(false)
    expect(isToolResultError({ data: 'ok' })).toBe(false)
  })
})
