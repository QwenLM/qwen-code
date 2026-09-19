/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { AcpDispatcher } from './dispatch.js';

describe('SSH ACP HTTP dispatch', () => {
  it.each([
    '_qwen/session/shell',
    '_qwen/workspace/init',
    '_qwen/workspace/mcp/servers/add',
    'session/fork',
    '_qwen/session/artifacts/add',
  ])('rejects %s before entering local services', async (method) => {
    type Deps = ConstructorParameters<typeof AcpDispatcher>;
    const executeShellCommand = vi.fn();
    const dispatcher = new AcpDispatcher(
      { executeShellCommand } as unknown as Deps[0],
      '/local/anchor',
      () => ({}),
      {} as Deps[3],
      {} as Deps[4],
      {} as Deps[5],
      { sshWorkspace: { host: 'host', directory: '/srv/project' } } as Deps[6],
    );
    const sendConn = vi.fn();
    await dispatcher.handle(
      { sendConn } as unknown as Parameters<AcpDispatcher['handle']>[0],
      {
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { command: 'touch wrong-host', sessionId: 'session' },
      },
    );
    expect(sendConn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          data: {
            errorKind: 'ssh_workspace_operation_unsupported',
            httpStatus: 501,
          },
        }),
      }),
    );
    expect(executeShellCommand).not.toHaveBeenCalled();
  });
});
