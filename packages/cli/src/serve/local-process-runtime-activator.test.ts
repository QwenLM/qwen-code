/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalProcessRuntimeActivator,
  managedWorkerEnvironment,
} from './local-process-runtime-activator.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

const fixture = `
process.on('message', b => {
  if (b.type === 'shutdown') process.exit(0);
  if (b.type === 'boot') setTimeout(() => process.send({ ...b, token: undefined, type: 'ready', url: 'http://127.0.0.1:12345' }), 50);
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;
const active: LocalProcessRuntimeActivator[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((a) => a.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(maxWorkers = 4, code = fixture, startupMs = 3000) {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-activator-test-'),
  );
  dirs.push(stateDir);
  const log = vi.fn();
  const activator = new LocalProcessRuntimeActivator({
    stateDir,
    cliEntry: process.execPath,
    launcher: ['-e', code],
    env: process.env,
    maxWorkers,
    startupMs,
    log,
  });
  active.push(activator);
  return { activator, log };
}
function scope(id = 'a') {
  return {
    tenantId: 'tenant',
    runtime: {
      workspaceId: id,
      workspaceCwd: os.tmpdir(),
      trusted: true,
    } as WorkspaceRuntime,
  };
}

describe('owned Runtime activation', () => {
  it('separates admission closure from verified worker exit', async () => {
    const { activator } = await setup(
      1,
      fixture.replace(
        "process.on('SIGTERM', () => process.exit(0));",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));",
      ),
    );
    const workspace = scope();
    const use = activator.activate(workspace);
    await use.endpoint;
    let exited = false;
    const exit = use.exited.then(() => {
      exited = true;
    });
    const shutdown = activator.revokeWorkspace(workspace.runtime);
    expect(use.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(exited).toBe(false);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(1);
    await shutdown;
    await exit;
    expect(exited).toBe(true);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(0);
  });

  it('starts once for concurrent uses, fences each lease and ignores duplicate release', async () => {
    const { activator, log } = await setup();
    const workspace = scope();
    const first = activator.activate(workspace);
    const second = activator.activate(workspace);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(2);
    const [one, two] = await Promise.all([first.endpoint, second.endpoint]);
    expect(one.boot.leaseId).toBe(two.boot.leaseId);
    expect(
      log.mock.calls.filter(([event]) => event === 'started'),
    ).toHaveLength(1);
    first.release('cancelled');
    first.release('cancelled');
    expect(second.signal.aborted).toBe(false);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(1);
    second.release('completed');
    expect(activator.workspaceActivity(workspace.runtime)).toBe(0);
    await activator.revokeWorkspace(workspace.runtime);
    expect(second.signal.aborted).toBe(true);
  });
  it('keeps uncertain execution reserved after cancellation ACK until other uses finish', async () => {
    const { activator } = await setup(1);
    const workspace = scope();
    const first = activator.activate(workspace);
    const other = activator.activate(workspace);
    await first.endpoint;
    const executed = first.beginOperation();
    executed(false);
    first.release('cancelled');
    expect(other.signal.aborted).toBe(false);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(2);
    await expect(activator.activate(workspace).endpoint).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
    });
    await expect(activator.activate(scope('b')).endpoint).rejects.toMatchObject(
      { code: 'managed_runtime_capacity_exhausted' },
    );
    other.release('completed');
    await vi.waitFor(() =>
      expect(activator.workspaceActivity(workspace.runtime)).toBe(0),
    );
    const replacement = activator.activate(workspace);
    const endpoint = await replacement.endpoint;
    expect(endpoint.boot.epoch).toBe(2);
    replacement.release('completed');
  });
  it('evicts idle generations before a new scope starts and never evicts busy uses', async () => {
    const { activator } = await setup(1);
    const workspace = scope();
    const first = activator.activate(workspace);
    await first.endpoint;
    await expect(activator.activate(scope('b')).endpoint).rejects.toMatchObject(
      { code: 'managed_runtime_capacity_exhausted' },
    );
    first.release('completed');
    const next = activator.activate(scope('b'));
    await next.endpoint;
    expect(first.signal.aborted).toBe(true);
    expect(activator.workspaceActivity(workspace.runtime)).toBe(0);
    next.release('completed');
  });
  it('blocks reload until the new snapshot publishes, and drain rollback cannot revive revoked use', async () => {
    const { activator } = await setup();
    const workspace = scope();
    const first = activator.activate(workspace);
    await first.endpoint;
    await activator.reloadWorkspace(workspace.runtime);
    await expect(activator.activate(workspace).endpoint).rejects.toThrow();
    activator.completeReload(workspace.runtime);
    const next = activator.activate(workspace);
    expect((await next.endpoint).boot.epoch).toBe(2);
    activator.beginDrain(workspace.runtime);
    await expect(activator.activate(workspace).endpoint).rejects.toThrow();
    activator.cancelDrain(workspace.runtime);
    next.release('completed');
    await activator.revokeWorkspace(workspace.runtime);
    activator.cancelDrain(workspace.runtime);
    await expect(activator.activate(workspace).endpoint).rejects.toThrow();
  });
  it('contains startup cancellation and shutdown without late attachment', async () => {
    const { activator } = await setup();
    const workspace = scope();
    const first = activator.activate(workspace);
    first.release('cancelled');
    await expect(first.endpoint).rejects.toThrow();
    await activator.close();
    expect(activator.workspaceActivity(workspace.runtime)).toBe(0);
    await expect(activator.activate(workspace).endpoint).rejects.toThrow();
  });
  it('bounds replacement requests while eviction is still awaiting exit', async () => {
    const { activator } = await setup(
      1,
      fixture.replace(
        "process.on('SIGTERM', () => process.exit(0));",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));",
      ),
    );
    const first = activator.activate(scope('a'));
    await first.endpoint;
    first.release('completed');
    const replacement = activator.activate(scope('b'));
    replacement.release('completed');
    for (let i = 0; i < 20; i++)
      await expect(
        activator.activate(scope(`extra-${i}`)).endpoint,
      ).rejects.toMatchObject({ code: 'managed_runtime_capacity_exhausted' });
    await replacement.endpoint;
  });
  it('reclaims a proven dead worker after forced termination', async () => {
    const { activator } = await setup(
      1,
      fixture.replace(
        "process.on('SIGTERM', () => process.exit(0));",
        "process.on('SIGTERM', () => {});",
      ),
      15_000,
    );
    const first = activator.activate(scope('a'));
    await first.endpoint;
    first.release('completed');
    const next = activator.activate(scope('b'));
    await next.endpoint;
    expect(first.signal.aborted).toBe(true);
    next.release('completed');
  }, 20_000);

  it('never forwards ambient model, Gateway, IDE or loader secrets', () => {
    expect(
      managedWorkerEnvironment({
        HOME: '/home/test',
        PATH: '/bin',
        WSL_INTEROP: '/run/WSL/123_interop',
        QWEN_HOME: '/config',
        QWEN_CODE_TRUSTED_FOLDERS_PATH: '/trust',
        OPENAI_API_KEY: 'secret',
        QWEN_SERVER_TOKEN: 'secret',
        QWEN_MANAGED_RUNTIME_TOKEN: 'secret',
        NODE_OPTIONS: '--import evil',
        QWEN_CODE_IDE_WORKSPACE_PATH: '/other',
      }),
    ).toEqual({
      HOME: '/home/test',
      PATH: '/bin',
      WSL_INTEROP: '/run/WSL/123_interop',
      QWEN_HOME: '/config',
      QWEN_CODE_TRUSTED_FOLDERS_PATH: '/trust',
    });
  });
});
