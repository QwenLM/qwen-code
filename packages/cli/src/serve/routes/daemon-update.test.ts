/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  PackageManager: { NPM: 'npm' },
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
  credentials.addWebShellToken('web-shell-device');
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
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('QWEN_CODE_CLI', '');
    vi.stubEnv('QWEN_CODE_MANAGED_NPM_PIN', '');
    mocks.check.mockResolvedValue(available);
    mocks.settings.mockReturnValue({
      merged: { general: { enableAutoUpdate: true } },
    });
    mocks.installation.mockReturnValue({
      isGlobal: true,
      isStandalone: true,
      standaloneDir: '/opt/qwen',
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
    fixture = undefined;
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
    expect(mocks.standalone).toHaveBeenCalledWith('/opt/qwen', '2.0.0');
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
        join('/opt/qwen', 'bin', 'qwen'),
      ),
    );
    expect(events.slice(-2)).toEqual(['cleanup', 'restart']);
    await (app.locals['cleanupDaemonUpdate'] as () => Promise<void>)();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
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
