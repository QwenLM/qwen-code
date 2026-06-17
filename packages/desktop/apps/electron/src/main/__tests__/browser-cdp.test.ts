/**
 * Tests for BrowserCDP (Chrome DevTools Protocol helpers).
 *
 * Mocks webContents.debugger to test accessibility snapshots,
 * element interaction, and CDP lifecycle management.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Mock logger before import
mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

const { BrowserCDP } = await import('../browser-cdp')

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockWebContents(sendCommandImpl?: (method: string, params?: any) => Promise<any>) {
  const listeners: Record<string, Function[]> = {}
  return {
    debugger: {
      attach: mock((_version: string) => {}),
      detach: mock(() => {}),
      sendCommand: mock(sendCommandImpl ?? (async () => ({ nodes: [] }))),
      on: mock((event: string, cb: Function) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
      }),
    },
    getURL: mock(() => 'https://example.com'),
    getTitle: mock(() => 'Example Page'),
    _debuggerListeners: listeners,
    _triggerDetach: () => {
      for (const cb of listeners['detach'] || []) cb()
    },
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('BrowserCDP', () => {
  describe('ensureAttached', () => {
    it('attaches debugger on first call', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Trigger attach via a CDP command
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
      expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    })

    it('skips attach on subsequent calls', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      await cdp.getAccessibilitySnapshot()
      await cdp.getAccessibilitySnapshot()

      expect(wc.debugger.attach).toHaveBeenCalledTimes(1)
    })

    it('handles already-attached error gracefully', async () => {
      const wc = createMockWebContents()
      wc.debugger.attach = mock(() => { throw new Error('Already attached to this target') })
      const cdp = new BrowserCDP(wc as any)

      // Should not throw
      await cdp.getAccessibilitySnapshot()
      expect(wc.debugger.sendCommand).toHaveBeenCalled()
    })

    it('registers detach listener only once', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Trigger ensureAttached multiple times by simulating detach + re-attach
      await cdp.getAccessibilitySnapshot()

      // Simulate detach
      wc._triggerDetach()

      // Re-attach
      await cdp.getAccessibilitySnapshot()

      // The 'on' for 'detach' should only be called once (guard prevents duplicates)
      const detachCalls = (wc.debugger.on as any).mock.calls.filter(
        (call: any[]) => call[0] === 'detach'
      )
      expect(detachCalls.length).toBe(1)
    })
  })

  describe('getAccessibilitySnapshot', () => {
    it('parses AX tree nodes and assigns refs', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 100 },
              { role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'test@example.com' }, backendDOMNodeId: 101, properties: [
                { name: 'focused', value: { value: true } },
              ]},
              { role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 102 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.url).toBe('https://example.com')
      expect(snapshot.title).toBe('Example Page')
      expect(snapshot.nodes).toHaveLength(3)

      expect(snapshot.nodes[0].ref).toBe('@e1')
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')

      expect(snapshot.nodes[1].ref).toBe('@e2')
      expect(snapshot.nodes[1].value).toBe('test@example.com')
      expect(snapshot.nodes[1].focused).toBe(true)

      expect(snapshot.nodes[2].ref).toBe('@e3')
      expect(snapshot.nodes[2].role).toBe('link')
    })

    it('keeps refs stable for same backend nodes across reordered snapshots', async () => {
      let snapshotCallCount = 0
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          snapshotCallCount += 1

          if (snapshotCallCount === 1) {
            return {
              nodes: [
                { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'created-oldest' }, backendDOMNodeId: 200 },
                { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              ],
            }
          }

          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Apply' }, backendDOMNodeId: 201 },
              { role: { value: 'combobox' }, name: { value: 'Sort' }, value: { value: 'updated-newest' }, backendDOMNodeId: 200 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const first = await cdp.getAccessibilitySnapshot()
      const second = await cdp.getAccessibilitySnapshot()

      const firstSortRef = first.nodes.find((n) => n.name === 'Sort')?.ref
      const secondSortRef = second.nodes.find((n) => n.name === 'Sort')?.ref

      expect(firstSortRef).toBeDefined()
      expect(secondSortRef).toBeDefined()
      expect(firstSortRef).toBe(secondSortRef)
    })

    it('skips non-interactive, non-content nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'generic' }, name: { value: '' } },       // Filtered: generic + no name
              { role: { value: 'none' }, name: { value: '' } },          // Filtered: none + no name
              { role: { value: 'button' }, name: { value: 'OK' } },      // Kept: interactive
              { role: { value: 'heading' }, name: { value: 'Title' } },  // Kept: content + name
              { role: { value: 'heading' }, name: { value: '' } },       // Filtered: content without name
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[1].role).toBe('heading')
    })

    it('caps at 500 nodes', async () => {
      const manyNodes = Array.from({ length: 600 }, (_, i) => ({
        role: { value: 'button' },
        name: { value: `Button ${i}` },
        backendDOMNodeId: i,
      }))

      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: manyNodes }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(500)
      expect(snapshot.nodes[499].ref).toBe('@e500')
    })

    it('normalizes role casing for primary filtering', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'Button' }, name: { value: 'Submit' }, backendDOMNodeId: 1 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.nodes[0].role).toBe('button')
      expect(snapshot.nodes[0].name).toBe('Submit')
    })

    it('uses fallback selection when primary filtering keeps zero nodes', async () => {
      const wc = createMockWebContents(async (method) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'grouping' }, name: { value: 'Recents List' }, backendDOMNodeId: 21 },
              { role: { value: 'pane' }, name: { value: 'Shared Files' }, backendDOMNodeId: 22 },
            ],
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0].name).toBe('Recents List')
      expect(snapshot.nodes[1].name).toBe('Shared Files')
    })

    it('keeps fallback nodes clickable through ref mapping', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'pane' }, name: { value: 'Canvas Action' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-42' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      const snapshot = await cdp.getAccessibilitySnapshot()

      expect(snapshot.nodes).toHaveLength(1)
      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')
    })
  })

  describe('clickElement', () => {
    it('throws for unknown ref', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      await expect(cdp.clickElement('@e99')).rejects.toThrow('not found')
    })

    it('resolves node and dispatches mouse events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method, params) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'button' }, name: { value: 'Click' }, backendDOMNodeId: 42 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-42' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot() // Populate refMap

      await cdp.clickElement('@e1')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('DOM.getBoxModel')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
      expect(sentCommands).toContain('Input.dispatchMouseEvent')

      const scrollIndex = sentCommands.indexOf('Runtime.callFunctionOn')
      const boxModelIndex = sentCommands.indexOf('DOM.getBoxModel')
      expect(scrollIndex).toBeGreaterThan(-1)
      expect(boxModelIndex).toBeGreaterThan(-1)
      expect(scrollIndex).toBeLessThan(boxModelIndex)
    })
  })

  describe('fillElement', () => {
    it('focuses, clears, and types characters', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'textbox' }, name: { value: 'Input' }, backendDOMNodeId: 10 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-10' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      await cdp.fillElement('@e1', 'ab')

      expect(sentCommands).toContain('DOM.focus')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
      // Two characters typed: 2 keyDown + 2 keyUp = 4 key events
      const keyEvents = sentCommands.filter(c => c === 'Input.dispatchKeyEvent')
      expect(keyEvents.length).toBe(4)
    })
  })

  describe('selectOption', () => {
    it('sets value and dispatches events', async () => {
      const sentCommands: string[] = []
      const wc = createMockWebContents(async (method) => {
        sentCommands.push(method)
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { role: { value: 'combobox' }, name: { value: 'Country' }, backendDOMNodeId: 20 },
            ],
          }
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'obj-20' } }
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 10, 50, 10, 50, 50, 10, 50] } }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.getAccessibilitySnapshot()

      await cdp.selectOption('@e1', 'US')

      expect(sentCommands).toContain('DOM.resolveNode')
      expect(sentCommands).toContain('Runtime.callFunctionOn')
    })
  })

  describe('drag', () => {
    it('dispatches pressed -> moved -> released with expected button state', async () => {
      const mouseEvents: any[] = []
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(params)
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await cdp.drag(10, 20, 110, 20)

      expect(mouseEvents.length).toBeGreaterThan(2)
      expect(mouseEvents[0]).toMatchObject({
        type: 'mousePressed',
        x: 10,
        y: 20,
        button: 'left',
        buttons: 1,
      })

      const movedEvents = mouseEvents.filter((event) => event.type === 'mouseMoved')
      expect(movedEvents.length).toBeGreaterThan(0)
      for (const event of movedEvents) {
        expect(event.buttons).toBe(1)
      }

      const lastEvent = mouseEvents[mouseEvents.length - 1]
      expect(lastEvent).toMatchObject({
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
      })
    })

    it('attempts release even when a move event fails and rethrows original error', async () => {
      const mouseEvents: any[] = []
      let failedOnce = false
      const wc = createMockWebContents(async (method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseEvents.push(params)
          if (params?.type === 'mouseMoved' && !failedOnce) {
            failedOnce = true
            throw new Error('move failed')
          }
        }
        return {}
      })

      const cdp = new BrowserCDP(wc as any)
      await expect(cdp.drag(0, 0, 100, 0)).rejects.toThrow('move failed')
      expect(mouseEvents.some((event) => event.type === 'mouseReleased')).toBe(true)
    })
  })

  describe('detach', () => {
    it('detaches debugger', async () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Attach first
      await cdp.getAccessibilitySnapshot()

      cdp.detach()
      expect(wc.debugger.detach).toHaveBeenCalled()
    })

    it('is safe to call when not attached', () => {
      const wc = createMockWebContents()
      const cdp = new BrowserCDP(wc as any)

      // Should not throw
      expect(() => cdp.detach()).not.toThrow()
    })
  })
})
