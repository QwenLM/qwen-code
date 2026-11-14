/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response, NextFunction } from 'express';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  nameManagedRuntimeIncarnation,
  type ManagedRuntimeAttestationIdentity,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  parseManagedToolReference,
  parseManagedShellCapture,
  parseManagedToolReceipt,
} from './managed-runtime-tool-v3-routes.js';
import { isMeasuredWorkspaceCapability } from './managed-workspace-activation.js';
import type {
  ManagedToolExecutor,
  ManagedToolInvocationView,
  ManagedToolV3View,
} from './managed-runtime-tool-executor.js';
import {
  ManagedToolConflictError,
  ManagedToolInvalidError,
  ManagedToolUnavailableError,
} from './managed-runtime-tool-executor.js';

export const MANAGED_RUNTIME_TOOL_V4_ROUTES = (
  ['execute', 'status', 'cancel', 'acknowledge'] as const
).map((key) => ({
  key: 'measured-' + key,
  method: 'POST' as const,
  path: '/internal/managed-runtime/v4/' + key,
  protocolVersion: 4,
  requestBodyLimitBytes: key === 'execute' ? 256 * 1024 : 16 * 1024,
  responseBodyLimitBytes: 1024 * 1024 + 4096,
  cacheControl: 'no-store' as const,
}));

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function measuredToolView(
  executionProtocol: 2 | 3,
  input: ManagedToolInvocationView | ManagedToolV3View | null,
  measurements: ReturnType<ManagedToolExecutor['measurements']>,
): Record<string, unknown> {
  const view = input ?? { state: 'unknown' as const };
  const result: Record<string, unknown> = {
    protocolVersion: 4,
    executionProtocol,
    ...view,
  };
  if (view.state === 'settled' && view.result) {
    result['measurements'] = measurements;
    result['resultDigest'] = managedToolDigest(
      { executionProtocol, result: view.result, measurements },
      2 * 1024 * 1024,
    );
  }
  return result;
}

export function registerManagedRuntimeToolV4Routes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity &
    Pick<
      ManagedRuntimeAttestationIdentity,
      'runtimeIncarnation' | 'capabilityDigest'
    >,
  executor: ManagedToolExecutor,
): void {
  if (!isMeasuredWorkspaceCapability(identity.capabilityDigest)) return;
  const frozen = new Map<
    string,
    {
      mode: 2 | 3;
      digest: string;
      value?: Record<string, unknown>;
      receiptDigest?: string;
    }
  >();
  const requests = new Map<string, string>();
  for (const route of MANAGED_RUNTIME_TOOL_V4_ROUTES) {
    app.post(
      route.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(identity),
      nameManagedRuntimeIncarnation(identity),
      managedRuntimeJsonBody(route.requestBodyLimitBytes),
      async (req: Request, res: Response, next: NextFunction) => {
        const body = object(req.body);
        const reference = parseManagedToolReference(body?.['reference']);
        const mode = body?.['executionProtocol'];
        const execute = route.key === 'measured-execute';
        const acknowledge = route.key === 'measured-acknowledge';
        const allowed = [
          'protocolVersion',
          'executionProtocol',
          'reference',
          ...(execute
            ? ['toolName', 'input', ...(mode === 3 ? ['capture'] : [])]
            : []),
          ...(acknowledge
            ? ['resultDigest', ...(mode === 3 ? ['receipt'] : [])]
            : []),
          ...(route.key === 'measured-status' ? ['afterSequence'] : []),
        ];
        if (
          !body ||
          !reference ||
          body['protocolVersion'] !== 4 ||
          (mode !== 2 && mode !== 3) ||
          Object.keys(body).some((key) => !allowed.includes(key)) ||
          (body['afterSequence'] !== undefined &&
            (!Number.isSafeInteger(body['afterSequence']) ||
              Number(body['afterSequence']) < 0))
        ) {
          res.status(400).json({ code: 'managed_runtime_measurement_invalid' });
          return;
        }
        try {
          const identityKey = managedToolDigest(reference);
          const saved = frozen.get(identityKey);
          if (saved && saved.mode !== mode) {
            res.status(409).json({ code: 'managed_tool_result_conflict' });
            return;
          }
          if (execute) {
            if (
              !object(body['input']) ||
              typeof body['toolName'] !== 'string' ||
              !body['toolName'].length ||
              (mode === 3 && !parseManagedShellCapture(body['capture']))
            ) {
              res
                .status(400)
                .json({ code: 'managed_runtime_measurement_invalid' });
              return;
            }
            const requestDigest = managedToolDigest({
              executionProtocol: mode,
              toolName: body['toolName'],
              input: body['input'],
              capture: body['capture'] ?? null,
            });
            const original = requests.get(identityKey);
            if (original && original !== requestDigest) {
              res.status(409).json({ code: 'managed_tool_result_conflict' });
              return;
            }
            requests.set(identityKey, requestDigest);
          }
          if (saved && !saved.value) {
            if (
              acknowledge &&
              (body['resultDigest'] !== saved.digest ||
                managedToolDigest(body['receipt'] ?? null) !==
                  saved.receiptDigest)
            ) {
              res.status(409).json({ code: 'managed_tool_result_conflict' });
              return;
            }
            res.json({
              protocolVersion: 4,
              executionProtocol: mode,
              state: 'acknowledged',
            });
            return;
          }
          let view: ManagedToolInvocationView | ManagedToolV3View | null;
          if (execute) {
            const input = object(body['input']);
            const toolName = body['toolName'];
            const capture =
              mode === 3
                ? parseManagedShellCapture(body['capture'])
                : undefined;
            if (
              !input ||
              typeof toolName !== 'string' ||
              !toolName.length ||
              (mode === 3 && !capture)
            ) {
              res
                .status(400)
                .json({ code: 'managed_runtime_measurement_invalid' });
              return;
            }
            if (mode === 2) {
              await executor.execute(reference, toolName, input, true);
              view = await executor.status(reference);
            } else {
              view = await executor.executeV3({
                reference,
                measure: true,
                toolName,
                input,
                capture: {
                  ...capture!,
                  ...(input['is_background'] === true
                    ? { background: true as const }
                    : {}),
                  ...(toolName === 'monitor'
                    ? { monitoring: true as const }
                    : {}),
                },
              });
            }
          } else if (acknowledge) {
            view =
              mode === 2
                ? await executor.status(reference)
                : executor.statusV3(reference);
            if (
              !view ||
              view.state === 'unknown' ||
              view.state === 'acknowledged'
            ) {
              res.json({
                protocolVersion: 4,
                executionProtocol: mode,
                state: view?.state ?? 'unknown',
              });
              return;
            }
            const measured =
              saved?.value ??
              measuredToolView(mode, view, executor.measurements(reference));
            if (
              view.state !== 'settled' ||
              body['resultDigest'] !== measured['resultDigest']
            ) {
              res.status(409).json({ code: 'managed_tool_result_conflict' });
              return;
            }
            if (mode === 2) view = executor.acknowledge(reference);
            else {
              const receipt = parseManagedToolReceipt(body['receipt']);
              if (!receipt) {
                res
                  .status(400)
                  .json({ code: 'managed_runtime_measurement_invalid' });
                return;
              }
              view = await executor.acknowledgeV3(reference, receipt);
            }
            frozen.set(identityKey, {
              mode,
              digest: String(measured['resultDigest']),
              receiptDigest: managedToolDigest(body['receipt'] ?? null),
            });
            res.json({
              protocolVersion: 4,
              executionProtocol: mode,
              state: 'acknowledged',
            });
            return;
          } else {
            view =
              route.key === 'measured-cancel'
                ? mode === 2
                  ? await executor.cancel(reference)
                  : executor.cancelV3(reference)
                : mode === 2
                  ? await executor.status(reference)
                  : executor.statusV3(reference);
          }
          const current = frozen.get(identityKey);
          if (current && !current.value) {
            res.json({
              protocolVersion: 4,
              executionProtocol: mode,
              state: 'acknowledged',
            });
            return;
          }
          const measured =
            current?.value ??
            measuredToolView(mode, view, executor.measurements(reference));
          if (measured['state'] === 'settled' && !current)
            frozen.set(identityKey, {
              mode,
              digest: String(measured['resultDigest']),
              value: structuredClone(measured),
            });
          res.json(measured);
        } catch (error) {
          if (error instanceof ManagedToolConflictError) {
            res.status(409).json({ code: error.code, error: error.message });
            return;
          }
          if (error instanceof ManagedToolInvalidError) {
            res.status(400).json({
              code: 'managed_runtime_measurement_invalid',
              error: error.message,
            });
            return;
          }
          if (error instanceof ManagedToolUnavailableError) {
            res.status(409).json({ code: error.code, error: error.message });
            return;
          }
          next(error);
        }
      },
      handleManagedRuntimeJsonError,
    );
  }
}
