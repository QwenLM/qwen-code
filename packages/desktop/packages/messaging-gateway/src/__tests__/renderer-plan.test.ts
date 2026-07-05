/**
 * Renderer — plan_submitted handling for Telegram.
 *
 * Covers:
 *   - Telegram + short plan: single sendButtons with inline content
 *   - Telegram + long plan: sendButtons with summary + sendFile attachment
 *   - Telegram without token registry: falls back to plain text
 *   - WhatsApp: keeps the legacy plain-text pointer (no buttons, no file)
 *   - recordPlanMessage callback fires for Telegram buttons only
 */

import { describe, expect, it } from 'bun:test'
import { Renderer, type SessionEvent } from '../renderer'
import { PlanTokenRegistry } from '../plan-tokens'
import {
  DEFAULT_BINDING_CONFIG,
  type AdapterCapabilities,
  type ChannelBinding,
  type PlatformAdapter,
  type PlatformType,
  type SentMessage,
  type InlineButton,
} from '../types'

interface Call {
  kind: 'sendText' | 'sendButtons' | 'sendFile' | 'clearButtons'
  channelId: string
  messageId?: string
  text?: string
  buttons?: InlineButton[]
  fileName?: string
  fileSize?: number
}

function makeAdapter(platform: PlatformType = 'telegram'): PlatformAdapter & { calls: Call[] } {
  const calls: Call[] = []
  let nextId = 100

  const caps: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: platform === 'telegram',
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: platform === 'telegram' ? 'v2' : 'whatsapp',
    webhookSupport: false,
  }

  return {
    platform,
    capabilities: caps,
    calls,
    async initialize() {},
    async destroy() {},
    isConnected() {
      return true
    },
    onMessage() {},
    onButtonPress() {},
    async sendText(channelId, text) {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendText', channelId, messageId, text })
      return { platform, channelId, messageId } as SentMessage
    },
    async editMessage() {},
    async sendButtons(channelId, text, buttons) {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendButtons', channelId, messageId, text, buttons })
      return { platform, channelId, messageId } as SentMessage
    },
    async sendTyping() {},
    async sendFile(channelId, file, fileName) {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendFile', channelId, messageId, fileName, fileSize: file.length })
      return { platform, channelId, messageId } as SentMessage
    },
    async clearButtons(channelId, messageId) {
      calls.push({ kind: 'clearButtons', channelId, messageId })
    },
  }
}

function makeBinding(platform: PlatformType, id = 'bind-1'): ChannelBinding {
  return {
    id,
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    platform,
    channelId: 'chan-1',
    enabled: true,
    createdAt: Date.now(),
    config: { ...DEFAULT_BINDING_CONFIG },
  }
}

function planEvent(content: string, planPath = '/tmp/plan.md'): SessionEvent {
  return {
    type: 'plan_submitted',
    sessionId: 'sess-1',
    message: {
      id: 'plan-1',
      role: 'plan',
      content,
      timestamp: Date.now(),
      planPath,
    },
  }
}

describe('Renderer — plan_submitted', () => {
  it('Telegram short plan: sends buttons with inline content', async () => {
    const tokens = new PlanTokenRegistry()
    const renderer = new Renderer({ planTokens: tokens })
    const adapter = makeAdapter('telegram')
    const binding = makeBinding('telegram')

    await renderer.handle(planEvent('# Plan\n\nStep 1'), binding, adapter)

    const sendButtons = adapter.calls.find((c) => c.kind === 'sendButtons')
    expect(sendButtons).toBeTruthy()
    expect(sendButtons?.text).toContain('Plan ready for review')
    expect(sendButtons?.text).toContain('Step 1')
    expect(sendButtons?.buttons).toHaveLength(2)
    expect(sendButtons?.buttons?.[0]?.id).toMatch(/^plan:accept:/)
    expect(sendButtons?.buttons?.[1]?.id).toMatch(/^plan:compact:/)

    // No file attachment for short plans
    expect(adapter.calls.some((c) => c.kind === 'sendFile')).toBe(false)
  })

  it('Telegram long plan: sends buttons + attached file', async () => {
    const tokens = new PlanTokenRegistry()
    const renderer = new Renderer({ planTokens: tokens })
    const adapter = makeAdapter('telegram')
    const binding = makeBinding('telegram')

    const longPlan = 'line\n'.repeat(1000) // ~5000 chars, above inline limit
    await renderer.handle(planEvent(longPlan), binding, adapter)

    const sendButtons = adapter.calls.find((c) => c.kind === 'sendButtons')
    const sendFile = adapter.calls.find((c) => c.kind === 'sendFile')

    expect(sendButtons).toBeTruthy()
    expect(sendButtons?.text).toContain('full plan attached')
    expect(sendFile).toBeTruthy()
    expect(sendFile?.fileName).toBe('plan.md')
    expect(sendFile?.fileSize).toBe(Buffer.byteLength(longPlan, 'utf-8'))
  })

  it('Telegram without token registry: falls back to plain text', async () => {
    const renderer = new Renderer() // no planTokens
    const adapter = makeAdapter('telegram')
    const binding = makeBinding('telegram')

    await renderer.handle(planEvent('# Plan'), binding, adapter)

    const text = adapter.calls.find((c) => c.kind === 'sendText')
    expect(text?.text).toContain('Open the desktop app')
    expect(adapter.calls.some((c) => c.kind === 'sendButtons')).toBe(false)
  })

  it('WhatsApp: legacy plain-text pointer, no buttons, no file', async () => {
    const tokens = new PlanTokenRegistry()
    const renderer = new Renderer({ planTokens: tokens })
    const adapter = makeAdapter('whatsapp')
    const binding = makeBinding('whatsapp')

    await renderer.handle(planEvent('# Plan'), binding, adapter)

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.kind).toBe('sendText')
    expect(adapter.calls[0]?.text).toContain('Open the desktop app')
  })

  it('recordPlanMessage callback fires with the rendering binding, token, messageId', async () => {
    const tokens = new PlanTokenRegistry()
    const recorded: Array<{ bindingId: string; sessionId: string; token: string; messageId: string }> = []
    const renderer = new Renderer({
      planTokens: tokens,
      recordPlanMessage: (b, t, m) => {
        recorded.push({ bindingId: b.id, sessionId: b.sessionId, token: t, messageId: m })
      },
    })
    const adapter = makeAdapter('telegram')
    const binding = makeBinding('telegram')

    await renderer.handle(planEvent('plan'), binding, adapter)

    expect(recorded).toHaveLength(1)
    const [rec] = recorded
    expect(rec?.bindingId).toBe(binding.id)
    expect(rec?.sessionId).toBe('sess-1')
    expect(rec?.token).toMatch(/^[A-Za-z0-9_-]{8}$/)
    expect(rec?.messageId).toBe('100')

    // Token was actually issued into the registry — including binding attribution.
    const resolved = tokens.resolve(rec!.token)
    expect(resolved?.sessionId).toBe('sess-1')
    expect(resolved?.bindingId).toBe(binding.id)
  })

  it('Telegram with empty plan content: buttons + hint, no file', async () => {
    const tokens = new PlanTokenRegistry()
    const renderer = new Renderer({ planTokens: tokens })
    const adapter = makeAdapter('telegram')
    const binding = makeBinding('telegram')

    await renderer.handle(planEvent(''), binding, adapter)

    const sendButtons = adapter.calls.find((c) => c.kind === 'sendButtons')
    expect(sendButtons).toBeTruthy()
    expect(sendButtons?.text).toContain('Open the desktop app to see the plan')
    expect(adapter.calls.some((c) => c.kind === 'sendFile')).toBe(false)
  })
})
