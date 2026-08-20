/**
 * Tests for the browser tools factory.
 *
 * Verifies that createBrowserTools produces a single browser_tool
 * and that it delegates correctly to BrowserPaneFns callbacks via CLI commands.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { createBrowserTools, type BrowserPaneFns } from '../browser-tools'

// ============================================================================
// Mock BrowserPaneFns
// ============================================================================

function createMockFns(): BrowserPaneFns {
  return {
    openPanel: async () => ({ instanceId: 'browser-test-1' }),
    navigate: async (url: string) => ({ url: `https://${url}`, title: 'Test Page' }),
    snapshot: async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [
        { ref: '@e1', role: 'button', name: 'Click me' },
        { ref: '@e2', role: 'textbox', name: 'Search', value: '', focused: true },
      ],
    }),
    click: async (_ref: string) => {},
    clickAt: async (_x: number, _y: number) => {},
    drag: async (_x1: number, _y1: number, _x2: number, _y2: number) => {},
    fill: async (_ref: string, _value: string) => {},
    type: async (_text: string) => {},
    select: async (_ref: string, _value: string) => {},
    setClipboard: async (_text: string) => {},
    getClipboard: async () => 'clipboard content',
    screenshot: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    screenshotRegion: async () => ({ imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }),
    getConsoleLogs: async () => ([
      { timestamp: Date.now(), level: 'warn', message: 'Test warning' },
    ]),
    windowResize: async (args) => ({ width: args.width, height: args.height }),
    getNetworkLogs: async () => ([
      { timestamp: Date.now(), method: 'GET', url: 'https://example.com/api', status: 500, resourceType: 'xhr', ok: false },
    ]),
    waitFor: async (args) => ({ ok: true as const, kind: args.kind, elapsedMs: 123, detail: 'condition met' }),
    sendKey: async (_args) => {},
    getDownloads: async () => ([
      { id: 'dl-1', timestamp: Date.now(), url: 'https://example.com/file.pdf', filename: 'file.pdf', state: 'completed', bytesReceived: 100, totalBytes: 100, mimeType: 'application/pdf' },
    ]),
    upload: async (_ref: string, _filePaths: string[]) => {},
    scroll: async (_dir: 'up' | 'down' | 'left' | 'right', _amount?: number) => {},
    goBack: async () => {},
    goForward: async () => {},
    evaluate: async (expr: string) => eval(expr),
    focusWindow: async (instanceId?: string) => ({ instanceId: instanceId ?? 'browser-1', title: 'Example Domain', url: 'https://example.com' }),
    releaseControl: async (_instanceId?: string) => ({ action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    closeWindow: async (_instanceId?: string) => ({ action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    hideWindow: async (_instanceId?: string) => ({ action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }),
    listWindows: async () => ([
      {
        id: 'browser-1',
        title: 'Example Domain',
        url: 'https://example.com',
        isVisible: true,
        ownerType: 'session',
        ownerSessionId: 'test-session',
        boundSessionId: 'test-session',
        agentControlActive: true,
      },
    ]),
    detectChallenge: async () => ({ detected: false, provider: 'none', signals: [] }),
  }
}

// ============================================================================
// Helper: execute a tool by name
// ============================================================================

function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  // SDK tool objects have a .name property
  return tools.find((t: any) => t.name === name)
}

async function executeTool(tools: ReturnType<typeof createBrowserTools>, name: string, args: Record<string, unknown> = {}) {
  const t = findTool(tools, name) as any
  if (!t) throw new Error(`Tool "${name}" not found`)
  // SDK tools have an execute/handler function — use the handler directly
  return t.handler(args)
}

// ============================================================================
// Tests
// ============================================================================

describe('createBrowserTools', () => {
  let mockFns: BrowserPaneFns
  let tools: ReturnType<typeof createBrowserTools>

  beforeEach(() => {
    mockFns = createMockFns()
    tools = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
  })

  it('returns exactly 1 tool (browser_tool only)', () => {
    expect(tools.length).toBe(1)
  })

  it('exposes only browser_tool', () => {
    const names = tools.map((t: any) => t.name)
    expect(names).toEqual(['browser_tool'])
  })

  describe('browser_tool', () => {
    it('returns help text for --help without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: '--help' })
      expect(result.content[0].text).toContain('browser_tool command help')
      expect(result.content[0].text).toContain('navigate <url>')
      expect(result.content[0].text).toContain('find <query>')
      expect(result.content[0].text).toContain('click-at <x> <y>')
      expect(result.content[0].text).toContain('type <text>')
      expect(result.content[0].text).toContain('upload <ref> <path> [path2...]')
      expect(result.content[0].text).toContain('set-clipboard <text>')
      expect(result.content[0].text).toContain('get-clipboard')
      expect(result.content[0].text).toContain('paste <text>')
      expect(result.content[0].text).toContain('screenshot [--annotated|-a]')
      expect(result.content[0].text).toContain('focus [windowId]')
      expect(result.content[0].text).toContain('windows')
      expect(result.content[0].text).toContain('Array mode (JSON array input, no batch splitting/tokenization):')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes navigate command and appends release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(result.content[0].text).toContain('Navigated to')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('releases control when navigate lands on a security challenge', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'navigate example.com' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes open command in background by default', async () => {
      let openOptions: { background?: boolean } | undefined
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(openOptions).toEqual({ background: true })
      expect(result.content[0].text).toContain('Opened in-app browser window in background')
      expect(result.content[0].text).toContain('browser-test-1')
    })

    it('routes open command with --foreground flag and reports settled visibility', async () => {
      let openOptions: { background?: boolean } | undefined
      let listCalls = 0
      mockFns.openPanel = async (options) => {
        openOptions = options
        return { instanceId: 'browser-test-1' }
      }
      mockFns.listWindows = async () => {
        listCalls += 1
        const isVisible = listCalls >= 3
        return [{
          id: 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
          isVisible,
          ownerType: 'session',
          ownerSessionId: 'test-session',
          boundSessionId: 'test-session',
          agentControlActive: true,
        }]
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
      expect(openOptions).toEqual({ background: false })
      expect(result.content[0].text).toContain('Opened in-app browser window in foreground')
      expect(result.content[0].text).toContain('Visibility settle: wait-loop')
      expect(result.content[0].text).toContain('Visible: true')
    })

    it('uses focus fallback when foreground open visibility does not settle in wait loop', async () => {
      const previousTimeout = process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
      const previousPoll = process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
      process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = '120'
      process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = '20'

      try {
        let focusCalls = 0
        let listCalls = 0
        mockFns.listWindows = async () => {
          listCalls += 1
          const isVisible = focusCalls > 0
          return [{
            id: 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
            isVisible,
            ownerType: 'session',
            ownerSessionId: 'test-session',
            boundSessionId: 'test-session',
            agentControlActive: true,
          }]
        }
        mockFns.focusWindow = async (instanceId?: string) => {
          focusCalls += 1
          return {
            instanceId: instanceId ?? 'browser-test-1',
            title: 'Example Domain',
            url: 'https://example.com',
          }
        }

        const result = await executeTool(tools, 'browser_tool', { command: 'open --foreground' })
        expect(listCalls).toBeGreaterThan(2)
        expect(focusCalls).toBe(1)
        expect(result.content[0].text).toContain('Visibility settle: timeout + focus retry')
        expect(result.content[0].text).toContain('Visible: true')
      } finally {
        if (previousTimeout === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS = previousTimeout

        if (previousPoll === undefined) delete process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS
        else process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS = previousPoll
      }
    })

    it('does not use focus fallback for background open', async () => {
      let focusCalls = 0
      mockFns.focusWindow = async (instanceId?: string) => {
        focusCalls += 1
        return {
          instanceId: instanceId ?? 'browser-test-1',
          title: 'Example Domain',
          url: 'https://example.com',
        }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'open' })
      expect(focusCalls).toBe(0)
      expect(result.content[0].text).not.toContain('Visibility settle:')
    })

    it('routes snapshot command and formats nodes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      const text = result.content[0].text
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
      expect(text).toContain('"Click me"')
      expect(text).toContain('(focused)')
    })

    it('treats near-zero actionable snapshot as challenge state and attaches screenshot', async () => {
      let releaseCalls = 0
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [
          { ref: '@e1', role: 'staticText', name: 'Checking your browser before accessing' },
        ],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['text:checking-browser'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 1 accessibility nodes.')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/jpeg')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('still reports challenge when screenshot capture fails or is empty', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://protected.example.com',
        title: 'Protected',
        nodes: [],
      })
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['title:just-a-moment'],
      })
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })

      const result = await executeTool(tools, 'browser_tool', { command: 'snapshot' })
      expect(result.content[0].text).toContain('Security verification detected (cloudflare).')
      expect(result.content[0].text).toContain('Detected only 0 actionable element(s) out of 0 accessibility nodes.')
      expect(result.content.some((item: any) => item.type === 'image')).toBe(false)
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes find command and returns matching refs', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find click button' })
      const text = result.content[0].text
      expect(text).toContain('Found 1 element(s)')
      expect(text).toContain('@e1')
      expect(text).toContain('[button]')
    })

    it('returns helpful message for find command with no matches', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'find this-does-not-exist' })
      expect(result.content[0].text).toContain('No elements found matching')
    })

    it('routes click command', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

    it('routes click with wait arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1 network-idle 5000' })
      expect(result.content[0].text).toContain('waitFor=network-idle')
    })

    it('detects security challenge after click even when URL does not change', async () => {
      let releaseCalls = 0
      mockFns.detectChallenge = async () => ({
        detected: true,
        provider: 'cloudflare',
        signals: ['dom:challenge-form'],
      })
      mockFns.releaseControl = async (_instanceId?: string) => {
        releaseCalls += 1
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'click @e1' })
      expect(releaseCalls).toBe(1)
      expect(result.content[0].text).toContain('security challenge detected (cloudflare)')
      expect(result.content[0].text).toContain('URL changed: false')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes click-at command with coordinates', async () => {
      let clickedX = 0
      let clickedY = 0
      mockFns.clickAt = async (x, y) => { clickedX = x; clickedY = y }
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350 200' })
      expect(clickedX).toBe(350)
      expect(clickedY).toBe(200)
      expect(result.content[0].text).toContain('Clicked at coordinates (350, 200)')
    })

    it('returns error for click-at with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at 350' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at requires x and y coordinates')
    })

    it('returns error for click-at with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'click-at foo bar' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('click-at coordinates must be numbers')
    })

    it('routes drag command with coordinates', async () => {
      let draggedCoords = { x1: 0, y1: 0, x2: 0, y2: 0 }
      mockFns.drag = async (x1, y1, x2, y2) => { draggedCoords = { x1, y1, x2, y2 } }
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200 300 400' })
      expect(draggedCoords).toEqual({ x1: 100, y1: 200, x2: 300, y2: 400 })
      expect(result.content[0].text).toContain('Dragged from (100, 200) to (300, 400)')
    })

    it('returns error for drag with missing coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag 100 200' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag requires 4 coordinates')
    })

    it('returns error for drag with non-numeric coordinates', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'drag foo bar baz qux' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('drag coordinates must be numbers')
    })

    it('routes fill command', async () => {
      let filledRef = ''
      let filledValue = ''
      mockFns.fill = async (ref, value) => { filledRef = ref; filledValue = value }
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e2 hello world' })
      expect(filledRef).toBe('@e2')
      expect(filledValue).toBe('hello world')
      expect(result.content[0].text).toContain('Filled element @e2')
    })

    it('supports semicolon command batching', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 user@example.com; fill @e2 password123; click @e3',
      })

      expect(calls).toEqual([
        'fill:@e1:user@example.com',
        'fill:@e2:password123',
        'click:@e3',
      ])
      expect(result.content[0].text).toContain('Filled element @e1')
      expect(result.content[0].text).toContain('Clicked element @e3')
    })

    it('does not split batch on semicolons inside quoted text', async () => {
      const calls: string[] = []
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }
      mockFns.click = async (ref) => { calls.push(`click:${ref}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 "a;b;c"; click @e2',
      })

      expect(calls).toEqual([
        'fill:@e1:a;b;c',
        'click:@e2',
      ])
      expect(result.content[0].text).toContain('Filled element @e1 with "a;b;c"')
      expect(result.content[0].text).toContain('Clicked element @e2')
    })

    it('stops batched commands after navigation-changing command', async () => {
      const calls: string[] = []
      mockFns.navigate = async (url) => {
        calls.push(`navigate:${url}`)
        return { url, title: 'Page' }
      }
      mockFns.fill = async (ref, value) => { calls.push(`fill:${ref}:${value}`) }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'fill @e1 start; navigate https://example.com; fill @e2 should-not-run',
      })

      expect(calls).toEqual([
        'fill:@e1:start',
        'navigate:https://example.com',
      ])
      expect(result.content[0].text).toContain('stopped batch after "navigate"')
    })

    it('routes type command', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'type Hello World' })
      expect(typedText).toBe('Hello World')
      expect(result.content[0].text).toContain('Typed 11 characters into focused element')
    })

    it('returns error for type with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'type' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('type requires text')
    })

    it('routes select command', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e3', role: 'combobox', name: 'Type', value: 'optionValue' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'select @e3 optionValue' })
      expect(selectedRef).toBe('@e3')
      expect(selectedValue).toBe('optionValue')
      expect(result.content[0].text).toContain('(verified)')
    })

    it('parses select assertion flags and timeout', async () => {
      let selectedRef = ''
      let selectedValue = ''
      mockFns.select = async (ref, value) => { selectedRef = ref; selectedValue = value }
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'CNAME' },
          { ref: '@e80', role: 'textbox', name: 'Target', value: 'beautiful-mermaid.com' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --assert-value CNAME --timeout 3000',
      })

      expect(selectedRef).toBe('@e75')
      expect(selectedValue).toBe('CNAME')
      expect(result.content[0].text).toContain('assertTextMatched=true')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).toContain('timeout=3000ms')
      expect(result.content[0].text).toContain('(verified)')
    })

    it('accepts assert-value from downstream node when selected control metadata lags', async () => {
      let snapshotCount = 0
      mockFns.snapshot = async () => {
        snapshotCount += 1
        if (snapshotCount === 1) {
          return {
            url: 'https://example.com',
            title: 'Example',
            nodes: [
              { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
              { ref: '@e80', role: 'status', name: 'Current sort', value: 'updated-newest' },
            ],
          }
        }

        return {
          url: 'https://example.com',
          title: 'Example',
          nodes: [
            { ref: '@e75', role: 'combobox', name: 'Sort updated-newest', value: 'Sort' },
            { ref: '@e81', role: 'status', name: 'Current sort', value: 'updated-newest' },
          ],
        }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 updated-newest --assert-value updated-newest --timeout 500',
      })

      expect(result.content[0].text).toContain('(verified)')
      expect(result.content[0].text).toContain('assertValueMatched=true')
      expect(result.content[0].text).not.toContain('assert-value did not match')
    })

    it('returns warning when select cannot be verified', async () => {
      mockFns.snapshot = async () => ({
        url: 'https://example.com',
        title: 'Example',
        nodes: [
          { ref: '@e75', role: 'combobox', name: 'Type', value: 'A' },
          { ref: '@e80', role: 'textbox', name: 'IPv4 address (required)', value: '' },
        ],
      })

      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text Target --timeout 500',
      })

      expect(result.content[0].text).toContain('(warning)')
      expect(result.content[0].text).toContain('Warning: select interaction succeeded but effective form state could not be fully verified')
      expect(result.content[0].text).toContain('assert-text did not match: "Target"')
    })

    it('returns error when select assertion flag is missing value', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: 'select @e75 CNAME --assert-text',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('select --assert-text requires a value')
    })

    it('routes upload command with one or more file paths', async () => {
      let uploadedRef = ''
      let uploadedPaths: string[] = []
      mockFns.upload = async (ref, filePaths) => { uploadedRef = ref; uploadedPaths = filePaths }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'upload @e3 /tmp/a.pdf /tmp/b.jpg',
      })

      expect(uploadedRef).toBe('@e3')
      expect(uploadedPaths).toEqual(['/tmp/a.pdf', '/tmp/b.jpg'])
      expect(result.content[0].text).toContain('Uploaded 2 files:')
      expect(result.content[0].text).toContain('/tmp/a.pdf')
      expect(result.content[0].text).toContain('/tmp/b.jpg')
    })

    it('returns error for upload with missing arguments', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'upload @e3' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('upload requires ref and file path(s)')
    })

    it('routes set-clipboard command', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(result.content[0].text).toContain('Clipboard set (11 characters)')
    })

    it('decodes escaped tab/newline sequences for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(result.content[0].text).toContain('Clipboard set (19 characters)')
    })

    it('preserves unknown escapes for set-clipboard', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      await executeTool(tools, 'browser_tool', {
        command: 'set-clipboard keep\\xliteral',
      })
      expect(clipboardText).toBe('keep\\xliteral')
    })

    it('returns error for set-clipboard with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'set-clipboard' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('set-clipboard requires text')
    })

    it('routes get-clipboard command', async () => {
      mockFns.getClipboard = async () => 'some clipboard data'
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('Clipboard content (19 chars, 1 lines, 0 tabs):')
      expect(result.content[0].text).toContain('some clipboard data')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('routes get-clipboard returns empty placeholder for empty clipboard', async () => {
      mockFns.getClipboard = async () => ''
      const result = await executeTool(tools, 'browser_tool', { command: 'get-clipboard' })
      expect(result.content[0].text).toContain('(empty clipboard)')
    })

    it('routes paste command (set-clipboard + key)', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', { command: 'paste Hello World' })
      expect(clipboardText).toBe('Hello World')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('Pasted 11 characters')
    })

    it('decodes escaped tab/newline sequences for paste', async () => {
      let clipboardText = ''
      let keySent = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async (args) => { keySent = args.key }
      const result = await executeTool(tools, 'browser_tool', {
        command: 'paste Hello\\tWorld\\nFoo\\tBar',
      })
      expect(clipboardText).toBe('Hello\tWorld\nFoo\tBar')
      expect(keySent).toBe('v')
      expect(result.content[0].text).toContain('Pasted 19 characters')
    })

    it('returns error for paste with no text', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'paste' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('paste requires text')
    })

    it('routes screenshot command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.content[0].text).toContain('Screenshot captured')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/png')
    })

    it('routes annotated screenshot and passes annotate flag', async () => {
      let screenshotArgs: any
      mockFns.screenshot = async (args) => {
        screenshotArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot --annotated' })
      expect(screenshotArgs).toMatchObject({ annotate: true, format: 'jpeg' })
      expect(result.content[0].text).toContain('Annotated screenshot captured')
      expect(result.content[1].type).toBe('image')
    })

    it('routes screenshot-region command and returns image block', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.content[0].text).toContain('Region screenshot captured')
      expect(result.content[1].type).toBe('image')
      expect((result.content[1] as any).mimeType).toBe('image/png')
    })

    it('returns error for screenshot when PNG is empty', async () => {
      mockFns.screenshot = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

    it('returns error for screenshot-region when PNG is empty', async () => {
      mockFns.screenshotRegion = async () => ({ imageBuffer: Buffer.alloc(0), imageFormat: 'png' as const })
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 20 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty image data')
    })

    it('returns parse error for screenshot-region missing padding value', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region --ref @e12 --padding' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing value for --padding')
    })

    it('returns parse error for screenshot-region non-numeric coords', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'screenshot-region 10 nope 100 80' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('coordinates must be numbers')
    })

    it('treats --padding-like text inside quoted selectors as selector content', async () => {
      let screenshotRegionArgs: any
      mockFns.screenshotRegion = async (args) => {
        screenshotRegionArgs = args
        return { imageBuffer: Buffer.from('fake-png-data'), imageFormat: 'png' as const }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'screenshot-region --selector "div[data-tip=\'--padding 99\';data-x=\'a;b\']" --padding 8',
      })

      expect(result.isError).toBeUndefined()
      expect(screenshotRegionArgs).toMatchObject({
        selector: "div[data-tip='--padding 99';data-x='a;b']",
        padding: 8,
        format: 'jpeg',
      })
      expect(result.content[0].text).toContain('Region screenshot captured')
    })

    it('routes console command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'console 10 warn' })
      expect(result.content[0].text).toContain('Console entries')
    })

    it('routes window-resize command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'window-resize 1024 768' })
      expect(result.content[0].text).toContain('Window resized to 1024x768')
    })

    it('routes network command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'network 10 failed' })
      expect(result.content[0].text).toContain('Network entries')
    })

    it('routes wait command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'wait network-idle 5000' })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

    it('parses quoted wait text values with spaces', async () => {
      let waitArgs: any
      mockFns.waitFor = async (args) => {
        waitArgs = args
        return { ok: true as const, kind: args.kind, elapsedMs: 42, detail: 'condition met' }
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'wait text "hello world" 5000',
      })

      expect(waitArgs).toEqual({ kind: 'text', value: 'hello world', timeoutMs: 5000 })
      expect(result.content[0].text).toContain('Wait succeeded')
    })

    it('routes key command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'key Enter' })
      expect(result.content[0].text).toContain('Key sent: Enter')
    })

    it('routes downloads command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('Downloads (')
    })

    it('includes savePath in downloads output when available', async () => {
      mockFns.getDownloads = async () => ([
        {
          id: 'dl-42',
          timestamp: Date.now(),
          url: 'https://example.com/file.pdf',
          filename: 'file.pdf',
          state: 'completed',
          bytesReceived: 100,
          totalBytes: 100,
          mimeType: 'application/pdf',
          savePath: '/tmp/downloads/file.pdf',
        },
      ])

      const result = await executeTool(tools, 'browser_tool', { command: 'downloads list 10' })
      expect(result.content[0].text).toContain('-> /tmp/downloads/file.pdf')
    })

    it('routes scroll command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll down 800' })
      expect(result.content[0].text).toContain('Scrolled down')
    })

    it('routes back command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'back' })
      expect(result.content[0].text).toContain('Navigated back')
    })

    it('routes forward command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'forward' })
      expect(result.content[0].text).toContain('Navigated forward')
    })

    it('routes evaluate command', async () => {
      mockFns.evaluate = async () => ({ key: 'value' })
      const result = await executeTool(tools, 'browser_tool', { command: 'evaluate 1+1' })
      expect(result.content[0].text).toContain('"key"')
    })

    it('preserves quoted evaluate expressions with semicolons', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }

      const result = await executeTool(tools, 'browser_tool', {
        command: 'evaluate "document.title + \';\' + location.href"',
      })

      expect(evaluatedExpression).toBe("document.title + ';' + location.href")
      expect(result.content[0].text).toContain('ok')
    })

    it('lists browser windows via windows command without release hint', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'windows' })
      expect(result.content[0].text).toContain('Browser windows (1)')
      expect(result.content[0].text).toContain('browser-1')
      expect(result.content[0].text).toContain('ownerType: session')
      expect(result.content[0].text).toContain('lockState: locked-session(test-session)')
      expect(result.content[0].text).toContain('availableToSession: true')
      expect(result.content[0].text).toContain('agentControlActive: true')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes focus command and calls focusWindow', async () => {
      let focusedId: string | undefined
      mockFns.focusWindow = async (instanceId?: string) => {
        focusedId = instanceId
        return { instanceId: instanceId ?? 'browser-1', title: 'Focused Tab', url: 'https://focused.example' }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'focus browser-1' })

      expect(focusedId).toBe('browser-1')
      expect(result.content[0].text).toContain('Focused browser window browser-1')
      expect(result.content[0].text).toContain('When you are done using the browser')
    })

    it('routes release command and calls releaseControl without hint', async () => {
      let requestedId: string | undefined
      mockFns.releaseControl = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'released' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'release' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser control released')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes close command and calls closeWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes hide command and calls hideWindow without hint', async () => {
      let requestedId: string | undefined
      mockFns.hideWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'hidden' as const, resolvedInstanceId: 'browser-1', affectedIds: ['browser-1'] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'hide' })

      expect(requestedId).toBeUndefined()
      expect(result.content[0].text).toContain('Browser window hidden')
      expect(result.content[0].text).not.toContain('When you are done using the browser')
    })

    it('routes close command with explicit window id', async () => {
      let requestedId: string | undefined
      mockFns.closeWindow = async (instanceId?: string) => {
        requestedId = instanceId
        return { action: 'closed' as const, requestedInstanceId: instanceId, resolvedInstanceId: instanceId, affectedIds: instanceId ? [instanceId] : [] }
      }

      const result = await executeTool(tools, 'browser_tool', { command: 'close browser-9' })

      expect(requestedId).toBe('browser-9')
      expect(result.content[0].text).toContain('Browser window closed and destroyed')
      expect(result.content[0].text).toContain('requested=browser-9')
    })

    it('reports close no-op explicitly', async () => {
      mockFns.closeWindow = async (instanceId?: string) => ({
        action: 'noop' as const,
        requestedInstanceId: instanceId,
        affectedIds: [],
        reason: 'No close target is currently associated with this session.',
      })

      const result = await executeTool(tools, 'browser_tool', { command: 'close' })

      expect(result.content[0].text).toContain('No browser window was closed')
      expect(result.content[0].text).toContain('No window state changed')
      expect(result.content[0].text).toContain('No close target is currently associated with this session')
    })

    it('returns validation feedback for invalid command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'scroll diagonal' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('scroll requires direction')
    })

    it('returns parse error for unclosed quotes', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'fill @e1 "unterminated' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Parse error: unclosed quote')
    })

    it('returns error for unknown command', async () => {
      const result = await executeTool(tools, 'browser_tool', { command: 'teleport' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown browser_tool command')
    })
  })

  describe('array command mode', () => {
    it('evaluate preserves semicolons without quoting', async () => {
      let evaluatedExpression = ''
      mockFns.evaluate = async (expression) => {
        evaluatedExpression = expression
        return 'ok'
      }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['evaluate', 'var x = 1; var y = 2; x + y'],
      })
      expect(evaluatedExpression).toBe('var x = 1; var y = 2; x + y')
      expect(result.content[0].text).toContain('ok')
    })

    it('paste preserves tabs and newlines', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      mockFns.sendKey = async () => {}
      const result = await executeTool(tools, 'browser_tool', {
        command: ['paste', 'Name\tAge\nAlice\t30'],
      })
      expect(clipboardText).toBe('Name\tAge\nAlice\t30')
      expect(result.content[0].text).toContain('Pasted')
    })

    it('set-clipboard preserves semicolons and special characters', async () => {
      let clipboardText = ''
      mockFns.setClipboard = async (text) => { clipboardText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['set-clipboard', 'function foo() { return 1; }'],
      })
      expect(clipboardText).toBe('function foo() { return 1; }')
      expect(result.content[0].text).toContain('Clipboard set')
    })

    it('click works with array input', async () => {
      let clickedRef = ''
      mockFns.click = async (ref) => { clickedRef = ref }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['click', '@e1'],
      })
      expect(clickedRef).toBe('@e1')
      expect(result.content[0].text).toContain('Clicked element @e1')
    })

    it('empty array returns error', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: [],
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Missing command')
    })

    it('type preserves whitespace characters', async () => {
      let typedText = ''
      mockFns.type = async (text) => { typedText = text }
      const result = await executeTool(tools, 'browser_tool', {
        command: ['type', 'Hello\tWorld'],
      })
      expect(typedText).toBe('Hello\tWorld')
      expect(result.content[0].text).toContain('Typed')
    })

    it('--help works in array mode', async () => {
      const result = await executeTool(tools, 'browser_tool', {
        command: ['--help'],
      })
      expect(result.content[0].text).toContain('browser_tool command help')
    })
  })

  describe('error handling', () => {
    it('returns isError when getBrowserPaneFns returns undefined', async () => {
      const errorTools = createBrowserTools({
        sessionId: 'test',
        getBrowserPaneFns: () => undefined,
      })
      const result = await executeTool(errorTools, 'browser_tool', { command: 'navigate test.com' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error')
    })

    it('catches and wraps thrown errors', async () => {
      mockFns.navigate = async () => { throw new Error('Network error') }
      const result = await executeTool(tools, 'browser_tool', { command: 'navigate test.com' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Network error')
    })
  })
})
