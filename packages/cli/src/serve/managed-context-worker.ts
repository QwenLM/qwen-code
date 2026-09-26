/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { sessionIdContext } from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import type express from 'express';
import type { Application, Response } from 'express';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  OWNED_MANAGED_RUNTIME_ROUTES,
} from './managed-runtime-attestation-contract.js';
import {
  checkManagedContextAttestation,
  MANAGED_CONTEXT_ROUTES,
  ManagedContextInstallations,
  parseManagedContextBoot,
  type ManagedContextBoot,
  type ManagedContextOutcome,
} from './managed-context-envelope.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';

/**
 * The routes of a worker booted with v2. Attestation v2 is not among them,
 * so it answers 404 and the Runtime never presents two identities.
 */
export const MANAGED_CONTEXT_WORKER_ROUTES = Object.freeze([
  ...MANAGED_CONTEXT_ROUTES,
  ...OWNED_MANAGED_RUNTIME_ROUTES.filter((route) => route.key !== 'attest'),
]);

const REFUSAL_MESSAGES = Object.freeze({
  managed_runtime_attestation_invalid:
    'Managed Runtime attestation request is invalid.',
  managed_runtime_identity_conflict:
    'Managed Runtime immutable identity conflicts.',
  managed_context_conflict:
    'Managed context conflicts with an earlier installation.',
  managed_context_unavailable: 'Managed context directory is unavailable.',
});

/**
 * The Workspace mount of a boot v2 Runtime. The mount root stays data until
 * a directory below it is verified; the root's device and inode are then
 * pinned for the Runtime's lifetime, so a replaced or remounted root is
 * refused rather than followed.
 */
export class ManagedContextMount {
  readonly #mountRoot: string;
  #root: { readonly dev: bigint; readonly ino: bigint } | undefined;

  constructor(mountRoot: string) {
    this.#mountRoot = mountRoot;
  }

  /**
   * The effective directory of a Workspace-relative directory in W0a's
   * normal form, or undefined when it is not a readable directory at exactly
   * that path below the pinned root, with no symbolic link on the way.
   */
  async resolve(cwdRelative: string): Promise<string | undefined> {
    if (!isHostAbsolute(this.#mountRoot)) {
      return undefined;
    }
    let rootStats: BigIntStats;
    let directory: string;
    try {
      const root = await fs.realpath(this.#mountRoot);
      rootStats = await fs.stat(root, { bigint: true });
      directory = path.join(root, ...cwdRelative.split('/'));
      if (
        (await fs.realpath(directory)) !== directory ||
        !(await fs.stat(directory)).isDirectory()
      ) {
        return undefined;
      }
      await fs.access(directory, constants.R_OK | constants.X_OK);
    } catch {
      return undefined;
    }
    const pinned = this.#root;
    if (pinned === undefined) {
      this.#root = { dev: rootStats.dev, ino: rootStats.ino };
    } else if (pinned.dev !== rootStats.dev || pinned.ino !== rootStats.ino) {
      return undefined;
    }
    return directory;
  }
}

/**
 * Whether a mount root is absolute on this host. The boot rule also admits
 * the other platform's forms, which would otherwise resolve against the
 * process's working directory or drive.
 */
function isHostAbsolute(mountRoot: string): boolean {
  return process.platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(mountRoot)
    : mountRoot.startsWith('/');
}

/**
 * Mounts attestation v3, context installation and the Tool v2 routes for a
 * boot v2 document. A tool call runs only for a Session with an installed
 * context, in its effective directory, verified again for every call.
 */
export function registerManagedContextRoutes(
  app: Application,
  bootDocument: ManagedContextBoot,
): ManagedToolExecutor {
  const boot = parseManagedContextBoot(bootDocument);
  const installations = new ManagedContextInstallations(boot);
  const mount = new ManagedContextMount(boot.mountRoot);
  const [attestRoute, contextRoute] = MANAGED_CONTEXT_ROUTES;

  app.post(
    attestRoute.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot),
    managedRuntimeJsonBody(attestRoute.requestBodyLimitBytes),
    (req: express.Request, res: express.Response) => {
      send(res, checkManagedContextAttestation(req.body, boot));
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    contextRoute.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot),
    managedRuntimeJsonBody(contextRoute.requestBodyLimitBytes),
    async (req: express.Request, res: express.Response) => {
      send(
        res,
        await installations.install(
          req.body,
          async (binding) =>
            (await mount.resolve(binding.cwdRelative)) !== undefined,
        ),
      );
    },
    handleManagedRuntimeJsonError,
  );

  const executor = new ManagedToolExecutor(async (reference) => {
    const binding = installations.installed(reference.sessionId);
    const directory = binding && (await mount.resolve(binding.cwdRelative));
    if (directory === undefined) {
      return undefined;
    }
    // Built for each call, so the tools see the directory just verified. Built
    // in the Session's context, so core does not hold the configuration as
    // the process's debug log session.
    const sessionId = runtimeSessionKey(
      boot.runtimeInstanceId,
      reference.sessionId,
    );
    return sessionIdContext.run(sessionId, () =>
      createManagedToolSet(directory, sessionId),
    );
  });
  registerManagedRuntimeToolRoutes(app, boot, executor);
  return executor;
}

/**
 * The session that a Runtime Session's calls run as, so that each Session's
 * shells get its own project directory. Core uses a session id in file names,
 * so the Runtime Session ID, which may hold any character, is hashed.
 */
function runtimeSessionKey(runtimeInstanceId: string, sessionId: string) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `${runtimeInstanceId}.${digest.slice(0, 32)}`;
}

function send<Body>(res: Response, outcome: ManagedContextOutcome<Body>): void {
  if (outcome.status === 200) {
    res.status(200).json(outcome.body);
    return;
  }
  res.status(outcome.status).json({
    code: outcome.code,
    error: REFUSAL_MESSAGES[outcome.code],
  });
}
