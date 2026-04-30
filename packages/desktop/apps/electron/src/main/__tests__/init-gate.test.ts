import { describe, it, expect } from 'bun:test'
import { InitGate } from '@craft-agent/server-core/domain'

describe('InitGate', () => {
  it('resolves waiters when marked ready', async () => {
    const gate = new InitGate()
    const waiting = gate.wait()
    gate.markReady()
    await expect(waiting).resolves.toBeUndefined()
  })

  it('rejects waiters when marked failed', async () => {
    const gate = new InitGate()
    const error = new Error('init failed')
    gate.markFailed(error)
    await expect(gate.wait()).rejects.toThrow('init failed')
  })

  it('settles only once', async () => {
    const gate = new InitGate()
    gate.markReady()
    gate.markFailed(new Error('should be ignored'))
    await expect(gate.wait()).resolves.toBeUndefined()
  })

  it('ignores ready when already failed', async () => {
    const gate = new InitGate()
    gate.markFailed(new Error('boom'))
    gate.markReady()
    await expect(gate.wait()).rejects.toThrow('boom')
  })
})
