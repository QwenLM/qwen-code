/**
 * Router tests — focused on attachment forwarding.
 *
 * Covers:
 *   - text-only messages forward to sessionManager.sendMessage unchanged
 *     (regression guard for the Phase-3 rewrite).
 *   - attachments with `localPath` are materialized to FileAttachment[]
 *     and forwarded.
 *   - attachments missing `localPath` are silently dropped.
 *   - caption-less attachments still produce a send with empty text.
 *   - unbound channels fall through to Commands.handle.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Router } from '../router'
import { BindingStore } from '../binding-store'
import type { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter } from '../types'

// Minimal 1×1 red PNG — small, valid, triggers image-type detection.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let storeDir: string
let fileDir: string

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'router-store-'))
  fileDir = mkdtempSync(join(tmpdir(), 'router-files-'))
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(fileDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTinyPng(): string {
  const path = join(fileDir, 'tiny.png')
  writeFileSync(path, Buffer.from(TINY_PNG_B64, 'base64'))
  return path
}

function baseMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'telegram',
    channelId: 'chat-1',
    messageId: '1',
    senderId: 'user-1',
    text: 'hello',
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

function makeFakeAdapter(): PlatformAdapter {
  // Only sendText is exercised by Router (for error branch); rest are unused.
  const noop = async () => {
    throw new Error('unused')
  }
  return {
    platform: 'telegram',
    capabilities: {
      messageEditing: true,
      inlineButtons: true,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: 'v2',
      webhookSupport: false,
    },
    initialize: noop,
    destroy: noop,
    isConnected: () => true,
    onMessage: () => {},
    onButtonPress: () => {},
    sendText: mock(async () => ({ platform: 'telegram', channelId: 'chat-1', messageId: 'm' })),
    editMessage: noop,
    sendButtons: noop,
    sendTyping: async () => {},
    sendFile: noop,
  } as unknown as PlatformAdapter
}

function makeFakeSessionManager(): { sendMessage: ReturnType<typeof mock> } {
  return { sendMessage: mock(async () => {}) }
}

function makeFakeCommands(): { handle: ReturnType<typeof mock> } {
  return { handle: mock(async () => {}) }
}

function makeRouter() {
  const store = new BindingStore(storeDir)
  store.bind('ws1', 'sess-A', 'telegram', 'chat-1')
  const sessionManager = makeFakeSessionManager()
  const commands = makeFakeCommands()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new Router(sessionManager as any, store, commands as unknown as Commands)
  return { router, store, sessionManager, commands }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router', () => {
  it('forwards a text-only bound message to sendMessage', async () => {
    const { router, sessionManager } = makeRouter()
    await router.route(makeFakeAdapter(), baseMsg({ text: 'hi there' }))
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[0]).toBe('sess-A') // sessionId
    expect(args[1]).toBe('hi there') // message
    expect(args[2]).toBeUndefined() // fileAttachments
  })

  it('materializes a localPath attachment into FileAttachment[]', async () => {
    const { router, sessionManager } = makeRouter()
    const pngPath = writeTinyPng()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: 'what is this?',
        attachments: [
          {
            type: 'photo',
            fileId: 'abc',
            fileName: 'my-photo.png',
            mimeType: 'image/png',
            localPath: pngPath,
          },
        ],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    const fileAttachments = args[2] as Array<{
      type: string
      name: string
      base64?: string
    }>
    expect(fileAttachments).toHaveLength(1)
    const first = fileAttachments[0]!
    expect(first.type).toBe('image')
    expect(first.name).toBe('my-photo.png')
    expect(first.base64 && first.base64.length).toBeGreaterThan(0)
  })

  it('drops attachments that have no localPath', async () => {
    const { router, sessionManager } = makeRouter()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: 'x',
        attachments: [{ type: 'photo', fileId: 'abc' }],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[2]).toBeUndefined()
  })

  it('forwards caption-less attachments with empty text', async () => {
    const { router, sessionManager } = makeRouter()
    const pngPath = writeTinyPng()
    await router.route(
      makeFakeAdapter(),
      baseMsg({
        text: '',
        attachments: [
          { type: 'photo', fileId: 'abc', localPath: pngPath },
        ],
      }),
    )
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1)
    const args = sessionManager.sendMessage.mock.calls[0]!
    expect(args[1]).toBe('')
    const fa = args[2] as unknown[]
    expect(fa).toHaveLength(1)
  })

  it('routes unbound channels to Commands.handle', async () => {
    const { router, sessionManager, commands } = makeRouter()
    await router.route(
      makeFakeAdapter(),
      baseMsg({ channelId: 'unbound-channel', text: '/help' }),
    )
    expect(sessionManager.sendMessage).not.toHaveBeenCalled()
    expect(commands.handle).toHaveBeenCalledTimes(1)
  })
})
