/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  mcpApp,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  useToolApprovals,
  waitFor,
} from './hosted-harness-session-approvals.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HostedMcpManager } from './hosted-mcp-settings.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import { ManagedSessionAppendUnsettledError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedMcpSession } from './hosted-mcp-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness tool approvals', () => {
  useToolApprovals();

  it('reattaches for MCP management without paying resident cleanup debt or waking work', async () => {
    const { server, authorize, requests } = await mcpApp();
    const prompt = [{ type: 'text', text: 'finish a turn' }];
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.hasActivePrompt).toBe(false);
    });
    const resident = (
      wakeDeps.last as {
        session: { managed: Awaited<ReturnType<typeof openManagedSession>> };
      }
    ).session;
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
    ).toBe(true);
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      hostedRuntimeSessionId(PROMPT_ID),
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, PROMPT_ID, broker);
    const sequence = resident.managed.authority.committedSequence;
    state.model.mockClear();
    requests.length = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockClear();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
      .mockImplementation(() => {});
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        mcpManagementOnly: true,
      })
      .expect(200);
    expect(loaded.body.sessionId).toBe(SESSION_ID);
    expect(resident.managed.authority.committedSequence).toBe(sequence);
    expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(state.model).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
      })
      .expect(409);
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    expect(resident.managed.authority.committedSequence).toBeGreaterThan(
      sequence,
    );
  });

  it('requires an explicit Session load before cold MCP management without opening its journal', async () => {
    const server = await app(true);
    const before = await readdir(state.root, { recursive: true });
    const load = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        mcpManagementOnly: true,
      })
      .expect(409);
    expect(load.body.code).toBe('hosted_mcp_session_load_required');
    expect(await readdir(state.root, { recursive: true })).toEqual(before);
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each([
    { managedSessionStore: { ...store(), tenantId: 'foreign' } },
    { managedSessionStore: { ...store(), workspaceId: 'foreign' } },
    { managedSessionStore: { ...store(), baseUrl: 'https://foreign.test' } },
    {
      mcpServers: [
        {
          serverId: 'demo',
          serverRevision: 2,
          definitionDigest: 'a'.repeat(64),
        },
      ],
    },
    { toolProfile: 'hosted-workspace-shell/1' },
  ])('rejects a mismatched MCP management attachment %j', async (drift) => {
    const { server } = await mcpApp();
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        mcpManagementOnly: true,
        ...drift,
      })
      .expect(409);
    expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each([
    'passiveManagedRuntimeRecovery',
    'driveRuntimeRecovery',
    'cancellationTakeover',
    'stopMessages',
  ])(
    'refuses recovery flag %s on an MCP management attachment',
    async (flag) => {
      const { server } = await mcpApp();
      const load = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-mcp/1',
          mcpServers: [
            {
              serverId: 'demo',
              serverRevision: 1,
              definitionDigest: 'a'.repeat(64),
            },
          ],
          mcpManagementOnly: true,
          [flag]: true,
        })
        .expect(400);
      expect(load.body.code).toBe('invalid_mcp_management_attachment');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('manages Session MCP over its live owner with command identity and revision checks', async () => {
    const pin = {
      serverId: 'demo',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([{ ...pin, transport: 'stdio' }]);
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const snapshot = await authorize(supertest(server).get(route));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({
      sessionId: SESSION_ID,
      revision: 0,
      supported: true,
    });
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'disable',
      serverId: 'demo',
      expectedRevision: 0,
    };
    const disabled = await authorize(supertest(server).post(route)).send(
      command,
    );
    expect(disabled.status).toBe(202);
    expect(disabled.body).toMatchObject({
      revision: 1,
      servers: [{ ...pin, state: 'disabled' }],
      operation: { operationId: command.operationId, state: 'settled' },
    });
    const replay = await authorize(supertest(server).post(route)).send(command);
    expect(replay.status).toBe(202);
    expect(replay.body.revision).toBe(1);
    const conflict = await authorize(supertest(server).post(route)).send({
      ...command,
      action: 'remove',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_mcp_configuration_conflict');
    const stale = await authorize(supertest(server).post(route)).send({
      ...command,
      operationId: randomUUID(),
      action: 'enable',
    });
    expect(stale.status).toBe(409);
    const status = await authorize(
      supertest(server).get(`${route}/operations/${command.operationId}`),
    );
    expect(status.status).toBe(200);
    expect(status.body.operation.state).toBe('settled');
    const foreign = await headers(supertest(server).post(route))
      .set('X-Qwen-Client-Id', 'foreign')
      .send(command);
    expect(foreign.status).toBe(404);
  });

  it('preserves an unknown MCP settings append as retryable instead of a definite conflict', async () => {
    const pin = {
      serverId: 'demo',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([{ ...pin, transport: 'stdio' }]);
    vi.spyOn(HostedMcpManager.prototype, 'submit').mockRejectedValueOnce(
      new ManagedSessionAppendUnsettledError(new Error('Commit response lost')),
    );
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'disable',
      serverId: 'demo',
      expectedRevision: 0,
    };
    const unknown = await authorize(supertest(server).post(route)).send(
      command,
    );
    expect(unknown.status).toBe(503);
    expect(unknown.body.code).toBe('hosted_mcp_recovery_required');
    const retry = await authorize(supertest(server).post(route)).send(command);
    expect(retry.status).toBe(202);
    expect(retry.body.operation).toMatchObject({
      operationId: command.operationId,
      state: 'settled',
    });
  });

  it('keeps concurrent MCP management and private reconfiguration out while a command is pending', async () => {
    const pin = {
      serverId: 'second',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    let complete:
      | ((value: Array<typeof pin & { transport: 'stdio' }>) => void)
      | undefined;
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'add',
      serverId: 'second',
      expectedRevision: 0,
      server: pin,
    };
    const pending = authorize(supertest(server).post(route))
      .send(command)
      .then((response) => response);
    await vi.waitFor(() => expect(complete).toBeDefined());
    const competing = await authorize(supertest(server).post(route)).send({
      ...command,
      operationId: randomUUID(),
    });
    expect(competing.status).toBe(409);
    expect(competing.body.code).toBe('hosted_turn_active');
    const privateRoute = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    ).send({
      operationId: randomUUID(),
      expectedRevision: 1,
      server: { ...pin, serverId: 'demo' },
    });
    expect(privateRoute.status).toBe(409);
    complete!([{ ...pin, transport: 'stdio' }]);
    expect((await pending).status).toBe(202);
  });

  it('names writes_stopped on the MCP operations gate when the writer is stopped', async () => {
    const { server, authorize } = await mcpApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'writesStopped',
      'get',
    ).mockReturnValue(true);
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    // The stopped writer outranks the pending operations the gate fired on.
    expect(refused.body.reason).toBe('writes_stopped');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });
});
