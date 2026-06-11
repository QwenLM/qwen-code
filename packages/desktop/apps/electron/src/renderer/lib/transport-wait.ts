import type { ElectronAPI, TransportConnectionState } from '../../shared/types'

const DEFAULT_TIMEOUT_MS = 12_000

function formatTransportFailure(state: TransportConnectionState): string {
  if (state.lastError?.message) return state.lastError.message
  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `Connection closed (${state.lastClose.code})${reason}`
  }
  return 'Connection failed'
}

export async function waitForTransportConnected(
  api: Pick<ElectronAPI, 'getTransportConnectionState' | 'onTransportConnectionStateChanged'>,
  options?: { timeoutMs?: number },
): Promise<TransportConnectionState> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const current = await api.getTransportConnectionState()
  if (current.status === 'connected') {
    return current
  }

  return await new Promise<TransportConnectionState>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (fn: (value: any) => void, value: any) => {
      if (settled) return
      settled = true
      if (unsubscribe) unsubscribe()
      if (timeout) clearTimeout(timeout)
      fn(value)
    }

    timeout = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for workspace connection after ${timeoutMs}ms`))
    }, timeoutMs)

    unsubscribe = api.onTransportConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        finish(resolve, state)
        return
      }

      if (state.status === 'failed') {
        finish(reject, new Error(formatTransportFailure(state)))
      }
    })
  })
}
