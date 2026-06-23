/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { FatalConfigError } from '@qwen-code/qwen-code-core';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const MAX_TRUST_REASON_LENGTH = 1024;

export interface WorkspaceTrustRouteDeps {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

function sendTrustError(res: Response, route: string, err: unknown): void {
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
  } = deps;

  app.get('/workspace/trust', async (_req: Request, res: Response) => {
    try {
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
