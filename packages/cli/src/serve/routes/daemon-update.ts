/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import type { Application, Request, RequestHandler } from 'express';
import { listenerIdentityOf } from '../local-control/listener-identity.js';
import { singleTokenCredentials } from '../local-control/credentials.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const CHECK_CACHE_MS = 15 * 60_000;
const ERROR_CACHE_MS = 60_000;

async function managedNpmLauncher(
  bootstrap: string | undefined,
  stamp: string | undefined,
): Promise<string | undefined> {
  if (!bootstrap || !stamp) return undefined;
  try {
    const pin: unknown = JSON.parse(stamp);
    if (
      typeof pin !== 'object' ||
      pin === null ||
      !('bootstrap' in pin) ||
      typeof pin.bootstrap !== 'string'
    ) {
      return undefined;
    }
    const resolved = await realpath(bootstrap);
    if (
      basename(resolved) !== 'cli-entry.js' ||
      resolved !== (await realpath(pin.bootstrap))
    ) {
      return undefined;
    }
    const manifest = JSON.parse(
      await readFile(join(dirname(resolved), 'package.json'), 'utf8'),
    ) as { name?: unknown; private?: unknown };
    return manifest.name === '@qwen-code/qwen-code' && manifest.private !== true
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

interface PreparedUpdate {
  launcher: string;
  activate(): Promise<unknown>;
  cleanup(): void | Promise<void>;
}

interface UpdateRouteDeps {
  currentVersion?: string;
  runtimeToken?: string;
  restartForUpdate?: (launcher: string) => Promise<void>;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
}

function createUpdateController(deps: UpdateRouteDeps) {
  const startupDirectory = process.cwd();
  const bootstrap = process.env['QWEN_CODE_CLI'];
  const launcherStamp = process.env['QWEN_CODE_MANAGED_NPM_PIN'];
  let currentVersion = deps.currentVersion;
  let status: DaemonUpdateStatus | undefined;
  let checkedAt = 0;
  let checking: Promise<DaemonUpdateStatus> | undefined;
  let prepare: (() => Promise<PreparedUpdate>) | undefined;
  let prepared: PreparedUpdate | undefined;
  let closed = false;
  let restartStarted = false;

  const enabled = async () => {
    if (!deps.restartForUpdate || closed) return false;
    const { loadSettings } = await import('../../config/settings.js');
    return (
      loadSettings(startupDirectory, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: true,
      }).merged.general?.enableAutoUpdate !== false && !closed
    );
  };
  const unavailable = (): DaemonUpdateStatus => ({
    state: 'unavailable',
    currentVersion,
    canInstall: false,
  });
  const disable = async (): Promise<DaemonUpdateStatus> => {
    const candidate = prepared;
    prepared = undefined;
    await candidate?.cleanup();
    return (status = unavailable());
  };
  const fail = (error: unknown): DaemonUpdateStatus => {
    checkedAt = Date.now();
    status = {
      ...status,
      state: 'error',
      currentVersion,
      canInstall: false,
      message: error instanceof Error ? error.message : String(error),
    };
    return status;
  };
  const check = async (refresh = false): Promise<DaemonUpdateStatus> => {
    if (closed) return unavailable();
    const current = status;
    if (current?.state === 'ready') {
      try {
        const allowed = await enabled();
        if (status?.state === 'restarting') return status;
        return allowed ? (status ?? current) : await disable();
      } catch (error) {
        if (status?.state === 'restarting') return status;
        await disable();
        return fail(error);
      }
    }
    if (status?.state === 'installing' || status?.state === 'restarting')
      return status;
    if (checking) return checking;
    if (
      status &&
      !refresh &&
      Date.now() - checkedAt <
        (status.state === 'error' ? ERROR_CACHE_MS : CHECK_CACHE_MS)
    )
      return status;
    checking = (async () => {
      prepare = undefined;
      try {
        if (!(await enabled())) return (status = unavailable());
        const { checkForUpdatesDetailed, describeUpdateCheckFailure } =
          await import('../../ui/utils/updateCheck.js');
        const result = await checkForUpdatesDetailed();
        currentVersion ??=
          result.status === 'update'
            ? result.info.update.current
            : result.currentVersion;
        if (result.status !== 'update') {
          status = {
            state: result.status === 'skipped' ? 'unavailable' : result.status,
            currentVersion,
            canInstall: false,
            ...(result.status === 'skipped'
              ? { message: result.reason }
              : result.status === 'error'
                ? { message: describeUpdateCheckFailure(result.error) }
                : {}),
          };
          return status;
        }
        const {
          getInstallationInfo,
          formatUpdateInstructions,
          PackageManager,
        } = await import('../../utils/installationInfo.js');
        const installation = getInstallationInfo(startupDirectory, false);
        const latestVersion = result.info.update.latest;
        if (installation.isStandalone && installation.standaloneDir) {
          const standaloneDir = installation.standaloneDir;
          prepare = async () => {
            const { prepareStandaloneUpdate } = await import(
              '../../ui/standalone-update.js'
            );
            return {
              ...(await prepareStandaloneUpdate(standaloneDir, latestVersion)),
              launcher: join(standaloneDir, 'bin', 'qwen'),
            };
          };
        } else if (
          installation.isGlobal &&
          installation.packageManager === PackageManager.NPM &&
          installation.updateCommand
        ) {
          const launcher = await managedNpmLauncher(bootstrap, launcherStamp);
          if (launcher) {
            prepare = async () => {
              const {
                stageManagedNpmUpdate,
                activateManagedNpmUpdate,
                cleanupManagedNpmUpdate,
              } = await import('../../utils/managed-npm-update.js');
              const staged = await stageManagedNpmUpdate(
                latestVersion,
                launcher,
              );
              return {
                launcher,
                activate: () =>
                  activateManagedNpmUpdate(staged, latestVersion, launcher),
                cleanup: () => cleanupManagedNpmUpdate(staged),
              };
            };
          }
        }
        status = {
          state: 'available',
          currentVersion,
          latestVersion,
          canInstall: prepare !== undefined,
          ...(!prepare
            ? {
                instructions: formatUpdateInstructions(
                  installation,
                  latestVersion,
                ),
              }
            : {}),
        };
      } catch (error) {
        return fail(error);
      } finally {
        checkedAt = Date.now();
      }
      return status;
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };

  return {
    check,
    async prepare(): Promise<DaemonUpdateStatus> {
      const current = await check();
      if (current.state !== 'available' || !prepare) return current;
      try {
        if (!(await enabled())) return await disable();
      } catch (error) {
        return fail(error);
      }
      if (
        status?.state === 'installing' ||
        status?.state === 'ready' ||
        status?.state === 'restarting'
      )
        return status;
      if (current.state !== 'available' || !prepare) return current;
      const installer = prepare;
      status = { ...current, state: 'installing', canInstall: false };
      const installing = status;
      void installer()
        .then(async (result) => {
          if (closed) {
            await result.cleanup();
            return;
          }
          prepared = result;
          status = { ...installing, state: 'ready' };
        })
        .catch(fail);
      return installing;
    },
    async reserveRestart() {
      const current = await check();
      if (current.state !== 'ready') return { status: current };
      try {
        const allowed = await enabled();
        if (status?.state === 'restarting') return { status };
        if (!allowed) return { status: await disable() };
      } catch (error) {
        if (status?.state === 'restarting') return { status };
        await disable();
        return { status: fail(error) };
      }
      if (current.state !== 'ready' || !prepared || !deps.restartForUpdate)
        return { status: current };
      const candidate = prepared;
      const restart = deps.restartForUpdate;
      status = { ...current, state: 'restarting' };
      return {
        status,
        cancel: () => {
          if (!restartStarted) status = current;
        },
        run: async () => {
          restartStarted = true;
          try {
            await candidate.activate();
            await candidate.cleanup();
            prepared = undefined;
            await restart(candidate.launcher);
          } catch (error) {
            restartStarted = false;
            prepared = undefined;
            await Promise.resolve()
              .then(() => candidate.cleanup())
              .catch(() => undefined);
            fail(error);
            writeStderrLine(
              `qwen serve: update restart failed: ${status?.message}`,
            );
          }
        },
      };
    },
    async cleanup(): Promise<void> {
      if (restartStarted) return;
      closed = true;
      const candidate = prepared;
      prepared = undefined;
      await candidate?.cleanup();
    },
  };
}

// Runtime reloads rebuild the Express app without replacing the daemon process.
let processUpdate: ReturnType<typeof createUpdateController> | undefined;

export function registerDaemonUpdateRoutes(
  app: Application,
  deps: UpdateRouteDeps,
): void {
  const update = (processUpdate ??= createUpdateController(deps));
  app.locals['cleanupDaemonUpdate'] = update.cleanup;
  const credentials = singleTokenCredentials(deps.runtimeToken);
  const canReconnect = (req: Request): boolean => {
    const listener = listenerIdentityOf(req);
    if (listener.kind !== 'primary') return false;
    if (credentials.isOpen(listener)) return true;
    const header = req.headers.authorization ?? '';
    const separator = header.indexOf(' ');
    return (
      separator > 0 &&
      header.slice(0, separator).toLowerCase() === 'bearer' &&
      credentials.verify(
        header.slice(separator + 1).replace(/^[ \t]+/, ''),
        listener,
      )
    );
  };
  const reconnectableOnly: RequestHandler = (req, res, next) => {
    if (canReconnect(req)) {
      next();
      return;
    }
    res.status(403).json({
      error:
        'Updates require the primary daemon connection and runtime credential',
      code: 'update_connection_unsupported',
    });
  };
  const emptyBody: RequestHandler = (req, res, next) => {
    if (
      req.body !== undefined &&
      (req.body === null ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length > 0)
    ) {
      res
        .status(400)
        .json({ error: 'Update does not accept request parameters' });
      return;
    }
    next();
  };
  app.get('/daemon/update', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canReconnect(req)) {
      res.json({
        state: 'unavailable',
        currentVersion: deps.currentVersion,
        canInstall: false,
      });
      return;
    }
    const refresh = req.query['refresh'];
    if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
      res.status(400).json({ error: 'refresh must be true or false' });
      return;
    }
    res.json(await update.check(refresh === 'true'));
  });
  app.post(
    '/daemon/update/prepare',
    deps.mutate({ strict: true }),
    reconnectableOnly,
    emptyBody,
    async (_req, res) => {
      const status = await update.prepare();
      if (
        status.state === 'installing' ||
        status.state === 'ready' ||
        status.state === 'restarting'
      ) {
        res.status(status.state === 'ready' ? 200 : 202).json(status);
        return;
      }
      res.status(409).json({
        ...status,
        error: status.message ?? 'No automatic update is available',
        code: 'update_unavailable',
      });
    },
  );
  app.post(
    '/daemon/update/restart',
    deps.mutate({ strict: true }),
    reconnectableOnly,
    emptyBody,
    async (_req, res) => {
      const reservation = await update.reserveRestart();
      if (reservation.status.state !== 'restarting') {
        res.status(409).json({
          ...reservation.status,
          error: 'No prepared update is available',
          code: 'update_not_ready',
        });
        return;
      }
      if (reservation.run) {
        res.once('finish', () => {
          void reservation.run?.();
        });
        res.once('close', () => {
          if (!res.writableFinished) reservation.cancel?.();
        });
      }
      res.status(202).json(reservation.status);
    },
  );
}
