/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  redactMcpServersSetting,
  restoreRedactedMcpServersSetting,
} from '../../config/mcp-server-secrets.js';
import type {
  SettingEnumOption,
  SettingsType,
  SettingsValue,
} from '../../config/settingsSchema.js';
import {
  getDialogSettingKeys,
  getNestedProperty,
  getSettingDefinition,
  validateSettingValue,
  WORKSPACE_RESTRICTED_SETTING_KEYS,
} from '../../config/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

const TUI_ONLY_SETTINGS = new Set([
  'general.vimMode',
  'general.terminalBell',
  'general.notificationMode',
  'general.preferredEditor',
  'general.outputLanguage',
  'ide.enabled',
  'ui.showLineNumbers',
  'ui.showToolCallArgs',
  'ui.renderMode',
  'ui.useTerminalBuffer',
  'ui.mouseTracking',
  'ui.showScrollbar',
  'ui.hideBanner',
  'ui.accessibility.enableLoadingPhrases',
  'ui.enableWelcomeBack',
]);

// `voiceModel` is `showInDialog: false` (so not in the dialog allowlist), but
// the Web Shell `/model --voice` picker needs to read + persist it; the daemon
// `/voice/stream` then reads it back via `loadSettings`.
const WEB_SHELL_SETTINGS = new Set([
  'ui.compactMode',
  'voiceModel',
  'mcpServers',
]);

const LIVE_WEB_SHELL_SETTINGS = [
  'experimental.liveVoice.enabled',
  'experimental.liveVoice.shortcut',
] as const;

const LIVE_MANAGED_SETTINGS = new Set<string>(LIVE_WEB_SHELL_SETTINGS);

// The primary /workspace/settings route may write the global user scope
// (~/.qwen/settings.json). The trust-gated workspace-qualified route stays
// workspace-only by design.
const VALID_WRITE_SCOPES = new Set(['workspace', 'user']);
const QUALIFIED_WRITE_SCOPES = new Set(['workspace']);
const mcpServerMutationQueues = new Map<string, Promise<void>>();

export interface McpServerSettingMutation {
  operation: 'set' | 'remove';
  name: string;
}

interface SettingDescriptor {
  key: string;
  type: SettingsType;
  label: string;
  category: string;
  description?: string;
  requiresRestart: boolean;
  default: SettingsValue;
  options?: readonly SettingEnumOption[];
  values: {
    effective: unknown;
    user?: unknown;
    workspace?: unknown;
  };
}

interface SettingsResponse {
  v: 1;
  warnings?: Array<{
    type: 'corrupted';
    recovered: boolean;
  }>;
  settings: SettingDescriptor[];
}

const SECURITY_SENSITIVE_SETTINGS = new Set(['tools.approvalMode']);

/**
 * Refuse a workspace-scope write of a setting the merge strips anyway.
 *
 * R8-1: `stripWorkspaceRestrictedSettings` drops these before every merge, so
 * persisting one at workspace scope writes a committable dead entry into the
 * repo's `.qwen/settings.json` and answers 200 + `requiresRestart: true` while
 * the feature never turns on — GET then reports `workspace: true` beside
 * `effective: false`, and the warnings channel carries only `corrupted`, so the
 * client never learns the write was inert. `tools.workflowsEnabled` is the
 * first restricted key with `showInDialog: true`, which is what puts it in
 * `getAllowedKeys()` and made this reachable. The TUI dialog already filters
 * these; this is the same trap one layer over.
 *
 * User scope is untouched — that scope honors the key.
 *
 * Returns true when the request was answered and the caller must stop.
 */
function rejectWorkspaceRestrictedWrite(
  res: Response,
  scope: string,
  key: string,
): boolean {
  if (scope !== 'workspace') return false;
  if (WORKSPACE_RESTRICTED_SETTING_KEYS.includes(key)) {
    res.status(400).json({
      error: `Setting "${key}" is not honored from workspace scope; set it at user scope instead`,
      code: 'workspace_restricted_setting',
    });
    return true;
  }
  return false;
}

function getAllowedKeys(includeLiveVoice = false): Set<string> {
  const keys = new Set(
    getDialogSettingKeys().filter(
      (k) => !TUI_ONLY_SETTINGS.has(k) && !SECURITY_SENSITIVE_SETTINGS.has(k),
    ),
  );
  for (const key of WEB_SHELL_SETTINGS) {
    keys.add(key);
  }
  if (includeLiveVoice) {
    for (const key of LIVE_WEB_SHELL_SETTINGS) keys.add(key);
  }
  return keys;
}

function buildSettingsResponse(
  boundWorkspace: string,
  keys: ReadonlySet<string>,
  workspaceTrusted = true,
): SettingsResponse {
  const loaded = loadSettings(boundWorkspace, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: !workspaceTrusted,
    workspaceTrusted,
  });
  const settings: SettingDescriptor[] = [];
  for (const key of keys) {
    const def = getSettingDefinition(key);
    if (!def) continue;

    const mergedEffective = getNestedProperty(
      loaded.merged as Record<string, unknown>,
      key,
    );
    const userVal = getNestedProperty(
      loaded.user.settings as Record<string, unknown>,
      key,
    );
    const wsVal = getNestedProperty(
      loaded.workspace.settings as Record<string, unknown>,
      key,
    );

    const publicValue = (value: unknown) =>
      key === 'mcpServers' ? redactMcpServersSetting(value) : value;
    const effective = LIVE_MANAGED_SETTINGS.has(key)
      ? (userVal ?? def.default)
      : (mergedEffective ?? def.default);
    const values: SettingDescriptor['values'] = {
      effective: publicValue(effective),
    };
    if (userVal !== undefined) values.user = publicValue(userVal);
    if (wsVal !== undefined && !LIVE_MANAGED_SETTINGS.has(key)) {
      values.workspace = publicValue(wsVal);
    }

    settings.push({
      key,
      type: def.type,
      label: def.label,
      category: def.category,
      ...(def.description ? { description: def.description } : {}),
      requiresRestart: def.requiresRestart,
      default: def.default,
      ...(def.options?.length ? { options: def.options } : {}),
      values,
    });
  }

  const warnings: SettingsResponse['warnings'] = [];
  if (loaded.corruptedPath) {
    warnings.push({
      type: 'corrupted',
      recovered: loaded.wasRecovered,
    });
  }

  return {
    v: 1,
    ...(warnings.length ? { warnings } : {}),
    settings,
  };
}

const SCOPE_MAP: Record<string, SettingScope> = {
  user: SettingScope.User,
  workspace: SettingScope.Workspace,
};

export function prepareSettingWrite(
  workspace: string,
  scope: SettingScope,
  key: string,
  value: unknown,
  mcpServerMutation?: McpServerSettingMutation,
  workspaceTrusted = true,
): { persistedValue: unknown; publicValue: unknown } {
  if (key !== 'mcpServers') {
    return { persistedValue: value, publicValue: value };
  }
  const existing =
    loadSettings(workspace, {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted,
    }).forScope(scope).settings.mcpServers ?? {};
  let nextValue = value;
  if (mcpServerMutation) {
    const servers = { ...existing };
    if (mcpServerMutation.operation === 'set') {
      servers[mcpServerMutation.name] = value as (typeof servers)[string];
    } else {
      delete servers[mcpServerMutation.name];
    }
    nextValue = servers;
  }
  const persistedValue = restoreRedactedMcpServersSetting(nextValue, existing);
  return {
    persistedValue,
    publicValue: redactMcpServersSetting(persistedValue),
  };
}

function parseMcpServerMutation(
  key: string,
  value: unknown,
): McpServerSettingMutation | undefined {
  if (value === undefined) return undefined;
  if (key !== 'mcpServers' || typeof value !== 'object' || value === null) {
    throw new Error('mcpServerMutation is only valid for mcpServers');
  }
  const operation = (value as Record<string, unknown>)['operation'];
  const name = (value as Record<string, unknown>)['name'];
  if (
    (operation !== 'set' && operation !== 'remove') ||
    typeof name !== 'string' ||
    !name.trim()
  ) {
    throw new Error('mcpServerMutation requires a valid operation and name');
  }
  return { operation, name };
}

export async function withMcpServerMutationLock<T>(
  workspace: string,
  scope: SettingScope,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${workspace}\0${scope}`;
  const previous = mcpServerMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mcpServerMutationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (mcpServerMutationQueues.get(key) === tail) {
      mcpServerMutationQueues.delete(key);
    }
  }
}

// The daemon-side settings lock serializes the disk persist only; it is
// released before these routes sample the post-write effective value and
// push it to live sessions. Two concurrent Session Workflow writes could
// then read back each other's state and push out of persist order, leaving
// live sessions on a gate value that contradicts the file. Chain the whole
// persist → readback → push critical section per workspace so each push
// reflects its own write and pushes land in persist order. This nests
// inside (never around) the daemon lock via persistSetting, so there is no
// lock-ordering cycle. Same promise-chain pattern as
// withMcpServerMutationLock above.
const sessionWorkflowWriteQueues = new Map<string, Promise<void>>();
export async function withSessionWorkflowWriteLock<T>(
  workspace: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    sessionWorkflowWriteQueues.get(workspace) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionWorkflowWriteQueues.set(workspace, tail);
  try {
    return await run;
  } finally {
    if (sessionWorkflowWriteQueues.get(workspace) === tail) {
      sessionWorkflowWriteQueues.delete(workspace);
    }
  }
}

export interface WorkspaceSettingsRouteDeps {
  boundWorkspace: string;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
    assertGenerationOpen?: () => void,
  ) => Promise<void>;
  updateSessionWorkflow: (enabled: boolean) => Promise<unknown>;
  /**
   * Fan a user-scope Session Workflow write out to the non-primary workspace
   * runtimes. A user-scope write persists to the global user file and flips
   * the effective gate for every workspace, but `updateSessionWorkflow` only
   * reaches the primary bridge; each sibling runtime owns its own bridge and
   * would otherwise keep deriving the stale gate. Best-effort by contract:
   * implementations must not throw for an unreachable sibling.
   */
  updateSiblingSessionWorkflows?: () => Promise<void>;
  broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
  includeLiveVoice?: boolean;
}

// A user-scoped write can be shadowed by a workspace-scoped value (workspace
// wins the merge), so live sessions must follow the post-write effective value
// rather than the raw value that was just written.
export function readEffectiveSessionWorkflow(
  boundWorkspace: string,
  workspaceTrusted: boolean,
): boolean {
  const loaded = loadSettings(boundWorkspace, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: !workspaceTrusted,
    workspaceTrusted,
  });
  return (
    getNestedProperty(
      loaded.merged as Record<string, unknown>,
      'experimental.sessionWorkflow',
    ) === true
  );
}

async function updateLiveSessionWorkflow(
  update: (enabled: boolean) => Promise<unknown>,
  enabled: boolean,
  workspace: string,
  res: Response,
): Promise<boolean> {
  try {
    await update(enabled);
    return true;
  } catch (err) {
    if (err instanceof SessionNotFoundError) return true;
    writeStderrLine(
      `qwen serve: failed to update the live Session Workflow setting for ${workspace}: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({
      error: 'Failed to update the live Session Workflow setting',
      code: 'runtime_update_error',
    });
    return false;
  }
}

/**
 * Outcome of a settings write that may include a live Session Workflow push,
 * split so the caller can decide whether change notifications must still go
 * out:
 * - 'ok': persist (and the live push, when applicable) succeeded; the caller
 *   sends the 200 and the change notification.
 * - 'unchanged_failure': the request failed before the on-disk value changed
 *   (persist error, or the runtime generation closed around the persist); an
 *   error response was already sent and no change notification may go out.
 * - 'disk_changed_push_failed': the on-disk value changed but the live push
 *   failed afterwards (e.g. bridge channel closed, push timeout). An error
 *   response was already sent to the requester, but the file DID change, so
 *   observers must still receive the change notification instead of staying
 *   stale until daemon restart.
 */
type SettingsWriteOutcome =
  | 'ok'
  | 'unchanged_failure'
  | 'disk_changed_push_failed';

export function registerWorkspaceSettingsRoutes(
  app: Application,
  deps: WorkspaceSettingsRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId,
  } = deps;

  const allowedKeys = getAllowedKeys(deps.includeLiveVoice === true);

  app.get('/workspace/settings', (_req: Request, res: Response) => {
    try {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      assertGenerationOpen();
      const response = buildSettingsResponse(
        boundWorkspace,
        allowedKeys,
        deps.isWorkspaceTrusted?.() ?? true,
      );
      res.status(200).json(response);
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      writeStderrLine(
        `qwen serve: GET /workspace/settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load settings',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspace/settings',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      const body = safeBody(req);
      const scope = body['scope'];
      const key = body['key'];
      const value = body['value'];
      let mcpServerMutation: McpServerSettingMutation | undefined;
      try {
        mcpServerMutation = parseMcpServerMutation(
          typeof key === 'string' ? key : '',
          body['mcpServerMutation'],
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_mcp_server_mutation',
        });
        return;
      }

      if (typeof scope !== 'string' || !VALID_WRITE_SCOPES.has(scope)) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }

      if (scope === 'workspace' && deps.isWorkspaceTrusted?.() === false) {
        res.status(403).json({
          error: 'Workspace is not trusted.',
          code: 'untrusted_workspace',
        });
        return;
      }

      if (typeof key !== 'string' || !key) {
        res.status(400).json({
          error: 'key is required and must be a string',
          code: 'invalid_key',
        });
        return;
      }

      if (!allowedKeys.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" is not modifiable via this API`,
          code: 'disallowed_key',
        });
        return;
      }

      if (rejectWorkspaceRestrictedWrite(res, scope, key)) return;

      if (LIVE_MANAGED_SETTINGS.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" must be changed through the Live setup API`,
          code: 'live_managed_setting',
        });
        return;
      }

      if (value === undefined || value === null) {
        res.status(400).json({
          error: 'value is required',
          code: 'missing_value',
        });
        return;
      }

      const def = getSettingDefinition(key);
      if (!def) {
        res.status(400).json({
          error: `Unknown setting: ${key}`,
          code: 'unknown_key',
        });
        return;
      }

      const validationError = validateSettingValue(def, value);
      if (validationError) {
        res.status(400).json({
          error: validationError,
          code: 'invalid_value',
        });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const settingScope = SCOPE_MAP[scope];
      if (!settingScope) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      let publicValue: unknown = value;
      const persistAndPushSessionWorkflow =
        async (): Promise<SettingsWriteOutcome> => {
          try {
            const persist = async () => {
              const prepared = prepareSettingWrite(
                boundWorkspace,
                settingScope,
                key,
                value,
                mcpServerMutation,
                deps.isWorkspaceTrusted?.() ?? true,
              );
              publicValue = prepared.publicValue;
              if (deps.captureGenerationAssertion) {
                await persistSetting(
                  boundWorkspace,
                  settingScope,
                  key,
                  prepared.persistedValue,
                  assertGenerationOpen,
                );
              } else {
                await persistSetting(
                  boundWorkspace,
                  settingScope,
                  key,
                  prepared.persistedValue,
                );
              }
            };
            if (mcpServerMutation) {
              await withMcpServerMutationLock(
                boundWorkspace,
                settingScope,
                persist,
              );
            } else {
              await persist();
            }
          } catch (err) {
            if (sendGenerationClosedError(res, err)) return 'unchanged_failure';
            writeStderrLine(
              `qwen serve: POST /workspace/settings persist error (key=${key}, scope=${scope}, workspace=${boundWorkspace}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            res.status(500).json({
              error: 'Failed to persist setting',
              code: 'persist_error',
            });
            return 'unchanged_failure';
          }

          try {
            assertGenerationOpen();
          } catch (err) {
            if (sendGenerationClosedError(res, err)) return 'unchanged_failure';
            throw err;
          }
          if (key === 'experimental.sessionWorkflow') {
            const livePushSucceeded = await updateLiveSessionWorkflow(
              deps.updateSessionWorkflow,
              readEffectiveSessionWorkflow(
                boundWorkspace,
                deps.isWorkspaceTrusted?.() ?? true,
              ),
              boundWorkspace,
              res,
            );
            // A user-scope write lands in the global user file, so the gate
            // flips for every workspace on the host; the primary push above
            // only reached the primary bridge. Fan the re-derivation out to
            // the sibling runtimes (best-effort, non-throwing by contract).
            // A workspace-scope write only touched this workspace's file, so
            // siblings keep their own value and need no push.
            if (settingScope === SettingScope.User) {
              await deps.updateSiblingSessionWorkflows?.();
            }
            if (!livePushSucceeded) {
              // The persist above already changed the file; only the live
              // push failed. The caller must still emit the change
              // notification so observers converge on the new disk value.
              return 'disk_changed_push_failed';
            }
            try {
              assertGenerationOpen();
            } catch (err) {
              if (sendGenerationClosedError(res, err))
                return 'unchanged_failure';
              throw err;
            }
          }
          return 'ok';
        };
      // Session Workflow writes serialize the whole persist → readback →
      // push sequence; other keys keep the plain (persist-only) path.
      const writeOutcome: SettingsWriteOutcome =
        key === 'experimental.sessionWorkflow'
          ? await withSessionWorkflowWriteLock(
              boundWorkspace,
              persistAndPushSessionWorkflow,
            )
          : await persistAndPushSessionWorkflow();
      if (writeOutcome === 'unchanged_failure') return;
      // Broadcast whenever the on-disk value changed — including the
      // push-failed case, where the requester already received a 500 but
      // every other observer would otherwise stay stale (file says one thing,
      // their cached settings say another) until the next write or restart.
      try {
        broadcastSettingsChanged(key, publicValue, scope, clientId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/settings broadcast error (key=${key}, scope=${scope}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (writeOutcome !== 'ok') return;

      res.status(200).json({
        key,
        scope,
        value: publicValue,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}

export function registerWorkspaceQualifiedSettingsRoutes(
  app: Application,
  deps: Pick<
    WorkspaceSettingsRouteDeps,
    'mutate' | 'safeBody' | 'persistSetting'
  > & {
    workspaceRegistry: WorkspaceRegistry;
    invalidateServeFeaturesCache: () => void;
  },
): void {
  const allowedKeys = getAllowedKeys(false);

  app.get('/workspaces/:workspace/settings', (req: Request, res: Response) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    // Legacy /workspace/settings remains primary-only and pre-trust for
    // compatibility; plural workspace-qualified settings intentionally follow
    // the Phase 3 core-route trust gate.
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    try {
      const response = buildSettingsResponse(runtime.workspaceCwd, allowedKeys);
      res.status(200).json(response);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load settings',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspaces/:workspace/settings',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const body = deps.safeBody(req);
      const scope = body['scope'];
      const key = body['key'];
      const value = body['value'];
      let mcpServerMutation: McpServerSettingMutation | undefined;
      try {
        mcpServerMutation = parseMcpServerMutation(
          typeof key === 'string' ? key : '',
          body['mcpServerMutation'],
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_mcp_server_mutation',
        });
        return;
      }

      if (typeof scope !== 'string' || !QUALIFIED_WRITE_SCOPES.has(scope)) {
        res.status(400).json({
          error: `scope must be one of: ${[...QUALIFIED_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      if (typeof key !== 'string' || !key) {
        res.status(400).json({
          error: 'key is required and must be a string',
          code: 'invalid_key',
        });
        return;
      }
      if (!allowedKeys.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" is not modifiable via this API`,
          code: 'disallowed_key',
        });
        return;
      }

      if (rejectWorkspaceRestrictedWrite(res, scope, key)) return;
      if (LIVE_MANAGED_SETTINGS.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" must be changed through the Live setup API`,
          code: 'live_managed_setting',
        });
        return;
      }
      if (value === undefined || value === null) {
        res.status(400).json({
          error: 'value is required',
          code: 'missing_value',
        });
        return;
      }
      const def = getSettingDefinition(key);
      if (!def) {
        res.status(400).json({
          error: `Unknown setting: ${key}`,
          code: 'unknown_key',
        });
        return;
      }
      const validationError = validateSettingValue(def, value);
      if (validationError) {
        res.status(400).json({
          error: validationError,
          code: 'invalid_value',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const assertGenerationOpen = () => runtime.generationGuard?.assertOpen();

      // The guard above already rejected any scope outside QUALIFIED_WRITE_SCOPES.
      const settingScope = SCOPE_MAP[scope];
      if (!settingScope) {
        res.status(400).json({
          error: `scope must be one of: ${[...QUALIFIED_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      let publicValue: unknown = value;
      const persistAndPushSessionWorkflow =
        async (): Promise<SettingsWriteOutcome> => {
          try {
            const persist = async () => {
              const prepared = prepareSettingWrite(
                runtime.workspaceCwd,
                settingScope,
                key,
                value,
                mcpServerMutation,
                true,
              );
              publicValue = prepared.publicValue;
              await deps.persistSetting(
                runtime.workspaceCwd,
                settingScope,
                key,
                prepared.persistedValue,
                assertGenerationOpen,
              );
            };
            if (mcpServerMutation) {
              await withMcpServerMutationLock(
                runtime.workspaceCwd,
                settingScope,
                persist,
              );
            } else {
              await persist();
            }
          } catch (err) {
            if (sendGenerationClosedError(res, err)) return 'unchanged_failure';
            writeStderrLine(
              `qwen serve: POST /workspaces/:workspace/settings persist error (key=${key}, scope=${scope}, workspace=${runtime.workspaceCwd}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            res.status(500).json({
              error: 'Failed to persist setting',
              code: 'persist_error',
            });
            return 'unchanged_failure';
          }

          try {
            assertGenerationOpen();
          } catch (err) {
            if (sendGenerationClosedError(res, err)) return 'unchanged_failure';
            throw err;
          }
          if (key === 'experimental.sessionWorkflow') {
            if (
              !(await updateLiveSessionWorkflow(
                (enabled) =>
                  runtime.bridge.invokeWorkspaceCommand(
                    SERVE_CONTROL_EXT_METHODS.workspaceSessionWorkflow,
                    { enabled },
                  ),
                // Push the post-write effective value, not the raw write: a
                // system-scope (fleet) settings file shadows a workspace write in
                // mergeSettings, so even on this workspace-only route the written
                // value is not necessarily the effective one.
                readEffectiveSessionWorkflow(runtime.workspaceCwd, true),
                runtime.workspaceCwd,
                res,
              ))
            ) {
              // The persist above already changed the file; only the live
              // push failed. The caller must still emit the change
              // notification so observers converge on the new disk value.
              return 'disk_changed_push_failed';
            }
            try {
              assertGenerationOpen();
            } catch (err) {
              if (sendGenerationClosedError(res, err))
                return 'unchanged_failure';
              throw err;
            }
          }
          return 'ok';
        };
      // Session Workflow writes serialize the whole persist → readback →
      // push sequence; other keys keep the plain (persist-only) path.
      const writeOutcome: SettingsWriteOutcome =
        key === 'experimental.sessionWorkflow'
          ? await withSessionWorkflowWriteLock(
              runtime.workspaceCwd,
              persistAndPushSessionWorkflow,
            )
          : await persistAndPushSessionWorkflow();
      if (writeOutcome === 'unchanged_failure') return;
      // Notify whenever the on-disk value changed — including the push-failed
      // case, where the requester already received a 500 but every other
      // observer would otherwise stay stale until the next write or restart.
      deps.invalidateServeFeaturesCache();
      runtime.bridge.publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key, value: publicValue, scope },
        ...(clientId ? { originatorClientId: clientId } : {}),
      });
      if (writeOutcome !== 'ok') return;
      res.status(200).json({
        key,
        scope,
        value: publicValue,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}
