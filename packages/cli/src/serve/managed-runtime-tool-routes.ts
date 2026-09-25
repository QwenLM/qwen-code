/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application } from 'express';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeNoStore,
  OWNED_MANAGED_RUNTIME_ROUTES,
  type ManagedRuntimeAttestationIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedToolConflictError,
  type ManagedToolExecutor,
  type ManagedToolReference,
} from './managed-runtime-tool-executor.js';

const REFERENCE_KEYS = Object.freeze([
  'argsDigest',
  'callId',
  'promptId',
  'sessionId',
] as const);

const INVALID_MESSAGE = 'Managed Runtime tool request is invalid.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseReference(value: unknown): ManagedToolReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== REFERENCE_KEYS.length ||
    !keys.every((key, index) => key === REFERENCE_KEYS[index])
  ) {
    return null;
  }
  const reference = value as Record<string, unknown>;
  if (
    !isNonEmptyString(reference['sessionId']) ||
    !isNonEmptyString(reference['promptId']) ||
    !isNonEmptyString(reference['callId']) ||
    !isNonEmptyString(reference['argsDigest'])
  ) {
    return null;
  }
  return reference as unknown as ManagedToolReference;
}

function parseClosedBody(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body['protocolVersion'] !== 2) {
    return null;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return null;
  }
  if (requiredKeys.some((key) => !(key in body))) {
    return null;
  }
  return body;
}

function invalid(res: express.Response): void {
  res.status(400).json({
    code: 'managed_runtime_attestation_invalid',
    error: INVALID_MESSAGE,
  });
}

/** Mounts the v2 execute/status/cancel routes with the shared discipline. */
export function registerManagedRuntimeToolRoutes(
  app: Application,
  identity: ManagedRuntimeAttestationIdentity,
  executor: ManagedToolExecutor,
): void {
  const routes = new Map(
    OWNED_MANAGED_RUNTIME_ROUTES.filter((route) => route.key !== 'attest').map(
      (route) => [route.key, route],
    ),
  );

  app.post(
    routes.get('execute')!.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    express.json({
      inflate: false,
      limit: routes.get('execute')!.requestBodyLimitBytes,
      strict: true,
      type: 'application/json',
    }),
    async (req: express.Request, res: express.Response) => {
      const body = parseClosedBody(req.body, [
        'protocolVersion',
        'reference',
        'toolName',
        'input',
      ]);
      const reference = body && parseReference(body['reference']);
      const toolName = body?.['toolName'];
      const input = body?.['input'];
      if (
        !body ||
        !reference ||
        !isNonEmptyString(toolName) ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
      ) {
        invalid(res);
        return;
      }
      if (!executor.hasTool(toolName)) {
        res.status(409).json({
          code: 'managed_runtime_identity_conflict',
          error: 'Managed Runtime does not admit this tool.',
        });
        return;
      }
      try {
        const result = await executor.execute(
          reference,
          toolName,
          input as Record<string, unknown>,
        );
        res.status(200).json({ protocolVersion: 2, state: 'settled', result });
      } catch (error) {
        if (error instanceof ManagedToolConflictError) {
          res.status(409).json({
            code: 'managed_runtime_identity_conflict',
            error: 'Managed Runtime invocation identity conflicts.',
          });
          return;
        }
        throw error;
      }
    },
    handleManagedRuntimeJsonError,
  );

  app.post(
    routes.get('status')!.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    express.json({
      inflate: false,
      limit: routes.get('status')!.requestBodyLimitBytes,
      strict: true,
      type: 'application/json',
    }),
    (req: express.Request, res: express.Response) => {
      const body = parseClosedBody(
        req.body,
        ['protocolVersion', 'reference'],
        ['afterSequence'],
      );
      const reference = body && parseReference(body['reference']);
      const afterSequence = body?.['afterSequence'];
      if (
        !body ||
        !reference ||
        (afterSequence !== undefined &&
          (typeof afterSequence !== 'number' ||
            !Number.isSafeInteger(afterSequence) ||
            afterSequence < 0))
      ) {
        invalid(res);
        return;
      }
      const view = executor.status(reference);
      if (!view) {
        res.status(200).json({ protocolVersion: 2, state: 'unknown' });
        return;
      }
      res.status(200).json({
        protocolVersion: 2,
        state: view.state,
        ...(view.state === 'settled' ? { result: view.result } : {}),
        lastSequence: view.lastSequence,
      });
    },
    handleManagedRuntimeJsonError,
  );

  app.post(
    routes.get('cancel')!.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    express.json({
      inflate: false,
      limit: routes.get('cancel')!.requestBodyLimitBytes,
      strict: true,
      type: 'application/json',
    }),
    (req: express.Request, res: express.Response) => {
      const body = parseClosedBody(req.body, ['protocolVersion', 'reference']);
      const reference = body && parseReference(body['reference']);
      if (!body || !reference) {
        invalid(res);
        return;
      }
      const view = executor.cancel(reference);
      if (!view) {
        res.status(200).json({ protocolVersion: 2, state: 'unknown' });
        return;
      }
      res.status(200).json({
        protocolVersion: 2,
        state: view.state,
        ...(view.state === 'settled' ? { result: view.result } : {}),
      });
    },
    handleManagedRuntimeJsonError,
  );
}
