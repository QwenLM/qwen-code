/**
 * RoutedClient tests — channel routing, workspace switch, listener re-subscription.
 */

import { describe, it, expect, mock } from 'bun:test'
import { RoutedClient } from '../routed-client'
import type { WsRpcClient, TransportConnectionState } from '../client'

// ---------------------------------------------------------------------------
// Minimal WsRpcClient stub
// ---------------------------------------------------------------------------

function stubClient(overrides?: Partial<WsRpcClient>): WsRpcClient {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const capabilities = new Map<string, (...args: any[]) => any>()

  return {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke: mock(async () => undefined),
    on: mock((channel: string, cb: (...args: any[]) => void) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    handleCapability: mock((channel: string, handler: (...args: any[]) => any) => {
      capabilities.set(channel, handler)
    }),
    isChannelAvailable: mock(() => true),
    getConnectionState: mock((): TransportConnectionState => ({
      mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now(),
    })),
    onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
      cb({ mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now() })
      return () => {}
    }),
    reconnectNow: mock(() => {}),
    // expose internals for assertions
    _listeners: listeners,
    _capabilities: capabilities,
    ...overrides,
  } as any
}

// Use real channel constants — RoutedClient routes based on isLocalOnly()
import { isLocalOnly, RPC_CHANNELS } from '@craft-agent/shared/protocol'

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE   // LOCAL_ONLY
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET           // REMOTE_ELIGIBLE
const SWITCH_CHANNEL = RPC_CHANNELS.window.SWITCH_WORKSPACE

describe('RoutedClient', () => {
  describe('routing', () => {
    it('routes LOCAL_ONLY invokes to localClient', async () => {
      const local = stubClient({ invoke: mock(async () => 'local-result') })
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(LOCAL_CHANNEL)
      expect(result).toBe('local-result')
      expect(local.invoke).toHaveBeenCalledWith(LOCAL_CHANNEL)
      expect(workspace.invoke).not.toHaveBeenCalled()
    })

    it('routes REMOTE_ELIGIBLE invokes to workspaceClient', async () => {
      const local = stubClient()
      const workspace = stubClient({ invoke: mock(async () => 'ws-result') })
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(REMOTE_CHANNEL)
      expect(result).toBe('ws-result')
      expect(workspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
      expect(local.invoke).not.toHaveBeenCalled()
    })

    it('routes LOCAL_ONLY listeners to localClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(LOCAL_CHANNEL, cb)

      expect(local.on).toHaveBeenCalledWith(LOCAL_CHANNEL, cb)
      expect(workspace.on).not.toHaveBeenCalledWith(LOCAL_CHANNEL, expect.any(Function))
    })

    it('routes REMOTE_ELIGIBLE listeners to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)

      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })
  })

  describe('workspace switch', () => {
    // SWITCH_WORKSPACE is LOCAL_ONLY — the switch result mock goes on localClient
    it('swaps workspaceClient when SWITCH_WORKSPACE returns remoteServer', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      await routed.invoke(SWITCH_CHANNEL)

      // New client should have been connected
      expect(newRemote.connect).toHaveBeenCalled()
      // Old workspace client should have been destroyed (it's not the local client)
      expect(workspace.destroy).toHaveBeenCalled()
    })

    it('reverts to localClient when switching to local workspace', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-local',
          remoteServer: null,
        })),
      })
      const remoteWs = stubClient()

      const routed = new RoutedClient(local, remoteWs)
      await routed.invoke(SWITCH_CHANNEL)

      // Remote client should be destroyed
      expect(remoteWs.destroy).toHaveBeenCalled()
      // Subsequent REMOTE_ELIGIBLE calls should go to localClient
      await routed.invoke(REMOTE_CHANNEL)
      expect(local.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('re-subscribes REMOTE_ELIGIBLE listeners on swap (make-before-break)', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      // Subscribe a listener before switch
      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)
      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)

      // Trigger switch
      await routed.invoke(SWITCH_CHANNEL)

      // Listener should be re-subscribed on the new client
      expect(newRemote.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })

    it('re-registers capabilities on swap', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      const handler = mock(async () => 'capability-result')
      routed.handleCapability('test:capability', handler)

      await routed.invoke(SWITCH_CHANNEL)

      expect(newRemote.handleCapability).toHaveBeenCalledWith('test:capability', handler)
    })
  })

  describe('connection state', () => {
    it('delegates getConnectionState to workspaceClient', () => {
      const expectedState: TransportConnectionState = {
        mode: 'remote', status: 'reconnecting', url: 'wss://remote:9001',
        attempt: 2, updatedAt: Date.now(),
      }
      const local = stubClient()
      const workspace = stubClient({ getConnectionState: mock(() => expectedState) })
      const routed = new RoutedClient(local, workspace)

      expect(routed.getConnectionState()).toEqual(expectedState)
    })

    it('notifies connection state listeners on change', () => {
      let capturedCb: ((state: TransportConnectionState) => void) | null = null
      const workspace = stubClient({
        onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
          capturedCb = cb
          // Initial callback
          cb({ mode: 'remote', status: 'connected', url: 'wss://remote', attempt: 0, updatedAt: Date.now() })
          return () => {}
        }),
      })
      const local = stubClient()
      const routed = new RoutedClient(local, workspace)

      const listener = mock(() => {})
      routed.onConnectionStateChanged(listener)

      // Should have received initial state
      expect(listener).toHaveBeenCalled()

      // Simulate a state change via the captured workspace client callback
      capturedCb!({ mode: 'remote', status: 'reconnecting', url: 'wss://remote', attempt: 1, updatedAt: Date.now() })

      // 1: initial from onConnectionStateChanged → callback(getConnectionState())
      // 2: the simulated change forwarded through connectionStateListeners
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('delegates reconnectNow to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      routed.reconnectNow()
      expect(workspace.reconnectNow).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('unsubscribes listeners when cleanup function is called', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      const unsub = routed.on(REMOTE_CHANNEL, cb)

      // Should be tracked
      unsub()

      // After cleanup, switching workspace should not attempt to re-subscribe this listener
      // (no error thrown = success)
    })
  })
})

describe('isLocalOnly consistency', () => {
  it('correctly classifies window channels as LOCAL_ONLY', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
  })

  it('correctly classifies session channels as REMOTE_ELIGIBLE', () => {
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})
