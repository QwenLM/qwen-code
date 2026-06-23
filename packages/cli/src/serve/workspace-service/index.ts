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
  STATUS_SCHEMA_VERSION,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceSkillsStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  createIdleEnvStatus,
  createIdleAcpPreflightCells,
  type ServeWorkspacePreflightStatus,
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

import { mapDomainErrorToErrorKind } from '@qwen-code/acp-bridge/status';
import { MCP_RESTART_SERVER_DEADLINE_MS } from '@qwen-code/acp-bridge/mcpTimeouts';

import { loadSettings, SettingScope } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  buildPermissionSettings,
  type PermissionSettingsScope,
} from '../../config/permission-settings.js';
import {
  buildWorkspaceVoiceStatus,
  validateWorkspaceVoiceConfig,
  validateWorkspaceVoiceModel,
  WorkspaceVoiceError,
} from '../../services/voice-service.js';
import {
  getVoiceSettingsScope,
  isVoiceEnabled,
  readVoiceModel,
} from '../../services/voice-settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

import type {
  DaemonWorkspaceService,
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
  RestartMcpServerResult,
  WorkspaceTrustChangeRequest,
  WorkspacePermissionRulesUpdate,
  WorkspaceVoiceSettingsUpdate,
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
  EnvReloadResult,
  ReloadResponse,
} from './types.js';

const PERMISSION_SCOPE_MAP: Record<PermissionSettingsScope, SettingScope> = {
  user: SettingScope.User,
  workspace: SettingScope.Workspace,
};

function validateResultingVoiceState(
  settings: ReturnType<typeof loadSettings>,
  update: WorkspaceVoiceSettingsUpdate,
): void {
  const nextEnabled = update.enabled ?? isVoiceEnabled(settings);
  const nextVoiceModel = update.voiceModel ?? readVoiceModel(settings);
  if (update.voiceModel) {
    validateWorkspaceVoiceModel(settings, update.voiceModel);
  }
  if (!nextEnabled) return;
  if (!nextVoiceModel) {
    throw new WorkspaceVoiceError(
      400,
      'voice_model_required',
      'A valid voiceModel is required before enabling voice.',
    );
  }
  validateWorkspaceVoiceConfig(settings, nextVoiceModel);
}

function scopeToWire(scope: SettingScope): 'user' | 'workspace' {
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}

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
    isChannelLive,
    persistDisabledTools,
    persistSetting,
    queryWorkspaceStatus,
    invokeWorkspaceCommand,
    refreshExtensionsForAllSessions: refreshExtensionsForAllSessionsOnBridge,
    publishWorkspaceEvent,
  } = deps;

  // -- Facade --
  return {
    // -- Status queries (delegate to ACP child via queryWorkspaceStatus) --

    async getWorkspaceMcpStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceMcp, () =>
        createIdleWorkspaceMcpStatus(boundWorkspace),
      );
    },

    async getWorkspaceSkillsStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace),
      );
    },

    async getWorkspaceProvidersStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace),
      );
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
        loadSettings(boundWorkspace),
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
        accepted: true,
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
      }

      if (!persistSetting) {
        throw new Error(
          'setWorkspacePermissionRules requires persistSetting in DaemonWorkspaceServiceDeps',
        );
      }

      await persistSetting(
        boundWorkspace,
        PERMISSION_SCOPE_MAP[request.scope],
        key,
        request.rules,
      );
      publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key, value: request.rules, scope: request.scope },
        originatorClientId: ctx.originatorClientId,
      });
      return buildPermissionSettings(loadSettings(boundWorkspace));
    },

    async setWorkspaceVoiceSettings(
      ctx: WorkspaceRequestContext,
      request: WorkspaceVoiceSettingsUpdate,
    ) {
      if (!persistSetting) {
        throw new WorkspaceVoiceError(
          501,
          'not_implemented',
          'Workspace voice settings persistence is not available',
        );
      }

      const settings = loadSettings(boundWorkspace);
      validateResultingVoiceState(settings, request);
      const voiceSettingsScope = getVoiceSettingsScope(settings);
      const writes: Array<{
        scope: SettingScope;
        key: string;
        value: unknown;
      }> = [];

      if (request.voiceModel !== undefined) {
        writes.push({
          scope: getPersistScopeForModelSelection(settings),
          key: 'voiceModel',
          value: request.voiceModel,
        });
      }
      if (request.mode !== undefined) {
        writes.push({
          scope: voiceSettingsScope,
          key: 'general.voice.mode',
          value: request.mode,
        });
      }
      if (request.language !== undefined) {
        writes.push({
          scope: voiceSettingsScope,
          key: 'general.voice.language',
          value: request.language,
        });
      }
      if (request.enabled !== undefined) {
        writes.push({
          scope: voiceSettingsScope,
          key: 'general.voice.enabled',
          value: request.enabled,
        });
      }

      for (const write of writes) {
        await persistSetting(
          boundWorkspace,
          write.scope,
          write.key,
          write.value,
        );
        publishWorkspaceEvent({
          type: 'settings_changed',
          data: {
            key: write.key,
            value: write.value,
            scope: scopeToWire(write.scope),
          },
          originatorClientId: ctx.originatorClientId,
        });
      }

      return buildWorkspaceVoiceStatus(
        boundWorkspace,
        loadSettings(boundWorkspace),
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
      }
    },
  };
}
