import { describe, expect, it } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import { resolveTextAnnotations } from '../annotation-resolver'

function makeAnnotation(selectors: AnnotationV1['target']['selectors']): AnnotationV1 {
  return {
    id: `ann-${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: 1,
    createdAt: Date.now(),
    intent: 'highlight',
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: 's1', messageId: 'm1' },
      selectors,
    },
  }
}

describe('resolveTextAnnotations', () => {
  it('resolves by valid text-position first', () => {
    const text = 'alpha beta gamma'
    const ann = makeAnnotation([
      { type: 'text-position', start: 6, end: 10 },
      { type: 'text-quote', exact: 'beta' },
    ])

    const result = resolveTextAnnotations(text, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.range).toEqual({ start: 6, end: 10 })
    expect(result.resolved[0]?.method).toBe('text-position')
    expect(result.unresolved).toHaveLength(0)
  })

  it('falls back to text-quote when text-position is invalid', () => {
    const text = 'alpha beta gamma'
    const ann = makeAnnotation([
      { type: 'text-position', start: 999, end: 1005 },
      { type: 'text-quote', exact: 'beta' },
    ])

    const result = resolveTextAnnotations(text, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.range).toEqual({ start: 6, end: 10 })
    expect(result.resolved[0]?.method).toBe('text-quote')
  })

  it('disambiguates quote matches using prefix and suffix', () => {
    const text = 'foo bar baz and foo bar qux'
    const ann = makeAnnotation([
      { type: 'text-quote', exact: 'bar', prefix: 'foo ', suffix: ' qux' },
    ])

    const result = resolveTextAnnotations(text, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.range).toEqual({ start: 20, end: 23 })
  })

  it('supports whitespace-normalized fallback matching', () => {
    const text = 'Line A\n\nLine B'
    const ann = makeAnnotation([
      { type: 'text-position', start: -1, end: 2 },
      { type: 'text-quote', exact: 'A Line', prefix: 'Line ', suffix: ' B' },
    ])

    const result = resolveTextAnnotations(text, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.method).toBe('text-quote')
  })

  it('returns unresolved when selectors cannot resolve', () => {
    const text = 'alpha beta gamma'
    const ann = makeAnnotation([
      { type: 'text-position', start: 99, end: 120 },
      { type: 'text-quote', exact: 'delta' },
    ])

    const result = resolveTextAnnotations(text, [ann])
    expect(result.resolved).toHaveLength(0)
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0]?.reason).toBe('quote-not-found')
  })
})
