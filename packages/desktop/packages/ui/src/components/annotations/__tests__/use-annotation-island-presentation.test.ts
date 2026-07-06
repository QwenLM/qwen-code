import { describe, expect, it } from 'bun:test'
import { decideAnnotationIslandPresentation } from '../use-annotation-island-presentation'

const GRACE = 220

describe('decideAnnotationIslandPresentation', () => {
  it('opens when anchor is provided', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: true,
      hasRenderAnchor: false,
      now: 1000,
      openedAt: 0,
      closeGraceMs: GRACE,
    })

    expect(decision).toEqual({ kind: 'open' })
  })

  it('opens even if a render anchor already exists (re-open during grace)', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: true,
      hasRenderAnchor: true,
      now: 100,
      openedAt: 50,
      closeGraceMs: GRACE,
    })

    expect(decision).toEqual({ kind: 'open' })
  })

  // Regression test: the bug was that an anchor=null arriving inside the grace
  // window returned silently and never retried — island stayed visible forever.
  it('defers the close when anchor clears inside the grace window', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: false,
      hasRenderAnchor: true,
      now: 1050,
      openedAt: 1000,
      closeGraceMs: GRACE,
    })

    expect(decision).toEqual({ kind: 'defer-close', afterMs: GRACE - 50 })
  })

  it('closes immediately once the grace window has elapsed', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: false,
      hasRenderAnchor: true,
      now: 1000 + GRACE,
      openedAt: 1000,
      closeGraceMs: GRACE,
    })

    expect(decision).toEqual({ kind: 'close-now' })
  })

  it('closes immediately when there is no render anchor to protect', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: false,
      hasRenderAnchor: false,
      now: 1050,
      openedAt: 1000,
      closeGraceMs: GRACE,
    })

    expect(decision).toEqual({ kind: 'close-now' })
  })

  it('treats a zero grace window as immediate close', () => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: false,
      hasRenderAnchor: true,
      now: 1000,
      openedAt: 1000,
      closeGraceMs: 0,
    })

    expect(decision).toEqual({ kind: 'close-now' })
  })
})
