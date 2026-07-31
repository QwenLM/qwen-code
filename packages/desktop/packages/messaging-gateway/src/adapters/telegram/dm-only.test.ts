/**
 * Tests for the DM-only guard in the Telegram adapter.
 *
 * Exercising the real grammY Bot#on handlers requires network access
 * (getUpdates polling) and is wasteful for what's effectively a
 * `ctx.chat.type === 'private'` check. Instead we unit-test the exported
 * `isPrivateChat` predicate directly — it's the single source of truth
 * used by every handler — and rely on typecheck + code review to confirm
 * each handler calls it.
 */
import { describe, it, expect } from 'bun:test'
import type { Context } from 'grammy'
import { isPrivateChat } from './index'

function ctxWithChatType(type: string | undefined): Context {
  return { chat: type ? { type } : undefined } as unknown as Context
}

describe('isPrivateChat', () => {
  it('accepts private chats', () => {
    expect(isPrivateChat(ctxWithChatType('private'))).toBe(true)
  })

  it('rejects group chats', () => {
    expect(isPrivateChat(ctxWithChatType('group'))).toBe(false)
  })

  it('rejects supergroups', () => {
    expect(isPrivateChat(ctxWithChatType('supergroup'))).toBe(false)
  })

  it('rejects channels', () => {
    expect(isPrivateChat(ctxWithChatType('channel'))).toBe(false)
  })

  it('rejects contexts without a chat', () => {
    expect(isPrivateChat(ctxWithChatType(undefined))).toBe(false)
  })
})
