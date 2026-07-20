/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { FatalConfigError } from '@qwen-code/qwen-code-core';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { MAX_TRUST_REASON_LENGTH } from '../validation-limits.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceEntry,
  WorkspaceRegistry,
} from '../workspace-registry.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import {
  evaluateDaemonWorkspaceTrust,
  readDaemonTrustPolicySnapshot,
  type DaemonTrustPolicySnapshot,
} from '../../config/daemon-trust-policy.js';

export interface WorkspaceTrustRouteDeps {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
  workspaceRegistry?: WorkspaceRegistry;
  workspaceTrustHotReloadAvailable?: boolean;
  getWorkspaceTrustPolicySnapshot?: () =>
    | DaemonTrustPolicySnapshot
    | Promise<DaemonTrustPolicySnapshot>;
}

function unavailableRuntime(res: Response): void {
  res.set('Retry-After', '1');
  res.status(503).json({
    error: 'Workspace runtime is not active',
    code: 'workspace_runtime_unavailable',
  });
}

function trustStatusV2(
  entry: WorkspaceEntry,
  snapshot: DaemonTrustPolicySnapshot,
) {
  const decision = evaluateDaemonWorkspaceTrust(snapshot, entry.workspaceCwd);
  const current = entry.state === 'active' ? entry.current : undefined;
  const reconciliationState =
    entry.state === 'transitioning' ||
    entry.configuredRevision !== snapshot.revision
      ? 'applying'
      : entry.state === 'blocked' ||
          entry.applyError !== undefined ||
          decision.state === 'error'
        ? 'failed'
        : 'stable';
  const errorCode =
    decision.error?.code ??
    (entry.applyError !== undefined ? 'runtime_rebuild_failed' : undefined);
  return {
    v: 2 as const,
    workspaceCwd: entry.workspaceCwd,
    folderTrustEnabled: snapshot.folderTrustEnabled,
    configured: {
      state: decision.state,
      source: decision.source,
      explicitTrustLevel: decision.explicitTrustLevel,
    },
    effective: current
      ? {
          state: current.runtime.trusted
            ? ('trusted' as const)
            : ('untrusted' as const),
          trusted: current.runtime.trusted,
        }
      : { state: 'unavailable' as const, trusted: null },
    reconciliation: {
      state: reconciliationState,
      revision: snapshot.revision,
      appliedRevision: entry.appliedRevision,
      ...(errorCode ? { error: { code: errorCode } } : {}),
    },
    requiresDaemonRestartForChanges: false as const,
  };
}

function sendTrustError(res: Response, route: string, err: unknown): void {
  if (sendGenerationClosedError(res, err)) return;
  writeStderrLine(
    `qwen serve: ${route} error: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  if (err instanceof FatalConfigError) {
    res.status(500).json({
      error: 'Failed to load trusted folders',
      code: 'trusted_folders_invalid',
    });
    return;
  }
  res.status(500).json({
    error: 'Failed to process workspace trust request',
    code: 'internal_error',
  });
}

export function registerWorkspaceTrustRoutes(
  app: Application,
  deps: WorkspaceTrustRouteDeps,
): void {
  const {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    parseAndValidateClientId,
    workspaceRegistry,
    workspaceTrustHotReloadAvailable,
    getWorkspaceTrustPolicySnapshot = readDaemonTrustPolicySnapshot,
  } = deps;

  app.get('/workspace/trust', async (req: Request, res: Response) => {
    try {
      if (
        req.query['statusVersion'] === '2' &&
        workspaceRegistry &&
        workspaceTrustHotReloadAvailable === true
      ) {
        res
          .status(200)
          .json(
            trustStatusV2(
              workspaceRegistry.primaryEntry,
              await getWorkspaceTrustPolicySnapshot(),
            ),
          );
        return;
      }
      const status = await workspace.getWorkspaceTrustStatus({
        route: 'GET /workspace/trust',
        workspaceCwd: boundWorkspace,
      });
      res.status(200).json(status);
    } catch (err) {
      sendTrustError(res, 'GET /workspace/trust', err);
    }
  });

  app.post(
    '/workspace/trust/request',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      if (
        workspaceRegistry &&
        workspaceRegistry.primaryEntry.state !== 'active'
      ) {
        unavailableRuntime(res);
        return;
      }
      const body = safeBody(req);
      const desiredState = body['desiredState'];
      if (desiredState !== 'trusted' && desiredState !== 'untrusted') {
        res.status(400).json({
          error: 'desiredState must be "trusted" or "untrusted"',
          code: 'invalid_desired_state',
        });
        return;
      }

      const reason = body['reason'];
      if (
        reason !== undefined &&
        (typeof reason !== 'string' || reason.length > MAX_TRUST_REASON_LENGTH)
      ) {
        res.status(400).json({
          error: `reason must be a string up to ${MAX_TRUST_REASON_LENGTH} characters`,
          code: 'invalid_reason',
        });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const ctx = {
        route: 'POST /workspace/trust/request',
        workspaceCwd: boundWorkspace,
        ...(clientId !== undefined ? { originatorClientId: clientId } : {}),
      };

      try {
        const status = await workspace.getWorkspaceTrustStatus(ctx);
        if (!status.folderTrustEnabled) {
          res.status(409).json({
            error: 'Folder trust is disabled for this workspace',
            code: 'folder_trust_disabled',
          });
          return;
        }
        const result = await workspace.requestWorkspaceTrustChange(ctx, {
          desiredState,
          ...(reason !== undefined ? { reason } : {}),
        });
        res.status(202).json(result);
      } catch (err) {
        sendTrustError(res, 'POST /workspace/trust/request', err);
      }
    },
  );
}

export function registerWorkspaceQualifiedTrustRoutes(
  app: Application,
  deps: Pick<
    WorkspaceTrustRouteDeps,
    'mutate' | 'safeBody' | 'getWorkspaceTrustPolicySnapshot'
  > & {
    workspaceRegistry: WorkspaceRegistry;
    workspaceTrustHotReloadAvailable?: boolean;
  },
): void {
  const { workspaceRegistry, mutate, safeBody } = deps;
  const getWorkspaceTrustPolicySnapshot =
    deps.getWorkspaceTrustPolicySnapshot ?? readDaemonTrustPolicySnapshot;

  app.get('/workspaces/:workspace/trust', async (req, res) => {
    if (
      req.query['statusVersion'] === '2' &&
      deps.workspaceTrustHotReloadAvailable === true
    ) {
      const entry = resolveWorkspaceEntryFromParam(workspaceRegistry, req, res);
      if (!entry) return;
      try {
        res
          .status(200)
          .json(trustStatusV2(entry, await getWorkspaceTrustPolicySnapshot()));
      } catch (err) {
        sendTrustError(res, 'GET /workspaces/:workspace/trust', err);
      }
      return;
    }
    const runtime = resolveWorkspaceRuntimeFromParam(
      workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    const route = 'GET /workspaces/:workspace/trust';
    try {
      const status = await runtime.workspaceService.getWorkspaceTrustStatus({
        route,
        workspaceCwd: runtime.workspaceCwd,
      });
      res.status(200).json(status);
    } catch (err) {
      sendTrustError(res, route, err);
    }
  });

  app.post(
    '/workspaces/:workspace/trust/request',
    mutate({ strict: true }),
    async (req, res) => {
      const entry = resolveWorkspaceEntryFromParam(workspaceRegistry, req, res);
      if (!entry) return;
      if (entry.state !== 'active' || !entry.current) {
        unavailableRuntime(res);
        return;
      }
      const runtime = resolveWorkspaceRuntimeFromParam(
        workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const body = safeBody(req);
      const desiredState = body['desiredState'];
      if (desiredState !== 'trusted' && desiredState !== 'untrusted') {
        res.status(400).json({
          error: 'desiredState must be "trusted" or "untrusted"',
          code: 'invalid_desired_state',
        });
        return;
      }

      const reason = body['reason'];
      if (
        reason !== undefined &&
        (typeof reason !== 'string' || reason.length > MAX_TRUST_REASON_LENGTH)
      ) {
        res.status(400).json({
          error: `reason must be a string up to ${MAX_TRUST_REASON_LENGTH} characters`,
          code: 'invalid_reason',
        });
        return;
      }

      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const route = 'POST /workspaces/:workspace/trust/request';
      const ctx = {
        route,
        workspaceCwd: runtime.workspaceCwd,
        ...(clientId !== undefined ? { originatorClientId: clientId } : {}),
      };
      try {
        const status =
          await runtime.workspaceService.getWorkspaceTrustStatus(ctx);
        if (!status.folderTrustEnabled) {
          res.status(409).json({
            error: 'Folder trust is disabled for this workspace',
            code: 'folder_trust_disabled',
          });
          return;
        }
        const result =
          await runtime.workspaceService.requestWorkspaceTrustChange(ctx, {
            desiredState,
            ...(reason !== undefined ? { reason } : {}),
          });
        res.status(202).json(result);
      } catch (err) {
        sendTrustError(res, route, err);
      }
    },
  );
}
