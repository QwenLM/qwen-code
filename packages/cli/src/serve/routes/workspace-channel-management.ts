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
  ChannelManagementService,
  ChannelUpsertRequest,
  RevisionRequest,
} from '../channel-management-service.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

const MAX_CHANNEL_INSTANCE_NAME_LENGTH = 256;
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
}

type RuntimeResolver = (req: Request, res: Response) => WorkspaceRuntime | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInstanceName(req: Request, res: Response): string | undefined {
  const name = req.params['name'] ?? '';
  if (
    name.trim().length === 0 ||
    name.includes('/') ||
    name.length > MAX_CHANNEL_INSTANCE_NAME_LENGTH
  ) {
    res.status(400).json({
      error: `Channel instance names must be non-empty, contain no slash, and be at most ${MAX_CHANNEL_INSTANCE_NAME_LENGTH} characters.`,
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
  if (
    !isRecord(config) ||
    typeof config['type'] !== 'string' ||
    config['type'].length === 0 ||
    (secrets !== undefined && !isRecord(secrets))
  ) {
    res.status(400).json({
      error:
        '`config` must be an object with a non-empty `type`; `secrets` must be an object when provided.',
      code: 'invalid_channel_management_request',
    });
    return undefined;
  }
  return {
    expectedRevision: revision.expectedRevision,
    config: config as Record<string, unknown> & { type: string },
    ...(secrets
      ? {
          secrets: secrets as NonNullable<ChannelUpsertRequest['secrets']>,
        }
      : {}),
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
]);

function sendManagementError(res: Response, error: unknown): void {
  const code = errorCode(error);
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
  const startMutation = deps.mutate({ strict: true });
  const stopMutation = deps.mutate({ strict: true });
  const restartMutation = deps.mutate({ strict: true });

  const register = (prefix: string, resolveRuntime: RuntimeResolver) => {
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
      const name = parseInstanceName(req, res);
      if (!name) return;
      const body = parseRevisionRequest(deps.safeBody(req), res);
      if (!body) return;
      try {
        res.status(200).json(await target.service.remove(name, body));
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
