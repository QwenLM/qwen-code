/**
 * Renderer tests — covers the three response modes.
 *
 *   - `streaming`: legacy behaviour, each text_complete finalises its own
 *     message; backwards-compatibility target.
 *   - `progress`: new default; single evolving message per run, intermediate
 *     text dropped, tool status reflected in-place.
 *   - `final_only`: silent until `complete`; single send with accumulated
 *     final text, no send if buffer is empty.
 *
 * Permissions and errors are mode-agnostic and tested separately.
 */

import { describe, expect, it, beforeEach } from 'bun:test'
import { Renderer, type SessionEvent } from '../renderer'
import {
  DEFAULT_BINDING_CONFIG,
  type AdapterCapabilities,
  type ChannelBinding,
  type PlatformAdapter,
  type SentMessage,
  type BindingConfig,
  type ResponseMode,
} from '../types'

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

interface Call {
  kind: 'sendText' | 'editMessage' | 'sendButtons' | 'sendTyping'
  channelId: string
  messageId?: string
  text?: string
}

function makeAdapter(
  capabilities: Partial<AdapterCapabilities> = {},
): PlatformAdapter & { calls: Call[] } {
  const calls: Call[] = []
  let nextId = 1

  const caps: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: 'v2',
    webhookSupport: false,
    ...capabilities,
  }

  const adapter: PlatformAdapter & { calls: Call[] } = {
    platform: 'telegram',
    capabilities: caps,
    calls,
    async initialize() {},
    async destroy() {},
    isConnected() {
      return true
    },
    onMessage() {},
    onButtonPress() {},
    async sendText(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendText', channelId, text, messageId })
      return { platform: 'telegram', channelId, messageId }
    },
    async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
      calls.push({ kind: 'editMessage', channelId, messageId, text })
    },
    async sendButtons(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendButtons', channelId, text, messageId })
      return { platform: 'telegram', channelId, messageId }
    },
    async sendTyping(channelId: string): Promise<void> {
      calls.push({ kind: 'sendTyping', channelId })
    },
    async sendFile(channelId: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      return { platform: 'telegram', channelId, messageId }
    },
  }

  return adapter
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBinding(overrides: Partial<BindingConfig> = {}): ChannelBinding {
  return {
    id: 'bind-1',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    platform: 'telegram',
    channelId: 'chan-1',
    enabled: true,
    createdAt: Date.now(),
    config: { ...DEFAULT_BINDING_CONFIG, ...overrides },
  }
}

async function play(
  renderer: Renderer,
  binding: ChannelBinding,
  adapter: PlatformAdapter,
  events: SessionEvent[],
): Promise<void> {
  for (const ev of events) {
    await renderer.handle(ev, binding, adapter)
  }
}

const ev = {
  delta: (s: string): SessionEvent => ({ type: 'text_delta', sessionId: 's', delta: s }),
  intermediate: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: true,
  }),
  final: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: false,
  }),
  // text_complete without an explicit isIntermediate flag — simulates
  // backends that don't set the field (older events or other agents).
  completeText: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
  }),
  toolStart: (displayName?: string): SessionEvent => ({
    type: 'tool_start',
    sessionId: 's',
    toolName: 'read',
    toolUseId: 'u1',
    toolInput: {},
    toolDisplayName: displayName,
  }),
  toolResult: (): SessionEvent => ({
    type: 'tool_result',
    sessionId: 's',
    toolUseId: 'u1',
    toolName: 'read',
    result: 'ok',
  }),
  complete: (): SessionEvent => ({ type: 'complete', sessionId: 's' }),
}

// ---------------------------------------------------------------------------
// progress mode (default)
// ---------------------------------------------------------------------------

describe('Renderer — progress mode (default)', () => {
  let renderer: Renderer
  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: tool run → evolving bubble → final text edit', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding() // default = progress
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    // Exactly one send (the initial bubble) + edits for status transitions + final.
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('🔧 Read…')

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // tool_result → '💭 thinking…', then complete → final text.
    expect(edits.map((e) => e.text)).toEqual(['💭 thinking…', 'The answer is 42.'])
  })

  it('text-only run: one send + one edit with final', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.delta('hello '),
      ev.delta('world'),
      ev.final('hello world'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('💭 thinking…')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toBe('hello world')
  })

  it('drops intermediate text — never appears in any message', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.intermediate('I am thinking about the question'),
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Final: 42'),
      ev.complete(),
    ])

    const all = adapter.calls
      .filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')
      .map((c) => c.text ?? '')
    expect(all.some((t) => t.includes('I am thinking'))).toBe(false)
    expect(all.some((t) => t.includes('Final: 42'))).toBe(true)
  })

  it('degrades to single send on complete for adapters without edit support', async () => {
    const adapter = makeAdapter({ messageEditing: false })
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // Bubble is posted (status only, cannot edit) + one final send via complete.
    expect(edits.length).toBe(0)
    expect(sends.map((s) => s.text)).toEqual(['🔧 Read…', 'The answer is 42.'])
  })

  it('collapses redundant status edits (same status twice = one edit total)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.toolResult(), // duplicate → should NOT emit a second edit to thinking
      ev.final('done'),
      ev.complete(),
    ])

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // thinking (from first tool_result) + final (from complete) = 2
    expect(edits.length).toBe(2)
    expect(edits[0]!.text).toBe('💭 thinking…')
    expect(edits[1]!.text).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// final_only mode
// ---------------------------------------------------------------------------

describe('Renderer — final_only mode', () => {
  let renderer: Renderer
  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: silent until complete, one send with concatenated final text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Part 1.'),
      ev.final('Part 2.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('Part 1.\n\nPart 2.')
  })

  it('empty completion: no send at all', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.toolStart('Read'), ev.toolResult(), ev.complete()])
    expect(adapter.calls.length).toBe(0)
  })

  it('treats text_complete without isIntermediate as final (backwards compat)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.completeText('legacy-shape-text'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('legacy-shape-text')
  })
})

// ---------------------------------------------------------------------------
// streaming mode (legacy — regression guard)
// ---------------------------------------------------------------------------

describe('Renderer — streaming mode (legacy)', () => {
  let renderer: Renderer
  beforeEach(() => {
    renderer = new Renderer()
  })

  it('each text_complete finalises its own message (legacy behaviour)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.delta('first'),
      ev.completeText('first'),
      ev.delta('second'),
      ev.completeText('second'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // Two separate messages, one per text_complete cycle.
    expect(sends.length).toBe(2)
    expect(sends[0]!.text).toBe('first')
    expect(sends[1]!.text).toBe('second')
  })
})

// ---------------------------------------------------------------------------
// Legacy config coercion (no responseMode field on BindingConfig)
// ---------------------------------------------------------------------------

describe('Renderer — legacy config coercion', () => {
  it('streamResponses=true with no responseMode → streaming behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    // Simulate a legacy binding (responseMode field absent).
    ;(binding.config as Partial<BindingConfig>).responseMode = undefined
    binding.config.streamResponses = true

    await play(renderer, binding, adapter, [ev.completeText('hi'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('hi')
  })

  it('streamResponses=false with no responseMode → final_only behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    ;(binding.config as Partial<BindingConfig>).responseMode = undefined
    binding.config.streamResponses = false

    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('done'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Permissions and errors (mode-agnostic)
// ---------------------------------------------------------------------------

describe('Renderer — permissions and errors', () => {
  it('permission_request sends buttons in chat channel', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )
    const buttons = adapter.calls.filter((c) => c.kind === 'sendButtons')
    expect(buttons.length).toBe(1)
  })

  it('error event emits ❌ message and resets state', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      { type: 'error', sessionId: 's', error: 'boom' } as SessionEvent,
      ev.complete(), // should be a no-op after reset
    ])
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // First send: the progress bubble. Second send: the error message.
    expect(sends.length).toBe(2)
    expect(sends[1]!.text).toContain('❌')
    expect(sends[1]!.text).toContain('boom')
  })
})


describe('Renderer — WhatsApp desktop-only approvals', () => {
  it('permission_request on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' })
    ;(adapter as any).platform = 'whatsapp'
    const binding = {
      ...makeBinding({ approvalChannel: 'chat' }),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )

    expect(adapter.calls.filter((c) => c.kind === 'sendButtons')).toHaveLength(0)
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('desktop app')
  })

  it('plan_submitted on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' })
    ;(adapter as any).platform = 'whatsapp'
    const binding = {
      ...makeBinding(),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'plan_submitted',
        sessionId: 's',
        message: { id: 'm1', role: 'assistant', content: 'Plan ready' } as any,
      } as SessionEvent,
      binding,
      adapter,
    )

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('plan is ready')
    expect(sends[0]!.text).toContain('desktop app')
  })
})
