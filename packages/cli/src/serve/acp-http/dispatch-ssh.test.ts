/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { AcpDispatcher } from './dispatch.js';

describe('SSH ACP HTTP dispatch', () => {
  it.each([false, true])(
    'advertises only methods admitted by the SSH gate (shell=%s)',
    async (shellEnabled) => {
      type Deps = ConstructorParameters<typeof AcpDispatcher>;
      const dispatcher = new AcpDispatcher(
        {} as Deps[0],
        '/local/anchor',
        () => ({}),
        {} as Deps[3],
        {} as Deps[4],
        {} as Deps[5],
        {
          sshWorkspace: { host: 'host', directory: '/srv/project' },
        } as Deps[6],
        undefined,
        shellEnabled,
      );
      const capabilities = dispatcher.buildInitializeResult('client')[
        'agentCapabilities'
      ] as {
        _meta: { qwen: { methods: string[] } };
      };
      const methods = capabilities._meta.qwen.methods;
      expect(methods).toEqual(
        expect.arrayContaining([
          '_qwen/file/read',
          '_qwen/file/glob',
          '_qwen/workspace/voice',
        ]),
      );
      expect(methods).not.toContain('_qwen/session/shell');
      const sendConn = vi.fn();
      for (const method of methods) {
        await Promise.allSettled([
          dispatcher.handle(
            { sendConn, clientId: 'client' } as unknown as Parameters<
              AcpDispatcher['handle']
            >[0],
            { jsonrpc: '2.0', id: 1, method, params: {} },
          ),
        ]);
      }
      expect(
        sendConn.mock.calls.some(
          ([frame]) =>
            frame.error?.data?.errorKind ===
            'ssh_workspace_operation_unsupported',
        ),
      ).toBe(false);
    },
  );

  it('preserves incomplete glob results below the result cap', async () => {
    type Deps = ConstructorParameters<typeof AcpDispatcher>;
    const matches = Object.assign(['/local/anchor/visible.txt'], {
      truncated: true,
    });
    const dispatcher = new AcpDispatcher(
      {} as Deps[0],
      '/local/anchor',
      () => ({}),
      {} as Deps[3],
      {} as Deps[4],
      {} as Deps[5],
      {
        sshWorkspace: { host: 'host', directory: '/srv/project' },
        forRequest: () => ({ glob: async () => matches }),
      } as unknown as Deps[6],
    );
    const sendConn = vi.fn().mockResolvedValue('delivered');
    await dispatcher.handle(
      { sendConn } as unknown as Parameters<AcpDispatcher['handle']>[0],
      {
        jsonrpc: '2.0',
        id: 1,
        method: '_qwen/file/glob',
        params: { pattern: '*.txt', maxResults: 10 },
      },
    );
    expect(sendConn).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          pattern: '*.txt',
          matches: ['/local/anchor/visible.txt'],
          truncated: true,
        },
      }),
      undefined,
    );
    expect(sendConn).toHaveBeenCalledOnce();
  });
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
  it.each([
    ['_qwen/workspace/providers', 'getWorkspaceProvidersStatus'],
    ['_qwen/workspace/tools', 'getWorkspaceToolsStatus'],
    ['_qwen/workspace/voice', 'getWorkspaceVoiceStatus'],
  ] as const)(
    'allows %s on the selected workspace service',
    async (method, action) => {
      type Deps = ConstructorParameters<typeof AcpDispatcher>;
      const service = vi.fn().mockResolvedValue({ selected: '/local/anchor' });
      const dispatcher = new AcpDispatcher(
        { [action]: service } as unknown as Deps[0],
        '/local/anchor',
        () => ({}),
        { [action]: service } as unknown as Deps[3],
        {} as Deps[4],
        {} as Deps[5],
        {
          sshWorkspace: { host: 'host', directory: '/srv/project' },
        } as Deps[6],
      );
      const sendConn = vi.fn().mockResolvedValue('delivered');
      await dispatcher.handle(
        { sendConn, clientId: 'client' } as unknown as Parameters<
          AcpDispatcher['handle']
        >[0],
        { jsonrpc: '2.0', id: 1, method },
      );
      if (method === '_qwen/workspace/tools')
        expect(service).toHaveBeenCalledWith();
      else
        expect(service).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceCwd: '/local/anchor',
            originatorClientId: 'client',
          }),
        );
      expect(sendConn).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          result: { selected: '/local/anchor' },
        }),
        undefined,
      );
      expect(sendConn).toHaveBeenCalledOnce();
    },
  );
});
