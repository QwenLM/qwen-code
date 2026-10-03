/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { MANAGED_MCP_ROUTE } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedMcpError,
  type ManagedMcpRuntime,
} from './managed-mcp-runtime.js';

export const MANAGED_MCP_WORKER_ROUTE = Object.freeze({
  key: 'mcp',
  method: 'POST',
  path: MANAGED_MCP_ROUTE,
  protocolVersion: 1,
  requestBodyLimitBytes: 256 * 1024,
  responseBodyLimitBytes: 1024 * 1024,
  cacheControl: 'no-store',
} as const);

export function registerManagedMcpRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  runtime: ManagedMcpRuntime,
): void {
  app.post(
    MANAGED_MCP_ROUTE,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(MANAGED_MCP_WORKER_ROUTE.requestBodyLimitBytes),
    async (req: Request, res: Response) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ code: 'managed_mcp_invalid' });
        return;
      }
      const request = body as Record<string, unknown>;
      if (
        Object.keys(request).sort().join(',') !==
          'operation,protocolVersion,runtimeSessionId' ||
        request['protocolVersion'] !== 1 ||
        typeof request['runtimeSessionId'] !== 'string' ||
        !request['runtimeSessionId']
      ) {
        res.status(400).json({ code: 'managed_mcp_invalid' });
        return;
      }
      try {
        const operation = await runtime.control(
          request['runtimeSessionId'],
          request['operation'],
        );
        res.json({
          protocolVersion: 1,
          runtimeSessionId: request['runtimeSessionId'],
          operation,
        });
      } catch (error) {
        const code =
          error instanceof ManagedMcpError
            ? error.code
            : 'managed_mcp_unavailable';
        res.status(code === 'managed_mcp_invalid' ? 400 : 409).json({ code });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
