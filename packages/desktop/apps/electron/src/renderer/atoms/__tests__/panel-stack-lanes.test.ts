import { describe, it, expect } from 'bun:test'
import { createStore } from 'jotai'
import {
  panelStackAtom,
  focusedPanelIdAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  updateFocusedPanelRouteAtom,
  type PanelStackEntry,
} from '../panel-stack'

function getStack(store: ReturnType<typeof createStore>): PanelStackEntry[] {
  return store.get(panelStackAtom)
}

describe('panel stack single-lane behavior', () => {
  it('keeps insertion order for new panels', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'sources/source/github' })
    store.set(pushPanelAtom, { route: 'settings' })

    const stack = getStack(store)
    expect(stack).toHaveLength(3)
    expect(stack[0].route).toBe('allSessions/session/s1')
    expect(stack[1].route).toBe('sources/source/github')
    expect(stack[2].route).toBe('settings')
    expect(stack.every((p) => p.laneId === 'main')).toBe(true)
  })

  it('implicit navigation updates focused panel route', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'sources/source/github' })

    const sourcePanel = getStack(store).find((p) => p.route === 'sources/source/github')
    expect(sourcePanel).toBeDefined()
    store.set(focusedPanelIdAtom, sourcePanel!.id)

    store.set(updateFocusedPanelRouteAtom, 'allSessions/session/s2')

    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    expect(stack.some((p) => p.route === 'allSessions/session/s2')).toBe(true)
    expect(stack.some((p) => p.route === 'allSessions/session/s1')).toBe(true)
  })

  it('pushPanel afterIndex inserts immediately after the given panel', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })

    store.set(pushPanelAtom, { route: 'sources/source/linear', afterIndex: 0 })

    const stack = getStack(store)
    expect(stack).toHaveLength(3)
    expect(stack[0].route).toBe('allSessions/session/s1')
    expect(stack[1].route).toBe('sources/source/linear')
    expect(stack[2].route).toBe('allSessions/session/s2')
  })

  it('reconcile focuses by focusedIndex first when duplicate routes exist', () => {
    const store = createStore()

    const changed = store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    expect(changed).toBe(true)

    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    const focusedId = store.get(focusedPanelIdAtom)
    expect(focusedId).toBe(stack[1].id)
  })

  it('reconcile no-op keeps focused index target with duplicate routes', () => {
    const store = createStore()

    store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    const stack = getStack(store)
    const firstId = stack[0].id
    const secondId = stack[1].id
    expect(firstId).not.toBe(secondId)

    const changed = store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    expect(changed).toBe(false)
    expect(store.get(focusedPanelIdAtom)).toBe(secondId)
  })
})
