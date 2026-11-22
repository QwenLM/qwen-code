/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedMonitorOperationView } from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
import { HostedMonitorRemoteExecutor } from './hosted-monitor-remote-executor.js';
import type { HostedShellPublisher } from './hosted-shell-publisher.js';
import { HostedWorkspaceBrokerRejection } from './hosted-workspace-broker.js';

const sessionKey = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: 'session',
};

async function terminate(
  monitorControl: () => Promise<ManagedMonitorOperationView>,
): Promise<{ proven: boolean; control: ReturnType<typeof vi.fn> }> {
  const control = vi.fn(monitorControl);
  const publisher = { setMonitorObserver: vi.fn() };
  const handle = await new HostedMonitorRemoteExecutor(
    publisher as unknown as HostedShellPublisher,
    {
      broker: { monitorControl: control },
      sessionKey,
      executionCallId: 'execution',
      runtimeCallId: 'runtime-call',
    },
  ).start(
    { command: 'tail -f build.log' },
    () => undefined,
    () => undefined,
    { unitName: 'execution' },
  );
  expect(publisher.setMonitorObserver).toHaveBeenCalledWith(
    'execution',
    expect.anything(),
  );
  return { proven: await handle.terminate(), control };
}

describe('HostedMonitorRemoteExecutor terminate (#13896)', () => {
  it('asks the worker through monitor-stop and is proven only by its exit evidence', async () => {
    const { proven, control } = await terminate(async () => ({
      operationId: 'runtime-call',
      state: 'exited',
      unitName: 'qwen-mon-runtime-call',
      evidence: { exitCode: null, exitSignal: 'SIGTERM' },
    }));
    expect(proven).toBe(true);
    expect(control).toHaveBeenCalledWith({
      kind: 'monitor-stop',
      sessionKey,
      operationId: 'execution',
      targetOperationId: 'runtime-call',
    });
  });

  it.each([
    ['still running', { state: 'running', unitName: 'qwen-mon-runtime-call' }],
    ['unknown', { state: 'unknown' }],
  ] as const)('proves nothing when the worker answers %s', async (_, view) => {
    const { proven } = await terminate(async () => ({
      operationId: 'runtime-call',
      ...view,
    }));
    expect(proven).toBe(false);
  });

  it('proves nothing when the Broker refuses the stop or never answers', async () => {
    for (const failure of [
      new HostedWorkspaceBrokerRejection(
        400,
        'runtime_control_operation_invalid',
      ),
      new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
      new TypeError('fetch failed'),
    ]) {
      const { proven } = await terminate(() => Promise.reject(failure));
      expect(proven).toBe(false);
    }
  });
});
