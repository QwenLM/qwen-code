/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DaemonWorkspaceService facade factory.
 *
 * Public entry point exposing workspace-scoped methods: status queries,
 * tool toggle, init, and MCP server restart. Status/mutation work is
 * delegated to the ACP child through injected callbacks so the facade
 * takes no direct reference to the bridge.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

import {
  SERVE_STATUS_EXT_METHODS,
  SERVE_CONTROL_EXT_METHODS,
  BridgeChannelClosedError,
  STATUS_SCHEMA_VERSION,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceSkillsStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  createIdleEnvStatus,
  createIdleAcpPreflightCells,
  mapDomainErrorToErrorKind,
  type ServeWorkspacePreflightStatus,
  type ServeWorkspaceSkillsRefreshResult,
  type ServeWorkspaceSkillsStatus,
} from '@qwen-code/acp-bridge/status';

import {
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitConflictError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionNotFoundError,
} from '@qwen-code/acp-bridge/bridgeErrors';

import { MCP_RESTART_SERVER_DEADLINE_MS } from '@qwen-code/acp-bridge/mcpTimeouts';

import { loadSettings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { buildPermissionSettings } from '../../config/permission-settings.js';
import {
  buildWorkspaceVoiceSettingsWrites,
  buildWorkspaceVoiceStatus,
  validateWorkspaceVoiceState,
  voiceSettingsScopeToWire,
  WorkspaceVoiceError,
  type WorkspaceVoiceSettingsWrite,
} from '../../services/voice-service.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

import {
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSkillNotFoundError,
  WorkspaceSkillNotToggleableError,
  WorkspaceSettingsPartialPersistError,
} from './types.js';
import type {
  DaemonWorkspaceService,
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
  RestartMcpServerResult,
  WorkspaceTrustChangeRequest,
  WorkspacePermissionRulesUpdate,
  WorkspaceVoiceSettingsUpdate,
  WorkspaceAcpPreheatResult,
  WorkspaceAcpStatusResult,
  WorkspaceSkillToggleResult,
} from './types.js';

// Re-export types for consumers.
export type {
  DaemonWorkspaceService,
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
  RestartMcpServerResult,
  WorkspaceTrustChangeRequest,
  WorkspaceTrustChangeResult,
  WorkspaceTrustDesiredState,
  WorkspacePermissionRulesUpdate,
  WorkspaceVoiceSettingsUpdate,
  WorkspaceAcpPreheatResult,
  WorkspaceAcpStatusResult,
  WorkspaceSkillToggleResult,
  WorkspaceSkillToggleActivation,
  EnvReloadResult,
  ReloadResponse,
} from './types.js';

export {
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSkillNotFoundError,
  WorkspaceSkillNotToggleableError,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `inputPath` until we find an ancestor that exists on disk,
 * then `realpath` it. Used by `initWorkspace` to canonicalize the parent
 * chain before writing, so a symlinked intermediate directory can't
 * redirect the write outside the workspace.
 */
async function canonicalizeExistingAncestor(
  inputPath: string,
): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * Post-open parent re-verification. After a successful `fs.open(..., 'wx')`
 * or `O_NOFOLLOW` open, re-canonicalize the parent directory and verify it
 * still resolves within the workspace. Closes the TOCTOU window between
 * the pre-open canonicalize and the open. On failure, closes the fd
 * (for creates) and throws `WorkspaceInitSymlinkError`.
 */
async function verifyParentPostOpen(
  target: string,
  wsCanonical: string,
  _fh: import('node:fs/promises').FileHandle,
): Promise<void> {
  const parentCanonical = await canonicalizeExistingAncestor(
    path.dirname(target),
  );
  const within =
    parentCanonical === wsCanonical ||
    parentCanonical.startsWith(wsCanonical + path.sep);
  if (within) return;
  // Do NOT close fh here — the caller's `finally` block handles it.
  // Closing here would cause a double-close on Node 22+ (ERR_INVALID_STATE).
  throw new WorkspaceInitSymlinkError(
    target,
    'parent',
    `Workspace context file ${JSON.stringify(target)}'s parent moved ` +
      `outside the workspace between the pre-open canonicalize and ` +
      `the post-open verify (parent canonicalizes to ${JSON.stringify(parentCanonical)}, ` +
      `workspace canonicalizes to ${JSON.stringify(wsCanonical)}). ` +
      `Refusing to write — investigate the concurrent writer or the ` +
      `parent-directory permissions.`,
  );
}

class TimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaemonWorkspaceService(
  deps: DaemonWorkspaceServiceDeps,
): DaemonWorkspaceService {
  const {
    boundWorkspace,
    contextFilename,
    statusProvider,
    workspaceProvidersStatusProvider,
    workspaceSkillsStatusProvider,
    isChannelLive,
    persistDisabledTools,
    persistDisabledSkills,
    persistSetting,
    persistSettings,
    voiceEnv,
    voiceSettingsScope,
    preheatAcpChild: preheatAcpChildOnBridge,
    queryWorkspaceStatus,
    invokeWorkspaceCommand,
    refreshExtensionsForAllSessions: refreshExtensionsForAllSessionsOnBridge,
    publishWorkspaceEvent,
  } = deps;

  // Last skills status answered by a live ACP child, retained so
  // skill-backed slash commands (e.g. `/review`) keep autocompleting after
  // the child channel has been reaped. See `getWorkspaceSkillsStatus`.
  let lastWorkspaceSkillsStatus: ServeWorkspaceSkillsStatus | undefined;
  let inFlightAcpPreheat: Promise<void> | undefined;

  const getWorkspaceSkillsStatus =
    async (): Promise<ServeWorkspaceSkillsStatus> => {
      let status: ServeWorkspaceSkillsStatus;
      try {
        status = await queryWorkspaceStatus(
          SERVE_STATUS_EXT_METHODS.workspaceSkills,
          () => createIdleWorkspaceSkillsStatus(boundWorkspace),
        );
      } catch (err) {
        // The channel can die mid-RPC (`liveChannelInfo()` was valid at the
        // check but the child exited before the call completed). Treat that
        // like "no live child" and fall back to the cache / daemon-local
        // enumeration below instead of failing the request — matching
        // getWorkspaceEnvStatus / getWorkspacePreflightStatus.
        writeStderrLine(
          `qwen serve: getWorkspaceSkillsStatus query failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        status = createIdleWorkspaceSkillsStatus(boundWorkspace);
      }
      if (status.initialized) {
        lastWorkspaceSkillsStatus = status;
        return status;
      }
      // Live child unavailable. Prefer the last answer it produced (keeps the
      // full, extension-aware list available across a reap)...
      if (lastWorkspaceSkillsStatus) return lastWorkspaceSkillsStatus;
      // ...then fall back to daemon-local enumeration, so a child that has not
      // answered even once (e.g. a preheat that times out under `npm run dev`)
      // still yields the on-disk skills — `/review` included. The provider
      // handles its own errors, but it is injected, so guard the call too and
      // degrade to the idle placeholder rather than failing the request —
      // matching getWorkspaceEnvStatus / getWorkspacePreflightStatus.
      if (workspaceSkillsStatusProvider) {
        try {
          return await workspaceSkillsStatusProvider(boundWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: getWorkspaceSkillsStatus local provider failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return status;
    };

  // -- Facade --
  return {
    // -- Status queries (delegate to ACP child via queryWorkspaceStatus) --

    async getWorkspaceMcpStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceMcp, () =>
        createIdleWorkspaceMcpStatus(boundWorkspace),
      );
    },

    async getWorkspaceSkillsStatus(_ctx: WorkspaceRequestContext) {
      // Skills are enumerated by the ACP child, which owns the live
      // SkillManager (including extension-provided skills). `queryWorkspaceStatus`
      // returns the idle placeholder (`initialized: false`, empty `skills`)
      // whenever no child channel is live — before the first session, after
      // the child is reaped on session close (`--channel-idle-timeout-ms`
      // defaults to an immediate kill), and when a cold-start preheat times
      // out before the child ever answers. In those windows the Web Shell's
      // pre-first-prompt slash-command list would otherwise drop every skill,
      // so `/rev` stops autocompleting `/review`. `initialized` cleanly
      // separates a real child answer (always `true`) from the placeholder.
      return getWorkspaceSkillsStatus();
    },

    async getWorkspaceProvidersStatus(_ctx: WorkspaceRequestContext) {
      if (workspaceProvidersStatusProvider) {
        return workspaceProvidersStatusProvider(
          boundWorkspace,
          isChannelLive?.() ?? false,
        );
      }
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace),
      );
    },

    async preheatAcpChild(
      _ctx: WorkspaceRequestContext,
      opts?: { timeoutMs?: number },
    ): Promise<WorkspaceAcpPreheatResult> {
      const startedAt = Date.now();
      const channelLive = () => isChannelLive?.() ?? false;
      const finish = (
        result: Omit<WorkspaceAcpPreheatResult, 'durationMs'>,
      ): WorkspaceAcpPreheatResult => ({
        ...result,
        durationMs: Date.now() - startedAt,
      });

      if (channelLive()) {
        return finish({ ready: true, channelLive: true });
      }
      if (!preheatAcpChildOnBridge) {
        return finish({
          ready: false,
          channelLive: false,
          reason: 'error',
          error: 'ACP preheat is not wired',
        });
      }

      if (!inFlightAcpPreheat) {
        inFlightAcpPreheat = preheatAcpChildOnBridge().finally(() => {
          inFlightAcpPreheat = undefined;
        });
        void inFlightAcpPreheat.catch((err) => {
          writeStderrLine(
            `qwen serve: ACP preheat failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      try {
        await withTimeout(
          inFlightAcpPreheat,
          opts?.timeoutMs ?? 5_000,
          'ACP preheat',
        );
      } catch (err) {
        if (err instanceof TimeoutError) {
          inFlightAcpPreheat = undefined;
          writeStderrLine(
            `qwen serve: ACP preheat timed out after ${opts?.timeoutMs ?? 5_000}ms`,
          );
        }
        const live = channelLive();
        const message = err instanceof Error ? err.message : String(err);
        return finish({
          ready: live,
          channelLive: live,
          reason: err instanceof TimeoutError ? 'timeout' : 'error',
          error: message,
        });
      }

      const live = channelLive();
      return finish({ ready: live, channelLive: live });
    },

    async getWorkspaceAcpStatus(
      _ctx: WorkspaceRequestContext,
    ): Promise<WorkspaceAcpStatusResult> {
      return { channelLive: isChannelLive?.() ?? false };
    },

    async getWorkspaceEnvStatus(_ctx: WorkspaceRequestContext) {
      // Env status is answered daemon-locally from process state — no ACP
      // query needed. The old bridge used statusProvider.getEnvStatus()
      // directly; replicate that behavior here.
      const acpChannelLive = isChannelLive?.() ?? false;
      if (!statusProvider) {
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
      try {
        return await statusProvider.getEnvStatus(
          boundWorkspace,
          acpChannelLive,
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: getEnvStatus failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
    },

    async getWorkspacePreflightStatus(_ctx: WorkspaceRequestContext) {
      // Preflight stitches two halves:
      // 1. Daemon cells from statusProvider.getDaemonPreflightCells() — always local
      // 2. ACP cells from queryWorkspaceStatus (live ACP child) or idle placeholders
      const acpChannelLive = isChannelLive?.() ?? false;
      const idleCells = createIdleAcpPreflightCells();

      // Get daemon cells (local, no ACP query).
      let daemonCells: ServeWorkspacePreflightStatus['cells'] = [];
      if (statusProvider) {
        try {
          daemonCells =
            await statusProvider.getDaemonPreflightCells(boundWorkspace);
        } catch (err) {
          // Daemon cells failing is non-fatal; proceed with empty.
          writeStderrLine(
            `qwen serve: getDaemonPreflightCells failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Get ACP cells — either from live child or idle placeholders.
      let acpCells: ServeWorkspacePreflightStatus['cells'] = idleCells;
      let errors: ServeWorkspacePreflightStatus['errors'] | undefined;

      if (acpChannelLive) {
        try {
          const acpResult = await queryWorkspaceStatus(
            SERVE_STATUS_EXT_METHODS.workspacePreflight,
            () => ({ cells: idleCells }),
          );
          // The ACP response may contain only ACP-locality cells.
          if (acpResult && 'cells' in acpResult) {
            const result = acpResult as {
              cells: ServeWorkspacePreflightStatus['cells'];
              errors?: ServeWorkspacePreflightStatus['errors'];
            };
            // Filter to only ACP cells from the ACP response (daemon cells come from our provider).
            acpCells = result.cells.filter((c) => c.locality !== 'daemon');
            errors = result.errors;
          }
        } catch (err) {
          // ACP query failed — fall back to idle placeholders and report error.
          acpCells = idleCells;
          const errorKind = mapDomainErrorToErrorKind(err);
          errors = [
            {
              kind: 'preflight',
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
              ...(errorKind ? { errorKind } : {}),
            },
          ];
        }
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        acpChannelLive,
        cells: [...daemonCells, ...acpCells],
        ...(errors && errors.length > 0 ? { errors } : {}),
      } as ServeWorkspacePreflightStatus;
    },

    async getWorkspaceHooksStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceHooks, () =>
        createIdleWorkspaceHooksStatus(boundWorkspace),
      );
    },

    async getWorkspaceExtensionsStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceExtensions,
        () => createIdleWorkspaceExtensionsStatus(boundWorkspace),
      );
    },

    async getWorkspaceTrustStatus(_ctx: WorkspaceRequestContext) {
      return getWorkspaceTrustStatus(
        loadSettings(boundWorkspace).merged,
        boundWorkspace,
      );
    },

    async getWorkspacePermissionsStatus(_ctx: WorkspaceRequestContext) {
      return buildPermissionSettings(loadSettings(boundWorkspace));
    },

    async getWorkspaceVoiceStatus(_ctx: WorkspaceRequestContext) {
      return buildWorkspaceVoiceStatus(
        boundWorkspace,
        loadSettings(
          boundWorkspace,
          voiceEnv ? { skipLoadEnvironment: true } : true,
        ),
      );
    },

    // -- Mutations --

    async requestWorkspaceTrustChange(
      ctx: WorkspaceRequestContext,
      request: WorkspaceTrustChangeRequest,
    ) {
      publishWorkspaceEvent({
        type: 'trust_change_requested',
        data: {
          workspaceCwd: boundWorkspace,
          desiredState: request.desiredState,
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
        },
        originatorClientId: ctx.originatorClientId,
      });
      return {
        accepted: false,
        desiredState: request.desiredState,
        requiresOperatorAction: true,
      };
    },

    async setWorkspacePermissionRules(
      ctx: WorkspaceRequestContext,
      request: WorkspacePermissionRulesUpdate,
    ) {
      const key = `permissions.${request.ruleType}`;
      try {
        const result = await invokeWorkspaceCommand(
          'qwen/permissions/setRules',
          {
            cwd: boundWorkspace,
            scope: request.scope,
            ruleType: request.ruleType,
            rules: request.rules,
          },
        );
        publishWorkspaceEvent({
          type: 'settings_changed',
          data: { key, value: request.rules, scope: request.scope },
          originatorClientId: ctx.originatorClientId,
        });
        return result as ReturnType<typeof buildPermissionSettings>;
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) {
          throw err;
        }
        throw new WorkspacePermissionRulesSessionRequiredError();
      }
    },

    async setWorkspaceVoiceSettings(
      ctx: WorkspaceRequestContext,
      request: WorkspaceVoiceSettingsUpdate,
    ) {
      if (!persistSettings && !persistSetting) {
        throw new WorkspaceVoiceError(
          501,
          'not_implemented',
          'Workspace voice settings persistence is not available',
        );
      }

      const settings = loadSettings(
        boundWorkspace,
        voiceEnv ? { skipLoadEnvironment: true } : true,
      );
      validateWorkspaceVoiceState(settings, request, { env: voiceEnv });
      const workspaceTrusted =
        getWorkspaceTrustStatus(settings.merged, boundWorkspace).effective
          .state === 'trusted';
      const writes = buildWorkspaceVoiceSettingsWrites(settings, request, {
        workspaceTrusted,
        ...(voiceSettingsScope ? { scopeOverride: voiceSettingsScope } : {}),
      });

      const publishWrite = (write: WorkspaceVoiceSettingsWrite) => {
        publishWorkspaceEvent({
          type: 'settings_changed',
          data: {
            key: write.key,
            value: write.value,
            scope: voiceSettingsScopeToWire(write.scope),
          },
          originatorClientId: ctx.originatorClientId,
        });
      };

      if (persistSettings) {
        try {
          await persistSettings(boundWorkspace, writes);
        } catch (err) {
          if (err instanceof WorkspaceSettingsPartialPersistError) {
            for (const write of err.committedWrites) {
              publishWrite(write);
            }
          }
          throw err;
        }
        for (const write of writes) {
          publishWrite(write);
        }
      } else {
        const committed: WorkspaceVoiceSettingsWrite[] = [];
        for (const write of writes) {
          try {
            await persistSetting!(
              boundWorkspace,
              write.scope,
              write.key,
              write.value,
            );
          } catch (err) {
            writeStderrLine(
              `qwen serve: workspace voice partial persist error (workspace=${boundWorkspace}, committed=${committed.length}/${writes.length}, failedKey=${write.key}, failedScope=${voiceSettingsScopeToWire(write.scope)}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            for (const committedWrite of committed) {
              publishWrite(committedWrite);
            }
            throw new WorkspaceSettingsPartialPersistError(
              `Voice settings partial persist failed: committed=${committed.length}/${writes.length}`,
              committed,
              err,
            );
          }
          committed.push(write);
        }
        for (const write of committed) {
          publishWrite(write);
        }
      }

      return buildWorkspaceVoiceStatus(
        boundWorkspace,
        loadSettings(
          boundWorkspace,
          voiceEnv ? { skipLoadEnvironment: true } : true,
        ),
      );
    },

    async setWorkspaceToolEnabled(
      ctx: WorkspaceRequestContext,
      toolName: string,
      enabled: boolean,
    ) {
      await persistDisabledTools(boundWorkspace, toolName, enabled);
      publishWorkspaceEvent({
        type: 'tool_toggled',
        data: { toolName, enabled },
        originatorClientId: ctx.originatorClientId,
      });
      return { toolName, enabled };
    },

    async setWorkspaceSkillEnabled(
      ctx: WorkspaceRequestContext,
      requestedSkillName: string,
      enabled: boolean,
    ): Promise<WorkspaceSkillToggleResult> {
      const normalizedName = requestedSkillName.trim().toLowerCase();
      const status = await getWorkspaceSkillsStatus();
      const skill = status.skills.find(
        (candidate) => candidate.name.trim().toLowerCase() === normalizedName,
      );
      if (!skill) throw new WorkspaceSkillNotFoundError(requestedSkillName);
      if (skill.userInvocable === false) {
        throw new WorkspaceSkillNotToggleableError(
          skill.name,
          'not_user_invocable',
        );
      }

      const disabled = loadSettings(boundWorkspace).merged.skills?.disabled;
      const disabledNames = new Set(
        (Array.isArray(disabled) ? disabled : [])
          .filter((name): name is string => typeof name === 'string')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      );
      if (
        skill.level === 'extension' &&
        skill.status === 'disabled' &&
        !disabledNames.has(normalizedName)
      ) {
        throw new WorkspaceSkillNotToggleableError(
          skill.name,
          'inactive_extension',
        );
      }

      const persisted = await persistDisabledSkills(
        boundWorkspace,
        skill.name,
        enabled,
      );
      const channelLive = isChannelLive?.() ?? false;
      let activation: WorkspaceSkillToggleResult['activation'] = channelLive
        ? 'applied'
        : 'deferred';
      let sessionsRefreshed = 0;
      let sessionsFailed = 0;

      if (persisted.changed) {
        lastWorkspaceSkillsStatus = undefined;
        if (channelLive) {
          try {
            const refreshed =
              await invokeWorkspaceCommand<ServeWorkspaceSkillsRefreshResult>(
                SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
                { cwd: boundWorkspace },
              );
            sessionsRefreshed = refreshed.sessionsRefreshed;
            sessionsFailed = refreshed.sessionsFailed;
            if (sessionsFailed > 0) activation = 'partial';
          } catch (err) {
            if (
              err instanceof SessionNotFoundError ||
              err instanceof BridgeChannelClosedError
            ) {
              activation = 'deferred';
            } else {
              activation = 'partial';
              sessionsFailed = 1;
              writeStderrLine(
                `qwen serve: workspace skill refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        publishWorkspaceEvent({
          type: 'settings_changed',
          data: {
            key: 'skills.disabled',
            value:
              persisted.disabled.length > 0 ? persisted.disabled : undefined,
            scope: 'workspace',
          },
          originatorClientId: ctx.originatorClientId,
        });
      }

      return {
        skillName: skill.name,
        enabled,
        changed: persisted.changed,
        activation,
        sessionsRefreshed,
        sessionsFailed,
      };
    },

    async initWorkspace(
      ctx: WorkspaceRequestContext,
      opts: { force?: boolean },
    ) {
      // Resolve the context filename against the workspace root.
      const filename = contextFilename;
      const target = path.resolve(boundWorkspace, filename);

      // Textual boundary check: reject paths that escape the workspace.
      const withinWorkspace =
        target === boundWorkspace ||
        target.startsWith(boundWorkspace + path.sep);
      if (!withinWorkspace) {
        throw new WorkspaceInitPathEscapeError(filename, boundWorkspace);
      }

      // Symlink check on parent path: canonicalize and verify.
      const wsCanonical = await fs.realpath(boundWorkspace);
      const parentCanonical = await canonicalizeExistingAncestor(
        path.dirname(target),
      );
      const parentWithinWorkspace =
        parentCanonical === wsCanonical ||
        parentCanonical.startsWith(wsCanonical + path.sep);
      if (!parentWithinWorkspace) {
        throw new WorkspaceInitSymlinkError(
          target,
          'parent',
          `Configured workspace context filename ${JSON.stringify(filename)} ` +
            `has a parent path that resolves outside the bound workspace ` +
            `(parent canonicalizes to ${JSON.stringify(parentCanonical)}, ` +
            `workspace canonicalizes to ${JSON.stringify(wsCanonical)}). ` +
            `Refusing to write — replace any symlinked parent directory ` +
            `with a real directory before re-running init.`,
        );
      }

      // Symlink check on the target itself.
      try {
        const lst = await fs.lstat(target);
        if (lst.isSymbolicLink()) {
          throw new WorkspaceInitSymlinkError(
            target,
            'target',
            `Workspace context file ${JSON.stringify(target)} is a symlink. ` +
              `Refusing to follow it for write — replace the symlink with a ` +
              `regular file (or remove it) before re-running init.`,
          );
        }
        if (!lst.isFile()) {
          throw new WorkspaceInitSymlinkError(
            target,
            'target',
            `Workspace context file ${JSON.stringify(target)} is not a regular file ` +
              `(mode=${lst.mode.toString(8)}). Refusing to proceed — ` +
              `FIFOs, sockets, and device nodes can block or misbehave on read/write.`,
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceInitSymlinkError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — target doesn't exist; fresh create is fine.
      }

      // Determine action based on existing file state.
      let action: 'created' | 'overwrote' | 'noop' = 'created';
      try {
        const existing = await fs.readFile(target, 'utf8');
        if (existing.trim().length > 0) {
          const existingSize = Buffer.byteLength(existing, 'utf8');
          if (opts.force !== true) {
            throw new WorkspaceInitConflictError(target, existingSize);
          }
          action = 'overwrote';
        } else {
          // Whitespace-only file: treat as noop.
          action = 'noop';
        }
      } catch (err) {
        if (err instanceof WorkspaceInitConflictError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — fall through to create.
      }

      // Write the file.
      if (action === 'created') {
        // Atomic exclusive create to close TOCTOU window.
        let fh: import('node:fs/promises').FileHandle;
        try {
          fh = await fs.open(target, 'wx');
        } catch (err) {
          const code = (err as { code?: unknown } | null | undefined)?.code;
          if (code === 'EEXIST') {
            throw new WorkspaceInitRaceError(
              target,
              'eexist',
              `Workspace context file ${JSON.stringify(target)} appeared ` +
                `between our absence check and the create — refusing to ` +
                `proceed (a regular file or symlink was just placed at the ` +
                `target path, and following it could escape the workspace).`,
            );
          }
          throw err;
        }
        try {
          // Post-open parent re-verification narrows the parent-symlink
          // TOCTOU window between `canonicalizeExistingAncestor` and
          // `fs.open`. Must verify before writing content.
          await verifyParentPostOpen(target, wsCanonical, fh);
          await fh.writeFile('', 'utf8');
        } finally {
          await fh.close();
        }
      } else if (action === 'overwrote') {
        // Use O_WRONLY | O_NOFOLLOW to avoid following symlinks that
        // may have been swapped in between our lstat check and this open.
        let overwriteFh: import('node:fs/promises').FileHandle;
        try {
          overwriteFh = await fs.open(
            target,
            fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
          );
        } catch (err) {
          const code = (err as { code?: unknown } | null | undefined)?.code;
          if (code === 'ELOOP') {
            throw new WorkspaceInitSymlinkError(
              target,
              'target',
              `Workspace context file ${JSON.stringify(target)} could not ` +
                `be opened with O_NOFOLLOW (ELOOP); the path may have been ` +
                `swapped to a symlink between the content check and the ` +
                `overwrite. Refusing to follow it.`,
            );
          }
          if (code === 'ENOENT') {
            throw new WorkspaceInitRaceError(
              target,
              'enoent',
              `Workspace context file ${JSON.stringify(target)} was deleted ` +
                `between the content check and the overwrite (likely a ` +
                `concurrent writer). Refusing to recreate blindly; rerun init.`,
            );
          }
          throw err;
        }
        try {
          // Post-open parent re-verification (same as create path).
          await verifyParentPostOpen(target, wsCanonical, overwriteFh);
          // Truncate AFTER verify, using the fd we already hold.
          await overwriteFh.truncate(0);
        } finally {
          await overwriteFh.close();
        }
      }
      // action === 'noop' — no write needed.

      publishWorkspaceEvent({
        type: 'workspace_initialized',
        data: { path: target, action },
        originatorClientId: ctx.originatorClientId,
      });

      return { path: target, action };
    },

    async restartMcpServer(
      ctx: WorkspaceRequestContext,
      serverName: string,
      opts?: { entryIndex?: number },
    ) {
      const params: Record<string, unknown> = { serverName };
      if (opts?.entryIndex !== undefined) {
        params['entryIndex'] = opts.entryIndex;
      }

      let result: RestartMcpServerResult;
      try {
        result = await invokeWorkspaceCommand<RestartMcpServerResult>(
          SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart,
          params,
          { timeoutMs: MCP_RESTART_SERVER_DEADLINE_MS },
        );
      } catch (err) {
        const data = (err as { data?: unknown })?.data;
        if (data && typeof data === 'object') {
          const kind = (data as { errorKind?: unknown }).errorKind;
          const sn = (data as { serverName?: unknown }).serverName;
          if (kind === 'mcp_server_not_found' && typeof sn === 'string') {
            throw new McpServerNotFoundError(sn);
          }
          if (kind === 'mcp_restart_failed' && typeof sn === 'string') {
            const status = (data as { mcpStatus?: unknown }).mcpStatus;
            throw new McpServerRestartFailedError(
              sn,
              typeof status === 'string' ? status : 'unknown',
            );
          }
        }
        throw err;
      }

      // Pool-mode: fan out per-entry events.
      if ('entries' in result) {
        const entries = Array.isArray(result.entries) ? result.entries : [];
        if (!Array.isArray(result.entries)) {
          writeStderrLine(
            `qwen serve: pool restart response carried 'entries' field ` +
              `but it is not an array (server=${serverName}); ` +
              `treating as empty.`,
          );
        }
        for (const entry of entries) {
          if (
            typeof entry !== 'object' ||
            entry === null ||
            typeof (entry as { entryIndex?: unknown }).entryIndex !== 'number'
          ) {
            writeStderrLine(
              `qwen serve: skipping malformed pool restart entry ` +
                `(server=${serverName}): ${JSON.stringify(entry)}`,
            );
            continue;
          }
          if (entry.restarted) {
            publishWorkspaceEvent({
              type: 'mcp_server_restarted',
              data: {
                serverName: result.serverName,
                durationMs: entry.durationMs ?? 0,
                entryIndex: entry.entryIndex,
              },
              originatorClientId: ctx.originatorClientId,
            });
          } else {
            publishWorkspaceEvent({
              type: 'mcp_server_restart_refused',
              data: {
                serverName: result.serverName,
                reason: 'restart_failed',
                entryIndex: entry.entryIndex,
                ...(entry.reason ? { details: entry.reason } : {}),
              },
              originatorClientId: ctx.originatorClientId,
            });
          }
        }
      } else if (result.restarted === true) {
        publishWorkspaceEvent({
          type: 'mcp_server_restarted',
          data: {
            serverName: result.serverName,
            durationMs: result.durationMs,
          },
          originatorClientId: ctx.originatorClientId,
        });
      } else {
        publishWorkspaceEvent({
          type: 'mcp_server_restart_refused',
          data: {
            serverName: result.serverName,
            reason: (result as { reason?: string }).reason,
          },
          originatorClientId: ctx.originatorClientId,
        });
      }

      return result;
    },

    async reload(ctx: WorkspaceRequestContext) {
      if (deps.reloadDaemonEnv) {
        try {
          await deps.reloadDaemonEnv(boundWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: daemon reload failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      let childReloaded = false;
      let env: { updatedKeys: string[]; removedKeys: string[] } = {
        updatedKeys: [],
        removedKeys: [],
      };
      let changedKeys: string[] = [];
      let sessionsRefreshed: string[] | undefined;
      let sessionsSkipped: string[] | undefined;
      let childError: string | undefined;
      try {
        const childResult = await invokeWorkspaceCommand<{
          env: { updatedKeys: string[]; removedKeys: string[] };
          changedKeys: string[];
          sessionsRefreshed: string[];
          sessionsSkipped: string[];
        }>(
          SERVE_CONTROL_EXT_METHODS.workspaceReload,
          { cwd: boundWorkspace },
          { timeoutMs: 30_000 },
        );
        childReloaded = true;
        env = childResult.env;
        changedKeys = childResult.changedKeys;
        sessionsRefreshed = childResult.sessionsRefreshed;
        sessionsSkipped = childResult.sessionsSkipped;
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          childError = 'ACP child not running';
        } else {
          childError = err instanceof Error ? err.message : String(err);
          writeStderrLine(`qwen serve: reload failed: ${childError}`);
        }
      }

      publishWorkspaceEvent({
        type: 'settings_reloaded',
        data: {
          env,
          changedKeys,
          childReloaded,
          sessionsRefreshed,
          sessionsSkipped,
          childError,
        },
        originatorClientId: ctx.originatorClientId,
      });

      return {
        env,
        changedKeys,
        childReloaded,
        sessionsRefreshed,
        sessionsSkipped,
        childError,
      };
    },

    invalidateWorkspaceSkillsStatus() {
      lastWorkspaceSkillsStatus = undefined;
    },

    async refreshExtensionsForAllSessions() {
      try {
        if (!refreshExtensionsForAllSessionsOnBridge) {
          throw new Error('refreshExtensionsForAllSessions is not wired');
        }
        return await refreshExtensionsForAllSessionsOnBridge();
      } catch (err) {
        writeStderrLine(
          `qwen serve: refreshExtensionsForAllSessions failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { refreshed: 0, failed: 1 };
      } finally {
        lastWorkspaceSkillsStatus = undefined;
      }
    },
  };
}
