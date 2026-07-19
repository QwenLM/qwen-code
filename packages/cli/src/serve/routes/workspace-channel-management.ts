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
  ChannelAuthSessionKey,
  ChannelAuthSessionManager,
} from '../channel-auth-session-manager.js';
import { renderChannelQrImage } from '../channel-qr-image.js';
import type {
  ChannelManagementService,
  ChannelStartupRequest,
  ChannelUpsertRequest,
  RevisionRequest,
} from '../channel-management-service.js';
import {
  isSafeChannelName,
  MAX_CHANNEL_INSTANCE_NAME_BYTES,
} from '../channel-selection.js';
import { assertValidChannelSecretUpdates } from '../channel-settings-store.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

const MAX_CHANNEL_MANAGEMENT_ERROR_LENGTH = 512;

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
  authManager?: ChannelAuthSessionManager;
}

type RuntimeResolver = (req: Request, res: Response) => WorkspaceRuntime | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSecretUpdates(
  value: unknown,
  res: Response,
): NonNullable<ChannelUpsertRequest['secrets']> | undefined {
  try {
    assertValidChannelSecretUpdates(value);
    return value;
  } catch {
    res.status(400).json({
      error: 'Secret updates are invalid.',
      code: 'channel_settings_invalid_secret',
    });
    return undefined;
  }
}

function parseInstanceName(
  req: Request,
  res: Response,
  options: { allowReservedAll?: boolean } = {},
): string | undefined {
  const name = req.params['name'] ?? '';
  if (!isSafeChannelName(name, options)) {
    res.status(400).json({
      error: `Channel instance names must be non-empty portable path components, differ from the reserved name "all", and be at most ${MAX_CHANNEL_INSTANCE_NAME_BYTES} UTF-8 bytes.`,
      code: 'invalid_channel_instance_name',
    });
    return undefined;
  }
  return name;
}

function parseRevisionRequest(
  body: Record<string, unknown>,
  res: Response,
): RevisionRequest | undefined {
  if (
    typeof body['expectedRevision'] !== 'string' ||
    body['expectedRevision'].length === 0
  ) {
    res.status(400).json({
      error: '`expectedRevision` must be a non-empty string.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  return { expectedRevision: body['expectedRevision'] };
}

function parseUpsertRequest(
  body: Record<string, unknown>,
  res: Response,
): ChannelUpsertRequest | undefined {
  const revision = parseRevisionRequest(body, res);
  if (!revision) return undefined;
  const config = body['config'];
  const secrets = body['secrets'];
  const webhookSecrets = body['webhookSecrets'];
  if (
    !isRecord(config) ||
    typeof config['type'] !== 'string' ||
    config['type'].length === 0
  ) {
    res.status(400).json({
      error:
        '`config` must be an object with a non-empty `type`; secret updates must be objects when provided.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  const parsedSecrets =
    secrets === undefined ? undefined : parseSecretUpdates(secrets, res);
  if (secrets !== undefined && parsedSecrets === undefined) return undefined;
  const parsedWebhookSecrets =
    webhookSecrets === undefined
      ? undefined
      : parseSecretUpdates(webhookSecrets, res);
  if (webhookSecrets !== undefined && parsedWebhookSecrets === undefined) {
    return undefined;
  }
  return {
    expectedRevision: revision.expectedRevision,
    config: config as Record<string, unknown> & { type: string },
    ...(parsedSecrets
      ? {
          secrets: parsedSecrets,
        }
      : {}),
    ...(parsedWebhookSecrets
      ? {
          webhookSecrets: parsedWebhookSecrets,
        }
      : {}),
  };
}

function parseStartupRequest(
  body: Record<string, unknown>,
  res: Response,
): ChannelStartupRequest | undefined {
  const revision = parseRevisionRequest(body, res);
  if (!revision) return undefined;
  if (typeof body['enabled'] !== 'boolean') {
    res.status(400).json({
      error: '`enabled` must be a boolean.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  return {
    expectedRevision: revision.expectedRevision,
    enabled: body['enabled'],
  };
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

const ERROR_STATUS = new Map<string, number>([
  ['invalid_channel_instance_name', 400],
  ['channel_settings_invalid_config', 400],
  ['channel_settings_invalid_secret', 400],
  ['channel_settings_unmanageable', 400],
  ['channel_workspace_mismatch', 400],
  ['ambiguous_channel_workspace', 400],
  ['untrusted_workspace', 403],
  ['channel_instance_not_found', 404],
  ['channel_settings_conflict', 409],
  ['channel_runtime_owner_mismatch', 409],
  ['channel_worker_not_enabled', 409],
  ['channel_service_conflict', 409],
  ['channel_worker_start_failed', 502],
  ['channel_worker_stop_failed', 500],
  ['daemon_draining', 503],
  ['channel_worker_unavailable', 503],
  ['channel_auth_instance_mismatch', 400],
  ['channel_auth_unsupported', 400],
  ['channel_auth_qr_payload_too_large', 400],
  ['channel_auth_session_not_found', 404],
  ['channel_auth_in_progress', 409],
  ['channel_auth_commit_in_progress', 409],
  ['channel_auth_not_ready', 409],
  ['channel_auth_already_committed', 409],
  ['channel_auth_cancelled', 410],
  ['channel_auth_expired', 410],
  ['channel_auth_qr_unavailable', 409],
  ['channel_auth_commit_failed', 500],
  ['channel_auth_failed', 500],
  ['channel_auth_unavailable', 503],
]);

function sendManagementError(res: Response, error: unknown): void {
  const code = errorCode(error);
  if (code === 'channel_auth_session_not_found') {
    res.status(404).json({
      error: 'Channel authentication session was not found.',
      code,
    });
    return;
  }
  const status = code ? ERROR_STATUS.get(code) : undefined;
  if (status !== undefined && code) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    res.status(status).json({
      error: sanitizeLogText(
        redactLogCredentials(rawMessage),
        MAX_CHANNEL_MANAGEMENT_ERROR_LENGTH,
      ),
      code,
    });
    return;
  }
  res.status(500).json({
    error: 'Channel management operation failed.',
    code: 'channel_management_failed',
  });
}

function parseChannelType(
  body: Record<string, unknown>,
  res: Response,
): string | undefined {
  const channelType = body['channelType'];
  if (
    typeof channelType !== 'string' ||
    channelType.length === 0 ||
    channelType.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(channelType)
  ) {
    res.status(400).json({
      error: '`channelType` must be a safe non-empty token.',
      code: 'invalid_channel_auth_request',
    });
    return undefined;
  }
  return channelType;
}

function parseAuthSessionId(req: Request, res: Response): string | undefined {
  const sessionId = req.params['id'] ?? '';
  if (
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    !/^[A-Za-z0-9-]+$/u.test(sessionId)
  ) {
    res.status(400).json({
      error: 'Channel authentication session id is invalid.',
      code: 'invalid_channel_auth_session_id',
    });
    return undefined;
  }
  return sessionId;
}

async function configuredChannelType(
  service: ChannelManagementService,
  name: string,
): Promise<string | undefined> {
  const instance = (await service.list()).instances[name];
  const channelType = instance?.config['type'];
  return typeof channelType === 'string' ? channelType : undefined;
}

function authKey(
  runtime: WorkspaceRuntime,
  name: string,
  channelType: string,
  clientId: string,
): ChannelAuthSessionKey {
  return {
    workspaceCwd: runtime.workspaceCwd,
    runtimeId: runtime.workspaceId,
    instanceName: name,
    channelType,
    clientId,
  };
}

async function resolveTarget(
  req: Request,
  res: Response,
  resolveRuntime: RuntimeResolver,
  resolveService: RegisterWorkspaceChannelManagementRoutesDeps['resolveService'],
): Promise<
  { runtime: WorkspaceRuntime; service: ChannelManagementService } | undefined
> {
  const runtime = resolveRuntime(req, res);
  if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
  let service: ChannelManagementService | undefined;
  try {
    service = await resolveService(runtime);
  } catch (error) {
    sendManagementError(res, error);
    return;
  }
  if (!service) {
    res.status(503).json({
      error: 'Channel management is unavailable.',
      code: 'channel_management_unavailable',
    });
    return;
  }
  return { runtime, service };
}

export function registerWorkspaceChannelManagementRoutes(
  app: Application,
  deps: RegisterWorkspaceChannelManagementRoutesDeps,
): void {
  const primary: RuntimeResolver = (_req, _res) => deps.primaryRuntime;
  const qualified: RuntimeResolver = (req, res) =>
    resolveWorkspaceRuntimeFromParam(deps.workspaceRegistry, req, res);
  const putMutation = deps.mutate({ strict: true });
  const deleteMutation = deps.mutate({ strict: true });
  const startupMutation = deps.mutate({ strict: true });
  const startMutation = deps.mutate({ strict: true });
  const stopMutation = deps.mutate({ strict: true });
  const restartMutation = deps.mutate({ strict: true });
  const beginAuth = deps.authManager
    ? deps.mutate({ strict: true })
    : undefined;
  const readAuth = deps.authManager ? deps.mutate() : undefined;
  const cancelAuth = deps.authManager
    ? deps.mutate({ strict: true })
    : undefined;
  const readAuthQr = deps.authManager ? deps.mutate() : undefined;
  const commitAuth = deps.authManager
    ? deps.mutate({ strict: true })
    : undefined;

  const register = (prefix: string, resolveRuntime: RuntimeResolver) => {
    if (
      deps.authManager &&
      beginAuth &&
      readAuth &&
      cancelAuth &&
      readAuthQr &&
      commitAuth
    ) {
      const resolveAuthKey = async (
        req: Request,
        res: Response,
        bodyChannelType?: string,
      ): Promise<
        | {
            key: ChannelAuthSessionKey;
            sessionId?: string;
            service: ChannelManagementService;
            name: string;
          }
        | undefined
      > => {
        const target = await resolveTarget(
          req,
          res,
          resolveRuntime,
          deps.resolveService,
        );
        if (!target) return;
        const clientId = deps.parseAndValidateClientId(
          req,
          res,
          target.runtime,
        );
        if (clientId === null) return;
        if (!clientId) {
          res.status(400).json({
            error: '`X-Qwen-Client-Id` is required for Channel authentication.',
            code: 'channel_auth_client_required',
          });
          return;
        }
        const name = parseInstanceName(req, res);
        if (!name) return;
        let configuredType: string | undefined;
        try {
          configuredType = await configuredChannelType(target.service, name);
        } catch (error) {
          sendManagementError(res, error);
          return;
        }
        if (
          !configuredType ||
          (bodyChannelType && configuredType !== bodyChannelType)
        ) {
          res.status(404).json({
            error: 'Channel authentication session was not found.',
            code: 'channel_auth_session_not_found',
          });
          return;
        }
        const sessionId = req.params['id']
          ? parseAuthSessionId(req, res)
          : undefined;
        if (req.params['id'] && !sessionId) return;
        return {
          key: authKey(target.runtime, name, configuredType, clientId),
          service: target.service,
          name,
          ...(sessionId ? { sessionId } : {}),
        };
      };

      app.post(
        `${prefix}/channels/:name/auth-sessions`,
        beginAuth,
        async (req, res) => {
          const channelType = parseChannelType(deps.safeBody(req), res);
          if (!channelType) return;
          const target = await resolveAuthKey(req, res, channelType);
          if (!target) return;
          try {
            res.status(201).json(await deps.authManager!.begin(target.key));
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );

      app.get(
        `${prefix}/channels/:name/auth-sessions/:id`,
        readAuth,
        async (req, res) => {
          const target = await resolveAuthKey(req, res);
          if (!target?.sessionId) return;
          try {
            res
              .status(200)
              .json(deps.authManager!.get(target.key, target.sessionId));
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );

      app.delete(
        `${prefix}/channels/:name/auth-sessions/:id`,
        cancelAuth,
        async (req, res) => {
          const target = await resolveAuthKey(req, res);
          if (!target?.sessionId) return;
          try {
            deps.authManager!.cancel(target.key, target.sessionId);
            res.status(200).json({ cancelled: true });
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );

      app.get(
        `${prefix}/channels/:name/auth-sessions/:id/qr`,
        readAuthQr,
        async (req, res) => {
          const target = await resolveAuthKey(req, res);
          if (!target?.sessionId) return;
          try {
            const qr = deps.authManager!.getQr(target.key, target.sessionId);
            const image = await renderChannelQrImage(qr.payload);
            res.set('Cache-Control', 'no-store');
            res.set('X-Content-Type-Options', 'nosniff');
            res.type(image.contentType).status(200).send(image.bytes);
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );

      app.post(
        `${prefix}/channels/:name/auth-sessions/:id/commit`,
        commitAuth,
        async (req, res) => {
          const channelType = parseChannelType(deps.safeBody(req), res);
          if (!channelType) return;
          const target = await resolveAuthKey(req, res, channelType);
          if (!target?.sessionId) return;
          try {
            await deps.authManager!.commit(target.key, target.sessionId);
            const snapshot = await target.service.list();
            const instance = snapshot.instances[target.name];
            if (!instance) {
              res.status(404).json({
                error: 'Channel authentication session was not found.',
                code: 'channel_auth_session_not_found',
              });
              return;
            }
            res.status(200).json({ snapshot, instance });
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );
    }

    app.get(`${prefix}/channel-types`, async (req, res) => {
      const target = await resolveTarget(
        req,
        res,
        resolveRuntime,
        deps.resolveService,
      );
      if (!target) return;
      try {
        res.status(200).json(await supportedChannelCatalog());
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.get(`${prefix}/channels`, async (req, res) => {
      const target = await resolveTarget(
        req,
        res,
        resolveRuntime,
        deps.resolveService,
      );
      if (!target) return;
      try {
        res.status(200).json(await target.service.list());
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.put(`${prefix}/channels/:name`, putMutation, async (req, res) => {
      const target = await resolveTarget(
        req,
        res,
        resolveRuntime,
        deps.resolveService,
      );
      if (!target) return;
      if (deps.parseAndValidateClientId(req, res, target.runtime) === null)
        return;
      const name = parseInstanceName(req, res);
      if (!name) return;
      const body = parseUpsertRequest(deps.safeBody(req), res);
      if (!body) return;
      try {
        res.status(200).json(await target.service.upsert(name, body));
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.delete(`${prefix}/channels/:name`, deleteMutation, async (req, res) => {
      const target = await resolveTarget(
        req,
        res,
        resolveRuntime,
        deps.resolveService,
      );
      if (!target) return;
      if (deps.parseAndValidateClientId(req, res, target.runtime) === null)
        return;
      const name = parseInstanceName(req, res, { allowReservedAll: true });
      if (!name) return;
      const body = parseRevisionRequest(deps.safeBody(req), res);
      if (!body) return;
      try {
        res.status(200).json(await target.service.remove(name, body));
      } catch (error) {
        sendManagementError(res, error);
      }
    });

    app.put(
      `${prefix}/channels/:name/startup`,
      startupMutation,
      async (req, res) => {
        const target = await resolveTarget(
          req,
          res,
          resolveRuntime,
          deps.resolveService,
        );
        if (!target) return;
        if (deps.parseAndValidateClientId(req, res, target.runtime) === null)
          return;
        const name = parseInstanceName(req, res);
        if (!name) return;
        const body = parseStartupRequest(deps.safeBody(req), res);
        if (!body) return;
        try {
          res.status(200).json(await target.service.setStartup(name, body));
        } catch (error) {
          sendManagementError(res, error);
        }
      },
    );

    const action = (
      operation: 'start' | 'stop' | 'restart',
      middleware: RequestHandler,
    ) => {
      app.post(
        `${prefix}/channels/:name/${operation}`,
        middleware,
        async (req, res) => {
          const target = await resolveTarget(
            req,
            res,
            resolveRuntime,
            deps.resolveService,
          );
          if (!target) return;
          if (deps.parseAndValidateClientId(req, res, target.runtime) === null)
            return;
          const name = parseInstanceName(req, res);
          if (!name) return;
          try {
            res.status(200).json(await target.service[operation](name));
          } catch (error) {
            sendManagementError(res, error);
          }
        },
      );
    };
    action('start', startMutation);
    action('stop', stopMutation);
    action('restart', restartMutation);
  };

  register('/workspace', primary);
  register('/workspaces/:workspace', qualified);
}
