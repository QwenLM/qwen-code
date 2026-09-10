/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SERVE_CONTROL_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceExtensionsRefreshResult,
  type ServeWorkspaceRuntimeCapabilityStatus,
  type ServeWorkspaceRuntimeExtensionsCapabilityStatus,
  type ServeWorkspaceRuntimeStatus,
  type ServeWorkspaceSkillsRefreshResult,
} from '@qwen-code/acp-bridge/status';
import {
  redactUrlCredentials,
  stripAnsiAndControl,
} from '@qwen-code/qwen-code-core';
import type {
  AcpSessionBridge,
  BridgeWorkspaceRuntimeLifecycleSnapshot,
} from './acp-session-bridge.js';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

const DEFAULT_ENSURE_TIMEOUT_MS = 60_000;
const ENSURE_KEEP_ALIVE_MS = 10 * 60_000;
// Full refresh includes MCP discovery; match the bridge's MCP control budget.
const EXTENSIONS_RECONCILE_TIMEOUT_MS = 5 * 60_000;
// A latched Extension failure is retried at most once per cooldown window;
// without a bound, a store stuck at its initial generation has no recovery
// path (the desired generation never moves to clear the latch).
const EXTENSIONS_ERROR_RETRY_COOLDOWN_MS = 2 * 60_000;
const MCP_PREPARE_TIMEOUT_MS = 2 * 60_000;
const MCP_POLL_INTERVAL_MS = 250;

type LifecycleAcpSessionBridge = AcpSessionBridge & {
  getWorkspaceRuntimeLifecycleSnapshot(): BridgeWorkspaceRuntimeLifecycleSnapshot;
};

export interface WorkspaceExtensionReconciliationResult {
  state: 'deferred' | 'superseded' | 'failed' | 'reconciled';
  refreshed: number;
  failed: number;
  error?: string;
}

// Extension refresh failures surface in two places — the persisted
// capabilities status and the `extensions_changed` broadcast — and the raw
// error can carry git credentials, ANSI/control sequences, or unbounded
// output. Sanitize once at the producer so both sinks stay safe.
const sanitizeExtensionsErrorMessage = (message: string): string =>
  redactUrlCredentials(stripAnsiAndControl(message)).slice(0, 500);

class ExtensionRuntimeRefreshError extends Error {
  constructor(
    readonly result: ServeWorkspaceExtensionsRefreshResult,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionRuntimeRefreshError';
  }
}

export class WorkspaceRuntimeStillStartingError extends Error {
  constructor() {
    super('Workspace runtime is still starting');
    this.name = 'WorkspaceRuntimeStillStartingError';
  }
}

export class WorkspaceRuntimeInitializationError extends Error {
  constructor(cause: unknown) {
    super('Workspace runtime failed to initialize', { cause });
    this.name = 'WorkspaceRuntimeInitializationError';
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new WorkspaceRuntimeStillStartingError()),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function supportsWorkspaceRuntimeLifecycle(
  bridge: AcpSessionBridge,
): bridge is LifecycleAcpSessionBridge {
  return typeof bridge.getWorkspaceRuntimeLifecycleSnapshot === 'function';
}

export class WorkspaceRuntimeCoordinator {
  private disposed = false;

  private draining = false;

  private activeManagementOperations = 0;

  private extensionsRevision = 0;

  private desiredExtensionGeneration = 0;

  private appliedExtensionGeneration = 0;

  private appliedExtensionRuntimeEpoch: number | undefined;

  private skillsRevision = 0;

  private mcpRevision = 0;

  private mcpConfigRevision = 0;

  private extensionsStatus: ServeWorkspaceRuntimeExtensionsCapabilityStatus = {
    state: 'not_started',
    revision: 0,
    desiredGeneration: 0,
    appliedGeneration: 0,
  };

  private skillsStatus: ServeWorkspaceRuntimeCapabilityStatus = {
    state: 'not_started',
    revision: 0,
  };

  private mcpStatus: ServeWorkspaceRuntimeCapabilityStatus = {
    state: 'not_started',
    revision: 0,
  };

  private skillsReconcileDeferred = false;

  private extensionsReconcileDeferred: { skillsOnly?: boolean } | undefined;

  private extensionsTail: Promise<void> = Promise.resolve();

  private extensionsQueuedWork = 0;

  private extensionsRefreshFailedRevision:
    | { revision: number; runtimeEpoch: number; failedAt: number }
    | undefined;

  private extensionsRefreshRetryRevision: number | undefined;

  private skillsRefreshRetryRevision: number | undefined;

  private skillsRefreshFailedRevision: number | undefined;

  private skillsTail: Promise<void> = Promise.resolve();

  private skillsQueuedWork = 0;

  private mcpReconcileDeferred = false;

  private mcpPhysicalTail: Promise<void> = Promise.resolve();

  private mcpQueuedWork = 0;

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly bridge: LifecycleAcpSessionBridge,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  cancelDrain(): void {
    if (this.disposed) return;
    this.draining = false;
    if (this.extensionsReconcileDeferred) {
      const options = this.extensionsReconcileDeferred;
      this.extensionsReconcileDeferred = undefined;
      void this.reconcileExtensionGeneration(
        this.desiredExtensionGeneration,
        options,
      ).catch(() => undefined);
    }
    if (this.skillsReconcileDeferred) {
      this.skillsReconcileDeferred = false;
      this.scheduleSkillsReconciliation();
    }
    if (this.mcpReconcileDeferred) {
      this.mcpReconcileDeferred = false;
      this.scheduleMcpReconciliation();
    }
  }

  hasActiveWork(): boolean {
    return (
      this.activeManagementOperations > 0 ||
      this.extensionsQueuedWork > 0 ||
      this.skillsQueuedWork > 0 ||
      this.mcpQueuedWork > 0 ||
      this.bridge.getWorkspaceRuntimeLifecycleSnapshot().activeWork
    );
  }

  dispose(): void {
    this.disposed = true;
    this.draining = true;
  }

  status(): ServeWorkspaceRuntimeStatus {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    const extensionsStatus =
      this.extensionsStatus.runtimeEpoch !== undefined &&
      (!snapshot.runtimeLive ||
        this.extensionsStatus.runtimeEpoch !== snapshot.runtimeEpoch)
        ? {
            state: 'stale' as const,
            revision: this.extensionsStatus.revision,
            runtimeEpoch: this.extensionsStatus.runtimeEpoch,
            desiredGeneration: this.extensionsStatus.desiredGeneration,
            appliedGeneration: this.extensionsStatus.appliedGeneration,
          }
        : this.extensionsStatus;
    const skillsStatus =
      this.skillsStatus.runtimeEpoch !== undefined &&
      (!snapshot.runtimeLive ||
        this.skillsStatus.runtimeEpoch !== snapshot.runtimeEpoch)
        ? {
            state: 'stale' as const,
            revision: this.skillsStatus.revision,
            runtimeEpoch: this.skillsStatus.runtimeEpoch,
          }
        : this.skillsStatus;
    const mcpStatus =
      this.mcpStatus.runtimeEpoch !== undefined &&
      (!snapshot.runtimeLive ||
        this.mcpStatus.runtimeEpoch !== snapshot.runtimeEpoch)
        ? {
            state: 'stale' as const,
            revision: this.mcpStatus.revision,
            runtimeEpoch: this.mcpStatus.runtimeEpoch,
          }
        : this.mcpStatus;
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: snapshot.state,
      runtimeLive: snapshot.runtimeLive,
      runtimeEpoch: snapshot.runtimeEpoch,
      capabilities: {
        extensions: {
          ...extensionsStatus,
          appliedGeneration:
            snapshot.runtimeLive &&
            this.appliedExtensionRuntimeEpoch === snapshot.runtimeEpoch
              ? this.appliedExtensionGeneration
              : 0,
        },
        mcp: mcpStatus,
        skills: skillsStatus,
      },
    };
  }

  async ensure(
    timeoutMs = DEFAULT_ENSURE_TIMEOUT_MS,
  ): Promise<ServeWorkspaceRuntimeStatus> {
    this.assertAcceptingWork();
    const deadline = Date.now() + timeoutMs;
    try {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        timeoutMs,
      );
    } catch (error) {
      this.assertAcceptingWork(error);
      if (error instanceof WorkspaceRuntimeStillStartingError) throw error;
      throw new WorkspaceRuntimeInitializationError(error);
    }
    this.assertAcceptingWork();
    const status = this.status();
    if (!status.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error('ACP preheat completed without a live runtime'),
      );
    }
    const extensionsReady =
      status.capabilities?.extensions?.state === 'ready' &&
      status.capabilities.extensions.runtimeEpoch === status.runtimeEpoch &&
      status.capabilities.extensions.appliedGeneration ===
        status.capabilities.extensions.desiredGeneration;
    if (!extensionsReady) {
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        try {
          await withTimeout(this.prepareExtensions(), remainingMs);
        } catch (error) {
          this.assertAcceptingWork(error);
        }
      }
    }
    const preparedStatus = this.status();
    const skillsReady =
      preparedStatus.capabilities?.skills?.state === 'ready' &&
      preparedStatus.capabilities.skills.runtimeEpoch ===
        preparedStatus.runtimeEpoch;
    const mcpReady =
      preparedStatus.capabilities?.mcp?.state === 'ready' &&
      preparedStatus.capabilities.mcp.runtimeEpoch ===
        preparedStatus.runtimeEpoch;
    if (skillsReady && mcpReady) {
      return preparedStatus;
    }
    const skillsRevision = this.skillsRevision;
    const mcpRevision = this.mcpRevision;
    const skillsPrep = skillsReady ? Promise.resolve() : this.prepareSkills();
    void skillsPrep.catch((error: unknown) => {
      this.recordSkillsError(
        skillsRevision,
        preparedStatus.runtimeEpoch,
        error,
      );
    });
    const mcpPrep = mcpReady ? Promise.resolve() : this.prepareMcp();
    void mcpPrep.catch((error: unknown) => {
      this.recordMcpError(mcpRevision, preparedStatus.runtimeEpoch, error);
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      try {
        await withTimeout(Promise.all([skillsPrep, mcpPrep]), remainingMs);
      } catch (error) {
        this.assertAcceptingWork(error);
        if (!(error instanceof WorkspaceRuntimeStillStartingError)) {
          throw new WorkspaceRuntimeInitializationError(error);
        }
      }
    }
    const finalStatus = this.status();
    if (!finalStatus.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error(
          'Workspace runtime stopped during Extensions/Skills/MCP preparation',
        ),
      );
    }
    return finalStatus;
  }

  async runManagementOperation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    this.activeManagementOperations += 1;
    try {
      return await run();
    } finally {
      this.activeManagementOperations -= 1;
    }
  }

  observeExtensionGeneration(
    generation: number,
    storeReadRevision?: number,
  ): void {
    if (generation === this.desiredExtensionGeneration) return;
    if (generation < this.desiredExtensionGeneration) {
      // Only a fresh store read may adopt automatic backup recovery. A late
      // operation receipt or a read overtaken by a mutation cannot roll back.
      if (storeReadRevision !== this.extensionsRevision) return;
      this.appliedExtensionGeneration = 0;
      this.appliedExtensionRuntimeEpoch = undefined;
    }
    this.runtime.workspaceService.invalidateWorkspaceSkillsStatus();
    this.desiredExtensionGeneration = generation;
    this.extensionsRevision += 1;
    this.extensionsRefreshFailedRevision = undefined;
    this.extensionsRefreshRetryRevision = undefined;
    this.extensionsStatus = {
      state:
        this.extensionsStatus.runtimeEpoch === undefined
          ? 'not_started'
          : 'stale',
      revision: this.extensionsRevision,
      desiredGeneration: generation,
      appliedGeneration: this.appliedExtensionGeneration,
      ...(this.extensionsStatus.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: this.extensionsStatus.runtimeEpoch }),
    };
  }

  async reconcileExtensionGeneration(
    generation: number,
    options: { skillsOnly?: boolean } = {},
  ): Promise<WorkspaceExtensionReconciliationResult> {
    this.observeExtensionGeneration(generation);
    if (generation < this.desiredExtensionGeneration) {
      return { state: 'superseded', refreshed: 0, failed: 0 };
    }
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      if (snapshot.runtimeLive && this.draining && !this.disposed) {
        this.deferExtensionsReconciliation(options);
      }
      return { state: 'deferred', refreshed: 0, failed: 0 };
    }
    const current = this.status().capabilities?.extensions;
    if (
      current?.state === 'ready' &&
      current.runtimeEpoch === snapshot.runtimeEpoch &&
      current.desiredGeneration === generation &&
      current.appliedGeneration === generation
    ) {
      return { state: 'reconciled', refreshed: 0, failed: 0 };
    }
    const revision = this.extensionsRevision;
    // The 30s poller selects an errored capability every cycle; bound its
    // re-drives of a latched failure by the same cooldown as the ensure path
    // so a permanently failing generation does not invalidate Skills/MCP on
    // every poll.
    if (
      current?.state === 'error' &&
      current.revision === revision &&
      this.isExtensionsFailureLatched(revision, snapshot.runtimeEpoch)
    ) {
      return {
        state: 'deferred',
        refreshed: 0,
        failed: 0,
        error: current.error?.message,
      };
    }
    const appliedGenerationBefore = this.appliedExtensionGeneration;
    const appliedEpochBefore = this.appliedExtensionRuntimeEpoch;
    let result: ServeWorkspaceExtensionsRefreshResult | undefined;
    try {
      result = await this.queueExtensionsWork(() =>
        this.prepareExtensionsRevision(revision, generation, options),
      );
    } catch (error) {
      if (this.draining && !this.disposed) {
        this.deferExtensionsReconciliation(options);
        return { state: 'deferred', refreshed: 0, failed: 0 };
      }
      if (
        revision !== this.extensionsRevision ||
        generation !== this.desiredExtensionGeneration
      ) {
        return { state: 'superseded', refreshed: 0, failed: 0 };
      }
      const refresh =
        error instanceof ExtensionRuntimeRefreshError
          ? error.result
          : undefined;
      return {
        state: 'failed',
        refreshed: refresh?.sessionsRefreshed ?? 0,
        failed:
          (refresh?.configsFailed ?? 0) +
          (refresh?.sessionsFailed ?? 0) +
          (refresh?.sessionsSkipped ?? (refresh ? 0 : 1)),
        error: sanitizeExtensionsErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    const status = this.status();
    const extensions = status.capabilities?.extensions;
    if (
      status.runtimeLive &&
      extensions?.state === 'ready' &&
      extensions.runtimeEpoch === status.runtimeEpoch &&
      revision === this.extensionsRevision &&
      generation === this.desiredExtensionGeneration &&
      this.appliedExtensionGeneration === generation
    ) {
      if (
        appliedGenerationBefore === this.appliedExtensionGeneration &&
        (revision === 0 ||
          appliedEpochBefore === this.appliedExtensionRuntimeEpoch)
      ) {
        this.afterExtensionApply(options);
      }
      return {
        state: 'reconciled',
        refreshed: result?.sessionsRefreshed ?? 0,
        failed: 0,
      };
    }
    return {
      state:
        generation !== this.desiredExtensionGeneration
          ? 'superseded'
          : 'deferred',
      refreshed: result?.sessionsRefreshed ?? 0,
      failed: 0,
      ...(extensions?.state === 'error'
        ? { error: extensions.error?.message }
        : {}),
    };
  }

  private deferExtensionsReconciliation(options: {
    skillsOnly?: boolean;
  }): void {
    this.extensionsReconcileDeferred = {
      skillsOnly:
        (this.extensionsReconcileDeferred?.skillsOnly ?? true) &&
        options.skillsOnly === true,
    };
  }

  reconcileSkillsConfiguration(): 'deferred' | 'reconciling' {
    this.skillsRevision += 1;
    this.skillsRefreshRetryRevision = undefined;
    this.skillsRefreshFailedRevision = undefined;
    return this.scheduleSkillsReconciliation();
  }

  private scheduleSkillsReconciliation(): 'deferred' | 'reconciling' {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.skillsReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      if (snapshot.state === 'starting') {
        this.skillsRefreshRetryRevision = this.skillsRevision;
      }
      this.skillsStatus = {
        state:
          this.skillsStatus.runtimeEpoch === undefined
            ? 'not_started'
            : 'stale',
        revision: this.skillsRevision,
        ...(this.skillsStatus.runtimeEpoch === undefined
          ? {}
          : { runtimeEpoch: this.skillsStatus.runtimeEpoch }),
      };
      return 'deferred';
    }
    const revision = this.skillsRevision;
    this.skillsStatus = {
      state: 'starting',
      revision,
      runtimeEpoch: snapshot.runtimeEpoch,
    };
    void this.queueSkillsWork(async () => {
      if (revision !== this.skillsRevision) return;
      await this.refreshSkillsRevision(revision);
      await this.prepareSkillsRevision(revision);
    }).catch((error: unknown) => {
      if (this.draining && !this.disposed) this.skillsReconcileDeferred = true;
      if (
        !this.draining &&
        !this.disposed &&
        revision === this.skillsRevision
      ) {
        this.skillsRefreshRetryRevision = revision;
      }
      this.recordSkillsError(revision, snapshot.runtimeEpoch, error);
    });
    return 'reconciling';
  }

  reconcileMcpConfiguration(): 'deferred' | 'reconciling' {
    this.mcpRevision += 1;
    this.mcpConfigRevision += 1;
    return this.scheduleMcpReconciliation();
  }

  private scheduleMcpReconciliation(): 'deferred' | 'reconciling' {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.mcpReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      this.mcpStatus = {
        state:
          this.mcpStatus.runtimeEpoch === undefined ? 'not_started' : 'stale',
        revision: this.mcpRevision,
        ...(this.mcpStatus.runtimeEpoch === undefined
          ? {}
          : { runtimeEpoch: this.mcpStatus.runtimeEpoch }),
      };
      return 'deferred';
    }
    this.mcpStatus = {
      state: 'starting',
      revision: this.mcpRevision,
      runtimeEpoch: snapshot.runtimeEpoch,
    };
    const revision = this.mcpRevision;
    const configRevision = this.mcpConfigRevision;
    void this.queueMcpWork(async () => {
      if (configRevision !== this.mcpConfigRevision) return;
      await this.bridge.reloadWorkspaceMcp();
      await this.prepareMcpRevision(revision);
    }).catch((error: unknown) => {
      if (this.draining && !this.disposed) this.mcpReconcileDeferred = true;
      this.recordMcpError(revision, snapshot.runtimeEpoch, error);
    });
    return 'reconciling';
  }

  private prepareSkills(): Promise<void> {
    const revision = this.skillsRevision;
    return this.queueSkillsWork(async () => {
      const status = this.status();
      if (
        status.capabilities?.skills?.state === 'ready' &&
        status.capabilities.skills.runtimeEpoch === status.runtimeEpoch
      ) {
        return;
      }
      if (
        status.capabilities?.skills?.state === 'error' &&
        status.capabilities.skills.revision === revision &&
        status.capabilities.skills.runtimeEpoch === status.runtimeEpoch &&
        this.skillsRefreshFailedRevision === revision
      ) {
        return;
      }
      if (this.skillsRefreshRetryRevision === revision) {
        try {
          await this.refreshSkillsRevision(revision);
        } catch (error) {
          if (this.skillsRefreshRetryRevision === revision) {
            this.skillsRefreshRetryRevision = undefined;
          }
          this.skillsRefreshFailedRevision = revision;
          const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
          this.recordSkillsError(revision, snapshot.runtimeEpoch, error);
          return;
        }
      }
      await this.prepareSkillsRevision(revision);
    });
  }

  private prepareExtensions(): Promise<
    ServeWorkspaceExtensionsRefreshResult | undefined
  > {
    const revision = this.extensionsRevision;
    const generation = this.desiredExtensionGeneration;
    return this.queueExtensionsWork(async () => {
      const status = this.status();
      const extensions = status.capabilities?.extensions;
      if (
        extensions?.state === 'ready' &&
        extensions.runtimeEpoch === status.runtimeEpoch &&
        extensions.desiredGeneration === generation &&
        extensions.appliedGeneration === generation
      ) {
        return undefined;
      }
      // A revision that already failed is retried from the ensure path only
      // after the failure cooldown; an observed generation move or a
      // certifying success clears the marker early. Mirror of the Skills
      // guard.
      if (
        extensions?.state === 'error' &&
        extensions.revision === revision &&
        this.isExtensionsFailureLatched(revision, status.runtimeEpoch)
      ) {
        return undefined;
      }
      return this.prepareExtensionsRevision(revision, generation);
    });
  }

  private async prepareExtensionsRevision(
    revision: number,
    generation: number,
    options: { skillsOnly?: boolean } = {},
  ): Promise<ServeWorkspaceExtensionsRefreshResult | undefined> {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) return;
    const runtimeEpoch = snapshot.runtimeEpoch;
    if (
      revision !== this.extensionsRevision ||
      generation !== this.desiredExtensionGeneration
    ) {
      return;
    }
    if (this.isExtensionsFailureLatched(revision, runtimeEpoch)) return;
    this.extensionsStatus = {
      state: 'starting',
      revision,
      runtimeEpoch,
      desiredGeneration: generation,
      appliedGeneration: this.appliedExtensionGeneration,
    };
    try {
      const result =
        await this.bridge.invokeWorkspaceCommand<ServeWorkspaceExtensionsRefreshResult>(
          SERVE_CONTROL_EXT_METHODS.workspaceExtensionsReconcile,
          {
            cwd: this.runtime.workspaceCwd,
            ...(options.skillsOnly ? { skillsOnly: true } : {}),
          },
          { timeoutMs: EXTENSIONS_RECONCILE_TIMEOUT_MS },
        );
      if (
        result.configsFailed > 0 ||
        result.sessionsFailed > 0 ||
        (result.sessionsSkipped ?? 0) > 0
      ) {
        const details = [
          ...(result.configErrors ?? []),
          ...(result.sessionErrors ?? []).map((entry) => entry.error),
        ];
        throw new ExtensionRuntimeRefreshError(
          result,
          `Extension runtime refresh failed${
            details[0] ? `: ${details[0]}` : ''
          }`,
        );
      }
      const catalog =
        await this.runtime.workspaceService.getWorkspaceExtensionsStatus({
          route: 'workspace runtime Extension preparation',
          workspaceCwd: this.runtime.workspaceCwd,
        });
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (
        revision !== this.extensionsRevision ||
        generation !== this.desiredExtensionGeneration
      ) {
        return;
      }
      if (
        this.draining ||
        !current.runtimeLive ||
        current.runtimeEpoch !== runtimeEpoch
      ) {
        if (
          this.draining &&
          !this.disposed &&
          current.runtimeLive &&
          current.runtimeEpoch === runtimeEpoch
        ) {
          this.deferExtensionsReconciliation(options);
        }
        this.extensionsStatus = {
          state: 'stale',
          revision,
          runtimeEpoch,
          desiredGeneration: generation,
          appliedGeneration: this.appliedExtensionGeneration,
        };
        return;
      }
      if (catalog.runtimeEpoch !== runtimeEpoch) {
        throw new Error(
          'Extension runtime returned a stale or uninitialized catalog',
        );
      }
      if (catalog.errors?.length) {
        throw new Error(
          catalog.errors[0]?.error ??
            'Extension runtime did not return a live snapshot',
        );
      }
      if (!catalog.initialized) {
        throw new Error(
          'Extension runtime returned a stale or uninitialized catalog',
        );
      }
      if (revision === this.extensionsRefreshRetryRevision) {
        this.extensionsRefreshRetryRevision = undefined;
      }
      if (this.extensionsRefreshFailedRevision?.revision === revision) {
        this.extensionsRefreshFailedRevision = undefined;
      }
      // A skill refresh cannot certify an earlier failed full refresh: the
      // narrow reconcile skipped refreshTools, MCP discovery, and the command
      // update for generations the runtime never fully applied.
      const certifiesGeneration =
        !options.skillsOnly ||
        (this.appliedExtensionRuntimeEpoch === runtimeEpoch &&
          (this.appliedExtensionGeneration === generation - 1 ||
            this.appliedExtensionGeneration === generation));
      const advancesGeneration =
        certifiesGeneration &&
        (this.appliedExtensionGeneration !== generation ||
          // Initial ensure prepares Skills/MCP itself; a later certification
          // reset (including Store recovery to zero) must invalidate them.
          (revision > 0 && this.appliedExtensionRuntimeEpoch !== runtimeEpoch));
      if (certifiesGeneration) {
        this.appliedExtensionGeneration = generation;
        this.appliedExtensionRuntimeEpoch = runtimeEpoch;
      }
      if (advancesGeneration) {
        this.afterExtensionApply(options);
      }
      this.extensionsStatus = certifiesGeneration
        ? {
            state: 'ready',
            revision,
            runtimeEpoch,
            desiredGeneration: generation,
            appliedGeneration: generation,
          }
        : {
            state: 'stale',
            revision,
            runtimeEpoch,
            desiredGeneration: generation,
            appliedGeneration: this.appliedExtensionGeneration,
          };
      return result;
    } catch (error) {
      this.recordExtensionsError(revision, runtimeEpoch, error);
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (
        !this.draining &&
        !this.disposed &&
        current.runtimeLive &&
        current.runtimeEpoch === runtimeEpoch &&
        revision === this.extensionsRevision &&
        generation === this.desiredExtensionGeneration
      ) {
        this.afterExtensionApply(options);
      }
      throw error;
    }
  }

  private async refreshSkillsRevision(revision: number): Promise<void> {
    const result =
      await this.bridge.invokeWorkspaceCommand<ServeWorkspaceSkillsRefreshResult>(
        SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
        { cwd: this.runtime.workspaceCwd, reason: 'all' },
      );
    if ((result.configsFailed ?? 0) > 0) {
      throw new Error('Skills runtime refresh failed');
    }
    if (revision === this.skillsRefreshRetryRevision) {
      this.skillsRefreshRetryRevision = undefined;
    }
  }

  async runMcpRuntimeMutation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    const revision = ++this.mcpRevision;
    const initial = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    this.mcpStatus = {
      state: initial.runtimeLive ? 'starting' : 'not_started',
      revision,
      ...(initial.runtimeLive ? { runtimeEpoch: initial.runtimeEpoch } : {}),
    };
    let started = false;
    const operation = this.queueMcpWork(async () => {
      started = true;
      let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      let mutationRejected = false;
      try {
        if (!snapshot.runtimeLive) {
          try {
            await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
          } catch (error) {
            if (error instanceof WorkspaceRuntimeStillStartingError)
              throw error;
            throw new WorkspaceRuntimeInitializationError(error);
          }
          snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
          if (!snapshot.runtimeLive) {
            throw new WorkspaceRuntimeInitializationError(
              new Error('ACP preheat completed without a live runtime'),
            );
          }
        }
        if (revision === this.mcpRevision) {
          this.mcpStatus = {
            state: 'starting',
            revision,
            runtimeEpoch: snapshot.runtimeEpoch,
          };
        }
        let result: T;
        try {
          result = await run();
        } catch (error) {
          mutationRejected = true;
          void this.queueMcpWork(() => this.prepareMcpRevision(revision)).catch(
            (prepareError: unknown) => {
              this.recordMcpError(
                revision,
                snapshot.runtimeEpoch,
                prepareError,
              );
            },
          );
          throw error;
        }
        await this.prepareMcpRevision(revision);
        return result;
      } catch (error) {
        if (!mutationRejected) {
          this.recordMcpError(revision, snapshot.runtimeEpoch, error);
        }
        throw error;
      }
    });
    try {
      return await operation;
    } catch (error) {
      if (!started) {
        if (this.draining && !this.disposed) this.mcpReconcileDeferred = true;
        this.recordMcpError(revision, initial.runtimeEpoch, error);
      }
      throw error;
    }
  }

  private prepareMcp(): Promise<void> {
    const revision = this.mcpRevision;
    return this.queueMcpWork(() => this.prepareMcpRevision(revision));
  }

  private queueSkillsWork<T>(run: () => Promise<T>): Promise<T> {
    this.skillsQueuedWork += 1;
    const operation = this.skillsTail
      .catch(() => undefined)
      .then(async () => {
        this.assertAcceptingWork();
        return await run();
      })
      .finally(() => {
        this.skillsQueuedWork -= 1;
      });
    this.skillsTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private queueExtensionsWork<T>(run: () => Promise<T>): Promise<T> {
    this.extensionsQueuedWork += 1;
    const operation = this.extensionsTail
      .catch(() => undefined)
      .then(async () => {
        this.assertAcceptingWork();
        return await run();
      })
      .finally(() => {
        this.extensionsQueuedWork -= 1;
      });
    this.extensionsTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private queueMcpWork<T>(run: () => Promise<T>): Promise<T> {
    this.mcpQueuedWork += 1;
    const operation = this.mcpPhysicalTail
      .catch(() => undefined)
      .then(async () => {
        this.assertAcceptingWork();
        return await run();
      })
      .finally(() => {
        this.mcpQueuedWork -= 1;
      });
    this.mcpPhysicalTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async prepareSkillsRevision(revision: number): Promise<void> {
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        DEFAULT_ENSURE_TIMEOUT_MS,
      );
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const runtimeEpoch = snapshot.runtimeEpoch;
    if (revision !== this.skillsRevision) return;
    this.skillsStatus = { state: 'starting', revision, runtimeEpoch };
    try {
      this.runtime.workspaceService.invalidateWorkspaceSkillsStatus();
      const status =
        await this.runtime.workspaceService.getWorkspaceSkillsRuntimeStatus({
          route: 'workspace runtime Skills preparation',
          workspaceCwd: this.runtime.workspaceCwd,
        });
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.skillsRevision) return;
      if (
        this.draining ||
        !current.runtimeLive ||
        current.runtimeEpoch !== runtimeEpoch ||
        status.runtimeEpoch !== runtimeEpoch
      ) {
        this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
        return;
      }
      if (status.errors?.length) {
        throw new Error(
          status.errors?.[0]?.error ??
            'Skills runtime did not return a live snapshot',
        );
      }
      if (!status.initialized) {
        this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
        return;
      }
      this.skillsStatus = { state: 'ready', revision, runtimeEpoch };
    } catch (error) {
      this.recordSkillsError(revision, runtimeEpoch, error);
    }
  }

  private async prepareMcpRevision(revision: number): Promise<void> {
    const deadline = Date.now() + MCP_PREPARE_TIMEOUT_MS;
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      try {
        await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
      } catch (error) {
        if (error instanceof WorkspaceRuntimeStillStartingError) throw error;
        throw new WorkspaceRuntimeInitializationError(error);
      }
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const epoch = snapshot.runtimeEpoch;
    if (revision !== this.mcpRevision) return;
    this.mcpStatus = { state: 'starting', revision, runtimeEpoch: epoch };
    try {
      let status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
        route: 'workspace runtime MCP preparation',
        workspaceCwd: this.runtime.workspaceCwd,
      });
      let initializationRequested = false;
      while (true) {
        if (revision !== this.mcpRevision) return;
        const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
        if (
          this.draining ||
          this.disposed ||
          !current.runtimeLive ||
          current.runtimeEpoch !== epoch
        ) {
          if (
            this.draining &&
            !this.disposed &&
            current.runtimeLive &&
            current.runtimeEpoch === epoch
          ) {
            this.mcpReconcileDeferred = true;
          }
          this.mcpStatus = { state: 'stale', revision, runtimeEpoch: epoch };
          return;
        }
        const currentEpochStatus =
          status.runtimeEpoch === epoch && status.source === 'live';
        if (
          currentEpochStatus &&
          status.discoveryState === 'not_started' &&
          !initializationRequested
        ) {
          initializationRequested = true;
          await this.bridge.initializeWorkspaceMcp();
        }
        if (currentEpochStatus && status.errors?.length) {
          throw new Error(
            status.errors[0]?.error ?? 'MCP discovery failed to initialize',
          );
        }
        if (currentEpochStatus && status.discoveryState === 'completed') break;
        if (Date.now() >= deadline) {
          throw new WorkspaceRuntimeStillStartingError();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, MCP_POLL_INTERVAL_MS);
          timer.unref?.();
        });
        status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
          route: 'workspace runtime MCP preparation',
          workspaceCwd: this.runtime.workspaceCwd,
        });
      }
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.mcpRevision) return;
      if (!current.runtimeLive || current.runtimeEpoch !== epoch) {
        this.mcpStatus = { state: 'stale', revision, runtimeEpoch: epoch };
        return;
      }
      this.mcpStatus = { state: 'ready', revision, runtimeEpoch: epoch };
    } catch (error) {
      this.recordMcpError(revision, epoch, error);
    }
  }

  private recordSkillsError(
    revision: number,
    runtimeEpoch: number,
    error: unknown,
  ): void {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.skillsRevision) return;
    if (
      this.draining ||
      !current.runtimeLive ||
      current.runtimeEpoch !== runtimeEpoch
    ) {
      this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
      return;
    }
    this.skillsStatus = {
      state: 'error',
      revision,
      runtimeEpoch,
      error: {
        code: 'skills_prepare_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Every Extension apply, including partial failure on either the
  // mutation/poller reconcile or ensure-path prepare, invalidates and
  // reschedules the capabilities derived from it, so a ready Skills/MCP
  // status never certifies revisions that predate the applied generation.
  private afterExtensionApply(options: { skillsOnly?: boolean } = {}): void {
    this.invalidateDerivedCapabilities(options);
    this.scheduleSkillsReconciliation();
    if (!options.skillsOnly) {
      this.scheduleMcpReconciliation();
    }
  }

  private isExtensionsFailureLatched(
    revision: number,
    runtimeEpoch: number,
  ): boolean {
    const latched = this.extensionsRefreshFailedRevision;
    return (
      latched !== undefined &&
      latched.revision === revision &&
      latched.runtimeEpoch === runtimeEpoch &&
      Date.now() - latched.failedAt < EXTENSIONS_ERROR_RETRY_COOLDOWN_MS
    );
  }

  private invalidateDerivedCapabilities(
    options: { skillsOnly?: boolean } = {},
  ): void {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    this.skillsRevision += 1;
    this.skillsStatus = {
      state:
        this.skillsStatus.runtimeEpoch === undefined ? 'not_started' : 'stale',
      revision: this.skillsRevision,
      ...(this.skillsStatus.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: this.skillsStatus.runtimeEpoch }),
    };
    this.skillsReconcileDeferred ||= snapshot.runtimeLive && this.draining;
    // A skills-only refresh cannot change MCP config; leave the MCP
    // capability and its reconciliation coalescing untouched.
    if (options.skillsOnly) return;
    this.mcpRevision += 1;
    this.mcpConfigRevision += 1;
    this.mcpStatus = {
      state:
        this.mcpStatus.runtimeEpoch === undefined ? 'not_started' : 'stale',
      revision: this.mcpRevision,
      ...(this.mcpStatus.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: this.mcpStatus.runtimeEpoch }),
    };
    this.mcpReconcileDeferred ||= snapshot.runtimeLive && this.draining;
  }

  private recordExtensionsError(
    revision: number,
    runtimeEpoch: number,
    error: unknown,
  ): void {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.extensionsRevision) return;
    if (
      this.draining ||
      !current.runtimeLive ||
      current.runtimeEpoch !== runtimeEpoch
    ) {
      this.extensionsStatus = {
        state: 'stale',
        revision,
        runtimeEpoch,
        desiredGeneration: this.desiredExtensionGeneration,
        appliedGeneration: this.appliedExtensionGeneration,
      };
      return;
    }
    this.extensionsStatus = {
      state: 'error',
      revision,
      runtimeEpoch,
      desiredGeneration: this.desiredExtensionGeneration,
      appliedGeneration: this.appliedExtensionGeneration,
      error: {
        code: 'extensions_prepare_failed',
        message: sanitizeExtensionsErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      },
    };
    // One failed refresh is retried once from the ensure path; the latch
    // closes only when that retry fails too. Mirror of the Skills markers.
    if (
      this.extensionsRefreshRetryRevision === revision ||
      (this.extensionsRefreshFailedRevision?.revision === revision &&
        this.extensionsRefreshFailedRevision.runtimeEpoch === runtimeEpoch)
    ) {
      this.extensionsRefreshRetryRevision = undefined;
      this.extensionsRefreshFailedRevision = {
        revision,
        runtimeEpoch,
        failedAt: Date.now(),
      };
    } else {
      this.extensionsRefreshRetryRevision = revision;
    }
  }

  private recordMcpError(
    revision: number,
    runtimeEpoch: number,
    error: unknown,
  ): void {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.mcpRevision) return;
    if (
      this.draining ||
      !current.runtimeLive ||
      current.runtimeEpoch !== runtimeEpoch
    ) {
      this.mcpStatus = { state: 'stale', revision, runtimeEpoch };
      return;
    }
    this.mcpStatus = {
      state: 'error',
      revision,
      runtimeEpoch,
      error: {
        code:
          error instanceof WorkspaceRuntimeStillStartingError
            ? 'mcp_prepare_timed_out'
            : 'mcp_prepare_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  private assertAcceptingWork(cause?: unknown): void {
    this.runtime.generationGuard?.assertOpen();
    if (this.disposed || this.draining) {
      throw new WorkspaceDrainingError(this.runtime.workspaceCwd, cause);
    }
  }
}

export function getWorkspaceRuntimeCoordinatorIfSupported(
  runtime: WorkspaceRuntime,
): WorkspaceRuntimeCoordinator | undefined {
  if (!supportsWorkspaceRuntimeLifecycle(runtime.bridge)) return undefined;
  runtime.runtimeCoordinator ??= new WorkspaceRuntimeCoordinator(
    runtime,
    runtime.bridge,
  );
  return runtime.runtimeCoordinator;
}

export function getWorkspaceRuntimeCoordinator(
  runtime: WorkspaceRuntime,
): WorkspaceRuntimeCoordinator {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (!coordinator) {
    throw new Error('Workspace runtime lifecycle is not supported');
  }
  return coordinator;
}
