/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { MANAGED_MONITOR_ROUTE } from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedMonitorError,
  type ManagedMonitorRuntime,
} from './managed-monitor-runtime.js';

export const MANAGED_MONITOR_WORKER_ROUTE = Object.freeze({
  key: 'monitor',
  method: 'POST',
  path: MANAGED_MONITOR_ROUTE,
  protocolVersion: 1,
  requestBodyLimitBytes: 16 * 1024,
  responseBodyLimitBytes: 64 * 1024,
  cacheControl: 'no-store',
} as const);

export function registerManagedMonitorRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  runtime: ManagedMonitorRuntime,
): void {
  app.post(
    MANAGED_MONITOR_ROUTE,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(MANAGED_MONITOR_WORKER_ROUTE.requestBodyLimitBytes),
    async (req: Request, res: Response) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ code: 'managed_monitor_invalid' });
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
        res.status(400).json({ code: 'managed_monitor_invalid' });
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
          error instanceof ManagedMonitorError
            ? error.code
            : 'managed_monitor_unavailable';
        res.status(code === 'managed_monitor_invalid' ? 400 : 409).json({
          code,
        });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
