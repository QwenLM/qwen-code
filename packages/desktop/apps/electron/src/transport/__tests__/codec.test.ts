/**
 * Codec tests — envelope validation and serialization edge cases.
 */

import { describe, it, expect } from 'bun:test'
import { validateEnvelopeShape, deserializeEnvelope, serializeEnvelope } from '../codec'

describe('validateEnvelopeShape', () => {
  it('rejects non-object', () => {
    expect(validateEnvelopeShape(null)).toBe(false)
    expect(validateEnvelopeShape('hello')).toBe(false)
    expect(validateEnvelopeShape(42)).toBe(false)
  })

  it('rejects missing id', () => {
    expect(validateEnvelopeShape({ type: 'request', channel: 'test' })).toBe(false)
  })

  it('rejects empty id', () => {
    expect(validateEnvelopeShape({ id: '', type: 'request', channel: 'test' })).toBe(false)
  })

  it('rejects unknown type', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'unknown' })).toBe(false)
  })

  it('accepts valid request', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'request', channel: 'test' })).toBe(true)
  })

  it('rejects request without channel', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'request' })).toBe(false)
  })

  it('accepts valid event', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'event', channel: 'test' })).toBe(true)
  })

  it('rejects event without channel', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'event' })).toBe(false)
  })

  // handshake_ack validation
  it('accepts handshake_ack with clientId', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'handshake_ack', clientId: 'abc-123' })).toBe(true)
  })

  it('rejects handshake_ack without clientId', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'handshake_ack' })).toBe(false)
  })

  it('rejects handshake_ack with empty clientId', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'handshake_ack', clientId: '' })).toBe(false)
  })

  it('rejects handshake_ack with numeric clientId', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'handshake_ack', clientId: 42 })).toBe(false)
  })

  // error code flexibility
  it('accepts response with string error code', () => {
    expect(validateEnvelopeShape({
      id: '1', type: 'response', error: { code: 'HANDLER_ERROR', message: 'fail' },
    })).toBe(true)
  })

  it('accepts response with numeric error code', () => {
    expect(validateEnvelopeShape({
      id: '1', type: 'response', error: { code: 404, message: 'not found' },
    })).toBe(true)
  })

  it('rejects response with error missing message', () => {
    expect(validateEnvelopeShape({
      id: '1', type: 'response', error: { code: 'ERR' },
    })).toBe(false)
  })

  it('accepts response without error (success)', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'response', result: 42 })).toBe(true)
  })

  it('accepts error envelope with numeric code', () => {
    expect(validateEnvelopeShape({
      id: '1', type: 'error', error: { code: 500, message: 'internal' },
    })).toBe(true)
  })

  it('rejects error envelope without error field', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'error' })).toBe(false)
  })

  it('accepts valid handshake', () => {
    expect(validateEnvelopeShape({ id: '1', type: 'handshake' })).toBe(true)
  })
})

describe('deserializeEnvelope', () => {
  it('roundtrips a valid envelope', () => {
    const envelope = { id: '1', type: 'request' as const, channel: 'test', args: [1, 'two'] }
    const raw = serializeEnvelope(envelope as any)
    const decoded = deserializeEnvelope(raw)
    expect(decoded.id).toBe('1')
    expect(decoded.channel).toBe('test')
    expect(decoded.args).toEqual([1, 'two'])
  })

  it('throws on invalid envelope shape', () => {
    expect(() => deserializeEnvelope(JSON.stringify({ type: 'request' }))).toThrow('Invalid envelope shape')
  })

  it('throws on non-JSON', () => {
    expect(() => deserializeEnvelope('not json')).toThrow()
  })
})
