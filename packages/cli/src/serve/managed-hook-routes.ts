/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  MANAGED_HOOK_ROUTE,
  MANAGED_HOOK_MAX_REQUEST_BYTES,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedHookError,
  type ManagedHookRuntime,
} from './managed-hook-runtime.js';

export const MANAGED_HOOK_WORKER_ROUTE = Object.freeze({
  key: 'hook',
  method: 'POST',
  path: MANAGED_HOOK_ROUTE,
  protocolVersion: 1,
  requestBodyLimitBytes: MANAGED_HOOK_MAX_REQUEST_BYTES,
  responseBodyLimitBytes: 1024 * 1024,
  cacheControl: 'no-store',
} as const);

export function registerManagedHookRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  runtime: ManagedHookRuntime,
): void {
  app.post(
    MANAGED_HOOK_ROUTE,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(MANAGED_HOOK_WORKER_ROUTE.requestBodyLimitBytes),
    async (req: Request, res: Response) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ code: 'managed_hook_invalid' });
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
        res.status(400).json({ code: 'managed_hook_invalid' });
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
          error instanceof ManagedHookError
            ? error.code
            : 'managed_hook_unavailable';
        res.status(code === 'managed_hook_invalid' ? 400 : 409).json({ code });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
