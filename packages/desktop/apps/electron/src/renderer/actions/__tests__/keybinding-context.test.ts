import { afterEach, describe, expect, it } from 'bun:test'
import { setDismissibleLayerBridge } from '../../lib/dismissible-layer-bridge'
import { getKeybindingContext } from '../keybinding-context'

const originalDocument = globalThis.document

afterEach(() => {
  setDismissibleLayerBridge(null)
  ;(globalThis as unknown as { document: Document | undefined }).document = originalDocument
})

describe('getKeybindingContext', () => {
  it('sets menuOpen=true when dismissible stack has open layers', () => {
    setDismissibleLayerBridge({
      registerLayer: () => () => {},
      hasOpenLayers: () => true,
      getTopLayer: () => ({ id: 'island-1', type: 'island', priority: 200 }),
      closeTop: () => true,
      handleEscape: () => true,
    })

    ;(globalThis as unknown as { document: { querySelector: (_selector: string) => null } }).document = {
      querySelector: () => null,
    }

    const event = {
      target: { tagName: 'DIV', isContentEditable: false },
    } as unknown as KeyboardEvent

    const context = getKeybindingContext(event)
    expect(context.menuOpen).toBe(true)
  })

  it('sets menuOpen=true when island dialog overlay is open', () => {
    ;(globalThis as unknown as { document: { querySelector: (selector: string) => object | null } }).document = {
      querySelector: (selector: string) => {
        if (selector.includes('[data-ca-island-dialog="true"][data-state="open"]')) {
          return {}
        }

        return null
      },
    }

    const event = {
      target: { tagName: 'DIV', isContentEditable: false },
    } as unknown as KeyboardEvent

    const context = getKeybindingContext(event)
    expect(context.menuOpen).toBe(true)
  })

  it('sets menuOpen=false when no overlay is open', () => {
    ;(globalThis as unknown as { document: { querySelector: (_selector: string) => null } }).document = {
      querySelector: () => null,
    }

    const event = {
      target: { tagName: 'DIV', isContentEditable: false },
    } as unknown as KeyboardEvent

    const context = getKeybindingContext(event)
    expect(context.menuOpen).toBe(false)
  })
})
