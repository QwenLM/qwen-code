/**
 * EventSink fan-out utility.
 *
 * Composes multiple EventSink callbacks into a single one.
 * Used to wire the MessagingGateway alongside the existing WsRpcServer push.
 *
 * Usage in bootstrap:
 * ```ts
 * import { createFanOutSink } from '@craft-agent/messaging-gateway'
 *
 * setSessionEventSink: (sm, sink) => {
 *   const fanOut = createFanOutSink(sink, gateway.onSessionEvent.bind(gateway))
 *   sm.setEventSink(fanOut)
 * }
 * ```
 */

import type { PushTarget } from '@craft-agent/shared/protocol'

export type EventSinkFn = (channel: string, target: PushTarget, ...args: any[]) => void

/**
 * Create a fan-out EventSink that forwards events to multiple sinks.
 * Errors in one sink do not block others.
 */
export function createFanOutSink(...sinks: EventSinkFn[]): EventSinkFn {
  return (channel: string, target: PushTarget, ...args: any[]) => {
    for (const sink of sinks) {
      try {
        sink(channel, target, ...args)
      } catch {
        // One sink failing must not break others
      }
    }
  }
}
