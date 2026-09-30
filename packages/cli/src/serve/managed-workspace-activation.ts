/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
} from './managed-runtime-attestation-contract.js';
import type {
  ManagedContextBoot,
  ManagedContextInstallations,
} from './managed-context-envelope.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import type { ManagedToolExecutor } from './managed-runtime-tool-executor.js';

export const WORKSPACE_EXECUTION_PROFILE = 'managed-workspace-execution/1';
export const WORKSPACE_CONTEXT_CONFIG_REF =
  'sha256:5fa15183dcfe582ce54c28bf25aff62801d19038a9ec649e9bfc67b06f2a389f';
export const WORKSPACE_CAPABILITY_DIGEST =
  'sha256:7df3981fa14b397fe09f6ba84ed0c096c71902394da667bf47f3b315866e7f91';
export const WORKSPACE_ACTIVATION_ROUTE = Object.freeze({
  key: 'activation',
  method: 'POST',
  path: '/internal/managed-runtime/v3/activation',
  protocolVersion: 1,
  requestBodyLimitBytes: 16 * 1024,
  responseBodyLimitBytes: 16 * 1024,
  cacheControl: 'no-store',
} as const);

const KEYS = [
  'contextConfigRef',
  'contextDigest',
  'operation',
  'profile',
  'protocolVersion',
  'sessionId',
].join(',');

export class WorkspaceActivations {
  private readonly sessions = new Map<string, boolean>();

  isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId) === true;
  }

  register(
    app: Application,
    boot: ManagedContextBoot,
    installations: ManagedContextInstallations,
    executor: ManagedToolExecutor,
  ): void {
    app.post(
      WORKSPACE_ACTIVATION_ROUTE.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(boot),
      managedRuntimeJsonBody(WORKSPACE_ACTIVATION_ROUTE.requestBodyLimitBytes),
      (req: Request, res: Response) => {
        const body: unknown = req.body;
        if (
          body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== KEYS
        ) {
          res.status(400).json({ code: 'managed_activation_invalid' });
          return;
        }
        const request = body as Record<string, unknown>;
        const binding =
          typeof request['sessionId'] === 'string'
            ? installations.installed(request['sessionId'])
            : undefined;
        if (
          request['protocolVersion'] !== 1 ||
          (request['operation'] !== 'activate' &&
            request['operation'] !== 'release') ||
          request['profile'] !== WORKSPACE_EXECUTION_PROFILE ||
          boot.capabilityDigest !== WORKSPACE_CAPABILITY_DIGEST ||
          binding === undefined ||
          binding.contextConfigRef !== WORKSPACE_CONTEXT_CONFIG_REF ||
          request['contextConfigRef'] !== binding.contextConfigRef ||
          request['contextDigest'] !== computeManagedContextDigest(binding)
        ) {
          res.status(409).json({ code: 'managed_activation_conflict' });
          return;
        }
        const sessionId = request['sessionId'] as string;
        const active = request['operation'] === 'activate';
        if (
          (active && this.sessions.get(sessionId) === false) ||
          (!active && executor.hasActiveSession(sessionId))
        ) {
          res.status(409).json({ code: 'managed_activation_conflict' });
          return;
        }
        this.sessions.set(sessionId, active);
        res.json({
          ...request,
          runtimeInstanceId: boot.runtimeInstanceId,
          runtimeIncarnation: boot.runtimeIncarnation,
          epoch: boot.epoch,
          active,
        });
      },
      handleManagedRuntimeJsonError,
    );
  }
}
