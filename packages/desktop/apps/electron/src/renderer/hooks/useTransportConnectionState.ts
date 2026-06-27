import { useEffect, useRef, useState } from 'react'
import type { TransportConnectionState } from '../../shared/types'

/**
 * Debounce delay for non-connected states (ms).
 * Absorbs rapid state transitions within a single reconnect cycle
 * (e.g. reconnecting → failed → reconnecting) to prevent banner flicker.
 * Connected state surfaces immediately — no delay for good news.
 */
const DEBOUNCE_MS = 300

export function useTransportConnectionState(): TransportConnectionState | null {
  const [state, setState] = useState<TransportConnectionState | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let mounted = true

    const readInitialState = async () => {
      if (!window.electronAPI.getTransportConnectionState) return
      try {
        const initial = await window.electronAPI.getTransportConnectionState()
        if (mounted) {
          setState(initial)
        }
      } catch {
        // Best effort only — avoid crashing renderer if preload state is unavailable.
      }
    }

    void readInitialState()

    const unsubscribe = window.electronAPI.onTransportConnectionStateChanged?.((next) => {
      if (!mounted) return

      // Connected state surfaces immediately (no delay for good news)
      if (next.status === 'connected') {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current)
          debounceRef.current = null
        }
        setState(next)
        return
      }

      // Non-connected states: debounce to avoid flicker during
      // rapid state transitions within a single reconnect cycle
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        if (mounted) setState(next)
      }, DEBOUNCE_MS)
    })

    return () => {
      mounted = false
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      unsubscribe?.()
    }
  }, [])

  return state
}
