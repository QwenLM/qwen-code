/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  parseMcpConfiguration,
  parseMcpOperation,
  type McpConfiguration,
  type McpOperation,
} from './managed-mcp-record.js';

const directories: string[] = [];
const sessionKey = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: '550e8400-e29b-41d4-a716-446655440001',
};
const actor = { class: 'trusted_entry' } as const;
const runtime = { runtimeBindingId: 'runtime-1', generation: '1' };
const definition = {
  definitionId: 'server-1',
  definitionRevision: 1,
  definitionDigest: 'b'.repeat(64),
};
const initialRun = {
  state: 'admitted',
  reason: null,
  definition,
  executionCallId: null,
  effectId: 'configure-1',
  dispatchId: null,
  deliveryId: null,
  execution: 'intent',
  runtime: null,
  delivery: null,
} as const;

function command(commandId: string) {
  return {
    operation: 'commitMcpRecord',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('reopens MCP chains and resource closure without tasks, preserves unknown operations and original bindings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-mcp-authority-'));
  directories.push(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    root,
    'chats',
    `${sessionKey.sessionId}.jsonl`,
  );
  await mkdir(runtimeBaseDir, { recursive: true });
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const open = async (create: boolean) => {
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources,
      ...(create
        ? {
            create: {
              definitionRef: await resources.publish(
                'definition',
                Buffer.from('{}'),
              ),
              rootSnapshotRef: await resources.publish(
                'root',
                Buffer.from('{}'),
              ),
              createdBy: 'daemon',
            },
          }
        : {}),
    });
    return { lease, authority };
  };
  const first = await open(true);
  let configuration: McpConfiguration = parseMcpConfiguration({
    configurationId: 'configure-1',
    runtimeSessionId: 'mcp:session-1',
    serverId: 'server-1',
    serverRevision: 1,
    configRevision: 1,
    catalogRevision: null,
    connectionGeneration: null,
    catalogRef: null,
    releaseState: 'active',
    run: initialRun,
  });
  let operation: McpOperation;
  try {
    const receipt = await first.authority.commitExtensionRecord(
      command('configure-1'),
      { domain: 'mcp_configuration', record: configuration },
      actor,
    );
    expect(receipt.taskId).toBeNull();
    configuration = {
      ...configuration,
      run: {
        ...configuration.run,
        state: 'running',
        execution: 'dispatch_started',
        runtime,
      },
    };
    await first.authority.commitExtensionRecord(
      command('configure-dispatch'),
      { domain: 'mcp_configuration', record: configuration },
      actor,
    );
    configuration = {
      ...configuration,
      connectionGeneration: 1,
      catalogRevision: 1,
      catalogRef: await resources.publish(
        'mcp-catalog',
        Buffer.from('{"tools":[]}'),
      ),
      run: { ...configuration.run, state: 'settled', execution: 'settled' },
    };
    await first.authority.commitExtensionRecord(
      command('configure-result'),
      { domain: 'mcp_configuration', record: configuration },
      actor,
    );
    await expect(
      first.authority.commitExtensionRecord(
        command('configure-2'),
        {
          domain: 'mcp_configuration',
          record: {
            ...configuration,
            configurationId: 'configure-2',
            catalogRef: null,
            catalogRevision: null,
            connectionGeneration: null,
            run: {
              ...initialRun,
              effectId: 'configure-2',
              definition: { ...definition, definitionDigest: 'c'.repeat(64) },
            },
          },
        },
        actor,
      ),
    ).rejects.toThrow('two definition digests');
    operation = parseMcpOperation({
      operationId: 'operation-1',
      configurationId: 'configure-1',
      serverId: 'server-1',
      serverRevision: 1,
      configRevision: 1,
      catalogRevision: 1,
      connectionGeneration: 1,
      operationKind: 'resource_read',
      argsRef: await resources.publish(
        'mcp-args',
        Buffer.from('{"uri":"mcp://file"}'),
      ),
      resultRef: null,
      cancelRequested: false,
      run: { ...initialRun, effectId: 'operation-1' },
    });
    await expect(
      first.authority.commitExtensionRecord(
        command('wrong-binding'),
        {
          domain: 'mcp_operation',
          record: { ...operation, catalogRevision: 2 },
        },
        actor,
      ),
    ).rejects.toThrow('active committed configuration');
    await first.authority.commitExtensionRecord(
      command('operation-1'),
      { domain: 'mcp_operation', record: operation },
      actor,
    );
    operation = {
      ...operation,
      run: {
        ...operation.run,
        state: 'running',
        execution: 'dispatch_started',
        runtime,
      },
    };
    await first.authority.commitExtensionRecord(
      command('operation-dispatch'),
      { domain: 'mcp_operation', record: operation },
      actor,
    );
    operation = {
      ...operation,
      run: {
        ...operation.run,
        state: 'recovery_blocked',
        execution: 'outcome_unknown',
        reason: 'outcome_unknown',
      },
    };
    await first.authority.commitExtensionRecord(
      command('operation-unknown'),
      { domain: 'mcp_operation', record: operation },
      actor,
    );
    expect(first.authority.taskViews()).toEqual([]);
  } finally {
    await first.lease.release();
  }
  const reopened = await open(false);
  try {
    expect(reopened.authority.taskViews()).toEqual([]);
    expect(
      reopened.authority.extensionRecordsInDomain('mcp_configuration'),
    ).toHaveLength(1);
    expect(
      reopened.authority.extensionRecord('mcp_operation', 'operation-1'),
    ).toMatchObject({
      task: null,
      record: operation!,
      run: { state: 'recovery_blocked' },
    });
    const next = {
      ...operation!,
      resultRef: await resources.publish(
        'mcp-response',
        Buffer.from('{"contents":[{"blob":"YQ=="}]}'),
      ),
      run: {
        ...operation!.run,
        state: 'settled',
        execution: 'settled',
        reason: null,
      },
    };
    await reopened.authority.commitExtensionRecord(
      command('late-result'),
      { domain: 'mcp_operation', record: next },
      actor,
    );
    const releasing = { ...configuration, releaseState: 'releasing' };
    await reopened.authority.commitExtensionRecord(
      command('release-intent'),
      { domain: 'mcp_configuration', record: releasing },
      actor,
    );
    const newOperation = {
      ...operation!,
      operationId: 'operation-2',
      run: { ...initialRun, effectId: 'operation-2' },
    };
    await expect(
      reopened.authority.commitExtensionRecord(
        command('operation-2'),
        { domain: 'mcp_operation', record: newOperation },
        actor,
      ),
    ).rejects.toThrow('active committed configuration');
    await reopened.authority.commitExtensionRecord(
      command('drain-receipt'),
      {
        domain: 'mcp_configuration',
        record: { ...releasing, releaseState: 'drained' },
      },
      actor,
    );
    await expect(
      reopened.authority.commitExtensionRecord(
        command('operation-after-drain'),
        { domain: 'mcp_operation', record: newOperation },
        actor,
      ),
    ).rejects.toThrow('active committed configuration');
    await reopened.authority.commitExtensionRecord(
      command('release-result'),
      {
        domain: 'mcp_configuration',
        record: { ...releasing, releaseState: 'released' },
      },
      actor,
    );
  } finally {
    await reopened.lease.release();
  }
  const final = await open(false);
  try {
    expect(
      final.authority.extensionRecordsInDomain('mcp_configuration')[0].record,
    ).toMatchObject({ releaseState: 'released' });
    expect(
      final.authority.extensionRecordsInDomain('mcp_operation')[0].run.state,
    ).toBe('settled');
    expect(final.authority.taskViews()).toEqual([]);
  } finally {
    await final.lease.release();
  }
});
