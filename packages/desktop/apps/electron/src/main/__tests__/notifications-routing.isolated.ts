import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'

let clickHandler: (() => void) | null = null

mock.module('electron', () => {
  class MockNotification {
    constructor(_opts: unknown) {}

    static isSupported(): boolean {
      return true
    }

    on(event: string, cb: () => void): void {
      if (event === 'click') {
        clickHandler = cb
      }
    }

    show(): void {}
  }

  return {
    Notification: MockNotification,
    app: {
      dock: { setIcon: () => {} },
      setBadgeCount: () => {},
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
    nativeImage: {
      createFromPath: () => ({}),
      createFromDataURL: () => ({}),
    },
  }
})

describe('notification click routing', () => {
  beforeEach(() => {
    clickHandler = null
  })

  it('routes notification navigation to resolved client target when resolver is provided', async () => {
    const notifications = await import('../notifications')

    const mockWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        id: 101,
        isDestroyed: () => false,
      },
    }

    notifications.initNotificationService({
      getWindowByWorkspace: () => mockWindow,
      createWindow: () => mockWindow,
    } as any)

    const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    notifications.setNotificationEventSink(((channel: string, target: unknown, ...args: unknown[]) => {
      pushed.push({ channel, target, args })
    }) as any, (wcId) => wcId === 101 ? 'client-101' : undefined)

    notifications.showNotification('Title', 'Body', 'ws-1', 'sess-1')
    expect(clickHandler).toBeTruthy()
    clickHandler?.()

    expect(pushed.length).toBe(1)
    expect(pushed[0]?.channel).toBe(RPC_CHANNELS.notification.NAVIGATE)
    expect(pushed[0]?.target).toEqual({ to: 'client', clientId: 'client-101' })
    expect(pushed[0]?.args[0]).toEqual({ workspaceId: 'ws-1', sessionId: 'sess-1' })
  })

  it('falls back to workspace-targeted navigation when resolver is not provided', async () => {
    const notifications = await import('../notifications')

    const mockWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        id: 202,
        isDestroyed: () => false,
      },
    }

    notifications.initNotificationService({
      getWindowByWorkspace: () => mockWindow,
      createWindow: () => mockWindow,
    } as any)

    const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    notifications.setNotificationEventSink(((channel: string, target: unknown, ...args: unknown[]) => {
      pushed.push({ channel, target, args })
    }) as any)

    notifications.showNotification('Title', 'Body', 'ws-2', 'sess-2')
    expect(clickHandler).toBeTruthy()
    clickHandler?.()

    expect(pushed.length).toBe(1)
    expect(pushed[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-2' })
    expect(pushed[0]?.args[0]).toEqual({ workspaceId: 'ws-2', sessionId: 'sess-2' })
  })
})
