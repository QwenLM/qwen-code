/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CSI_FILE_FINALIZATION_FORMAT,
  parseManagedCsiFileJson,
  type ManagedCsiFileBoot,
} from './managed-csi-file-envelope.js';
import { createManagedContextAttestationResponse } from './managed-context-envelope.js';
import type {
  ManagedCsiMountReceipt,
  ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';

export const CSI_FILE_FINALIZE_PATH =
  '/internal/managed-runtime/csi/v2/finalize';
export const CSI_FILE_FINALIZE_LIMIT = 32 * 1024 * 1024;

export interface CsiFileFinalizeOperation {
  readonly operation: 'observe' | 'finalize';
  readonly retirementId: string;
  readonly preparedCommitSha256: string;
  readonly frozenRequestSha256: string | null;
  readonly cutSha256: string | null;
}

export function csiFinalizationDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    const encoded = JSON.stringify(item);
    if (encoded === undefined)
      throw new Error('Invalid CSI finalization value.');
    return encoded;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function csiFileFinalizeRequest(
  boot: ManagedCsiFileBoot,
  installedContext: Record<string, unknown>,
  pod: ManagedCsiPodIdentity,
  mount: ManagedCsiMountReceipt,
  operation: CsiFileFinalizeOperation,
) {
  if (boot.version !== 6 || boot.finalization !== CSI_FILE_FINALIZATION_FORMAT)
    throw new Error('The original worker does not support CSI finalization.');
  if (
    typeof operation.retirementId !== 'string' ||
    typeof operation.preparedCommitSha256 !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      operation.retirementId,
    ) ||
    !/^[0-9a-f]{64}$/.test(operation.preparedCommitSha256) ||
    (operation.operation !== 'observe' && operation.operation !== 'finalize') ||
    (operation.operation === 'observe'
      ? operation.frozenRequestSha256 !== null || operation.cutSha256 !== null
      : typeof operation.frozenRequestSha256 !== 'string' ||
        typeof operation.cutSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(operation.frozenRequestSha256) ||
        !/^[0-9a-f]{64}$/.test(operation.cutSha256))
  )
    throw new Error('Invalid CSI finalization operation.');
  return {
    format: CSI_FILE_FINALIZATION_FORMAT,
    bootSha256: csiFinalizationDigest(boot),
    identity: boot.identity,
    context: createManagedContextAttestationResponse(boot.context),
    installedContext,
    storage: boot.storage,
    pod,
    mount,
    operation: operation.operation,
    retirementId: operation.retirementId,
    preparedCommitSha256: operation.preparedCommitSha256,
    frozenRequestSha256: operation.frozenRequestSha256,
    cutSha256: operation.cutSha256,
  };
}

export function readCsiFileFinalizeRequest(
  value: unknown,
  boot: ManagedCsiFileBoot,
  installedContext: Record<string, unknown>,
  pod: ManagedCsiPodIdentity,
  mount: ManagedCsiMountReceipt,
): ReturnType<typeof csiFileFinalizeRequest> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid CSI finalization request.');
  const raw = value as CsiFileFinalizeOperation;
  const expected = csiFileFinalizeRequest(
    boot,
    installedContext,
    pod,
    mount,
    raw,
  );
  if (!isDeepStrictEqual(value, expected))
    throw new Error('Original CSI finalization identity conflicts.');
  return structuredClone(expected);
}

export async function requireSavedCsiApplicationCut(
  boot: ManagedCsiFileBoot,
  request: ReturnType<typeof csiFileFinalizeRequest>,
  preCutObservationSha256: string,
): Promise<void> {
  if (boot.version !== 6 || request.operation !== 'finalize')
    throw new Error('Original CSI cut authority is unavailable.');
  const response = await fetch(
    `${boot.authority.origin}/internal/managed-session-store/v1/sessions/${encodeURIComponent(boot.identity.sessionId)}/csi-retirement:worker-authority`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${boot.context.token}`,
        'X-Qwen-Tenant-Id': boot.context.tenantId,
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify(request),
    },
  );
  if (
    response.status !== 200 ||
    response.headers.get('content-encoding') !== null ||
    response.headers.get('cache-control') !== 'no-store' ||
    response.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
  )
    throw new Error('Original CSI cut authority is unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Original CSI cut authority is unavailable.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 16 * 1024)
        throw new Error('CSI cut authority exceeds its bound.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const actual = parseManagedCsiFileJson(Buffer.concat(chunks), 16 * 1024);
  if (
    !isDeepStrictEqual(actual, {
      format: 'qwen-csi-application-cut-authority/1',
      retirementId: request.retirementId,
      preparedCommitSha256: request.preparedCommitSha256,
      frozenRequestSha256: request.frozenRequestSha256,
      cutSha256: request.cutSha256,
      preCutObservationSha256,
      workerRequestSha256: csiFinalizationDigest(request),
    })
  )
    throw new Error('Saved original CSI cut conflicts.');
}
