/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import { AcpDispatcher } from './dispatch.js';
import { RPC } from './json-rpc.js';

describe('ACP HTTP agent backend rejection', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'qwen-acp-agent-backend-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      join(directory, 'global'),
    );
    vi.spyOn(Storage, 'getRuntimeBaseDir').mockReturnValue(
      join(directory, 'runtime'),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function setup(trusted = true) {
    type Dependencies = ConstructorParameters<typeof AcpDispatcher>;
    const publishWorkspaceEvent = vi.fn();
    const assertOpen = vi.fn();
    const dispatcher = new AcpDispatcher(
      { publishWorkspaceEvent } as unknown as Dependencies[0],
      directory,
      () => ({}),
      {} as Dependencies[3],
      {} as Dependencies[4],
      {} as Dependencies[5],
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => trusted,
      () => assertOpen,
    );
    const sendConn = vi.fn();
    const connection = {
      fromLoopback: true,
      sendConn,
    } as unknown as Parameters<AcpDispatcher['handle']>[0];
    return {
      dispatcher,
      connection,
      sendConn,
      publishWorkspaceEvent,
      assertOpen,
    };
  }

  it.each(['container', 'local', null])(
    'rejects create and mixed update with executionBackend=%j before filesystem mutation',
    async (executionBackend) => {
      const {
        dispatcher,
        connection,
        sendConn,
        publishWorkspaceEvent,
        assertOpen,
      } = setup();
      const agentsDir = join(directory, '.qwen', 'agents');
      await fs.mkdir(agentsDir, { recursive: true });
      const file = join(agentsDir, 'existing-agent.md');
      const original =
        '---\nname: existing-agent\ndescription: Original\n---\nComplete the requested task.\n';
      await fs.writeFile(file, original);
      for (const action of ['create', 'update']) {
        await dispatcher.handle(connection, {
          jsonrpc: '2.0',
          id: action,
          method: `_qwen/workspace/agents/${action}`,
          params: {
            scope: 'workspace',
            name: 'new-agent',
            agentType: 'existing-agent',
            description: 'Changed',
            systemPrompt: 'Complete the requested task.',
            executionBackend,
          },
        });
        expect(sendConn).toHaveBeenLastCalledWith({
          jsonrpc: '2.0',
          id: action,
          error: {
            code: RPC.INVALID_PARAMS,
            message: 'Daemon agents do not support executionBackend.',
          },
        });
      }
      expect(assertOpen).toHaveBeenCalledTimes(2);
      expect(publishWorkspaceEvent).not.toHaveBeenCalled();
      expect(await fs.readdir(agentsDir)).toEqual(['existing-agent.md']);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    },
  );

  it('keeps the workspace trust refusal before the backend declaration guard', async () => {
    const { dispatcher, connection, sendConn, publishWorkspaceEvent } =
      setup(false);
    await dispatcher.handle(connection, {
      jsonrpc: '2.0',
      id: 1,
      method: '_qwen/workspace/agents/create',
      params: { executionBackend: 'container' },
    });
    expect(sendConn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: -32003,
          message: 'Workspace is not trusted.',
        }),
      }),
    );
    expect(publishWorkspaceEvent).not.toHaveBeenCalled();
  });
});
