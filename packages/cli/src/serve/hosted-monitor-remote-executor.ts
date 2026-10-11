/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import type {
  MonitorWatchExecutor,
  MonitorWatchHandle,
} from './hosted-monitor-loop.js';

// H3 of #12827: the hosted observation loop's executor for a remote watch
// whose physical side already started (worker-side cgroup spawn). Lines
// and its end arrive backwards through the session publisher's monitor
// fan-out; this bridge binds those to the loop's executor shape. The watch
// runs nowhere in this process, so the handle carries no supervised unit
// and its terminate asks the worker through the Runtime's `monitor-stop`:
// only the worker's exit evidence proves the stop, and anything else —
// an unproven answer, a refusal, no answer — parks the record instead of
// settling a stop the physical side never confirmed (#13896).

export class HostedMonitorRemoteExecutor implements MonitorWatchExecutor {
  constructor(
    private readonly publisher: HostedShellPublisher,
    private readonly watch: {
      readonly broker: Pick<HostedWorkspaceBroker, 'monitorControl'>;
      readonly sessionKey: ManagedSessionKey;
      /** The execution that started the watch. */
      readonly executionCallId: string;
      /** The Runtime call the worker derived the watch's unit from. */
      readonly runtimeCallId: string;
    },
  ) {}

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
      terminate: () => this.stop(),
    });
  }

  private async stop(): Promise<boolean> {
    try {
      const view = await this.watch.broker.monitorControl({
        kind: 'monitor-stop',
        sessionKey: this.watch.sessionKey,
        operationId: this.watch.executionCallId,
        targetOperationId: this.watch.runtimeCallId,
      });
      return view.state === 'exited';
    } catch {
      return false;
    }
  }
}
