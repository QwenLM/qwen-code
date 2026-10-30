/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { MANAGED_SHELL_ROUTE } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedShellError,
  type ManagedShellRuntime,
} from './managed-shell-runtime.js';

export const MANAGED_SHELL_WORKER_ROUTE = Object.freeze({
  key: 'shell',
  method: 'POST',
  path: MANAGED_SHELL_ROUTE,
  protocolVersion: 1,
  requestBodyLimitBytes: 16 * 1024,
  responseBodyLimitBytes: 64 * 1024,
  cacheControl: 'no-store',
} as const);

export function registerManagedShellRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  runtime: ManagedShellRuntime,
): void {
  app.post(
    MANAGED_SHELL_ROUTE,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(MANAGED_SHELL_WORKER_ROUTE.requestBodyLimitBytes),
    async (req: Request, res: Response) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ code: 'managed_shell_invalid' });
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
        res.status(400).json({ code: 'managed_shell_invalid' });
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
          error instanceof ManagedShellError
            ? error.code
            : 'managed_shell_unavailable';
        res.status(code === 'managed_shell_invalid' ? 400 : 409).json({ code });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
