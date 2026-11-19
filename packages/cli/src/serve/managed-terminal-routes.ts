/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { MANAGED_TERMINAL_ROUTE } from '@qwen-code/qwen-code-core/managed-runtime/managed-terminal-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import type { ManagedRuntimeTerminals } from './managed-runtime-terminal.js';

export const MANAGED_TERMINAL_WORKER_ROUTE = Object.freeze({
  key: 'terminal-control',
  method: 'POST',
  path: MANAGED_TERMINAL_ROUTE,
  protocolVersion: 1,
  requestBodyLimitBytes: 16 * 1024,
  responseBodyLimitBytes: 64 * 1024,
  cacheControl: 'no-store',
} as const);

export function registerManagedTerminalRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  terminals: ManagedRuntimeTerminals,
): void {
  app.post(
    MANAGED_TERMINAL_ROUTE,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(MANAGED_TERMINAL_WORKER_ROUTE.requestBodyLimitBytes),
    (req: Request, res: Response) => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ code: 'managed_terminal_invalid' });
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
        res.status(400).json({ code: 'managed_terminal_invalid' });
        return;
      }
      try {
        const operation = terminals.control(request['operation']);
        res.json({
          protocolVersion: 1,
          runtimeSessionId: request['runtimeSessionId'],
          operation,
        });
      } catch {
        res.status(400).json({ code: 'managed_terminal_invalid' });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
