import { describe, expect, it, mock, spyOn } from 'bun:test'
import {
  openUrlInBuiltInBrowser,
  type BrowserPaneApi,
} from '../open-url-in-built-in-browser'

function makeBrowserPaneApi(overrides: Partial<BrowserPaneApi> = {}) {
  return {
    create: mock(() => Promise.resolve('built-in-browser')),
    navigate: mock(() => Promise.resolve({ url: 'https://example.com', title: 'Example' })),
    focus: mock(() => Promise.resolve()),
    hide: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as BrowserPaneApi & {
    create: ReturnType<typeof mock>
    navigate: ReturnType<typeof mock>
    focus: ReturnType<typeof mock>
    hide: ReturnType<typeof mock>
  }
}

describe('openUrlInBuiltInBrowser', () => {
  it('opens http(s) URLs in the built-in browser via create, navigate and focus', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://github.com/QwenLM/qwen-code', {
      browserPaneApi,
      openExternal,
    })

    expect(browserPaneApi.create).toHaveBeenCalledTimes(1)
    expect(browserPaneApi.create).toHaveBeenCalledWith({
      id: 'built-in-browser',
      show: true,
      presentation: 'docked',
    })
    expect(browserPaneApi.navigate).toHaveBeenCalledWith(
      'built-in-browser',
      'https://github.com/QwenLM/qwen-code',
    )
    expect(browserPaneApi.focus).toHaveBeenCalledWith('built-in-browser')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens host-like URLs in the built-in browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('example.com:8443/docs', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(browserPaneApi.navigate).toHaveBeenCalledWith(
      'built-in-browser',
      'example.com:8443/docs',
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens host-like URLs with a fragment in the built-in browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('localhost:3000#docs', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(browserPaneApi.navigate).toHaveBeenCalledWith(
      'built-in-browser',
      'localhost:3000#docs',
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens bare host-like URLs with a query in the built-in browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('example.com?q=1', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(browserPaneApi.navigate).toHaveBeenCalledWith(
      'built-in-browser',
      'example.com?q=1',
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('normalizes a bare host-like query URL before the external fallback', async () => {
    const browserPaneApi = makeBrowserPaneApi({
      navigate: mock(() => Promise.reject(new Error('Navigation timed out after 30s'))),
    } as Partial<BrowserPaneApi>)
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('example.com?q=1', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com?q=1')
  })

  it('routes scheme-prefixed non-http URLs to the system browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('  MAILTO:someone@example.com  ', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('MAILTO:someone@example.com')
    expect(browserPaneApi.create).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when the browser pane API is missing', async () => {
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('search \ud800 term', {
      browserPaneApi: undefined,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=search%20%EF%BF%BD%20term',
    )
  })

  it('falls back to the system browser when browser-pane channels are unavailable', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})
    const isChannelAvailable = mock(() => false)
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})

    await openUrlInBuiltInBrowser('127.0.0.1:3000/docs', {
      browserPaneApi,
      isChannelAvailable,
      openExternal,
    })

    expect(isChannelAvailable).toHaveBeenCalledWith('browser-pane:create')
    expect(infoSpy).toHaveBeenCalledWith(
      '[openUrlInBuiltInBrowser] Browser pane channel unavailable, falling back to default browser:',
      '127.0.0.1:3000/docs',
    )
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://127.0.0.1:3000/docs')
    expect(browserPaneApi.create).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })

  it('searches scheme-less free text in the built-in browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('qwen code docs', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(browserPaneApi.navigate).toHaveBeenCalledWith(
      'built-in-browser',
      'qwen code docs',
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it.each([
    ['256.1.1.1:8080', '256.1.1.1%3A8080'],
    ['localhost:70000', 'localhost%3A70000'],
    [
      '192.168.1.1:70000?token=SECRET',
      '192.168.1.1%3A70000',
    ],
  ])(
    'searches invalid host-like input when falling back: %s',
    async (url, query) => {
      const openExternal = mock(() => {})

      await openUrlInBuiltInBrowser(url, { openExternal })

      expect(openExternal).toHaveBeenCalledWith(
        `https://duckduckgo.com/?q=${query}`,
      )
    },
  )

  it('falls back to the system browser when create fails', async () => {
    const browserPaneApi = makeBrowserPaneApi({
      create: mock(() => Promise.reject(new Error('no handler for browser-pane:create'))),
    } as Partial<BrowserPaneApi>)
    const openExternal = mock(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    await openUrlInBuiltInBrowser('localhost:3000/docs', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[openUrlInBuiltInBrowser] Failed to open URL in built-in browser, falling back to default browser:',
      'localhost:3000/docs',
      expect.any(Error),
    )
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://localhost:3000/docs')
    expect(browserPaneApi.hide).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back without hiding a reused pane when navigation fails after create', async () => {
    const browserPaneApi = makeBrowserPaneApi({
      navigate: mock(() => Promise.reject(new Error('Navigation timed out after 30s'))),
    } as Partial<BrowserPaneApi>)
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://example.com', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(browserPaneApi.create).toHaveBeenCalledTimes(1)
    expect(browserPaneApi.hide).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('falls back when focusing the built-in browser fails', async () => {
    const browserPaneApi = makeBrowserPaneApi({
      focus: mock(() => Promise.reject(new Error('Focus failed'))),
    } as Partial<BrowserPaneApi>)
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://example.com', {
      browserPaneApi,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(browserPaneApi.hide).not.toHaveBeenCalled()
  })
})
