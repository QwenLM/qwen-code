/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { supportedChannelCatalog } from '../../commands/channel/channel-registry.js';
import type {
  ChannelPairingApprovalSubject,
  ChannelManagementService,
  ChannelStartupRequest,
  ChannelUpsertRequest,
  RevisionRequest,
} from '../channel-management-service.js';
import { assertValidChannelSecretUpdates } from '../channel-settings-store.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeWithLiveCompatibilityFromParam,
  sendConversationRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

const MAX_ERROR_LENGTH = 512;
const MAX_INSTANCE_NAME_BYTES = 255;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

interface RegisterWorkspaceChannelManagementRoutesDeps {
  primaryRuntime: WorkspaceRuntime;
  workspaceRegistry: WorkspaceRegistry;
  resolveService: (
    runtime: WorkspaceRuntime,
  ) =>
    | ChannelManagementService
    | undefined
    | Promise<ChannelManagementService | undefined>;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
    runtime: WorkspaceRuntime,
  ) => string | undefined | null;
  conversationRuntimeActivity?: ConversationRuntimeActivityGate;
}

type RuntimeResolver = (req: Request, res: Response) => WorkspaceRuntime | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function isPortableInstanceName(
  name: string,
  allowReservedAll = false,
): boolean {
  if (allowReservedAll && name.trim() === 'all') return true;
  const baseName = name.split('.', 1)[0]!.trimEnd();
  return (
    isWellFormed(name) &&
    name.trim().length > 0 &&
    name !== '.' &&
    name !== '..' &&
    name.trim() !== 'all' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !/[:*?"<>|\p{Cc}]/u.test(name) &&
    !name.endsWith('.') &&
    !name.endsWith(' ') &&
    !WINDOWS_DEVICE_NAME.test(baseName) &&
    Buffer.byteLength(name, 'utf8') <= MAX_INSTANCE_NAME_BYTES
  );
}

function parseInstanceName(
  req: Request,
  res: Response,
  allowReservedAll = false,
): string | undefined {
  const name = req.params['name'] ?? '';
  if (!isPortableInstanceName(name, allowReservedAll)) {
    res.status(400).json({
      error: `Channel instance names must be portable path components, differ from the reserved name "all", and be at most ${MAX_INSTANCE_NAME_BYTES} UTF-8 bytes.`,
      code: 'invalid_channel_instance_name',
    });
    return undefined;
  }
  return name;
}

function parseRevision(
  body: Record<string, unknown>,
  res: Response,
): RevisionRequest | undefined {
  const expectedRevision = body['expectedRevision'];
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    res.status(400).json({
      error: '`expectedRevision` must be a non-empty string.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  return { expectedRevision };
}

function parseUpsert(
  body: Record<string, unknown>,
  res: Response,
): ChannelUpsertRequest | undefined {
  const revision = parseRevision(body, res);
  if (!revision) return undefined;
  const config = body['config'];
  if (
    !isRecord(config) ||
    typeof config['type'] !== 'string' ||
    config['type'].length === 0
  ) {
    res.status(400).json({
      error: '`config` must contain a non-empty Channel type.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  const secrets = body['secrets'];
  if (secrets !== undefined) {
    try {
      assertValidChannelSecretUpdates(secrets);
    } catch {
      res.status(400).json({
        error: 'Secret updates are invalid.',
        code: 'channel_settings_invalid_secret',
      });
      return undefined;
    }
  }
  return {
    ...revision,
    config: config as Record<string, unknown> & { type: string },
    ...(secrets === undefined ? {} : { secrets }),
  };
}

function parseStartup(
  body: Record<string, unknown>,
  res: Response,
): ChannelStartupRequest | undefined {
  const revision = parseRevision(body, res);
  if (!revision) return undefined;
  if (typeof body['enabled'] !== 'boolean') {
    res.status(400).json({
      error: '`enabled` must be a boolean.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  return { ...revision, enabled: body['enabled'] };
}

function parsePairingCode(
  body: Record<string, unknown>,
  res: Response,
): string | undefined {
  const code = body['code'];
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/iu.test(code.trim())) {
    res.status(400).json({
      error: '`code` must be an 8-character pairing code.',
      code: 'invalid_channel_pairing_code',
    });
    return undefined;
  }
  return code.trim().toUpperCase();
}

function parsePairingApprovalSubject(
  body: Record<string, unknown>,
  res: Response,
): ChannelPairingApprovalSubject | undefined {
  const senderId = body['senderId'];
  const groupId = body['groupId'];
  if (senderId !== undefined && groupId !== undefined) {
    res.status(400).json({
      error: 'Provide exactly one of `senderId` or `groupId`.',
      code: 'invalid_channel_pairing_subject',
    });
    return undefined;
  }
  if (senderId !== undefined) {
    if (typeof senderId === 'string' && senderId.length > 0) {
      return { type: 'user', id: senderId };
    }
    res.status(400).json({
      error: '`senderId` must be a non-empty string.',
      code: 'invalid_channel_pairing_sender_id',
    });
    return undefined;
  }
  if (groupId !== undefined) {
    if (typeof groupId === 'string' && groupId.length > 0) {
      return { type: 'group', id: groupId };
    }
    res.status(400).json({
      error: '`groupId` must be a non-empty string.',
      code: 'invalid_channel_pairing_group_id',
    });
    return undefined;
  }
  res.status(400).json({
    error: 'Provide exactly one of `senderId` or `groupId`.',
    code: 'invalid_channel_pairing_subject',
  });
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function statePersistedFalse(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try {
    return Reflect.get(error, 'statePersisted') === false;
  } catch {
    return false;
  }
}

function statePersistFailedWorkspaces(error: unknown): string[] | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const value = Reflect.get(error, 'statePersistFailedWorkspaces');
    if (!Array.isArray(value)) return undefined;
    const workspaces = value.filter(
      (item): item is string => typeof item === 'string',
    );
    return workspaces.length > 0 ? workspaces : undefined;
  } catch {
    return undefined;
  }
}

const ERROR_STATUS = new Map<string, number>([
  ['invalid_channel_instance_name', 400],
  ['channel_settings_invalid_name', 400],
  ['channel_settings_invalid_config', 400],
  ['channel_settings_invalid_secret', 400],
  ['channel_settings_unmanageable', 400],
  ['channel_workspace_mismatch', 400],
  ['ambiguous_channel_workspace', 400],
  ['untrusted_workspace', 403],
  ['channel_instance_not_found', 404],
  ['channel_pairing_request_not_found', 404],
  ['channel_pairing_approval_not_found', 404],
  ['channel_pairing_not_enabled', 409],
  ['channel_settings_conflict', 409],
  ['channel_runtime_owner_mismatch', 409],
  ['channel_worker_not_enabled', 409],
  ['channel_worker_starting', 409],
  ['channel_service_conflict', 409],
  ['channel_worker_start_failed', 502],
  ['channel_worker_stop_failed', 500],
  ['channel_state_persist_failed', 500],
  ['daemon_draining', 503],
  ['channel_worker_unavailable', 503],
]);

function sendManagementError(res: Response, error: unknown): void {
  const code = errorCode(error);
  const status = code ? ERROR_STATUS.get(code) : undefined;
  if (code && status !== undefined) {
    const raw = error instanceof Error ? error.message : String(error);
    const failedWorkspaces = statePersistFailedWorkspaces(error);
    res.status(status).json({
      error: sanitizeLogText(redactLogCredentials(raw), MAX_ERROR_LENGTH),
      code,
      // A failed per-channel stop can still have torn down channels, and
      // the service marks the error when that record ALSO failed to
      // persist: the client has no retry handle, so the loss must ride
      // the error body — mirroring the DELETE route's statePersisted
      // field (#8975) and carrying the failed workspaces for a targeted
      // retry (R14).
      ...(statePersistedFalse(error) ? { statePersisted: false } : {}),
      ...(failedWorkspaces
        ? { statePersistFailedWorkspaces: failedWorkspaces }
        : {}),
    });
    return;
  }
  res.status(500).json({
    error: 'Channel management operation failed.',
    code: 'channel_management_failed',
  });
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

async function resolveTarget(
  req: Request,
  res: Response,
  resolveRuntime: RuntimeResolver,
  resolveService: RegisterWorkspaceChannelManagementRoutesDeps['resolveService'],
  activity: ConversationRuntimeActivityGate | undefined,
): Promise<
  | {
      runtime: WorkspaceRuntime;
      service: ChannelManagementService;
      run: <T>(operation: () => Promise<T>) => Promise<T>;
    }
  | undefined
> {
  const runtime = resolveRuntime(req, res);
  if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
  if (runtime.provenance === 'live-conversation' && req.method !== 'GET') {
    res.status(400).json({
      error:
        'Channel configuration and lifecycle operations are unavailable in the Conversations workspace.',
      code: 'live_channel_management_reserved',
    });
    return;
  }
  if (runtime.provenance === 'live-conversation' && !activity) {
    sendConversationRuntimeUnavailable(res);
    return;
  }
  try {
    const run = <T>(operation: () => Promise<T>): Promise<T> =>
      runtime.provenance === 'live-conversation'
        ? activity!.run(operation)
        : operation();
    const service = await run(async () => resolveService(runtime));
    if (!service) {
      res.status(503).json({
        error: 'Channel management is unavailable.',
        code: 'channel_management_unavailable',
      });
      return;
    }
    return { runtime, service, run };
  } catch (error) {
    sendManagementError(res, error);
    return;
  }
}

export function registerWorkspaceChannelManagementRoutes(
  app: Application,
  deps: RegisterWorkspaceChannelManagementRoutesDeps,
): void {
  const primary: RuntimeResolver = () => deps.primaryRuntime;
  const qualified: RuntimeResolver = (req, res) =>
    resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );

  const register = (prefix: string, resolveRuntime: RuntimeResolver) => {
    const pairingRead = deps.mutate({ strict: true });
    const pairingApprove = deps.mutate({ strict: true });
    const pairingApprovalsRead = deps.mutate({ strict: true });
    const pairingRevoke = deps.mutate({ strict: true });
    const upsert = deps.mutate({ strict: true });
    const remove = deps.mutate({ strict: true });
    const startup = deps.mutate({ strict: true });
    const start = deps.mutate({ strict: true });
    const stop = deps.mutate({ strict: true });
    const restart = deps.mutate({ strict: true });

    const target = (req: Request, res: Response) =>
      resolveTarget(
        req,
        res,
        resolveRuntime,
        deps.resolveService,
        deps.conversationRuntimeActivity,
      );
    const validateClient = (
      req: Request,
      res: Response,
      runtime: WorkspaceRuntime,
    ) => deps.parseAndValidateClientId(req, res, runtime) !== null;

    app.get(`${prefix}/channel-types`, async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      if (
        runtime.provenance === 'live-conversation' &&
        !deps.conversationRuntimeActivity
      ) {
        sendConversationRuntimeUnavailable(res);
        return;
      }
      try {
        noStore(res);
        const catalog =
          runtime.provenance === 'live-conversation' &&
          deps.conversationRuntimeActivity
            ? await deps.conversationRuntimeActivity.run(() =>
                supportedChannelCatalog(),
              )
            : await supportedChannelCatalog();
        res.status(200).json(catalog);
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.get(`${prefix}/channels`, async (req, res) => {
      const resolved = await target(req, res);
      if (!resolved || !validateClient(req, res, resolved.runtime)) return;
      try {
        noStore(res);
        res.status(200).json(await resolved.run(() => resolved.service.list()));
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.get(
      `${prefix}/channels/:name/pairing-requests`,
      pairingRead,
      async (req, res) => {
        const resolved = await target(req, res);
        if (!resolved || !validateClient(req, res, resolved.runtime)) return;
        const name = parseInstanceName(req, res);
        if (!name) return;
        try {
          noStore(res);
          res
            .status(200)
            .json(
              await resolved.run(() => resolved.service.pairingRequests(name)),
            );
        } catch (error) {
          sendManagementError(res, error);
        }
      },
    );

    app.post(
      `${prefix}/channels/:name/pairing-requests/approve`,
      pairingApprove,
      async (req, res) => {
        const resolved = await target(req, res);
        if (!resolved || !validateClient(req, res, resolved.runtime)) return;
        const name = parseInstanceName(req, res);
        if (!name) return;
        const code = parsePairingCode(deps.safeBody(req), res);
        if (!code) return;
        try {
          noStore(res);
          res
            .status(200)
            .json(
              await resolved.run(() =>
                resolved.service.approvePairing(name, code),
              ),
            );
        } catch (error) {
          sendManagementError(res, error);
        }
      },
    );

    app.get(
      `${prefix}/channels/:name/pairing-approvals`,
      pairingApprovalsRead,
      async (req, res) => {
        const resolved = await target(req, res);
        if (!resolved || !validateClient(req, res, resolved.runtime)) return;
        const name = parseInstanceName(req, res);
        if (!name) return;
        try {
          noStore(res);
          res
            .status(200)
            .json(
              await resolved.run(() => resolved.service.pairingApprovals(name)),
            );
        } catch (error) {
          sendManagementError(res, error);
        }
      },
    );

    app.delete(
      `${prefix}/channels/:name/pairing-approvals`,
      pairingRevoke,
      async (req, res) => {
        const resolved = await target(req, res);
        if (!resolved || !validateClient(req, res, resolved.runtime)) return;
        const name = parseInstanceName(req, res);
        if (!name) return;
        const subject = parsePairingApprovalSubject(deps.safeBody(req), res);
        if (!subject) return;
        try {
          noStore(res);
          res
            .status(200)
            .json(
              await resolved.run(() =>
                resolved.service.revokePairingApproval(name, subject),
              ),
            );
        } catch (error) {
          sendManagementError(res, error);
        }
      },
    );

    app.put(`${prefix}/channels/:name`, upsert, async (req, res) => {
      const resolved = await target(req, res);
      if (!resolved || !validateClient(req, res, resolved.runtime)) return;
      const name = parseInstanceName(req, res);
      if (!name) return;
      const request = parseUpsert(deps.safeBody(req), res);
      if (!request) return;
      try {
        noStore(res);
        res
          .status(200)
          .json(
            await resolved.run(() => resolved.service.upsert(name, request)),
          );
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.delete(`${prefix}/channels/:name`, remove, async (req, res) => {
      const resolved = await target(req, res);
      if (!resolved || !validateClient(req, res, resolved.runtime)) return;
      const name = parseInstanceName(req, res);
      if (!name) return;
      const request = parseRevision(deps.safeBody(req), res);
      if (!request) return;
      try {
        noStore(res);
        res
          .status(200)
          .json(
            await resolved.run(() => resolved.service.remove(name, request)),
          );
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.put(`${prefix}/channels/:name/startup`, startup, async (req, res) => {
      const resolved = await target(req, res);
      if (!resolved || !validateClient(req, res, resolved.runtime)) return;
      const name = parseInstanceName(req, res);
      if (!name) return;
      const request = parseStartup(deps.safeBody(req), res);
      if (!request) return;
      try {
        noStore(res);
        res
          .status(200)
          .json(
            await resolved.run(() =>
              resolved.service.setStartup(name, request),
            ),
          );
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    const action = (
      operation: 'start' | 'stop' | 'restart',
      middleware: RequestHandler,
    ) => {
      app.post(
        `${prefix}/channels/:name/${operation}`,
        middleware,
        async (req, res) => {
          const resolved = await target(req, res);
          if (!resolved || !validateClient(req, res, resolved.runtime)) return;
          const name = parseInstanceName(req, res);
          if (!name) return;
          try {
            noStore(res);
            res
              .status(200)
              .json(
                await resolved.run(() => resolved.service[operation](name)),
              );
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );
    };
    action('start', start);
    action('stop', stop);
    action('restart', restart);
  };

  register('/workspace', primary);
  register('/workspaces/:workspace', qualified);
}
