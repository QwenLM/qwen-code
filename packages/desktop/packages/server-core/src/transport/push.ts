/**
 * Type-safe push helper — constrains args against BroadcastEventMap at compile time.
 */

import type { BroadcastEventMap, PushTarget } from '@craft-agent/shared/protocol'
import type { RpcServer } from './types'

export function pushTyped<K extends keyof BroadcastEventMap & string>(
  server: RpcServer,
  channel: K,
  target: PushTarget,
  ...args: BroadcastEventMap[K]
): void {
  server.push(channel, target, ...args)
}
