/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyAuthentication,
  readBoundedBody,
  type FetchLike,
} from './request-engine.js';
import { isValidMemoryContent } from './write-profile.js';
import type {
  RememberProvider,
  RememberResult,
  WriteDialectV1,
  WriteRuntimeConfiguration,
} from './types.js';

export function createWriteRequestEngine(
  runtime: WriteRuntimeConfiguration,
  fetcher: FetchLike = fetch,
): RememberProvider {
  return async ({ content, signal }) => {
    let url: URL;
    let init: RequestInit;
    try {
      if (!isValidMemoryContent(content) || signal.aborted)
        return { status: 'failed' };
      url = new URL(runtime.instance.endpoint.origin);
      url.pathname = `${runtime.instance.endpoint.basePath.replace(/\/$/u, '')}${runtime.dialect.create.path}`;
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
      });
      applyAuthentication(headers, runtime);
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content }],
        infer: false,
      };
      const scope = runtime.instance.scope;
      if (scope.userId !== undefined) body['user_id'] = scope.userId;
      if (scope.agentId !== undefined) body['agent_id'] = scope.agentId;
      if (scope.appId !== undefined) body['app_id'] = scope.appId;
      init = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(runtime.instance.timeoutMs),
        ]),
      };
    } catch {
      return { status: 'failed' };
    }

    try {
      const response = await fetcher(url, init);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 'unknown' };
      }
      const value: unknown = JSON.parse(await readBoundedBody(response));
      return parseRememberResponse(value, runtime.dialect);
    } catch {
      return { status: 'unknown' };
    }
  };
}

function parseRememberResponse(
  value: unknown,
  dialect: WriteDialectV1,
): RememberResult {
  if (isRecord(value)) {
    if (
      hasError(value) ||
      (value['event'] !== undefined && value['event'] !== 'ADD')
    ) {
      return { status: 'unknown' };
    }
    const status = value['status'];
    const operationId = value['event_id'];
    if (operationId !== undefined && !isIdentifier(operationId))
      return { status: 'unknown' };
    if (status === 'PENDING') {
      return dialect.response.completion === 'records-or-event' &&
        isIdentifier(operationId)
        ? { status: 'accepted', providerOperationId: operationId }
        : { status: 'unknown' };
    }
    if (status !== undefined && status !== 'SUCCEEDED')
      return { status: 'unknown' };
    if (
      status === 'SUCCEEDED' &&
      dialect.response.completion === 'records-or-event' &&
      value['results'] === undefined &&
      isIdentifier(operationId)
    )
      return { status: 'accepted', providerOperationId: operationId };
  }

  const collection =
    dialect.response.collection === 'root-array'
      ? value
      : dialect.response.collection === 'root-object'
        ? [value]
        : isRecord(value)
          ? value['results']
          : undefined;
  if (!Array.isArray(collection) || collection.length !== 1)
    return { status: 'unknown' };
  const record: unknown = collection[0];
  if (!isRecord(record) || hasError(record)) return { status: 'unknown' };
  if (
    (record['status'] !== undefined && record['status'] !== 'SUCCEEDED') ||
    (record['event'] !== undefined && record['event'] !== 'ADD')
  )
    return { status: 'unknown' };
  const id = record[dialect.response.idField];
  return isIdentifier(id)
    ? { status: 'stored', memoryId: id }
    : { status: 'unknown' };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function hasError(value: Record<string, unknown>): boolean {
  return ['error', 'errors'].some(
    (key) => value[key] !== undefined && value[key] !== null,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
