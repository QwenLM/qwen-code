/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type { SettingScope } from '../config/settings.js';
import {
  configureRetention,
  makeRetainedSession,
  makeRetentionRepo,
} from '../test-utils/worktree-session-retention-fixtures.js';
import type { WorkspaceRuntime } from './workspace-registry.js';
import type { ServeOptions } from './types.js';
import type { WorkspaceSkillsStatusProviderOptions } from './workspace-skills-status.js';
import {
  getServeAppLifecycle,
  ServeAppLifecycleController,
} from './serve-app-lifecycle.js';

const retentionHarness = vi.hoisted(() => ({
  controllers: [] as Array<{ stop: () => Promise<void> }>,
  restoreStops: [] as Array<() => Promise<void>>,
  stopFailure: undefined as Error | undefined,
}));

vi.mock('./server/worktree-retention.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./server/worktree-retention.js')>();
  return {
    ...actual,
    startWorktreeRetention: vi.fn(
      (...args: Parameters<typeof actual.startWorktreeRetention>) => {
        const controller = actual.startWorktreeRetention(...args);
        retentionHarness.restoreStops.push(controller.stop.bind(controller));
        if (retentionHarness.stopFailure) {
          vi.spyOn(controller, 'stop').mockRejectedValue(
            retentionHarness.stopFailure,
          );
        }
        retentionHarness.controllers.push(controller);
        return controller;
      },
    ),
  };
});

const mockCreateDaemonWorkspaceService = vi.hoisted(() =>
  vi.fn((_deps: unknown) => ({})),
);

vi.mock('./workspace-service/index.js', () => ({
  createDaemonWorkspaceService: mockCreateDaemonWorkspaceService,
}));

const mockCreateSkillsProvider = vi.hoisted(() =>
  vi.fn((_options: WorkspaceSkillsStatusProviderOptions) =>
    Object.assign(vi.fn(), { dispose: vi.fn(async () => {}) }),
  ),
);
vi.mock('./workspace-skills-status.js', () => ({
  createWorkspaceSkillsStatusProvider: mockCreateSkillsProvider,
}));

const stopPackagePreparation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./hosted-package-preparation.js', () => ({
  registerHostedPackagePreparation: () => stopPackagePreparation,
}));
vi.mock('./hosted-harness-session.js', () => ({
  registerHostedHarnessSessionRoutes: () => ({ accepting: () => true }),
}));

const { createServeApp } = await import('./server.js');

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

function makeBridge() {
  return {
    isChannelLive: vi.fn(() => false),
    queryWorkspaceStatus: vi.fn(),
    invokeWorkspaceCommand: vi.fn(),
    refreshExtensionsForAllSessions: vi.fn(async () => ({
      refreshed: 0,
      failed: 0,
    })),
    publishWorkspaceEvent: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

describe('createServeApp workspace service wiring', () => {
  it.each([false, true])(
    'drains Hosted preparation with an externally supplied lifecycle: %s',
    async (supplied) => {
      stopPackagePreparation.mockClear();
      const lifecycle = new ServeAppLifecycleController();
      const drain = vi.fn(async () => {});
      if (supplied) lifecycle.setAppDrain(drain);
      const app = createServeApp(
        {
          ...baseOpts,
          profile: 'hosted-harness',
          token: 'hosted-secret',
          serveWebShell: false,
          hostedHarnessCapabilityDigest: `sha256:${'a'.repeat(64)}`,
        },
        undefined,
        {
          boundWorkspace: '/workspace',
          bridge: makeBridge(),
          ...(supplied ? { serveAppLifecycle: lifecycle } : {}),
        } as never,
      );
      await getServeAppLifecycle(app).close();
      expect(stopPackagePreparation).toHaveBeenCalledOnce();
      if (supplied) expect(drain).toHaveBeenCalledOnce();
    },
  );

  it.each(['before', 'after'] as const)(
    'preserves an injected lifecycle drain registered %s app creation',
    async (order) => {
      mockCreateSkillsProvider.mockClear();
      const lifecycle = new ServeAppLifecycleController();
      const drain = vi.fn(async () => {});
      if (order === 'before') lifecycle.setAppDrain(drain);
      const app = createServeApp(baseOpts, undefined, {
        boundWorkspace: '/workspace',
        bridge: makeBridge(),
        serveAppLifecycle: lifecycle,
      } as never);
      if (order === 'after') lifecycle.setAppDrain(drain);
      await getServeAppLifecycle(app).close();
      expect(drain).toHaveBeenCalledOnce();
      for (const [
        index,
        [options],
      ] of mockCreateSkillsProvider.mock.calls.entries()) {
        if (options.autoDiscover)
          expect(
            mockCreateSkillsProvider.mock.results[index]!.value.dispose,
          ).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    'disposes both automatic catalogs with an externally supplied lifecycle: %s',
    async (supplied) => {
      mockCreateSkillsProvider.mockClear();
      const app = createServeApp(baseOpts, undefined, {
        boundWorkspace: '/workspace',
        bridge: makeBridge(),
        ...(supplied
          ? { serveAppLifecycle: new ServeAppLifecycleController() }
          : {}),
      } as never);
      const automatic = mockCreateSkillsProvider.mock.calls.flatMap(
        ([options], index) =>
          options.autoDiscover
            ? [mockCreateSkillsProvider.mock.results[index]!.value]
            : [],
      );
      expect(automatic).toHaveLength(2);
      await getServeAppLifecycle(app).close();
      for (const provider of automatic)
        expect(provider.dispose).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'waits for real retention filesystem work with a supplied lifecycle',
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-server-retention-drain-'),
      );
      const removalEntered = path.join(root, 'removal-entered');
      const removalRelease = path.join(root, 'removal-release');
      const releaseRemoval = () => fs.writeFileSync(removalRelease, 'release');
      let app: ReturnType<typeof createServeApp> | undefined;
      let closing: Promise<void> | undefined;
      let savedEnv: Array<readonly [string, string | undefined]> = [];
      try {
        const target = makeRetentionRepo(root, 'primary');
        configureRetention(target, 1);
        const oldest = await makeRetainedSession(target, {
          slug: 'lifecycle-oldest',
          dirty: true,
          activity: '2026-01-01T00:00:00.000Z',
        });
        await makeRetainedSession(target, {
          slug: 'lifecycle-newer',
          activity: '2026-01-02T00:00:00.000Z',
        });
        const realGit = execFileSync('sh', ['-c', 'command -v git'], {
          env: target.runtime.env.effectiveEnv,
          encoding: 'utf8',
        }).trim();
        fs.writeFileSync(
          path.join(root, 'git'),
          `#!/bin/sh
case " $* " in
  *" worktree remove "*)
    : > ${JSON.stringify(removalEntered)}
    while [ ! -f ${JSON.stringify(removalRelease)} ]; do
      sleep 0.01
    done
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`,
          { mode: 0o755 },
        );
        // simple-git inherits process.env; keep this shim scoped to our fixture.
        savedEnv = (
          ['PATH', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const
        ).map((key) => [key, process.env[key]] as const);
        Object.assign(process.env, {
          PATH: `${root}${path.delimiter}${process.env['PATH'] ?? ''}`,
          HOME: target.home,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        });
        const bridge = {
          ...makeBridge(),
          getSessionSummary: target.runtime.bridge.getSessionSummary,
        };
        const lifecycle = new ServeAppLifecycleController();
        const externalDrain = vi.fn(async () => {});
        lifecycle.setAppDrain(externalDrain);
        app = Storage.runWithResolvedRuntimeBaseDir(
          target.runtime.sessionRuntimeBaseDir,
          () =>
            createServeApp({ ...baseOpts, serveWebShell: false }, undefined, {
              boundWorkspace: target.repo,
              bridge,
              primaryWorkspaceTrusted: true,
              primaryRuntimeEnv: target.runtime.env,
              manageScheduledTaskSessions: true,
              serveAppLifecycle: lifecycle,
            } as never),
        );
        expect(retentionHarness.controllers).toHaveLength(1);
        const controller = retentionHarness.controllers[0]!;
        const stop = vi.spyOn(controller, 'stop');
        await vi.waitFor(
          () => expect(fs.existsSync(removalEntered)).toBe(true),
          { timeout: 3_000 },
        );

        let settled = false;
        closing = lifecycle.close();
        void closing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        const late = makeRetentionRepo(root, 'late');
        (
          app.locals['startScheduledTaskKeepaliveForWorkspace'] as (
            runtime: WorkspaceRuntime,
          ) => void
        )(late.runtime);
        expect(retentionHarness.controllers).toHaveLength(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        releaseRemoval();
        await closing;
        expect(settled).toBe(true);
        expect(fs.existsSync(oldest.worktreePath)).toBe(false);
        expect(externalDrain).toHaveBeenCalledOnce();
        const binding = await readWorktreeSessionStrict(oldest.sidecarPath);
        expect(binding.state).toBe('valid');
        if (binding.state === 'valid') {
          expect(binding.session.worktreeRemoved?.archiveKey).toBeDefined();
        }
      } finally {
        releaseRemoval();
        if (app) {
          const stop = (
            app.locals as { stopScheduledTaskKeepalive?: () => void }
          ).stopScheduledTaskKeepalive;
          try {
            stop?.();
          } catch {
            // The original failure is the test's observable outcome.
          }
          await getServeAppLifecycle(app)
            .close()
            .catch(() => undefined);
        }
        await Promise.allSettled(
          retentionHarness.controllers.map((controller) => controller.stop()),
        );
        await closing?.catch(() => undefined);
        retentionHarness.controllers.length = 0;
        retentionHarness.restoreStops.length = 0;
        retentionHarness.stopFailure = undefined;
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('reports a rejected retention stop through a supplied lifecycle', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-server-retention-failure-'),
    );
    const stopFailure = new Error('retention stop failed');
    retentionHarness.stopFailure = stopFailure;
    let app: ReturnType<typeof createServeApp> | undefined;
    try {
      const target = makeRetentionRepo(root, 'primary');
      const bridge = {
        ...makeBridge(),
        getSessionSummary: target.runtime.bridge.getSessionSummary,
      };
      const lifecycle = new ServeAppLifecycleController();
      lifecycle.setAppDrain(vi.fn(async () => {}));
      app = Storage.runWithResolvedRuntimeBaseDir(
        target.runtime.sessionRuntimeBaseDir,
        () =>
          createServeApp(baseOpts, undefined, {
            boundWorkspace: target.repo,
            bridge,
            primaryWorkspaceTrusted: true,
            primaryRuntimeEnv: target.runtime.env,
            manageScheduledTaskSessions: true,
            serveAppLifecycle: lifecycle,
          } as never),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await lifecycle.close().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(result).toBeInstanceOf(AggregateError);
        if (result instanceof AggregateError) {
          expect(result.errors).toContain(stopFailure);
        }
      }
    } finally {
      if (app) {
        const stop = (app.locals as { stopScheduledTaskKeepalive?: () => void })
          .stopScheduledTaskKeepalive;
        try {
          stop?.();
        } catch {
          // The rejection was already consumed by the assertion above.
        }
        await Promise.allSettled(
          retentionHarness.controllers.map((controller) => controller.stop()),
        );
        await getServeAppLifecycle(app)
          .close()
          .catch(() => undefined);
      }
      await Promise.allSettled(
        retentionHarness.restoreStops.map((stop) => stop()),
      );
      retentionHarness.controllers.length = 0;
      retentionHarness.restoreStops.length = 0;
      retentionHarness.stopFailure = undefined;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards batch settings persistence to the workspace service', () => {
    mockCreateDaemonWorkspaceService.mockClear();
    const persistSetting = vi.fn(
      async (
        _workspace: string,
        _scope: SettingScope,
        _key: string,
        _value: unknown,
      ) => {},
    );
    const persistSettings = vi.fn(
      async (
        _workspace: string,
        _writes: Array<{ scope: SettingScope; key: string; value: unknown }>,
      ) => {},
    );

    createServeApp(baseOpts, undefined, {
      boundWorkspace: '/workspace',
      bridge: makeBridge(),
      persistSetting,
      persistSettings,
    } as never);

    expect(mockCreateDaemonWorkspaceService).toHaveBeenCalledTimes(1);
    expect(mockCreateDaemonWorkspaceService.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        persistSetting,
        persistSettings,
      }),
    );
  });
});
