import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listSessions } from '../storage'
import { readSessionHeader, readSessionJsonl, writeSessionJsonl } from '../jsonl'
import type { StoredSession } from '../types'

const tempRoots: string[] = []

function makeWorkspaceRoot(): string {
  const root = join(tmpdir(), `session-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  tempRoots.push(root)
  return root
}

function makeStoredSession(workspaceRoot: string): StoredSession {
  return {
    id: '260508-provider-managed',
    workspaceRootPath: workspaceRoot,
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Provider Managed',
    model: 'qwen3-coder',
    llmConnection: 'qwen-code',
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
})

describe('session model persistence', () => {
  it('does not write session model into JSONL headers', () => {
    const workspaceRoot = makeWorkspaceRoot()
    const session = makeStoredSession(workspaceRoot)
    const sessionDir = join(workspaceRoot, 'sessions', session.id)
    mkdirSync(sessionDir, { recursive: true })

    const sessionFile = join(sessionDir, 'session.jsonl')
    writeSessionJsonl(sessionFile, session)

    const header = JSON.parse(readFileSync(sessionFile, 'utf-8').split('\n')[0]!)
    expect(header.model).toBeUndefined()

    const loaded = readSessionJsonl(sessionFile)
    expect(loaded?.model).toBeUndefined()
  })

  it('ignores legacy session model values when listing and loading', () => {
    const workspaceRoot = makeWorkspaceRoot()
    const session = makeStoredSession(workspaceRoot)
    const sessionDir = join(workspaceRoot, 'sessions', session.id)
    mkdirSync(sessionDir, { recursive: true })

    const sessionFile = join(sessionDir, 'session.jsonl')
    writeFileSync(sessionFile, `${JSON.stringify({
      ...session,
      messageCount: 0,
      tokenUsage: session.tokenUsage,
    })}\n`)

    const [listed] = listSessions(workspaceRoot)
    expect(listed?.model).toBeUndefined()

    const header = readSessionHeader(sessionFile)
    expect(header?.model).toBeUndefined()

    const loaded = readSessionJsonl(sessionFile)
    expect(loaded?.model).toBeUndefined()
  })

  it('can omit provider-derived JSONL header fields for provider-native history', () => {
    const workspaceRoot = makeWorkspaceRoot()
    const session = {
      ...makeStoredSession(workspaceRoot),
      omitMessageDerivedHeaderFields: true,
      omitTranscriptDerivedHeaderFields: true,
    } as StoredSession & {
      omitMessageDerivedHeaderFields: true
      omitTranscriptDerivedHeaderFields: true
    }
    const sessionDir = join(workspaceRoot, 'sessions', session.id)
    mkdirSync(sessionDir, { recursive: true })

    const sessionFile = join(sessionDir, 'session.jsonl')
    writeSessionJsonl(sessionFile, session)

    const header = JSON.parse(readFileSync(sessionFile, 'utf-8').split('\n')[0]!)
    expect(header.createdAt).toBeUndefined()
    expect(header.lastUsedAt).toBeUndefined()
    expect(header.lastMessageAt).toBeUndefined()
    expect(header.llmConnection).toBeUndefined()
    expect(header.connectionLocked).toBeUndefined()
    expect(header.messageCount).toBeUndefined()
    expect(header.preview).toBeUndefined()
    expect(header.lastMessageRole).toBeUndefined()
    expect(header.lastFinalMessageId).toBeUndefined()
  })

  it('can preserve provider-native timestamps while omitting message-derived fields', () => {
    const workspaceRoot = makeWorkspaceRoot()
    const session = {
      ...makeStoredSession(workspaceRoot),
      createdAt: 11,
      lastUsedAt: 22,
      lastMessageAt: 22,
      omitMessageDerivedHeaderFields: true,
      preserveSessionTimestamps: true,
    } as StoredSession & {
      omitMessageDerivedHeaderFields: true
      preserveSessionTimestamps: true
    }
    const sessionDir = join(workspaceRoot, 'sessions', session.id)
    mkdirSync(sessionDir, { recursive: true })

    const sessionFile = join(sessionDir, 'session.jsonl')
    writeSessionJsonl(sessionFile, session)

    const header = JSON.parse(readFileSync(sessionFile, 'utf-8').split('\n')[0]!)
    expect(header.createdAt).toBe(11)
    expect(header.lastUsedAt).toBe(22)
    expect(header.lastMessageAt).toBe(22)
    expect(header.messageCount).toBeUndefined()
    expect(header.preview).toBeUndefined()
  })
})
