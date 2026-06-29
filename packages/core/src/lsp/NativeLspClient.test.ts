/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { NativeLspClient } from './NativeLspClient.js';
import type { NativeLspService } from './NativeLspService.js';
import type { LspServerHandle } from './types.js';

const createHandle = (overrides: Partial<LspServerHandle>): LspServerHandle =>
  ({
    config: {
      name: 'clangd',
      languages: ['cpp'],
      command: 'clangd',
      args: [],
      transport: 'stdio',
      rootUri: 'file:///workspace',
      workspaceFolder: '/workspace',
    },
    status: 'READY',
    ...overrides,
  }) as LspServerHandle;

describe('NativeLspClient', () => {
  it('returns status details from the current server handles', () => {
    const service = {
      getStatus: vi.fn().mockReturnValue(
        new Map([
          ['clangd', 'FAILED'],
          ['stale-server', 'READY'],
        ]),
      ),
      getServerHandles: vi.fn().mockReturnValue(
        new Map([
          [
            'clangd',
            createHandle({
              status: 'READY',
              config: {
                name: 'clangd',
                languages: ['c', 'cpp'],
                command: 'clangd',
                args: ['--background-index'],
                transport: 'stdio',
                rootUri: 'file:///workspace',
                workspaceFolder: '/workspace',
              },
            }),
          ],
        ]),
      ),
    } as unknown as NativeLspService;

    const client = new NativeLspClient(service);

    expect(client.getServerStatus()).toEqual([
      {
        name: 'clangd',
        status: 'READY',
        command: 'clangd',
        languages: ['c', 'cpp'],
      },
    ]);
    expect(service.getStatus).not.toHaveBeenCalled();
  });

  it('stringifies non-Error startup failures', () => {
    const service = {
      getServerHandles: vi.fn().mockReturnValue(
        new Map([
          [
            'pyright',
            createHandle({
              status: 'FAILED',
              config: {
                name: 'pyright',
                languages: ['python'],
                command: 'pyright-langserver',
                args: ['--stdio'],
                transport: 'stdio',
                rootUri: 'file:///workspace',
                workspaceFolder: '/workspace',
              },
              error: 'startup failed' as unknown as Error,
            }),
          ],
        ]),
      ),
    } as unknown as NativeLspService;

    const client = new NativeLspClient(service);

    expect(client.getServerStatus()).toEqual([
      {
        name: 'pyright',
        status: 'FAILED',
        command: 'pyright-langserver',
        languages: ['python'],
        error: 'startup failed',
      },
    ]);
  });
});
