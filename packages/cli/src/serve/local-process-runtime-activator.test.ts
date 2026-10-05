/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment node
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  LocalProcessRuntimeActivator,
  managedWorkerEnvironment,
} from './local-process-runtime-activator.js';
import { ProcessRegistry } from '@qwen-code/acp-bridge';
import type { WorkspaceRuntime } from './workspace-registry.js';

const fixture = `
process.on('message', b => {
  if (b.type === 'shutdown') process.exit(0);
  if (b.type === 'boot') setTimeout(() => process.send({ ...b, token: undefined, type: 'ready', url: 'http://127.0.0.1:12345' }), 50);
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;
// Arms a controllable rm for the close()-window test: while armed, every rm
// hangs until the test settles it; while disarmed, rm passes through.
const rmControl = vi.hoisted(() => ({
  armed: false,
  calls: 0,
  settle: undefined as
    | undefined
    | { resolve: () => void; reject: (error: unknown) => void },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (!rmControl.armed) return actual.rm(...args);
      rmControl.calls++;
      return new Promise<void>((resolve, reject) => {
        rmControl.settle = { resolve, reject };
      });
    },
  };
});
const active: LocalProcessRuntimeActivator[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((a) => a.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(
  maxWorkers = 4,
  code: string | ((stateDir: string) => string) = fixture,
  startupMs = 3000,
  env: NodeJS.ProcessEnv = process.env,
) {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-activator-test-'),
  );
  dirs.push(stateDir);
  const log = vi.fn();
  const activator = new LocalProcessRuntimeActivator({
    stateDir,
    cliEntry: process.execPath,
    launcher: ['-e', typeof code === 'function' ? code(stateDir) : code],
    env,
    maxWorkers,
    startupMs,
    log,
  });
  active.push(activator);
  return { activator, log, stateDir };
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

// terminate() rejects without proving the exit; the registry's own tracked
// child is untouched, so it stays committed until shutdown — mirroring the
// surviving-groups teardown branch. The restore is registered with the test
// so a rejection before the test body's own teardown cannot leak the stub.
function stubFailingTerminate(): void {
  const originalReserve = ProcessRegistry.prototype.reserve;
  const reserveSpy = vi
    .spyOn(ProcessRegistry.prototype, 'reserve')
    .mockImplementation(function (this: ProcessRegistry) {
      const reservation = originalReserve.call(this);
      return {
        ...reservation,
        attach: (
          child: Parameters<typeof reservation.attach>[0],
          options?: Parameters<typeof reservation.attach>[1],
        ) => {
          const tracked = reservation.attach(child, options);
          return {
            ...tracked,
            terminate: async () => {
              throw new Error(
                'ACP child did not exit with its owned process groups (surviving pgids=[stub])',
              );
            },
          };
        },
      };
    });
  onTestFinished(() => reserveSpy.mockRestore());
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

  it('accepts allowlisted keys under any casing (Windows names are case-insensitive)', () => {
    expect(
      managedWorkerEnvironment({
        Path: '/bin',
        systemroot: 'C:\\Windows',
        lc_all: 'en_US.UTF-8',
        qwen_home: 'config',
        openai_api_key: 'secret',
        qwen_server_token: 'secret',
        node_options: '--import evil',
      }),
    ).toEqual({
      Path: '/bin',
      systemroot: 'C:\\Windows',
      lc_all: 'en_US.UTF-8',
      qwen_home: path.resolve('config'),
    });
  });

  it('spawns the worker without ambient secrets end-to-end', async () => {
    const SECRETS = [
      'OPENAI_API_KEY',
      'QWEN_SERVER_TOKEN',
      'QWEN_MANAGED_RUNTIME_TOKEN',
      'NODE_OPTIONS',
      'QWEN_CODE_IDE_WORKSPACE_PATH',
    ];
    const { activator, stateDir } = await setup(
      4,
      (dir) => `
const fs = require('node:fs');
process.on('message', b => {
  if (b.type === 'shutdown') process.exit(0);
  if (b.type === 'boot') {
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'observed.json'))}, JSON.stringify({
      leaked: ${JSON.stringify(SECRETS)}.filter(k => process.env[k]),
      path: process.env.PATH,
      qwenHome: process.env.QWEN_HOME,
    }));
    setTimeout(() => process.send({ ...b, token: undefined, type: 'ready', url: 'http://127.0.0.1:12345' }), 50);
  }
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`,
      3000,
      {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        QWEN_HOME: 'config',
        OPENAI_API_KEY: 'leak-check',
        QWEN_SERVER_TOKEN: 'leak-check',
        QWEN_MANAGED_RUNTIME_TOKEN: 'leak-check',
        NODE_OPTIONS: '--import leak-check',
        QWEN_CODE_IDE_WORKSPACE_PATH: '/leak-check',
      },
    );
    const use = activator.activate(scope());
    await use.endpoint;
    // Both halves: no secrets leak *and* the allowlist is delivered — an
    // empty spawned environment would pass a leak-only check.
    const observed = JSON.parse(
      await readFile(path.join(stateDir, 'observed.json'), 'utf8'),
    ) as { leaked: string[]; path?: string; qwenHome?: string };
    expect(observed.leaked).toEqual([]);
    expect(observed.path).toBe(process.env['PATH']);
    expect(observed.qwenHome).toBe(path.resolve('config'));
    use.release('completed');
  });

  it('counts an unreclaimed child toward admission after a failed cleanup', async () => {
    const shutdownSpy = vi.spyOn(ProcessRegistry.prototype, 'shutdown');
    onTestFinished(() => shutdownSpy.mockRestore());
    stubFailingTerminate();
    const { activator } = await setup(1);
    const workspace = scope();
    const use = activator.activate(workspace);
    await use.endpoint;
    try {
      await expect(
        activator.revokeWorkspace(workspace.runtime),
      ).rejects.toThrow();
      use.release('completed');
      // The retained generation still occupies the admission slot.
      await expect(
        activator.activate(scope('b')).endpoint,
      ).rejects.toMatchObject({ code: 'managed_runtime_capacity_exhausted' });
      // An unproven teardown also fails closed for the same workspace,
      // instead of admitting a second worker onto the same cwd.
      await expect(
        activator.activate(workspace).endpoint,
      ).rejects.toMatchObject({ code: 'managed_runtime_unavailable' });
    } finally {
      // close() now surfaces this recorded cleanup failure; the recorded
      // assertion above is the full teardown of this one.
      active.splice(active.indexOf(activator), 1);
      await activator.close().catch(() => {});
      // The drain must reach the registry even though the generation's stop
      // already rejected: Promise.all would skip it, allSettled does not.
      expect(shutdownSpy).toHaveBeenCalledOnce();
    }
  });

  it('fails closed for a workspace whose failed teardown left a retiring generation', async () => {
    stubFailingTerminate();
    const { activator } = await setup(1);
    const workspace = scope();
    const use = activator.activate(workspace);
    await use.endpoint;
    try {
      // reloadWorkspace stops without revoking, so only the retained
      // retiring generation can refuse the next activation.
      await expect(
        activator.reloadWorkspace(workspace.runtime),
      ).rejects.toThrow();
      activator.completeReload(workspace.runtime);
      await expect(
        activator.activate(workspace).endpoint,
      ).rejects.toMatchObject({ code: 'managed_runtime_unavailable' });
    } finally {
      active.splice(active.indexOf(activator), 1);
      await activator.close().catch(() => {});
    }
  });

  it('awaits an in-flight stop past the map delete before closing', async () => {
    const { activator } = await setup(1);
    const workspace = scope();
    const use = activator.activate(workspace);
    await use.endpoint;
    rmControl.armed = true;
    try {
      const revoking = activator.revokeWorkspace(workspace.runtime);
      void revoking.catch(() => {});
      // The stop reaches its rm with the generation already off the map.
      await vi.waitFor(() => expect(rmControl.calls).toBe(1));
      let closed = 'pending';
      const closing = activator.close();
      void closing.then(
        () => {
          closed = 'resolved';
        },
        () => {
          closed = 'rejected';
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe('pending');
      rmControl.settle!.reject(new Error('rm failed'));
      await expect(closing).rejects.toThrow('rm failed');
      await expect(revoking).rejects.toThrow('rm failed');
      expect(closed).toBe('rejected');
    } finally {
      rmControl.armed = false;
      active.splice(active.indexOf(activator), 1);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'aggregates a settled rm-class cleanup failure into close()',
    async () => {
      const { activator, stateDir } = await setup(1);
      const workspace = scope();
      const use = activator.activate(workspace);
      await use.endpoint;
      const workersRoot = path.join(stateDir, 'workers');
      await chmod(workersRoot, 0o500);
      try {
        await expect(
          activator.revokeWorkspace(workspace.runtime),
        ).rejects.toThrow();
        // The failure settled before close() — the stop deletion already
        // dropped it from the map, so only instance state can surface it.
        await expect(activator.close()).rejects.toMatchObject({
          code: 'EACCES',
        });
      } finally {
        await chmod(workersRoot, 0o700);
        // close() intentionally aggregates the recorded failure; asserted
        // above, so the shared teardown must not re-await it.
        active.splice(active.indexOf(activator), 1);
      }
    },
  );
});

describe('worker handshake validation', () => {
  const handshakeFixture = (mutations: string) => `
process.on('message', b => {
  if (b.type === 'shutdown') process.exit(0);
  if (b.type === 'boot') setTimeout(() => {
    const ready = { ...b, token: undefined, type: 'ready', url: 'http://127.0.0.1:12345' };
    ${mutations}
    process.send(ready);
  }, 50);
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`;
  it.each([
    ['wrong leaseId', "ready.leaseId = 'forged';"],
    ['wrong epoch', 'ready.epoch += 1;'],
    ['wrong gatewayIncarnation', "ready.gatewayIncarnation = 'forged';"],
    ['wrong message type', "ready.type = 'banner';"],
    ['wrong boot version', 'ready.version = 2;'],
    ['wrong tenantId', "ready.tenantId = 'forged';"],
    ['wrong workspaceId', "ready.workspaceId = 'forged';"],
    ['wrong workspaceCwd', "ready.workspaceCwd = '/forged';"],
    ['unparseable URL', "ready.url = 'not a url';"],
    ['non-http protocol', "ready.url = 'https://127.0.0.1:12345';"],
    ['non-loopback host', "ready.url = 'http://192.168.1.10:12345';"],
    ['portless URL', "ready.url = 'http://127.0.0.1';"],
    ['path prefix', "ready.url = 'http://127.0.0.1:12345/prefix';"],
    ['fragment', "ready.url = 'http://127.0.0.1:12345/#f';"],
    ['embedded credentials', "ready.url = 'http://user:pw@127.0.0.1:12345';"],
    ['password only', "ready.url = 'http://:pw@127.0.0.1:12345';"],
    ['username only', "ready.url = 'http://user@127.0.0.1:12345';"],
    ['query string', "ready.url = 'http://127.0.0.1:12345/?q=1';"],
  ])('rejects the endpoint on %s', async (_label, mutations) => {
    const { activator } = await setup(4, handshakeFixture(mutations));
    await expect(activator.activate(scope()).endpoint).rejects.toThrow(
      /invalid (handshake|URL|endpoint)/,
    );
  });

  // Non-string URL pins the `typeof ready.url` clause specifically: without
  // it the failure would surface one error later as an unparseable URL.
  it('rejects a non-string endpoint URL as an invalid handshake', async () => {
    const { activator } = await setup(
      4,
      handshakeFixture('ready.url = 12345;'),
    );
    await expect(activator.activate(scope()).endpoint).rejects.toThrow(
      /invalid handshake/,
    );
  });

  it('rejects when no ready message arrives before the startup deadline', async () => {
    const { activator } = await setup(
      4,
      `process.on('message', b => { if (b.type === 'shutdown') process.exit(0); });
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`,
      500,
    );
    await expect(activator.activate(scope()).endpoint).rejects.toThrow(
      /startup timed out/,
    );
  });
});
