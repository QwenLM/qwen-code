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
  type ManagedShellCapturePublisher,
} from './managed-runtime-tool-executor.js';
import { ManagedChildRunSupervisor } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { RemoteShellResultPublisher } from './remote-shell-result-publication.js';
import type { ManagedShellPublisherRegistry } from './managed-shell-publisher.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';
import { registerManagedRuntimeToolV3Routes } from './managed-runtime-tool-v3-routes.js';
import {
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  ManagedRuntimeProviderProtocolError,
} from './managed-runtime-provider-protocol.js';
import { registerManagedRuntimeProviderRoute } from './managed-runtime-provider-worker.js';
import {
  WorkspaceActivations,
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
} from './managed-workspace-activation.js';
import {
  ManagedHookRuntime,
  loadManagedHookManifest,
} from './managed-hook-runtime.js';
import {
  MANAGED_HOOK_WORKER_ROUTE,
  registerManagedHookRoutes,
} from './managed-hook-routes.js';
import {
  ManagedMcpRuntime,
  loadManagedMcpManifest,
} from './managed-mcp-runtime.js';
import {
  MANAGED_MCP_WORKER_ROUTE,
  registerManagedMcpRoutes,
} from './managed-mcp-routes.js';
import { ManagedBackgroundShellRegistry } from './managed-background-shell-registry.js';
import { ManagedShellRuntime } from './managed-shell-runtime.js';
import {
  MANAGED_SHELL_WORKER_ROUTE,
  registerManagedShellRoutes,
} from './managed-shell-routes.js';
import { ManagedMonitorRegistry } from './managed-monitor-registry.js';
import { ManagedMonitorRuntime } from './managed-monitor-runtime.js';
import {
  MANAGED_MONITOR_WORKER_ROUTE,
  registerManagedMonitorRoutes,
} from './managed-monitor-routes.js';

/**
 * The routes of a worker booted with v2. Attestation v2 is not among them,
 * so it answers 404 and the Runtime never presents two identities.
 */
export const MANAGED_CONTEXT_WORKER_ROUTES = Object.freeze([
  ...MANAGED_CONTEXT_ROUTES,
  WORKSPACE_ACTIVATION_ROUTE,
  MANAGED_MCP_WORKER_ROUTE,
  MANAGED_HOOK_WORKER_ROUTE,
  MANAGED_SHELL_WORKER_ROUTE,
  MANAGED_MONITOR_WORKER_ROUTE,
  MANAGED_RUNTIME_PROVIDER_ROUTE,
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

  get isAvailable(): boolean {
    return true;
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
 * Picks the capture funnel of one prepare by the capture's own identity. A
 * background Shell or Monitor capture belongs to the record funnel of its
 * Session; a foreground result belongs to its own publication grant, and
 * the same Session owning both at once is a legal, ordinary topology — a
 * Session-level mixed-mode check can never tell the two apart.
 */
export function selectShellCapturePublisher(
  remotePublishers: ManagedShellPublisherRegistry,
  remotePublisher: RemoteShellResultPublisher,
): ManagedShellCapturePublisher {
  return {
    // The retirement gate reads this flag — the selector owns both funnels'
    // installed state, exactly like the inline composite it replaced.
    get hasInstalledPublication() {
      return (
        remotePublishers.hasInstalledPublication ||
        remotePublisher.hasInstalledPublication
      );
    },
    async prepare(request) {
      if (request.capture.background === true) {
        // The detached handle carries no result manifest, so an
        // unregistered Session funnel is the one place the record could
        // never settle — admission refuses it instead of silently parking
        // the capture on the publication.
        if (!remotePublishers.hasSession(request.reference.sessionId))
          throw new Error(
            'Background captures require their Session publisher.',
          );
        return {
          ...(await remotePublishers.prepare(request)),
          publisher: remotePublishers,
        };
      }
      if (remotePublisher.hasExecution(request.capture.executionCallId)) {
        // The foreground result's own funnel; the Session's background
        // lane registered beside it is not a conflict.
        return {
          ...(await remotePublisher.prepare(request)),
          publisher: remotePublisher,
        };
      }
      const selected = remotePublishers.hasSession(request.reference.sessionId)
        ? remotePublishers
        : remotePublisher;
      return {
        ...(await selected.prepare(request)),
        publisher: selected,
      };
    },
  };
}

/**
 * Mounts attestation v3, context installation and the Tool v2 routes for a
 * boot v2 document. A tool call runs only for a Session with an installed
 * context, in its effective directory, verified again for every call.
 */
export function registerManagedContextRoutes(
  app: Application,
  bootDocument: ManagedContextBoot,
  capturePublisher?: ManagedShellCapturePublisher,
  remotePublishers?: ManagedShellPublisherRegistry,
  mount = new ManagedContextMount(bootDocument.mountRoot),
): ManagedToolExecutor {
  const boot = parseManagedContextBoot(bootDocument);
  const installations = new ManagedContextInstallations(boot);
  const activations = new WorkspaceActivations();
  const requiresActivation =
    boot.capabilityDigest === WORKSPACE_CAPABILITY_DIGEST;
  const admissionOpen = (): boolean => executor.isAdmissionOpen;
  const remotePublisher =
    !capturePublisher && requiresActivation
      ? new RemoteShellResultPublisher()
      : undefined;
  const publisher: ManagedShellCapturePublisher | undefined =
    capturePublisher ??
    (remotePublishers && remotePublisher
      ? selectShellCapturePublisher(remotePublishers, remotePublisher)
      : (remotePublishers ?? remotePublisher));
  remotePublisher?.registerInstallRoute(app, boot, admissionOpen);
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
          admissionOpen,
        ),
      );
    },
    handleManagedRuntimeJsonError,
  );

  const mcp = new ManagedMcpRuntime(
    boot,
    async (runtimeSessionId) => {
      if (
        !admissionOpen() ||
        !mount.isAvailable ||
        !requiresActivation ||
        !activations.isActive(runtimeSessionId)
      )
        return undefined;
      const binding = installations.installed(runtimeSessionId);
      const directory = binding && (await mount.resolve(binding.cwdRelative));
      return admissionOpen() &&
        mount.isAvailable &&
        activations.isActive(runtimeSessionId)
        ? directory
        : undefined;
    },
    loadManagedMcpManifest(process.env['QWEN_MANAGED_MCP_CONFIG']),
  );
  registerManagedMcpRoutes(app, boot, mcp);
  const hooks = new ManagedHookRuntime(
    boot,
    async (runtimeSessionId) => {
      if (
        !admissionOpen() ||
        !mount.isAvailable ||
        !requiresActivation ||
        !activations.isActive(runtimeSessionId)
      )
        return undefined;
      const binding = installations.installed(runtimeSessionId);
      const directory = binding && (await mount.resolve(binding.cwdRelative));
      return admissionOpen() &&
        mount.isAvailable &&
        activations.isActive(runtimeSessionId)
        ? directory
        : undefined;
    },
    loadManagedHookManifest(process.env['QWEN_MANAGED_HOOK_CONFIG']),
  );
  registerManagedHookRoutes(app, boot, hooks);
  // H3 background Shells share the delegation the Hook commands already use;
  // unset or empty both mean no delegation, and the executor keeps its
  // committed refusal then.
  const cgroupRoot = process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
  const backgroundSupervisor = cgroupRoot
    ? ManagedChildRunSupervisor.create({ cgroupRoot })
    : undefined;
  const backgroundRegistry = new ManagedBackgroundShellRegistry();
  // One monitor registry shared by executor and maintenance routes: a
  // private second instance could only ever answer unknown.
  const monitorRegistry = new ManagedMonitorRegistry();
  const executor: ManagedToolExecutor = new ManagedToolExecutor(
    async (reference) => {
      const isActive = () =>
        admissionOpen() &&
        mount.isAvailable &&
        (!requiresActivation || activations.isActive(reference.sessionId));
      if (!isActive()) {
        return undefined;
      }
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
      return {
        ...sessionIdContext.run(sessionId, () =>
          createManagedToolSet(
            directory,
            sessionId,
            requiresActivation ? boot.mountRoot : directory,
          ),
        ),
        isActive,
      };
    },
    publisher,
    mcp,
    hooks,
    backgroundSupervisor,
    backgroundRegistry,
    monitorRegistry,
  );
  registerManagedShellRoutes(
    app,
    boot,
    new ManagedShellRuntime(backgroundRegistry),
  );
  registerManagedMonitorRoutes(
    app,
    boot,
    new ManagedMonitorRuntime(monitorRegistry),
  );
  registerManagedRuntimeProviderRoute(
    app,
    boot,
    executor,
    async (sessionId) => {
      const binding = installations.installed(sessionId);
      if (
        !requiresActivation ||
        (binding !== undefined &&
          binding.contextConfigRef !== WORKSPACE_CONTEXT_CONFIG_REF)
      ) {
        throw new ManagedRuntimeProviderProtocolError(
          'Managed Runtime provider configuration is unsupported.',
          501,
          'managed_runtime_provider_unsupported',
        );
      }
      const isActive = () =>
        !executor.isAdmissionSealed &&
        mount.isAvailable &&
        activations.isActive(sessionId);
      if (!isActive()) return undefined;
      const directory = binding && (await mount.resolve(binding.cwdRelative));
      return directory === undefined
        ? undefined
        : {
            directory,
            workspaceRoot: boot.mountRoot,
            preapproved: true,
            isActive,
          };
    },
  );
  activations.register(app, boot, installations, executor);
  registerManagedRuntimeToolRoutes(app, boot, executor);
  if (publisher) {
    registerManagedRuntimeToolV3Routes(app, boot, executor);
  }
  remotePublishers?.register(
    app,
    boot,
    (sessionId) =>
      admissionOpen() &&
      mount.isAvailable &&
      requiresActivation &&
      activations.isActive(sessionId) &&
      installations.installed(sessionId) !== undefined,
  );
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
