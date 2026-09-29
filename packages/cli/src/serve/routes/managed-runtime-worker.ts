/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { dispatchManagedToolRuntimeRequest } from '../../acp-integration/managed-tool-runtime-session.js';
import {
  MANAGED_LEASE_ID_HEADER,
  MANAGED_LEASE_EPOCH_HEADER,
  type ManagedWorkerBoot,
} from '../managed-runtime-activator.js';
import type { ManagedWorkerFileBoot } from '../managed-runtime-worker-bootstrap.js';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { ManagedRuntimeProvider } from '../managed-runtime-provider.js';
import { ManagedRuntimeProviderError } from '../managed-runtime-provider.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_ROUTE_PREFIX,
  ManagedRuntimeProtocolError,
  parseManagedRuntimeCancelRequest,
  parseManagedRuntimeExecuteRequest,
  parseManagedRuntimePrepareRequest,
} from '../managed-runtime-protocol.js';

export interface RegisterManagedRuntimeWorkerRoutesDeps {
  readonly provider: ManagedRuntimeProvider;
  readonly owned?: ManagedWorkerBoot | ManagedWorkerFileBoot;
  readonly authorize: RequestHandler;
}

function requestSignal(
  req: Request,
  res: Response,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(
        new DOMException(
          'Managed Runtime HTTP client disconnected.',
          'AbortError',
        ),
      );
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
}

function sendError(res: Response, error: unknown, fallbackStatus = 500): void {
  if (res.headersSent || res.writableEnded) return;
  if (error instanceof ManagedRuntimeProtocolError) {
    res.status(400).json({
      error: 'Managed Runtime request is invalid.',
      code: error.code,
    });
    return;
  }
  if (error instanceof ManagedRuntimeProviderError) {
    res.status(error.retryable ? 503 : 409).json({
      error: error.retryable
        ? 'Managed Runtime is unavailable.'
        : 'Managed Runtime request conflicts with its Session binding.',
      code: error.code,
    });
    return;
  }
  res.status(fallbackStatus).json({
    error: 'Managed Runtime operation failed.',
    code: 'managed_runtime_operation_failed',
  });
}

export function registerManagedRuntimeWorkerRoutes(
  app: Application,
  deps: RegisterManagedRuntimeWorkerRoutesDeps,
): void {
  const authorize: RequestHandler = (req, res, next) =>
    deps.authorize(req, res, () => {
      const owned = deps.owned;
      if (
        owned &&
        (req.get(MANAGED_LEASE_ID_HEADER) !== owned.leaseId ||
          req.get(MANAGED_LEASE_EPOCH_HEADER) !== String(owned.epoch) ||
          req.body?.tenantId !== owned.tenantId ||
          req.body?.workspaceId !== owned.workspaceId ||
          req.body?.workspaceCwd !== owned.workspaceCwd)
      ) {
        res.status(409).json({
          code: 'managed_runtime_identity_conflict',
          error: 'Managed Runtime lease or workspace binding conflicts.',
        });
        return;
      }
      next();
    });
  if (deps.owned && 'runtimeInstanceId' in deps.owned) {
    const owned = deps.owned;
    app.post('/internal/managed-runtime/v2/attest', authorize, (req, res) => {
      // The Broker refuses an attestation it could have cached (see the
      // owned-route contract), so every answer from this route says so.
      res.setHeader('Cache-Control', 'no-store');
      const body: unknown = req.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body as Record<string, unknown>)['protocolVersion'] !== 2
      ) {
        sendError(res, new ManagedRuntimeProtocolError());
        return;
      }
      const value = body as Record<string, unknown>;
      if (
        value['provisionRequestId'] !== owned.provisionRequestId ||
        value['tenantId'] !== owned.tenantId ||
        value['workspaceId'] !== owned.workspaceId ||
        value['workspaceGeneration'] !== owned.workspaceGeneration ||
        value['workspaceCwd'] !== owned.workspaceCwd ||
        value['capabilityDigest'] !== owned.capabilityDigest ||
        value['isolationClass'] !== owned.isolationClass
      ) {
        res.status(409).json({
          code: 'managed_runtime_identity_conflict',
          error: 'Managed Runtime immutable identity conflicts.',
        });
        return;
      }
      res.status(200).json({
        protocolVersion: 2,
        runtimeInstanceId: owned.runtimeInstanceId,
        runtimeIncarnation: owned.gatewayIncarnation,
        leaseId: owned.leaseId,
        epoch: owned.epoch,
        provisionRequestId: owned.provisionRequestId,
        tenantId: owned.tenantId,
        workspaceId: owned.workspaceId,
        workspaceGeneration: owned.workspaceGeneration,
        workspaceCwd: owned.workspaceCwd,
        capabilityDigest: owned.capabilityDigest,
        isolationClass: owned.isolationClass,
      });
    });
  }
  if (deps.owned && deps.provider.getToolV2Client) {
    app.post(
      '/internal/managed-runtime/v2/release',
      authorize,
      async (req, res) => {
        try {
          const body: unknown = req.body;
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            (body as Record<string, unknown>)['protocolVersion'] !== 2
          )
            throw new ManagedRuntimeProtocolError();
          const request = parseManagedRuntimePrepareRequest({
            ...body,
            protocolVersion: 1,
          });
          const released = await deps.provider.release(
            request.sessionId,
            request,
            {
              terminal: true,
            },
          );
          res.status(200).json({ protocolVersion: 2, released });
        } catch (error) {
          sendError(res, error);
        }
      },
    );
    const operations = {
      'bind-history': SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2BindHistory,
      checkpoint: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Checkpoint,
      history: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2History,
      manifest: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Manifest,
      'begin-turn': SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2BeginTurn,
      prepare: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Prepare,
      confirmation: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Confirmation,
      confirm: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Confirm,
      preflight: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Preflight,
      execute: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Execute,
      status: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Status,
      cancel: SERVE_CONTROL_EXT_METHODS.sessionManagedToolV2Cancel,
    };
    for (const [operation, method] of Object.entries(operations)) {
      app.post(
        `/internal/managed-runtime/v2/${operation}`,
        authorize,
        async (req, res) => {
          try {
            const body: unknown = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new ManagedRuntimeProtocolError();
            const {
              protocolVersion,
              tenantId,
              workspaceId,
              workspaceCwd,
              sessionId,
              turnKind,
              ...params
            } = body as Record<string, unknown>;
            if (protocolVersion !== 2) throw new ManagedRuntimeProtocolError();
            const request = parseManagedRuntimePrepareRequest({
              protocolVersion: 1,
              tenantId,
              workspaceId,
              workspaceCwd,
              sessionId,
              turnKind,
            });
            const client = await deps.provider.getToolV2Client!(request);
            const result = await dispatchManagedToolRuntimeRequest(
              client,
              method,
              { ...params, sessionId: request.sessionId },
            );
            res.status(200).json({
              protocolVersion: 2,
              result:
                operation === 'begin-turn' || operation === 'confirm'
                  ? null
                  : result,
            });
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'managed_tool_invalid_request'
            ) {
              sendError(res, new ManagedRuntimeProtocolError());
            } else sendError(res, error);
          }
        },
      );
    }
  }

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`,
    authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        await deps.provider.prepare(request).ready;
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      } catch (error) {
        sendError(res, error, 503);
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/manifest`,
    authorize,
    async (req, res) => {
      const connection = requestSignal(req, res);
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        const handle = deps.provider.prepare(request);
        const manifest = await handle.getManifest(connection.signal);
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          manifest,
        });
      } catch (error) {
        sendError(res, error);
      } finally {
        connection.dispose();
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/execute`,
    authorize,
    async (req, res) => {
      const connection = requestSignal(req, res);
      try {
        const request = parseManagedRuntimeExecuteRequest(req.body);
        const handle = deps.provider.prepare(request);
        const result = await handle.execute(
          request.toolRequest,
          connection.signal,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          result,
        });
      } catch (error) {
        sendError(res, error);
      } finally {
        connection.dispose();
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/cancel`,
    authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimeCancelRequest(req.body);
        const cancelled = await deps.provider.cancel(
          request.sessionId,
          request.executionId,
          request,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          cancelled,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    `${MANAGED_RUNTIME_ROUTE_PREFIX}/release`,
    authorize,
    async (req, res) => {
      try {
        const request = parseManagedRuntimePrepareRequest(req.body);
        const released = await deps.provider.release(
          request.sessionId,
          request,
        );
        res.status(200).json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          released,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );
}
