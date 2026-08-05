import { describe, expect, it, mock } from 'bun:test'
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
      isChannelAvailable: () => true,
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

  it('routes scheme-prefixed non-http URLs to the system browser', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('mailto:someone@example.com', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com')
    expect(browserPaneApi.create).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when the browser pane API is missing', async () => {
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://example.com', {
      browserPaneApi: undefined,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('falls back to the system browser when browser-pane channels are unavailable', async () => {
    const browserPaneApi = makeBrowserPaneApi()
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://example.com', {
      browserPaneApi,
      isChannelAvailable: () => false,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(browserPaneApi.create).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when create fails', async () => {
    const browserPaneApi = makeBrowserPaneApi({
      create: mock(() => Promise.reject(new Error('no handler for browser-pane:create'))),
    } as Partial<BrowserPaneApi>)
    const openExternal = mock(() => {})

    await openUrlInBuiltInBrowser('https://example.com', {
      browserPaneApi,
      isChannelAvailable: () => true,
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(browserPaneApi.hide).not.toHaveBeenCalled()
  })

  it('falls back to the system browser and hides the pane when navigation fails after create', async () => {
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
    expect(browserPaneApi.hide).toHaveBeenCalledTimes(1)
    expect(browserPaneApi.hide).toHaveBeenCalledWith('built-in-browser')
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
