/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostedShellPublisher } from './hosted-shell-publisher.js';
import type {
  MonitorWatchExecutor,
  MonitorWatchHandle,
} from './hosted-monitor-loop.js';

// H3 of #12827: the hosted observation loop's executor for a remote watch
// whose physical side already started (worker-side cgroup spawn). Lines
// and its end arrive backwards through the session publisher's monitor
// fan-out; this bridge binds those to the loop's executor shape. The watch
// runs nowhere in this process, so the handle carries no supervised unit
// and terminate is answered by the maintenance route (consumers of the
// monitor-stop kind), not re-implemented here.

export class HostedMonitorRemoteExecutor implements MonitorWatchExecutor {
  constructor(private readonly publisher: HostedShellPublisher) {}

  start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean) => Promise<void> | void,
    identity: { readonly unitName: string; readonly cwd?: string },
  ): Promise<MonitorWatchHandle> {
    this.publisher.setMonitorObserver(identity.unitName, { onLine, onExit });
    return Promise.resolve({
      receipt: {
        unitName: identity.unitName,
        started: true,
      },
      terminate: () => Promise.resolve(),
    });
  }
}
