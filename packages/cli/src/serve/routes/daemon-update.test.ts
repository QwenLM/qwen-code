/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth, createMutationGate } from '../auth.js';
import { CredentialStore } from '../local-control/credentials.js';
import { tagListener } from '../local-control/listener-identity.js';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  installation: vi.fn(),
  settings: vi.fn(),
  standalone: vi.fn(),
  npm: vi.fn(),
  activate: vi.fn(),
  cleanup: vi.fn(),
  activateNpm: vi.fn(),
  cleanupNpm: vi.fn(),
  restart: vi.fn(),
}));
vi.mock('../../ui/utils/updateCheck.js', () => ({
  checkForUpdatesDetailed: mocks.check,
  describeUpdateCheckFailure: () => 'registry unreachable',
}));
vi.mock('../../config/settings.js', () => ({ loadSettings: mocks.settings }));
vi.mock('../../utils/installationInfo.js', () => ({
  getInstallationInfo: mocks.installation,
  PackageManager: { NPM: 'npm', PNPM: 'pnpm', YARN: 'yarn', BUN: 'bun' },
  formatUpdateInstructions: () => ['npm install -g @qwen-code/qwen-code@2.0.0'],
}));
vi.mock('../../ui/standalone-update.js', () => ({
  prepareStandaloneUpdate: mocks.standalone,
}));
vi.mock('../../utils/managed-npm-update.js', () => ({
  stageManagedNpmUpdate: mocks.npm,
  activateManagedNpmUpdate: mocks.activateNpm,
  cleanupManagedNpmUpdate: mocks.cleanupNpm,
}));

const available = {
  status: 'update',
  info: {
    message: 'Update available',
    update: {
      current: '1.0.0',
      latest: '2.0.0',
      name: 'qwen',
      type: 'major',
    },
  },
};
const release = (latest: string) => ({
  ...available,
  info: {
    ...available.info,
    update: { ...available.info.update, latest },
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
async function makeApp(
  options: {
    trusted?: boolean;
    token?: string;
    restart?: boolean;
    secondary?: boolean;
    events?: string[];
  } = {},
) {
  const { registerDaemonUpdateRoutes } = await import('./daemon-update.js');
  const app = express();
  const credentials = new CredentialStore(options.token);
  credentials.addPairingToken('device', 'pairing');
  credentials.addWebShellToken('paired-device', 'web-shell-device');
  app.use((req, res, next) => {
    if (options.secondary)
      tagListener(
        (req.socket as typeof req.socket & { server: Server }).server,
        { kind: 'local-control' },
      );
    if (req.path.endsWith('/restart'))
      res.once('finish', () => options.events?.push('finish'));
    next();
  });
  app.use(bearerAuth(credentials));
  app.use(express.json());
  registerDaemonUpdateRoutes(app, {
    currentVersion: '1.0.0',
    runtimeToken: options.token,
    restartForUpdate: options.restart === false ? undefined : mocks.restart,
    mutate: createMutationGate({
      tokenConfigured: Boolean(options.token),
      requireAuth: false,
      trustedLoopbackMode: options.trusted ?? true,
    }),
  });
  return app;
}
async function ready(app: express.Application) {
  await request(app).post('/daemon/update/prepare').send({}).expect(202);
  await vi.waitFor(async () =>
    expect((await request(app).get('/daemon/update')).body.state).toBe('ready'),
  );
}

describe('daemon update routes', () => {
  let fixture: string | undefined;
  let workdir: string | undefined;
  let standaloneDir = '';
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('QWEN_CODE_CLI', '');
    vi.stubEnv('QWEN_CODE_MANAGED_NPM_PIN', '');
    mocks.check.mockResolvedValue(available);
    mocks.settings.mockReturnValue({
      merged: { general: { enableAutoUpdate: true } },
    });
    workdir = await mkdtemp(join(tmpdir(), 'qwen-daemon-update-'));
    standaloneDir = join(workdir, 'share', 'qwen-code');
    await mkdir(join(standaloneDir, 'bin'), { recursive: true });
    await writeFile(join(standaloneDir, 'bin', 'qwen'), '#!/usr/bin/env sh\n', {
      mode: 0o755,
    });
    mocks.installation.mockReturnValue({
      isGlobal: true,
      isStandalone: true,
      standaloneDir,
    });
    mocks.standalone.mockImplementation(async () => ({
      activate: mocks.activate,
      cleanup: mocks.cleanup,
    }));
    mocks.activate.mockResolvedValue('done');
    mocks.restart.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await rm(fixture, { recursive: true, force: true });
    if (workdir) await rm(workdir, { recursive: true, force: true });
    fixture = undefined;
    workdir = undefined;
  });

  it('checks without downloading, caches for 15 minutes, and refreshes explicitly', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const app = await makeApp();
    const first = await request(app).get('/daemon/update').expect(200);
    expect(first.body).toEqual({
      state: 'available',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      canInstall: true,
    });
    expect(first.headers['cache-control']).toBe('no-store');
    await request(app).get('/daemon/update').expect(200);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await request(app).get('/daemon/update?refresh=true').expect(200);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_900_001);
    await request(app).get('/daemon/update').expect(200);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(mocks.standalone).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('shares concurrent checks', async () => {
    const pending = deferred<typeof available>();
    mocks.check.mockReturnValue(pending.promise);
    const app = await makeApp();
    const requests = [
      request(app).get('/daemon/update'),
      request(app).get('/daemon/update?refresh=true'),
    ].map((operation) => operation.then((response) => response));
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    pending.resolve(available);
    expect(
      (await Promise.all(requests)).map((response) => response.body.state),
    ).toEqual(['available', 'available']);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { status: 'up-to-date', currentVersion: '1.0.0' },
      'up-to-date',
      undefined,
    ],
    [
      { status: 'skipped', reason: 'development mode' },
      'unavailable',
      'development mode',
    ],
    [
      { status: 'error', error: new Error('offline') },
      'error',
      'registry unreachable',
    ],
  ])('reports check outcome %j', async (result, state, message) => {
    mocks.check.mockResolvedValue(result);
    const response = await request(await makeApp())
      .get('/daemon/update')
      .expect(200);
    expect(response.body).toEqual({
      state,
      currentVersion: '1.0.0',
      canInstall: false,
      ...(message ? { message } : {}),
    });
    expect(mocks.installation).not.toHaveBeenCalled();
  });

  it.each(['embedding', 'disabled'])(
    'does not check or prepare when %s',
    async (reason) => {
      if (reason === 'disabled')
        mocks.settings.mockReturnValue({
          merged: { general: { enableAutoUpdate: false } },
        });
      const app = await makeApp({ restart: reason !== 'embedding' });
      expect((await request(app).get('/daemon/update')).body).toEqual({
        state: 'unavailable',
        currentVersion: '1.0.0',
        canInstall: false,
      });
      await request(app).post('/daemon/update/prepare').send({}).expect(409);
      expect(mocks.check).not.toHaveBeenCalled();
      expect(mocks.standalone).not.toHaveBeenCalled();
    },
  );

  it('keeps checking in notify mode because the daemon never installs (#14274)', async () => {
    mocks.settings.mockReturnValue({
      merged: { general: { updateMode: 'notify' } },
    });
    const app = await makeApp();
    const response = await request(app).get('/daemon/update').expect(200);
    expect(response.body.state).toBe('available');
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it('does not check in explicit off mode (#14274)', async () => {
    mocks.settings.mockReturnValue({
      merged: { general: { updateMode: 'off' } },
    });
    const app = await makeApp();
    expect((await request(app).get('/daemon/update')).body).toEqual({
      state: 'unavailable',
      currentVersion: '1.0.0',
      canInstall: false,
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('stages one download without activation and retains readiness across app replacement', async () => {
    const pending = deferred<{
      activate: typeof mocks.activate;
      cleanup: typeof mocks.cleanup;
    }>();
    mocks.standalone.mockReturnValue(pending.promise);
    const app = await makeApp();
    const responses = await Promise.all([
      request(app).post('/daemon/update/prepare').send({}).expect(202),
      request(app).post('/daemon/update/prepare').send({}).expect(202),
    ]);
    expect(responses.map((response) => response.body.state)).toEqual([
      'installing',
      'installing',
    ]);
    await vi.waitFor(() => expect(mocks.standalone).toHaveBeenCalledTimes(1));
    expect(mocks.standalone).toHaveBeenCalledWith(standaloneDir, '2.0.0');
    pending.resolve({ activate: mocks.activate, cleanup: mocks.cleanup });
    const replacement = await makeApp();
    await vi.waitFor(async () =>
      expect(
        (await request(replacement).get('/daemon/update?refresh=true')).body
          .state,
      ).toBe('ready'),
    );
    await request(replacement)
      .post('/daemon/update/prepare')
      .send({})
      .expect(200);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it('responds before activating, coalesces restart clicks, and restarts only after activation', async () => {
    const events: string[] = [];
    const activation = deferred<void>();
    mocks.activate.mockImplementation(async () => {
      events.push('activate');
      await activation.promise;
    });
    mocks.cleanup.mockImplementation(() => {
      events.push('cleanup');
    });
    mocks.restart.mockImplementation(async () => {
      events.push('restart');
    });
    const app = await makeApp({ events });
    await ready(app);
    const first = await request(app)
      .post('/daemon/update/restart')
      .send({})
      .expect(202);
    expect(first.body.state).toBe('restarting');
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(events.slice(0, 2)).toEqual(['finish', 'activate']);
    activation.resolve();
    await vi.waitFor(() =>
      expect(mocks.restart).toHaveBeenCalledWith(
        join(standaloneDir, 'bin', 'qwen'),
      ),
    );
    expect(events.slice(-2)).toEqual(['cleanup', 'restart']);
    await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('activates the current latest, not the release pinned when it prepared', async () => {
    const activated: string[] = [];
    const cleaned: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          activated.push(version);
        },
        cleanup: async () => {
          cleaned.push(version);
        },
      }),
    );
    const app = await makeApp();
    await ready(app);
    expect(mocks.standalone).toHaveBeenCalledWith(standaloneDir, '2.0.0');
    // Another release ships while the daemon sits in `ready`.
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(mocks.standalone).toHaveBeenCalledWith(standaloneDir, '3.0.0');
    expect(activated).toEqual(['3.0.0']);
    expect(cleaned).toEqual(['2.0.0', '3.0.0']);
    expect((await request(app).get('/daemon/update')).body).toMatchObject({
      state: 'restarting',
      latestVersion: '3.0.0',
    });
  });

  it('re-resolves a newer release for managed npm installs too', async () => {
    const launcher = await stubManagedLauncher();
    mocks.installation.mockReturnValue({
      isGlobal: true,
      packageManager: 'npm',
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
    mocks.npm.mockImplementation(async (version: string) => ({
      stagingDir: `/staged-${version}`,
    }));
    const app = await makeApp();
    await ready(app);
    expect(mocks.npm).toHaveBeenCalledWith('2.0.0', launcher);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() =>
      expect(mocks.activateNpm).toHaveBeenCalledWith(
        { stagingDir: '/staged-3.0.0' },
        '3.0.0',
        launcher,
      ),
    );
    expect(mocks.cleanupNpm).toHaveBeenCalledWith({
      stagingDir: '/staged-2.0.0',
    });
  });

  it('keeps the prepared release pinned while polling, and only re-resolves on click', async () => {
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).get('/daemon/update').expect(200);
    await request(app).get('/daemon/update?refresh=true').expect(200);
    expect(mocks.standalone).toHaveBeenCalledTimes(1);
    expect((await request(app).get('/daemon/update')).body).toMatchObject({
      state: 'ready',
      latestVersion: '2.0.0',
    });
  });

  it('applies the prepared release and logs when the registry is unreachable', async () => {
    const activated: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          activated.push(version);
        },
        cleanup: async () => {},
      }),
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const app = await makeApp();
    await ready(app);
    // The real check resolves an error result for a registry outage; it does
    // not throw. Pinning the thrown shape would test the mock, not the product.
    mocks.check.mockResolvedValue({
      status: 'error',
      error: new Error('offline'),
      currentVersion: '1.0.0',
    });
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(activated).toEqual(['2.0.0']);
    expect(mocks.standalone).toHaveBeenCalledTimes(1);
    const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain('update re-resolve failed');
    expect(logged).toContain('registry unreachable');
    stderr.mockRestore();
  });

  it('names staging, not the registry, when the restage itself throws', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    mocks.standalone.mockRejectedValueOnce(new Error('Download failed'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain('update restage failed');
    expect(logged).toContain('Download failed');
    expect(logged).not.toContain('re-resolve failed');
    stderr.mockRestore();
  });

  it('applies the prepared release when the registry reports nothing newer', async () => {
    const activated: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          activated.push(version);
        },
        cleanup: async () => {},
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '1.0.0',
    });
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(activated).toEqual(['2.0.0']);
    expect(mocks.standalone).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2.0.0-nightly.1', 'a prerelease below the prepared release'],
    ['1.9.0', 'a registry rollback'],
    ['2.0.0+build.9', 'build metadata that does not change precedence'],
    ['not-a-version', 'a malformed registry value'],
  ])('never restages to %s (%s)', async (latest) => {
    const activated: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          activated.push(version);
        },
        cleanup: async () => {},
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release(latest));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(activated).toEqual(['2.0.0']);
    expect(mocks.standalone).toHaveBeenCalledTimes(1);
  });

  it('applies the prepared release when staging the newer one fails', async () => {
    const events: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => {
        if (version === '3.0.0') throw new Error('Download failed');
        return {
          activate: async () => {
            events.push(`activate:${version}`);
          },
          cleanup: async () => {
            events.push(`cleanup:${version}`);
          },
        };
      },
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    // The prepared payload must survive the failed restage and be activated
    // before anything cleans it.
    expect(events).toEqual(['activate:2.0.0', 'cleanup:2.0.0']);
  });

  it('applies the prepared release when the newer one has no one-click path', async () => {
    const activated: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          activated.push(version);
        },
        cleanup: async () => {},
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    mocks.installation.mockReturnValue({
      isGlobal: false,
      isStandalone: false,
    });
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(activated).toEqual(['2.0.0']);
    expect(mocks.standalone).toHaveBeenCalledTimes(1);
  });

  it('cleans the restaged payload when activation of the newer release fails', async () => {
    const cleaned: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          if (version === '3.0.0') throw new Error('Activation failed');
        },
        cleanup: async () => {
          cleaned.push(version);
        },
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(async () =>
      expect((await request(app).get('/daemon/update')).body).toMatchObject({
        state: 'error',
        message: 'Activation failed',
      }),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(cleaned).toEqual(['2.0.0', '3.0.0']);
  });

  it('still activates the newer release when discarding the old payload fails', async () => {
    const events: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          events.push(`activate:${version}`);
        },
        cleanup: async () => {
          events.push(`cleanup:${version}`);
          if (version === '2.0.0') throw new Error('rm failed');
        },
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    // Committing to the newer payload must not depend on discarding the old
    // one: a failed discard leaks disk, but must not orphan the new payload
    // and fall back to a possibly half-removed old one.
    expect(events).toContain('activate:3.0.0');
    expect(events).not.toContain('activate:2.0.0');
  });

  it('keeps a restart in flight when the operator disables automatic updates', async () => {
    const activation = deferred<void>();
    const events: string[] = [];
    mocks.standalone.mockImplementation(
      async (_dir: string, version: string) => ({
        activate: async () => {
          events.push(`activate:${version}`);
          await activation.promise;
        },
        cleanup: async () => {
          events.push(`cleanup:${version}`);
        },
      }),
    );
    const app = await makeApp();
    await ready(app);
    mocks.check.mockResolvedValue(release('3.0.0'));
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(events).toContain('activate:3.0.0'));
    expect(events).toEqual(['cleanup:2.0.0', 'activate:3.0.0']);
    // Restaging widened the window between the authority check and process
    // replacement to minutes. The operator turning updates off mid-flight,
    // other clients polling and retrying, and an ordinary shutdown must none
    // of them disturb the restart that was already authorized.
    mocks.settings.mockReturnValue({
      merged: { general: { enableAutoUpdate: false } },
    });
    expect((await request(app).get('/daemon/update')).body.state).toBe(
      'restarting',
    );
    expect(
      (await request(app).get('/daemon/update?refresh=true')).body.state,
    ).toBe('restarting');
    await request(app).post('/daemon/update/prepare').send({}).expect(202);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
    expect(events).toEqual(['cleanup:2.0.0', 'activate:3.0.0']);
    activation.resolve();
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(events).toEqual([
      'cleanup:2.0.0',
      'activate:3.0.0',
      'cleanup:3.0.0',
    ]);
  });

  it('restarts a launcher-less standalone install through its PATH wrapper', async () => {
    await rm(join(standaloneDir, 'bin'), { recursive: true, force: true });
    await mkdir(join(standaloneDir, 'lib'), { recursive: true });
    await writeFile(join(standaloneDir, 'lib', 'cli-entry.js'), '');
    await mkdir(join(standaloneDir, 'node', 'bin'), { recursive: true });
    await writeFile(join(standaloneDir, 'node', 'bin', 'node'), '', {
      mode: 0o755,
    });
    const wrapper = join(dirname(standaloneDir), '..', 'bin', 'qwen');
    await mkdir(dirname(wrapper), { recursive: true });
    await writeFile(
      wrapper,
      `#!/usr/bin/env sh\nexec '${join(standaloneDir, 'node', 'bin', 'node')}' '${join(standaloneDir, 'lib', 'cli-entry.js')}' "$@"\n`,
      { mode: 0o755 },
    );
    const app = await makeApp();
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledWith(wrapper));
    expect(existsSync(wrapper)).toBe(true);
  });

  it('ignores a PATH wrapper that targets another install', async () => {
    const wrapper = join(dirname(standaloneDir), '..', 'bin', 'qwen');
    await mkdir(dirname(wrapper), { recursive: true });
    await writeFile(
      wrapper,
      '#!/usr/bin/env sh\nexec /elsewhere/bin/qwen "$@"\n',
      { mode: 0o755 },
    );
    const app = await makeApp();
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() =>
      expect(mocks.restart).toHaveBeenCalledWith(
        join(standaloneDir, 'bin', 'qwen'),
      ),
    );
  });

  it('keeps a standalone install without a restartable launcher manual', async () => {
    await rm(join(standaloneDir, 'bin'), { recursive: true, force: true });
    const app = await makeApp();
    const response = await request(app).get('/daemon/update').expect(200);
    expect(response.body).toMatchObject({
      state: 'available',
      canInstall: false,
      instructions: ['npm install -g @qwen-code/qwen-code@2.0.0'],
    });
    await request(app).post('/daemon/update/prepare').send({}).expect(409);
    expect(mocks.standalone).not.toHaveBeenCalled();
  });

  it('keeps the daemon usable after activation failure and restages for retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mocks.activate.mockRejectedValueOnce(new Error('Activation failed'));
    const app = await makeApp();
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(async () =>
      expect((await request(app).get('/daemon/update')).body).toMatchObject({
        state: 'error',
        message: 'Activation failed',
      }),
    );
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_060_001);
    await request(app).get('/daemon/update');
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(mocks.standalone).toHaveBeenCalledTimes(2);
  });

  it('keeps download errors visible and permits a new check', async () => {
    mocks.standalone.mockRejectedValueOnce(new Error('Download failed'));
    const app = await makeApp();
    await request(app).post('/daemon/update/prepare').send({}).expect(202);
    await vi.waitFor(async () =>
      expect((await request(app).get('/daemon/update')).body).toMatchObject({
        state: 'error',
        message: 'Download failed',
      }),
    );
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await request(app).get('/daemon/update?refresh=true');
    await ready(app);
  });

  it('keeps update recovery available when restart cleanup runs before a failed drain', async () => {
    const app = await makeApp();
    mocks.restart.mockImplementationOnce(async () => {
      await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
      throw new Error('Drain failed');
    });
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(async () =>
      expect((await request(app).get('/daemon/update')).body).toMatchObject({
        state: 'error',
        message: 'Drain failed',
      }),
    );
    await request(app).get('/daemon/update?refresh=true');
    await ready(app);
    await request(app).post('/daemon/update/restart').send({}).expect(202);
    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(2));
  });

  it('discards readiness if the operator disables automatic updates', async () => {
    const app = await makeApp();
    await ready(app);
    mocks.settings.mockReturnValue({
      merged: { general: { enableAutoUpdate: false } },
    });
    expect((await request(app).get('/daemon/update')).body.state).toBe(
      'unavailable',
    );
    await request(app).post('/daemon/update/restart').send({}).expect(409);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each(['check', 'restart'] as const)(
    'cleans a prepared download after a settings failure during %s before retrying',
    async (action) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const app = await makeApp();
      await ready(app);
      if (action === 'restart')
        mocks.settings.mockReturnValueOnce({
          merged: { general: { enableAutoUpdate: true } },
        });
      mocks.settings.mockImplementationOnce(() => {
        throw new Error('Invalid settings.json');
      });
      const response =
        action === 'check'
          ? await request(app).get('/daemon/update').expect(200)
          : await request(app)
              .post('/daemon/update/restart')
              .send({})
              .expect(409);
      expect(response.body).toMatchObject({
        state: 'error',
        message: 'Invalid settings.json',
      });
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
      expect(mocks.standalone).toHaveBeenCalledTimes(1);
      expect(mocks.activate).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      now.mockReturnValue(1_060_001);
      await ready(app);
      expect(mocks.standalone).toHaveBeenCalledTimes(2);
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
      expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.standalone.mock.invocationCallOrder[1]!,
      );
      await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
      expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    },
  );

  it('cleans a ready or late-finishing download on ordinary shutdown without activation', async () => {
    const app = await makeApp();
    await ready(app);
    await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect((await request(app).get('/daemon/update')).body.state).toBe(
      'unavailable',
    );
    vi.resetModules();
    const pending = deferred<{
      activate: typeof mocks.activate;
      cleanup: typeof mocks.cleanup;
    }>();
    mocks.standalone.mockReturnValue(pending.promise);
    const next = await makeApp();
    await request(next).post('/daemon/update/prepare').send({}).expect(202);
    await (next.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
    pending.resolve({ activate: mocks.activate, cleanup: mocks.cleanup });
    await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledTimes(2));
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('reads operator settings only and provides manual instructions for unsupported installs', async () => {
    mocks.installation.mockReturnValue({
      isGlobal: false,
      packageManager: 'npm',
    });
    const app = await makeApp();
    const response = await request(app)
      .get('/daemon/update?workspace=/other')
      .expect(200);
    expect(mocks.settings).toHaveBeenCalledWith(process.cwd(), {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
    });
    expect(mocks.installation).toHaveBeenCalledWith(process.cwd(), false);
    expect(response.body).toMatchObject({
      state: 'available',
      canInstall: false,
      instructions: ['npm install -g @qwen-code/qwen-code@2.0.0'],
    });
    await request(app).post('/daemon/update/prepare').send({}).expect(409);
    expect(mocks.npm).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'stages npm only for a valid managed launcher (%s)',
    async (valid) => {
      fixture = await mkdtemp(join(tmpdir(), 'qwen-daemon-update-'));
      const bootstrap = join(fixture, 'cli-entry.js');
      await writeFile(bootstrap, '');
      await writeFile(
        join(fixture, 'package.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', private: !valid }),
      );
      vi.stubEnv('QWEN_CODE_CLI', bootstrap);
      vi.stubEnv('QWEN_CODE_MANAGED_NPM_PIN', JSON.stringify({ bootstrap }));
      mocks.installation.mockReturnValue({
        isGlobal: true,
        packageManager: 'npm',
        updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
      });
      const descriptor = { stagingDir: '/staged' };
      mocks.npm.mockResolvedValue(descriptor);
      const app = await makeApp();
      expect((await request(app).get('/daemon/update')).body.canInstall).toBe(
        valid,
      );
      if (!valid) {
        await request(app).post('/daemon/update/prepare').send({}).expect(409);
        return;
      }
      await ready(app);
      expect(mocks.activateNpm).not.toHaveBeenCalled();
      await request(app).post('/daemon/update/restart').send({}).expect(202);
      const launcher = await realpath(bootstrap);
      await vi.waitFor(() =>
        expect(mocks.activateNpm).toHaveBeenCalledWith(
          descriptor,
          '2.0.0',
          launcher,
        ),
      );
    },
  );

  it('does not offer npm installation without a launcher stamp', async () => {
    mocks.installation.mockReturnValue({
      isGlobal: true,
      packageManager: 'npm',
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
    expect(
      (await request(await makeApp()).get('/daemon/update')).body.canInstall,
    ).toBe(false);
  });

  async function stubManagedLauncher() {
    fixture = await mkdtemp(join(tmpdir(), 'qwen-daemon-update-'));
    const bootstrap = join(fixture, 'cli-entry.js');
    await writeFile(bootstrap, '');
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: '@qwen-code/qwen-code' }),
    );
    vi.stubEnv('QWEN_CODE_CLI', bootstrap);
    vi.stubEnv('QWEN_CODE_MANAGED_NPM_PIN', JSON.stringify({ bootstrap }));
    return realpath(bootstrap);
  }

  it.each(['pnpm', 'yarn', 'bun'])(
    'offers one-click for global %s installations with a managed launcher',
    async (packageManager) => {
      const launcher = await stubManagedLauncher();
      mocks.installation.mockReturnValue({
        isGlobal: true,
        packageManager,
        updateCommand: `${packageManager} global update`,
      });
      mocks.npm.mockResolvedValue({ stagingDir: '/staged' });
      const app = await makeApp();
      expect((await request(app).get('/daemon/update')).body.canInstall).toBe(
        true,
      );
      await ready(app);
      expect(mocks.npm).toHaveBeenCalledWith('2.0.0', launcher);
      expect(mocks.activateNpm).not.toHaveBeenCalled();
    },
  );

  it('offers one-click for a root-owned npm prefix without an update command', async () => {
    await stubManagedLauncher();
    mocks.installation.mockReturnValue({
      isGlobal: true,
      packageManager: 'npm',
      updateMessage:
        'Update requires sudo. Please run: sudo npm install -g @qwen-code/qwen-code@latest',
    });
    mocks.npm.mockResolvedValue({ stagingDir: '/staged' });
    expect(
      (await request(await makeApp()).get('/daemon/update')).body.canInstall,
    ).toBe(true);
  });

  it('keeps Homebrew installations manual even with a managed launcher', async () => {
    await stubManagedLauncher();
    mocks.installation.mockReturnValue({
      isGlobal: true,
      packageManager: 'homebrew',
      updateMessage:
        'Installed via Homebrew. Please update with "brew upgrade".',
    });
    const response = await request(await makeApp())
      .get('/daemon/update')
      .expect(200);
    expect(response.body).toMatchObject({
      state: 'available',
      canInstall: false,
      instructions: ['npm install -g @qwen-code/qwen-code@2.0.0'],
    });
    await request(await makeApp())
      .post('/daemon/update/prepare')
      .send({})
      .expect(409);
    expect(mocks.npm).not.toHaveBeenCalled();
  });

  it('keeps non-global installations manual even with a managed launcher', async () => {
    await stubManagedLauncher();
    mocks.installation.mockReturnValue({
      isGlobal: false,
      packageManager: 'pnpm',
      updateCommand: 'pnpm add -g @qwen-code/qwen-code@latest',
    });
    const response = await request(await makeApp())
      .get('/daemon/update')
      .expect(200);
    expect(response.body).toMatchObject({
      state: 'available',
      canInstall: false,
      instructions: ['npm install -g @qwen-code/qwen-code@2.0.0'],
    });
    await request(await makeApp())
      .post('/daemon/update/prepare')
      .send({})
      .expect(409);
    expect(mocks.npm).not.toHaveBeenCalled();
  });

  it('requires operator authentication for mutations', async () => {
    const untrusted = await makeApp({ trusted: false });
    for (const action of ['prepare', 'restart'])
      await request(untrusted)
        .post(`/daemon/update/${action}`)
        .send({})
        .expect(401);
    const protectedApp = await makeApp({ token: 'secret' });
    await request(protectedApp).get('/daemon/update').expect(401);
    expect(mocks.check).not.toHaveBeenCalled();
    await request(protectedApp)
      .post('/daemon/update/prepare')
      .set('Authorization', 'Bearer secret')
      .send({})
      .expect(202);
  });

  it('does not expose updates to paired secondary listeners', async () => {
    const app = await makeApp({ secondary: true });
    expect(
      (
        await request(app)
          .get('/daemon/update')
          .set('Authorization', 'Bearer pairing')
      ).body.state,
    ).toBe('unavailable');
    for (const action of ['prepare', 'restart'])
      await request(app)
        .post(`/daemon/update/${action}`)
        .set('Authorization', 'Bearer pairing')
        .send({})
        .expect(403);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('does not expose updates to primary paired browsers whose credentials expire on restart', async () => {
    const app = await makeApp({ token: 'runtime-token' });
    expect(
      (
        await request(app)
          .get('/daemon/update')
          .set('Authorization', 'Bearer web-shell-device')
      ).body.state,
    ).toBe('unavailable');
    for (const action of ['prepare', 'restart'])
      await request(app)
        .post(`/daemon/update/${action}`)
        .set('Authorization', 'Bearer web-shell-device')
        .send({})
        .expect(403);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .get('/daemon/update')
          .set('Authorization', 'bEaReR  \truntime-token')
      ).body.state,
    ).toBe('available');
  });

  it('rejects arbitrary parameters and restart before a ready download', async () => {
    const app = await makeApp();
    for (const action of ['prepare', 'restart'])
      await request(app)
        .post(`/daemon/update/${action}`)
        .send({ version: '3.0.0', command: 'echo surprise' })
        .expect(400);
    await request(app).get('/daemon/update?refresh=other').expect(400);
    expect(mocks.check).not.toHaveBeenCalled();
    await request(app).post('/daemon/update/restart').send({}).expect(409);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
