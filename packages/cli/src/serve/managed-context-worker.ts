/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { preflightManagedExtensionPackage } from './managed-extension-preflight.js';
import { managedExtensionEnvironment } from './managed-extension-environment.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import {
  compileManagedExtensionPackage,
  type ManagedPackageContributions,
} from '@qwen-code/qwen-code-core/extension/managed-package.js';
import {
  MANAGED_EXTENSION_RETIRE_ROUTE,
  ManagedExtensionRuntime,
  registerManagedExtensionRuntimeRoutes,
} from './managed-extension-runtime.js';
import { runManagedExtensionShell } from './managed-extension-shell.js';
import {
  ManagedExtensionCommandRuntime,
  registerManagedExtensionCommandRoute,
} from './managed-extension-command-runtime.js';
import { parseManagedExtensionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import {
  type ManagedToolSet,
  type ManagedToolSetResolver,
  createManagedToolSet,
  ManagedToolExecutor,
  realpathDeepestExisting,
  type ManagedShellCapturePublisher,
} from './managed-runtime-tool-executor.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';
import { stageManagedExtensionManifests } from './managed-extension-manifests.js';

import {
  constants,
  promises as fs,
  mkdirSync,
  type BigIntStats,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sessionIdContext } from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import {
  computeManagedContextDigest,
  normalizeWorkspaceRelativePath,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
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
import { ManagedChildRunSupervisor } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { RemoteShellResultPublisher } from './remote-shell-result-publication.js';
import type { ManagedShellPublisherRegistry } from './managed-shell-publisher.js';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
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
  RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
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
  MANAGED_MCP_DEFINITIONS_WORKER_ROUTE,
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
  MANAGED_MCP_DEFINITIONS_WORKER_ROUTE,
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

  constructor(
    mountRoot: string,
    private readonly verifyStorage?: () => Promise<void>,
  ) {
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
      await this.verifyStorage?.();
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

  /**
   * The canonical mount root, or undefined when it is unreadable or its
   * device and inode no longer match the pinned ones. A binding whose own
   * directory stopped resolving is still judged against the location it
   * occupied, which needs the same root `resolve` would have joined onto.
   */
  async rootDirectory(): Promise<string | undefined> {
    if (!isHostAbsolute(this.#mountRoot)) {
      return undefined;
    }
    try {
      await this.verifyStorage?.();
      const root = await fs.realpath(this.#mountRoot);
      const stats = await fs.stat(root, { bigint: true });
      const pinned = this.#root;
      if (
        pinned !== undefined &&
        (pinned.dev !== stats.dev || pinned.ino !== stats.ino)
      ) {
        return undefined;
      }
      return root;
    } catch {
      return undefined;
    }
  }
}

/**
 * Where an installed sibling Session's directory is now. `mount.resolve`
 * answers only for a canonical, readable directory; a binding that was
 * removed, or replaced by a symlink, still has a knowable location. A
 * resolvable redirect retains ownership of its target; a resolution error
 * retains the occupied path without vetoing unrelated shared reads.
 */
async function siblingDirectory(
  mount: ManagedContextMount,
  cwdRelative: string,
): Promise<string | undefined> {
  const resolved = await mount.resolve(cwdRelative);
  if (resolved !== undefined) return resolved;
  const root = await mount.rootDirectory();
  if (root === undefined) return undefined;
  const occupied = path.join(root, ...cwdRelative.split('/'));
  try {
    return await realpathDeepestExisting(occupied);
  } catch {
    return occupied;
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
  ledger?: ManagedRuntimeLedger,
  sshForegroundOnly = false,
  externalFilesOnly = false,
  externalShell = false,
): ManagedToolExecutor {
  const boot = parseManagedContextBoot(bootDocument);
  if (boot.capabilityDigest === CSI_FILES_RETIREMENT_CAPABILITY_DIGEST)
    throw new Error('Private CSI file profile requires its dedicated worker.');
  const installations = new ManagedContextInstallations(boot);
  let extensionRuntime: ManagedExtensionRuntime | undefined;
  let extensionToolSet:
    | ((
        reference: Parameters<ManagedToolSetResolver>[0],
        invocation: NonNullable<Parameters<ManagedToolSetResolver>[1]>,
        tools: ManagedToolSet,
      ) => Promise<ManagedToolSet>)
    | undefined;
  const extensionConfiguration = boot.managedExtensions;
  const processDirectory = extensionConfiguration
    ? path.join(
        extensionConfiguration.cacheDirectory,
        'owners',
        createHash('sha256')
          .update(
            `${boot.tenantId}\0${boot.workspaceId}\0${boot.runtimeInstanceId}\0${boot.epoch}`,
          )
          .digest('hex'),
      )
    : undefined;
  if (extensionConfiguration && !ledger && processDirectory) {
    mkdirSync(processDirectory, { recursive: true, mode: 0o700 });
    const pgid = Number(
      execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
        encoding: 'utf8',
      }).trim(),
    );
    if (!Number.isSafeInteger(pgid) || pgid < 2)
      throw new Error('Worker process group is unavailable.');
    ledger = ManagedRuntimeLedger.create({
      workFile: path.join(processDirectory, 'ledger.json'),
      worker: {
        pid: process.pid,
        pgid,
        groupOwned: false,
        incarnation: boot.runtimeIncarnation,
        startedAt: Date.now(),
      },
    });
  }

  const extensionProcesses = extensionConfiguration
    ? new ManagedExtensionProcessOwners(extensionConfiguration.mode, {
        ledger,
        cgroupRoot: extensionConfiguration.cgroupRoot,
        directory: processDirectory,
      })
    : undefined;
  const foregroundOnly = sshForegroundOnly && !extensionConfiguration;
  const activations = new WorkspaceActivations();
  const resident =
    boot.capabilityDigest === RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
  if (resident && boot.isolationClass !== 'workspace')
    throw new Error('Resident Workspace requires Workspace isolation.');
  const requiresActivation =
    boot.capabilityDigest === WORKSPACE_CAPABILITY_DIGEST ||
    resident ||
    extensionConfiguration !== undefined;
  const admissionOpen = (): boolean => executor.isAdmissionOpen;
  const remotePublisher =
    (externalShell || !capturePublisher) && requiresActivation && !resident
      ? new RemoteShellResultPublisher()
      : undefined;
  const publisher: ManagedShellCapturePublisher | undefined = externalShell
    ? remotePublisher
    : (capturePublisher ??
      (remotePublishers && remotePublisher
        ? selectShellCapturePublisher(remotePublishers, remotePublisher)
        : (remotePublishers ?? remotePublisher)));
  remotePublisher?.registerInstallRoute(app, boot, admissionOpen);
  const [attestRoute, contextRoute] = MANAGED_CONTEXT_ROUTES;

  app.post(
    attestRoute.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot),
    managedRuntimeJsonBody(attestRoute.requestBodyLimitBytes),
    async (req: express.Request, res: express.Response) => {
      if (externalFilesOnly && (await mount.resolve('')) === undefined) {
        res.status(409).json({ code: 'managed_context_unavailable' });
        return;
      }
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

  const mcp = foregroundOnly
    ? undefined
    : new ManagedMcpRuntime(
        boot,
        async (runtimeSessionId) => {
          if (
            !admissionOpen() ||
            !mount.isAvailable ||
            resident ||
            !requiresActivation ||
            !activations.isActive(runtimeSessionId) ||
            extensionRuntime?.isChanging(runtimeSessionId) === true
          )
            return undefined;
          const binding = installations.installed(runtimeSessionId);
          const directory =
            binding && (await mount.resolve(binding.cwdRelative));
          return admissionOpen() &&
            mount.isAvailable &&
            activations.isActive(runtimeSessionId)
            ? directory
            : undefined;
        },
        loadManagedMcpManifest(
          resident ? undefined : process.env['QWEN_MANAGED_MCP_CONFIG'],
        ),
        extensionProcesses,
      );
  if (mcp) registerManagedMcpRoutes(app, boot, mcp);
  const hooks = foregroundOnly
    ? undefined
    : new ManagedHookRuntime(
        boot,
        async (runtimeSessionId) => {
          if (
            !admissionOpen() ||
            !mount.isAvailable ||
            resident ||
            !requiresActivation ||
            !activations.isActive(runtimeSessionId) ||
            extensionRuntime?.isChanging(runtimeSessionId) === true
          )
            return undefined;
          const binding = installations.installed(runtimeSessionId);
          const directory =
            binding && (await mount.resolve(binding.cwdRelative));
          return admissionOpen() &&
            mount.isAvailable &&
            activations.isActive(runtimeSessionId)
            ? directory
            : undefined;
        },
        loadManagedHookManifest(
          resident ? undefined : process.env['QWEN_MANAGED_HOOK_CONFIG'],
        ),
        extensionProcesses,
      );
  if (hooks) registerManagedHookRoutes(app, boot, hooks);
  // H3 background Shells share the delegation the Hook commands already use;
  // unset or empty both mean no delegation, and the executor keeps its
  // committed refusal then.
  const cgroupRoot = resident
    ? undefined
    : process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
  const backgroundSupervisor =
    !foregroundOnly && cgroupRoot
      ? ManagedChildRunSupervisor.create({ cgroupRoot })
      : undefined;
  const backgroundRegistry = new ManagedBackgroundShellRegistry();
  // One monitor registry shared by executor and maintenance routes: a
  // private second instance could only ever answer unknown.
  const monitorRegistry = new ManagedMonitorRegistry();
  const executor: ManagedToolExecutor = new ManagedToolExecutor(
    async (reference, invocation) => {
      const isActive = () =>
        extensionRuntime?.isChanging(reference.sessionId) !== true &&
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
      let toolSet = sessionIdContext.run(sessionId, () =>
        createManagedToolSet(
          directory,
          sessionId,
          requiresActivation ? boot.mountRoot : directory,
        ),
      );
      if (invocation) {
        if (!extensionToolSet)
          throw new Error('Extension tool context is unavailable.');
        toolSet = await extensionToolSet(reference, invocation, {
          ...toolSet,
          isActive,
        });
      }
      return {
        ...toolSet,
        tools:
          resident || externalFilesOnly
            ? new Map(
                [...toolSet.tools].filter(([name]) =>
                  (resident
                    ? ['read_file', 'write_file', 'edit']
                    : externalShell
                      ? [
                          'read_file',
                          'write_file',
                          'edit',
                          'web_fetch',
                          'glob',
                          'run_shell_command',
                        ]
                      : ['read_file', 'write_file', 'edit', 'web_fetch']
                  ).includes(name),
                ),
              )
            : toolSet.tools,
        isActive: toolSet.isActive ?? isActive,
      };
    },
    publisher,
    mcp,
    hooks,
    async (sessionId, realPath, ownDirectory) => {
      // A stale binding still owns its missing or symlinked location, but
      // must not veto targets in unrelated shared directories.
      const contains = (directory: string, target: string): boolean => {
        const relative = path.relative(directory, target);
        return (
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      };
      const root = await mount.rootDirectory();
      // A target inside the caller's own directory is the caller's business
      // only when that directory is private: a Session bound at the mount
      // root (`'.'`, a Workspace selection without `cwd_relative`) delimits
      // no private area, so its targets stay subject to sibling ownership.
      const ownEstate =
        contains(ownDirectory, realPath) &&
        root !== undefined &&
        ownDirectory !== root;
      for (const [otherId, binding] of installations.bindings()) {
        if (otherId === sessionId) continue;
        if (resident && !activations.isActive(otherId)) continue;
        const directory = await siblingDirectory(mount, binding.cwdRelative);
        // A binding that cannot be located at all cannot prove the outside
        // target is shared — and it cannot veto the caller's own estate
        // either, which is the caller's business by the test above. The
        // exemption holds only while the root that granted it is still the
        // live one: a mount that fenced between the read above and this
        // sibling's resolution made the sibling unlocatable, and excusing it
        // then would flip the veto from deny to allow.
        if (directory === undefined) {
          if (ownEstate && (await mount.rootDirectory()) === root) continue;
          return true;
        }
        // Only a binding AT the mount root exempts: the shared Workspace
        // itself owns nothing. One bound at a non-root ancestor of the
        // caller still owns its whole subtree, including what spills past
        // the caller's directory.
        if (root !== undefined && directory === root) continue;
        if (!contains(directory, realPath)) continue;
        // Ownership runs in both directions. Inside the caller's own estate
        // only a Session installed strictly below it owns the target: one at
        // the same directory shares it, and one above it leaves it intact, or
        // the caller could not read its own files.
        if (
          !ownEstate ||
          (directory !== ownDirectory && contains(ownDirectory, directory))
        ) {
          return true;
        }
      }
      return false;
    },
    backgroundSupervisor,
    backgroundRegistry,
    monitorRegistry,
    { ledger, sshForegroundOnly, externalFilesOnly },
  );
  if (!sshForegroundOnly) {
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
  } else {
    for (const route of [
      MANAGED_MCP_WORKER_ROUTE,
      MANAGED_MCP_DEFINITIONS_WORKER_ROUTE,
      MANAGED_HOOK_WORKER_ROUTE,
      MANAGED_SHELL_WORKER_ROUTE,
      MANAGED_MONITOR_WORKER_ROUTE,
    ]) {
      app.post(
        route.path,
        managedRuntimeNoStore,
        authorizeManagedRuntime(boot),
        (_req, res) => {
          res.status(501).json({ code: 'managed_runtime_profile_unsupported' });
        },
      );
    }
  }
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
        extensionRuntime?.isChanging(sessionId) !== true &&
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
            filesOnly: resident || externalFilesOnly,
            isActive,
          };
    },
    sshForegroundOnly && !externalFilesOnly,
  );

  if (extensionConfiguration && mcp && hooks && extensionProcesses) {
    const configurationDirectory = path.join(
      extensionConfiguration.cacheDirectory,
      createHash('sha256')
        .update(
          `${boot.tenantId}\0${boot.workspaceId}\0${boot.workspaceGeneration}`,
        )
        .digest('hex'),
    );
    const relativeCache = path.relative(
      path.resolve(boot.mountRoot),
      configurationDirectory,
    );
    if (!relativeCache.startsWith('..') && !path.isAbsolute(relativeCache))
      throw new Error('Extension cache must stay outside the Workspace.');
    const contexts = new Map<string, ManagedContextBinding>();
    const hydrated = new Map<
      string,
      {
        contributions: ManagedPackageContributions;
        environment: Readonly<Record<string, string>>;
      }
    >();
    const staged = new Map<
      string,
      ReturnType<typeof stageManagedExtensionManifests>
    >();
    extensionRuntime = new ManagedExtensionRuntime({
      directory: configurationDirectory,
      executionMode: extensionConfiguration.mode,
      ownerJournalId: extensionProcesses.journalId,
      bindContext: async (sessionId, value) => {
        const binding = value as ManagedContextBinding;
        computeManagedContextDigest(binding);
        if (
          binding.tenantId !== boot.tenantId ||
          binding.workspaceId !== boot.workspaceId ||
          binding.workspaceGeneration !== boot.workspaceGeneration ||
          binding.storageId !== boot.storageId ||
          !(await mount.resolve(binding.cwdRelative))
        )
          throw new Error('Extension context scope conflicts.');
        const existing = contexts.get(sessionId);
        if (
          existing &&
          computeManagedContextDigest(existing) !==
            computeManagedContextDigest(binding)
        )
          throw new Error('Extension context changed.');
        contexts.set(sessionId, { ...binding });
      },
      admitted: async (sessionId) => {
        const binding = contexts.get(sessionId);
        return (
          admissionOpen() &&
          binding !== undefined &&
          (await mount.resolve(binding.cwdRelative)) !== undefined
        );
      },
      idle: (sessionId) =>
        !mcp.hasExtensionPendingOperations(sessionId) &&
        !hooks.hasExtensionHolds(sessionId) &&
        executor.isSessionConfigurationIdle(
          extensionRuntime?.runtimeSessionId(sessionId) ?? sessionId,
        ),
      compile: async (
        directory,
        _pin,
        environment,
        sessionId,
        publishedManifest,
      ) => {
        const binding = contexts.get(sessionId);
        const workspaceDirectory =
          binding && (await mount.resolve(binding.cwdRelative));
        if (
          !workspaceDirectory ||
          !['linux', 'darwin'].includes(process.platform) ||
          !['x64', 'arm64'].includes(process.arch)
        )
          throw new Error('Extension target is unavailable.');
        const target = {
          platform: process.platform as 'linux' | 'darwin',
          arch: process.arch as 'x64' | 'arm64',
        };
        const raw = await compileManagedExtensionPackage(directory, {
          target,
          workspaceDirectory,
          resolveRecipes: false,
        });
        if (
          Buffer.byteLength(JSON.stringify(raw.contributions)) >
          2 * 1024 * 1024
        )
          throw new Error('Extension contributions exceed their size limit.');
        if (
          publishedManifest === undefined ||
          !isDeepStrictEqual(raw.manifest, publishedManifest)
        )
          throw new Error('Extension published manifest conflicts.');
        const resolved = await compileManagedExtensionPackage(directory, {
          target,
          workspaceDirectory,
          environment,
        });
        await preflightManagedExtensionPackage(
          resolved.contributions,
          directory,
          workspaceDirectory,
          managedExtensionEnvironment(
            process.env,
            workspaceDirectory,
            environment,
          ),
        );
        hydrated.set(directory, {
          contributions: resolved.contributions,
          environment,
        });
        return raw.contributions;
      },
      stage: async (sessionId, command, packages, base) => {
        await extensionProcesses.coverSession(
          sessionId,
          command.expectedRevision + 1,
        );
        const manifests = stageManagedExtensionManifests({
          tenantId: boot.tenantId,
          workspaceId: boot.workspaceId,
          runtimeSessionId: sessionId,
          command,
          packages,
          ...base,
          mcp,
          hooks,
          hydrated: (directory) => {
            const value = hydrated.get(directory);
            if (!value) throw new Error('Extension recipes are unavailable.');
            return value;
          },
        });
        staged.set(`${sessionId}\0${command.operationId}`, manifests);
        return manifests;
      },
      drain: async (sessionId, command) => {
        const next = staged.get(`${sessionId}\0${command.operationId}`);
        if (!next) throw new Error('Extension configuration is not staged.');
        const retained = mcp.retainedExtensionOwnerIds(
          sessionId,
          next.mcpManifest,
        );
        await mcp.drainExtensionSession(sessionId, next.mcpManifest);
        if (hooks.hasExtensionHolds(sessionId))
          throw new Error('Original extension Hook outcome is unknown.');
        const receipts = await extensionProcesses.stopSession(
          sessionId,
          retained,
        );
        if (receipts.some((receipt) => receipt.state !== 'stopped'))
          throw new Error('Original extension process stop is unknown.');
      },
      reconcile: async (sessionId) => {
        await mcp.drainExtensionSession(sessionId);
        if (hooks.hasExtensionHolds(sessionId))
          throw new Error('Original Hook execution outcome is unknown.');
        return extensionProcesses.stopSession(sessionId);
      },
      install: async (sessionId, _packages, command) => {
        const manifests = staged.get(`${sessionId}\0${command.operationId}`);
        if (!manifests)
          throw new Error('Extension configuration is not prepared.');
        const retained = mcp.retainedExtensionOwnerIds(
          sessionId,
          manifests.mcpManifest,
        );
        if (await extensionProcesses.hasLiveSessionOwners(sessionId, retained))
          throw new Error('Original extension owners require reconciliation.');
        mcp.installSessionDefinitions(sessionId, manifests.mcpManifest);
        hooks.installSessionManifest(sessionId, manifests.hookManifest);
      },
    });
    executor.attachExtensionLifecycle({
      mode: extensionConfiguration.mode,
      drain: async () => {
        if (
          mcp.hasUnsettledExtensionOperations() ||
          hooks.hasUnsettledExtensionOperations()
        )
          throw new Error('Original extension operations are unsettled.');
        const receipts = await extensionProcesses.stopAll();
        if (receipts.some((entry) => entry.state !== 'stopped'))
          throw new Error('Original extension owners are not stopped.');
      },
    });
    app.post(
      MANAGED_EXTENSION_RETIRE_ROUTE.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(boot),
      managedRuntimeJsonBody(4096),
      async (req, res) => {
        try {
          const body = req.body as Record<string, unknown>;
          if (
            !body ||
            Object.keys(body).sort().join(',') !==
              'protocolVersion,retirementId' ||
            body['protocolVersion'] !== 1 ||
            typeof body['retirementId'] !== 'string'
          )
            throw new Error('Invalid extension retirement.');
          await executor.retireSsh(body['retirementId']);
          res.json({
            protocolVersion: 1,
            retirementId: body['retirementId'],
            executionMode: extensionConfiguration.mode,
            scope:
              extensionConfiguration.mode === 'linux-cgroup'
                ? 'process_tree'
                : 'process_group',
            state: 'stopped',
            runtimeInstanceId: boot.runtimeInstanceId,
            runtimeIncarnation: boot.runtimeIncarnation,
            leaseId: boot.leaseId,
            epoch: boot.epoch,
          });
        } catch {
          res.status(409).json({ code: 'managed_extension_stop_unverified' });
        }
      },
    );
    extensionToolSet = async (reference, invocation, original) => {
      const value = invocation.input['managedExtension'];
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid extension tool context.');
      const context = value as Record<string, unknown>;
      if (
        Object.keys(context).sort().join(',') !==
          'configRevision,harnessSessionId,pin' ||
        typeof context['harnessSessionId'] !== 'string' ||
        !Number.isSafeInteger(context['configRevision']) ||
        Number(context['configRevision']) < 1
      )
        throw new Error('Invalid extension tool context.');
      const logicalId = context['harnessSessionId'];
      const installed = installations.installed(reference.sessionId);
      const logical = contexts.get(logicalId);
      if (
        !installed ||
        !logical ||
        computeManagedContextDigest(installed) !==
          computeManagedContextDigest(logical)
      )
        throw new Error('Extension tool Session binding conflicts.');
      const runtime = extensionRuntime!;
      const selected = await runtime.getToolContext(
        logicalId,
        Number(context['configRevision']),
        parseManagedExtensionPin(context['pin']),
      );
      const active = () =>
        original.isActive?.() !== false && !runtime.isChanging(logicalId);
      if (
        invocation.toolName === 'read_file' ||
        invocation.toolName === 'glob'
      ) {
        const assetTools = createManagedToolSet(
          selected.assetRoot,
          runtimeSessionKey(
            boot.runtimeInstanceId,
            logicalId +
              '/' +
              parseManagedExtensionPin(context['pin']).extensionId,
          ),
          selected.assetRoot,
        );
        return {
          ...assetTools,
          extensionAssets: true,
          tools: new Map(
            [...assetTools.tools].filter(
              ([name]) => name === invocation.toolName,
            ),
          ),
          isActive: active,
        };
      }
      if (invocation.toolName !== 'run_shell_command')
        throw new Error('Extension assets are read-only.');
      return {
        ...original,
        isActive: active,
        runShell: (input, signal, capture) =>
          runManagedExtensionShell(extensionProcesses, {
            sessionId: logicalId,
            configRevision: Number(context['configRevision']),
            command: String(input['command']),
            cwd: original.directory!,
            environment: managedExtensionEnvironment(
              process.env,
              original.directory!,
              selected.environment,
            ),
            signal,
            capture,
            timeoutMs:
              typeof input['timeout'] === 'number'
                ? input['timeout']
                : undefined,
          }),
      };
    };
    registerManagedExtensionRuntimeRoutes(app, boot, extensionRuntime);
    registerManagedExtensionCommandRoute(
      app,
      boot,
      new ManagedExtensionCommandRuntime({
        directory: path.join(configurationDirectory, 'command-receipts'),
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceGeneration: boot.workspaceGeneration,
        prepareInput: async (runtimeSessionId, operation) => {
          const logicalId = operation.grant.sessionKey.sessionId;
          const installed = installations.installed(runtimeSessionId);
          const logical = contexts.get(logicalId);
          if (
            !admissionOpen() ||
            !installed ||
            !logical ||
            (requiresActivation && !activations.isActive(runtimeSessionId)) ||
            computeManagedContextDigest(installed) !==
              computeManagedContextDigest(logical)
          )
            throw new Error('Command Session context conflicts.');
          const runtime = extensionRuntime!;
          const active = await runtime.status(logicalId);
          const pin = active.extensions.find(
            (entry) => entry.extensionId === operation.extensionId,
          );
          if (
            active.state !== 'active' ||
            active.pendingOperationId ||
            active.revision !== operation.revision ||
            !pin
          )
            throw new Error('Command configuration is unavailable.');
          await runtime.getToolContext(logicalId, operation.revision, pin);
          const input = structuredClone(operation.input);
          const context = {
            harnessSessionId: logicalId,
            configRevision: operation.revision,
            pin,
          };
          if (operation.toolName === 'shell') {
            if (
              Object.keys(input).some(
                (key) => !['command', 'timeout'].includes(key),
              ) ||
              typeof input['command'] !== 'string'
            )
              throw new Error('Invalid command Shell input.');
            return { ...input, managedExtension: context };
          }
          if (
            Object.keys(input).some(
              (key) => !['file_path', 'offset', 'limit', 'pages'].includes(key),
            ) ||
            typeof input['file_path'] !== 'string'
          )
            throw new Error('Invalid command file input.');
          const prefix = `extension://${operation.extensionId}/`;
          if (input['file_path'].startsWith(prefix)) {
            input['file_path'] = normalizeWorkspaceRelativePath(
              input['file_path'].slice(prefix.length),
            );
            return { ...input, managedExtension: context };
          }
          if (input['file_path'].startsWith('extension://'))
            throw new Error('Command asset belongs to another extension.');
          input['file_path'] = normalizeWorkspaceRelativePath(
            input['file_path'],
          );
          return input;
        },
        execute: (reference, toolName, input) =>
          executor.execute(reference, toolName, input),
        cancel: (reference) => executor.cancel(reference),
      }),
    );
  }

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
