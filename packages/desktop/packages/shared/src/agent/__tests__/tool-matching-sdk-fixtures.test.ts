/**
 * Tests using realistic SDK message fixtures to validate the stateless
 * tool matching against real-world patterns.
 *
 * Each test simulates a complete tool lifecycle by feeding SDK-like content
 * blocks through extractToolStarts() and extractToolResults() and verifying
 * the output matches expected AgentEvents.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  ToolIndex,
  extractToolStarts,
  extractToolResults,
  type ContentBlock,
  type ToolUseBlock,
  type ToolResultBlock,
} from '../tool-matching'

// ============================================================================
// Fixture Helpers
// ============================================================================

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, content: unknown = 'ok', isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }
}

// ============================================================================
// Fixture: Simple Bash Tool
// ============================================================================

describe('Fixture: Simple Bash tool', () => {
  it('complete lifecycle: start → result', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // 1. Assistant message with Bash tool_use
    const startBlocks: ContentBlock[] = [
      toolUse('toolu_bash1', 'Bash', { command: 'git status', description: 'Check git status' }),
    ]
    const startEvents = extractToolStarts(startBlocks, null, index, emitted, 'turn_1')

    expect(startEvents).toHaveLength(1)
    expect(startEvents[0]).toMatchObject({
      type: 'tool_start',
      toolName: 'Bash',
      toolUseId: 'toolu_bash1',
      input: { command: 'git status', description: 'Check git status' },
      intent: 'Check git status',
      parentToolUseId: undefined,
      turnId: 'turn_1',
    })

    // 2. User message with tool_result
    const resultBlocks: ContentBlock[] = [
      toolResult('toolu_bash1', 'On branch main\nnothing to commit'),
    ]
    const resultEvents = extractToolResults(resultBlocks, 'toolu_bash1', undefined, index, 'turn_1')

    expect(resultEvents).toHaveLength(1)
    expect(resultEvents[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_bash1',
      toolName: 'Bash',
      result: 'On branch main\nnothing to commit',
      isError: false,
      turnId: 'turn_1',
    })
  })
})

// ============================================================================
// Fixture: Task with Grep + Read children
// ============================================================================

describe('Fixture: Task with Grep + Read children', () => {
  it('full subagent lifecycle', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // 1. Task starts (top-level)
    const taskStart: ContentBlock[] = [
      toolUse('toolu_task1', 'Task', { prompt: 'Find auth code', subagent_type: 'Explore' }),
    ]
    const taskStartEvents = extractToolStarts(taskStart, null, index, emitted)
    expect(taskStartEvents).toHaveLength(1)
    expect(taskStartEvents[0]).toMatchObject({
      toolName: 'Task',
      toolUseId: 'toolu_task1',
      parentToolUseId: undefined,
    })

    // 2. Grep child starts (inside Task subagent — SDK provides parent)
    const grepStart: ContentBlock[] = [
      toolUse('toolu_grep1', 'Grep', { pattern: 'authenticate' }),
    ]
    const grepEvents = extractToolStarts(grepStart, 'toolu_task1', index, emitted)
    expect(grepEvents[0]).toMatchObject({
      toolName: 'Grep',
      toolUseId: 'toolu_grep1',
      parentToolUseId: 'toolu_task1',
    })

    // 3. Read child starts (inside same Task)
    const readStart: ContentBlock[] = [
      toolUse('toolu_read1', 'Read', { file_path: '/src/auth.ts' }),
    ]
    const readEvents = extractToolStarts(readStart, 'toolu_task1', index, emitted)
    expect(readEvents[0]).toMatchObject({
      toolName: 'Read',
      toolUseId: 'toolu_read1',
      parentToolUseId: 'toolu_task1',
    })

    // 4. Grep result arrives (with direct tool_use_id match)
    const grepResult: ContentBlock[] = [
      toolResult('toolu_grep1', '5 matches in auth.ts'),
    ]
    const grepResultEvents = extractToolResults(grepResult, 'toolu_task1', undefined, index)
    expect(grepResultEvents[0]).toMatchObject({
      toolUseId: 'toolu_grep1',
      toolName: 'Grep',
      parentToolUseId: 'toolu_task1',
    })

    // 5. Read result arrives
    const readResult: ContentBlock[] = [
      toolResult('toolu_read1', 'export function authenticate() { ... }'),
    ]
    const readResultEvents = extractToolResults(readResult, 'toolu_task1', undefined, index)
    expect(readResultEvents[0]).toMatchObject({
      toolUseId: 'toolu_read1',
      toolName: 'Read',
      parentToolUseId: 'toolu_task1',
    })

    // 6. Task itself completes
    const taskResult: ContentBlock[] = [
      toolResult('toolu_task1', 'Found authentication code in /src/auth.ts'),
    ]
    const taskResultEvents = extractToolResults(taskResult, null, undefined, index)
    expect(taskResultEvents[0]).toMatchObject({
      toolUseId: 'toolu_task1',
      toolName: 'Task',
      parentToolUseId: undefined,
    })
  })
})

// ============================================================================
// Fixture: Parallel Tasks
// ============================================================================

describe('Fixture: Parallel Tasks with interleaved children', () => {
  it('children correctly assigned to their parent regardless of interleaving', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Both Tasks start in the same assistant message
    const tasksStart: ContentBlock[] = [
      toolUse('toolu_taskA', 'Task', { prompt: 'Search logs' }),
      toolUse('toolu_taskB', 'Task', { prompt: 'Build project' }),
    ]
    extractToolStarts(tasksStart, null, index, emitted)

    // TaskA's child starts
    const childA: ContentBlock[] = [
      toolUse('toolu_grepA', 'Grep', { pattern: 'ERROR' }),
    ]
    const childAEvents = extractToolStarts(childA, 'toolu_taskA', index, emitted)
    expect(childAEvents[0]).toMatchObject({ parentToolUseId: 'toolu_taskA' })

    // TaskB's child starts (interleaved)
    const childB: ContentBlock[] = [
      toolUse('toolu_bashB', 'Bash', { command: 'npm run build' }),
    ]
    const childBEvents = extractToolStarts(childB, 'toolu_taskB', index, emitted)
    expect(childBEvents[0]).toMatchObject({ parentToolUseId: 'toolu_taskB' })

    // TaskB's child result arrives FIRST (out of start order)
    const childBResult: ContentBlock[] = [
      toolResult('toolu_bashB', 'Build succeeded'),
    ]
    const childBResultEvents = extractToolResults(childBResult, 'toolu_taskB', undefined, index)
    expect(childBResultEvents[0]).toMatchObject({
      toolUseId: 'toolu_bashB',
      toolName: 'Bash',
      parentToolUseId: 'toolu_taskB',
    })

    // TaskA's child result arrives SECOND
    const childAResult: ContentBlock[] = [
      toolResult('toolu_grepA', '42 errors found'),
    ]
    const childAResultEvents = extractToolResults(childAResult, 'toolu_taskA', undefined, index)
    expect(childAResultEvents[0]).toMatchObject({
      toolUseId: 'toolu_grepA',
      toolName: 'Grep',
      parentToolUseId: 'toolu_taskA',
    })
  })
})

// ============================================================================
// Fixture: MCP Tool
// ============================================================================

describe('Fixture: MCP tool', () => {
  it('MCP tool with parent_tool_use_id', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // MCP tool starts
    const mcpStart: ContentBlock[] = [
      toolUse('toolu_mcp1', 'mcp__craft__search', { query: 'auth docs', _intent: 'Search docs', _displayName: 'Search' }),
    ]
    const startEvents = extractToolStarts(mcpStart, null, index, emitted)
    expect(startEvents[0]).toMatchObject({
      toolName: 'mcp__craft__search',
      intent: 'Search docs',
      displayName: 'Search',
    })

    // MCP tool result with explicit tool_use_id
    const mcpResult: ContentBlock[] = [
      toolResult('toolu_mcp1', { results: ['doc1', 'doc2'] }),
    ]
    const resultEvents = extractToolResults(mcpResult, 'toolu_mcp1', undefined, index)
    expect(resultEvents[0]).toMatchObject({
      toolUseId: 'toolu_mcp1',
      toolName: 'mcp__craft__search',
    })
  })

  it('MCP tool fallback: no content blocks, uses convenience fields', () => {
    const index = new ToolIndex()
    index.register('toolu_mcp2', 'mcp__api__get', {})

    // No tool_result content blocks — some in-process MCP tools may not have them
    const events = extractToolResults([], 'toolu_mcp2', 'API response data', index)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_mcp2',
      toolName: 'mcp__api__get',
      result: 'API response data',
    })
  })
})

// ============================================================================
// Fixture: Task with no children (immediate return)
// ============================================================================

describe('Fixture: Task with no children', () => {
  it('Task starts and immediately returns result', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Task starts
    const taskStart: ContentBlock[] = [
      toolUse('toolu_task_fast', 'Task', { prompt: 'Quick lookup' }),
    ]
    extractToolStarts(taskStart, null, index, emitted)

    // Task returns immediately with no child tools spawned
    const taskResult: ContentBlock[] = [
      toolResult('toolu_task_fast', 'Cached result: 42'),
    ]
    const events = extractToolResults(taskResult, null, undefined, index)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolUseId: 'toolu_task_fast',
      toolName: 'Task',
      result: 'Cached result: 42',
    })
  })
})

// ============================================================================
// Fixture: Backgrounded task
// ============================================================================

describe('Fixture: Backgrounded Task', () => {
  it('detects background task from agentId in result', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Task starts
    const taskStart: ContentBlock[] = [
      toolUse('toolu_bg_task', 'Task', {
        prompt: 'Run comprehensive analysis',
        _intent: 'Analyze codebase',
        run_in_background: true,
      }),
    ]
    extractToolStarts(taskStart, null, index, emitted)

    // Task returns with agentId (backgrounded)
    const taskResult: ContentBlock[] = [
      toolResult('toolu_bg_task', 'Analysis started.\nagentId: bg_agent_xyz'),
    ]
    const events = extractToolResults(taskResult, null, undefined, index)

    // Should produce tool_result + task_backgrounded
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_bg_task',
    })
    expect(events[1]).toMatchObject({
      type: 'task_backgrounded',
      toolUseId: 'toolu_bg_task',
      taskId: 'bg_agent_xyz',
      intent: 'Analyze codebase',
    })
  })

  it('does NOT detect background for foreground Task with agentId in result', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    // Foreground Task — no run_in_background
    const taskStart: ContentBlock[] = [
      toolUse('toolu_fg_task', 'Task', {
        prompt: 'Quick lookup',
        _intent: 'Find something',
      }),
    ]
    extractToolStarts(taskStart, null, index, emitted)

    // Result happens to contain agentId (SDK correlation)
    const taskResult: ContentBlock[] = [
      toolResult('toolu_fg_task', 'Result found.\nagentId: fg_agent_abc'),
    ]
    const events = extractToolResults(taskResult, null, undefined, index)

    // Should ONLY produce tool_result — no task_backgrounded
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_fg_task',
    })
  })
})

// ============================================================================
// Fixture: Backgrounded Bash shell
// ============================================================================

describe('Fixture: Backgrounded Shell', () => {
  it('detects background shell from JSON backgroundTaskId', () => {
    const index = new ToolIndex()
    const emitted = new Set<string>()

    const bashStart: ContentBlock[] = [
      toolUse('toolu_bg_bash', 'Bash', {
        command: 'npm run test -- --watch',
        description: 'Run tests in watch mode',
        run_in_background: true,
      }),
    ]
    extractToolStarts(bashStart, null, index, emitted)

    const bashResult: ContentBlock[] = [
      toolResult('toolu_bg_bash', '{"backgroundTaskId": "shell_watch_123"}'),
    ]
    const events = extractToolResults(bashResult, null, undefined, index)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'shell_backgrounded',
      toolUseId: 'toolu_bg_bash',
      shellId: 'shell_watch_123',
      intent: 'Run tests in watch mode',
      command: 'npm run test -- --watch',
    })
  })
})
