/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type express from 'express';
import type { Application, Request, Response } from 'express';
import {
  MANAGED_TOOL_RESULT_PROTOCOL,
  MANAGED_TOOL_RESULT_ROUTES,
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_LIMITS,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  ManagedToolConflictError,
  ManagedToolInvalidError,
  ManagedToolUnavailableError,
  type ManagedToolExecutor,
  type ManagedToolReference,
  type ToolResultAcknowledgement,
} from './managed-runtime-tool-executor.js';

function closed(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !keys.includes(key))) return null;
  if (keys.some((key) => !optional.includes(key) && !(key in body)))
    return null;
  return body;
}

function reference(value: unknown): ManagedToolReference | null {
  const body = closed(value, ['sessionId', 'promptId', 'callId', 'argsDigest']);
  if (
    !body ||
    typeof body['argsDigest'] !== 'string' ||
    !/^(?:sha256:)?[0-9a-f]{64}$/.test(body['argsDigest'])
  )
    return null;
  try {
    for (const key of ['sessionId', 'promptId', 'callId']) {
      assertManagedSessionStableId(
        body[key] as Parameters<typeof assertManagedSessionStableId>[0],
        `reference.${key}`,
      );
    }
  } catch {
    return null;
  }
  return body as unknown as ManagedToolReference;
}

function body(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  const parsed = closed(
    value,
    ['protocolVersion', 'toolResult', ...keys],
    optional,
  );
  return parsed?.['protocolVersion'] === 3 &&
    parsed['toolResult'] === MANAGED_TOOL_RESULT_PROTOCOL
    ? parsed
    : null;
}

function capture(value: unknown): LocalShellCaptureRequest['capture'] | null {
  const parsed = closed(value, [
    'tenantId',
    'sessionId',
    'turnId',
    'executionCallId',
    'bindingGeneration',
    'capturePolicy',
  ]);
  if (
    !parsed ||
    parsed['capturePolicy'] !== 'complete_required' ||
    typeof parsed['bindingGeneration'] !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(parsed['bindingGeneration']) ||
    BigInt(parsed['bindingGeneration']) > 2n ** 63n - 1n
  )
    return null;
  try {
    for (const key of ['tenantId', 'sessionId', 'turnId', 'executionCallId']) {
      assertManagedSessionStableId(
        parsed[key] as Parameters<typeof assertManagedSessionStableId>[0],
        `capture.${key}`,
      );
    }
  } catch {
    return null;
  }
  return parsed as unknown as LocalShellCaptureRequest['capture'];
}

function receipt(value: unknown): ToolResultAcknowledgement | null {
  const parsed = closed(value, [
    'executionCallId',
    'manifest',
    'deliveryStatus',
    'historyRevision',
  ]);
  if (!parsed) return null;
  try {
    assertManagedSessionStableId(
      parsed['executionCallId'] as Parameters<
        typeof assertManagedSessionStableId
      >[0],
      'receipt.executionCallId',
    );
  } catch {
    return null;
  }
  const deliveryStatus = parsed['deliveryStatus'];
  if (deliveryStatus !== 'committed' && deliveryStatus !== 'blocked')
    return null;
  let manifest = null;
  try {
    if (parsed['manifest'] !== null) {
      manifest = assertManagedSessionDurableRef(
        parsed['manifest'] as Parameters<
          typeof assertManagedSessionDurableRef
        >[0],
        'receipt.manifest',
      );
      if (
        manifest.kind !== MANAGED_TOOL_RESULT_KINDS.manifest ||
        manifest.byteLength < 1 ||
        manifest.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes
      )
        return null;
    }
  } catch {
    return null;
  }
  const historyRevision = parsed['historyRevision'];
  if (
    deliveryStatus === 'committed'
      ? !Number.isSafeInteger(historyRevision) ||
        (historyRevision as number) < 1
      : historyRevision !== null
  )
    return null;
  return {
    executionCallId: parsed['executionCallId'] as string,
    manifest,
    deliveryStatus,
    historyRevision: historyRevision as number | null,
  };
}

function invalid(res: express.Response): void {
  res.status(400).json({
    code: 'managed_runtime_attestation_invalid',
    error: 'Managed Tool v3 request is invalid.',
  });
}

function failure(res: express.Response, cause: unknown): void {
  if (cause instanceof ManagedToolInvalidError) return invalid(res);
  if (
    cause instanceof ManagedToolConflictError ||
    cause instanceof ManagedToolUnavailableError
  ) {
    res.status(409).json({ code: cause.code, error: cause.message });
    return;
  }
  throw cause;
}

/** Registers Tool v3 only for a locally injected Session-owned publisher. */
export function registerManagedRuntimeToolV3Routes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  executor: ManagedToolExecutor,
): void {
  const routes = Object.fromEntries(
    MANAGED_TOOL_RESULT_ROUTES.map((route) => [route.key, route]),
  );
  const prefix = {
    protocolVersion: 3,
    toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
  };
  app.post(
    routes['execute'].path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(routes['execute'].requestBodyLimitBytes),
    async (req: Request, res: Response) => {
      const parsed = body(req.body, [
        'reference',
        'toolName',
        'input',
        'capture',
      ]);
      const ref = reference(parsed?.['reference']);
      const cap = capture(parsed?.['capture']);
      const input = parsed?.['input'];
      if (
        !parsed ||
        !ref ||
        !cap ||
        parsed['toolName'] !== 'run_shell_command' ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
      )
        return invalid(res);
      try {
        const view = await executor.executeV3({
          reference: ref,
          capture: cap,
          toolName: 'run_shell_command',
          input: input as Record<string, unknown>,
        });
        res.status(200).json({
          ...prefix,
          state: view.state,
          ...(view.result ? { result: view.result } : {}),
        });
      } catch (cause) {
        failure(res, cause);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    routes['status'].path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(routes['status'].requestBodyLimitBytes),
    (req: Request, res: Response) => {
      const parsed = body(
        req.body,
        ['reference', 'afterSequence'],
        ['afterSequence'],
      );
      const ref = reference(parsed?.['reference']);
      const after = parsed?.['afterSequence'];
      if (
        !parsed ||
        !ref ||
        (after !== undefined &&
          (!Number.isSafeInteger(after) || (after as number) < 0))
      )
        return invalid(res);
      try {
        const view = executor.statusV3(ref);
        res.status(200).json({
          ...prefix,
          state: view.state,
          ...(view.result ? { result: view.result } : {}),
          ...(view.lastSequence !== undefined
            ? { lastSequence: view.lastSequence }
            : {}),
        });
      } catch (cause) {
        failure(res, cause);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    routes['cancel'].path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(routes['cancel'].requestBodyLimitBytes),
    (req: Request, res: Response) => {
      const parsed = body(req.body, ['reference']);
      const ref = reference(parsed?.['reference']);
      if (!parsed || !ref) return invalid(res);
      try {
        const view = executor.cancelV3(ref);
        res.status(200).json({
          ...prefix,
          state: view.state,
          ...(view.result ? { result: view.result } : {}),
        });
      } catch (cause) {
        failure(res, cause);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    routes['acknowledge'].path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(routes['acknowledge'].requestBodyLimitBytes),
    (req: Request, res: Response) => {
      const parsed = body(req.body, ['reference', 'receipt']);
      const ref = reference(parsed?.['reference']);
      const ack = receipt(parsed?.['receipt']);
      if (!parsed || !ref || !ack) return invalid(res);
      try {
        const view = executor.acknowledgeV3(ref, ack);
        res.status(200).json({
          ...prefix,
          state: view.state,
          ...(view.result ? { result: view.result } : {}),
        });
      } catch (cause) {
        failure(res, cause);
      }
    },
    handleManagedRuntimeJsonError,
  );
}
