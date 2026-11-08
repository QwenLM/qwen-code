/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ManagedExtensionRuntimeControl } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import { HostedExtensionSession } from './hosted-extension-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST } from './managed-extension-profile.js';

const cleanups: Array<() => Promise<void>> = [];
const personalBinding = {
  serverId: 'sample:tools',
  credentialId: 'mcred_11111111-1111-4111-8111-111111111111',
  credentialGeneration: 2,
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-extension-apply-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'test',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  cleanups.push(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  const owners = {
    bindingId: 'original-binding',
    generation: '1',
    workspaceGeneration: '1',
  };
  const warm = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'warm')
    .mockImplementation(async function (this: HostedWorkspaceBroker) {
      this.runtime = owners;
    });
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'capabilityDigest',
    'get',
  ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
  const states = new Map<string, { state: string; revision: number }>();
  let rejectPrepare = false;
  let rejectActivation = false;
  const control = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'extensionControl')
    .mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation: ManagedExtensionRuntimeControl,
    ) {
      this.runtime = owners;
      const common = {
        operationId: operation.operationId,
        executionMode: 'developer-process-group',
      };
      if (operation.kind === 'extension-prepare') {
        if (rejectPrepare) throw new Error('invalid package');
        states.set(operation.operationId, {
          state: 'prepared',
          revision: operation.expectedRevision + 1,
        });
        return {
          ...common,
          state: 'prepared',
          expectedRevision: operation.expectedRevision,
          revision: operation.expectedRevision + 1,
          packages: operation.extensions.map((pin) => ({
            pin,
            assetRoot: `extension://${pin.extensionId}/`,
            contributions: {
              skills: [],
              commands: [],
              agents: [],
              context: [],
              mcpServers: {},
              hooks: {},
              settings: [],
            },
          })),
          mcpServers: operation.baseMcpServers,
          hookCatalog: null,
        };
      }
      if (operation.kind === 'extension-activate') {
        if (rejectActivation) {
          states.set(operation.operationId, {
            state: 'outcome_unknown',
            revision: operation.revision,
          });
          throw new Error('lost activation response');
        }
        states.set(operation.operationId, {
          state: 'active',
          revision: operation.revision,
        });
      }
      if (operation.kind === 'extension-reconcile') {
        states.set(operation.operationId, {
          state: 'failed',
          revision: operation.revision,
        });
        return {
          ...common,
          state: 'stopped',
          revision: operation.revision,
          receipts: [{ ownerId: 'old-owner', state: 'stopped' }],
        };
      }
      return {
        ...common,
        ...(states.get(operation.operationId) ?? {
          state: 'not_found',
          revision: 0,
        }),
      };
    });
  const callbacks = {
    validate: vi.fn(),
    drain: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
  };
  const manager = new HostedExtensionSession(
    session,
    { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
    { mcpRevision: 0, mcpServers: [], hookCatalog: null },
    callbacks,
  );
  await manager.open();
  const command = (expectedRevision = 0, extensionId = 'sample') => ({
    operationId: randomUUID(),
    actorKey: 'a'.repeat(64),
    expectedRevision,
    extensions: [
      { extensionId, packageRevision: 1, packageDigest: 'b'.repeat(64) },
    ],
  });
  return {
    session,
    manager,
    warm,
    control,
    callbacks,
    command,
    reopen: async () => {
      const reopened = new HostedExtensionSession(
        session,
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        { mcpRevision: 0, mcpServers: [], hookCatalog: null },
        callbacks,
      );
      await reopened.open();
      return reopened;
    },
    failPrepare: (fail = true) => {
      rejectPrepare = fail;
    },
    failActivation: (fail = true) => {
      rejectActivation = fail;
    },
  };
}

describe('Hosted extension Session configuration', () => {
  it('persists v2 references on reload and rejects legacy writes before touching the Runtime', async () => {
    const context = await fixture();
    const command = {
      ...context.command(),
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
    };
    await context.manager.submit(command);
    const reference = context.manager.activeBundleRef;
    const reloaded = await context.reopen();
    expect(reloaded.activeBundleRef).toEqual(reference);
    expect(await reloaded.active()).toMatchObject({
      formatVersion: 2,
      executionActorKey: command.actorKey,
      mcpAuthBindings: [personalBinding],
    });
    expect(await reloaded.snapshot()).toMatchObject({
      revision: 1,
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
      operation: { operationId: command.operationId, state: 'active' },
    });
    context.control.mockClear();
    context.warm.mockClear();
    await expect(reloaded.submit(context.command(1))).rejects.toThrow(
      'version 2',
    );
    expect(context.control).not.toHaveBeenCalled();
    expect(context.warm).not.toHaveBeenCalled();
    expect(reloaded.activeBundleRef).toEqual(reference);
  });

  it('preserves personal ownership when independently adding MCP and rejects another actor', async () => {
    const context = await fixture();
    const command = {
      ...context.command(),
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
    };
    await context.manager.submit(command);
    const server = {
      serverId: 'independent',
      serverRevision: 1,
      definitionDigest: 'c'.repeat(64),
    };
    const definitions = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'mcpDefinitions')
      .mockResolvedValue([{ ...server, transport: 'stdio' }]);
    const add = {
      operationId: randomUUID(),
      actorKey: command.actorKey,
      expectedRevision: 0,
      action: 'add' as const,
      serverId: server.serverId,
      server,
    };
    await expect(
      context.manager.submitMcp({ ...add, actorKey: 'd'.repeat(64) }),
    ).rejects.toThrow('another actor');
    expect(definitions).not.toHaveBeenCalled();
    await context.manager.submitMcp(add);
    expect(await context.manager.active()).toMatchObject({
      formatVersion: 2,
      configRevision: 2,
      executionActorKey: command.actorKey,
      mcpAuthBindings: [personalBinding],
      packages: [{ pin: command.extensions[0] }],
      independentMcpSelections: [{ ...server, state: 'enabled' }],
    });
    expect(await (await context.reopen()).snapshot()).toMatchObject({
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
    });
    const prepare = context.control.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === 'extension-prepare')
      .at(-1)!;
    expect(prepare.command).toMatchObject({
      selectionVersion: 2,
      actorKey: command.actorKey,
      mcpAuthBindings: [personalBinding],
    });
  });

  it('restores previous personal references as a newer revision after a failed binding removal', async () => {
    const context = await fixture();
    const initial = {
      ...context.command(),
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
    };
    await context.manager.submit(initial);
    context.failActivation();
    const failed = {
      ...context.command(1),
      actorKey: 'b'.repeat(64),
      selectionVersion: 2,
      mcpAuthBindings: [],
    };
    await expect(context.manager.submit(failed)).rejects.toThrow(
      'lost activation response',
    );
    const reloaded = await context.reopen();
    expect(await reloaded.active()).toMatchObject({
      mcpAuthBindings: [personalBinding],
      executionActorKey: initial.actorKey,
    });
    expect(await reloaded.snapshot()).toMatchObject({
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
      revision: 2,
      operation: { state: 'recovery_required' },
    });
    context.failActivation(false);
    await reloaded.recoverPrevious(failed.operationId);
    expect(await reloaded.active()).toMatchObject({
      formatVersion: 2,
      configRevision: 3,
      executionActorKey: initial.actorKey,
      mcpAuthBindings: [personalBinding],
    });
    expect(await (await context.reopen()).snapshot()).toMatchObject({
      revision: 3,
      selectionVersion: 2,
      mcpAuthBindings: [personalBinding],
      operation: {
        operationId: failed.operationId,
        mode: 'recoverPrevious',
        state: 'active',
      },
    });
    const preparation = context.control.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === 'extension-prepare')
      .at(-1)!;
    expect(preparation.command).toMatchObject({
      selectionVersion: 2,
      actorKey: initial.actorKey,
      mcpAuthBindings: [personalBinding],
    });
    expect(preparation.operationId).not.toBe(failed.operationId);
  });

  it('blocks a failed initial selection on reload until an explicit repair is active', async () => {
    const context = await fixture();
    const initial = context.command();
    context.failPrepare();
    await expect(context.manager.bootstrap(initial)).rejects.toThrow(
      'invalid package',
    );
    await expect(context.manager.bootstrap(initial)).rejects.toThrow(
      'requires recovery',
    );
    expect(context.manager.activeBundleRef).toBeUndefined();
    context.failPrepare(false);
    await context.manager.submit(context.command(0, 'repaired'));
    await expect(context.manager.bootstrap(initial)).resolves.toBeUndefined();
    expect(await context.manager.active()).toMatchObject({
      configRevision: 1,
      packages: [{ pin: { extensionId: 'repaired' } }],
    });
  });

  it('activates an explicit empty initial selection', async () => {
    const context = await fixture();
    await context.manager.bootstrap({ ...context.command(), extensions: [] });
    expect(context.manager.activeBundleRef).toBeDefined();
    expect(await context.manager.active()).toMatchObject({
      configRevision: 1,
      packages: [],
    });
  });

  it('keeps the previous view usable when preparation fails', async () => {
    const context = await fixture();
    context.failPrepare();
    await expect(context.manager.submit(context.command())).rejects.toThrow(
      'invalid package',
    );
    expect(context.manager.pending).toBe(false);
    expect(await context.manager.snapshot()).toMatchObject({
      revision: 0,
      extensions: [],
      operation: { state: 'failed' },
    });
    expect(context.callbacks.drain).not.toHaveBeenCalled();
    expect(
      context.session.authority
        .eventsInSequenceRange(1, context.session.authority.committedSequence)
        .filter((event) => event.kind === 'config.bound'),
    ).toHaveLength(0);
  });

  it('commits the binding before drain and only queries an unknown original operation', async () => {
    const context = await fixture();
    context.callbacks.drain.mockImplementation(async () => {
      expect(
        context.session.authority
          .eventsInSequenceRange(1, context.session.authority.committedSequence)
          .filter((event) => event.kind === 'config.bound'),
      ).toHaveLength(1);
    });
    context.failActivation();
    const command = context.command();
    await expect(context.manager.submit(command)).rejects.toThrow(
      'lost activation response',
    );
    expect(context.manager.pending).toBe(true);
    const activations = () =>
      context.control.mock.calls.filter(
        ([operation]) => operation.kind === 'extension-activate',
      );
    expect(activations()).toHaveLength(1);
    await expect(context.manager.continue(command.operationId)).rejects.toThrow(
      'requires recovery',
    );
    expect(activations()).toHaveLength(1);
    expect(context.warm).toHaveBeenCalledTimes(1);
  });

  it('restores saved pins as a newer revision after proving the failed owner stopped', async () => {
    const context = await fixture();
    await context.manager.submit(context.command());
    context.failActivation();
    const failed = context.command(1, 'replacement');
    await expect(context.manager.submit(failed)).rejects.toThrow();
    context.failActivation(false);
    await context.manager.recoverPrevious(failed.operationId);
    expect(await context.manager.snapshot()).toMatchObject({
      revision: 3,
      extensions: [{ extensionId: 'sample' }],
      operation: { mode: 'recoverPrevious', state: 'active' },
    });
    const prepares = context.control.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === 'extension-prepare');
    expect(prepares.at(-1)).toMatchObject({
      expectedRevision: 2,
      extensions: [{ extensionId: 'sample' }],
    });
    expect(prepares.at(-1)!.operationId).not.toBe(failed.operationId);
  });

  it('retries a compensation preparation on its original operation after a transient failure', async () => {
    const context = await fixture();
    await context.manager.submit(context.command());
    context.failActivation();
    const failed = context.command(1, 'replacement');
    await expect(context.manager.submit(failed)).rejects.toThrow();
    context.failActivation(false);
    context.failPrepare();
    await expect(
      context.manager.recoverPrevious(failed.operationId),
    ).rejects.toThrow('invalid package');
    expect(context.manager.pending).toBe(true);
    expect(await context.manager.snapshot()).toMatchObject({
      operation: { mode: 'recoverPrevious', state: 'preparing' },
    });
    const prepareOperation = context.control.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === 'extension-prepare')
      .at(-1)!.operationId;
    context.failPrepare(false);
    await context.manager.continue(failed.operationId);
    expect(context.manager.pending).toBe(false);
    expect(await context.manager.snapshot()).toMatchObject({
      revision: 3,
      extensions: [{ extensionId: 'sample' }],
      operation: { mode: 'recoverPrevious', state: 'active' },
    });
    const compensationPrepares = context.control.mock.calls
      .map(([operation]) => operation)
      .filter(
        (operation) =>
          operation.kind === 'extension-prepare' &&
          operation.expectedRevision === 2,
      );
    expect(compensationPrepares).toHaveLength(3);
    expect(
      compensationPrepares.every(
        (operation) => operation.operationId === prepareOperation,
      ),
    ).toBe(true);
    expect(
      context.control.mock.calls.filter(
        ([operation]) => operation.kind === 'extension-reconcile',
      ),
    ).toHaveLength(1);
  });
});
