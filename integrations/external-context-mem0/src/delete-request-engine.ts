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
import { isDeletionContent, isMemoryId } from './delete-profile.js';
import type {
  DeleteProvider,
  DeleteRuntimeConfiguration,
  ForgetReason,
  ForgetResult,
} from './types.js';

type Target =
  | { status: 'found'; content: string }
  | { status: 'absent' | 'unavailable' };

export function createDeleteRequestEngine(
  runtime: DeleteRuntimeConfiguration,
  fetcher: FetchLike = fetch,
): DeleteProvider {
  function request(memoryId: string, signal: AbortSignal) {
    const url = new URL(runtime.instance.endpoint.origin);
    url.pathname = `${runtime.instance.endpoint.basePath.replace(/\/$/u, '')}${runtime.dialect.record.pathPrefix}${encodeURIComponent(memoryId)}${runtime.dialect.record.pathSuffix}`;
    const headers = new Headers({ accept: 'application/json' });
    applyAuthentication(headers, runtime);
    return {
      url,
      init: {
        headers,
        redirect: 'manual' as const,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(runtime.instance.timeoutMs),
        ]),
      },
    };
  }

  async function readTarget(
    memoryId: string,
    url: URL,
    init: RequestInit,
  ): Promise<Target> {
    init.signal?.throwIfAborted();
    const response = await fetcher(url, { ...init, method: 'GET' });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (
        response.status === 404 &&
        runtime.dialect.record.notFound === 'http-404'
      )
        return { status: 'absent' };
      throw new Error('Target read failed.');
    }
    const value: unknown = JSON.parse(await readBoundedBody(response));
    if (value === null && runtime.dialect.record.notFound === 'null-200')
      return { status: 'absent' };
    if (!isRecord(value) || hasError(value)) throw new Error('Invalid target.');
    const { idField, contentField } = runtime.dialect.record;
    if (value[idField] !== memoryId) throw new Error('Invalid target.');
    for (const [key, field] of [
      ['userId', 'user_id'],
      ['agentId', 'agent_id'],
      ['appId', 'app_id'],
    ] as const) {
      const expected = runtime.instance.scope[key];
      if (expected !== undefined && value[field] !== expected)
        return { status: 'unavailable' };
    }
    const content = value[contentField];
    if (typeof content !== 'string' || !isDeletionContent(content))
      throw new Error('Invalid target.');
    return { status: 'found', content };
  }

  return {
    async get({ memoryId, signal }) {
      if (!isMemoryId(memoryId)) return { status: 'failed' };
      try {
        signal.throwIfAborted();
        const { url, init } = request(memoryId, signal);
        const target = await readTarget(memoryId, url, init);
        init.signal.throwIfAborted();
        return target.status === 'found'
          ? { status: 'found', memoryId, content: target.content }
          : { status: 'unavailable', memoryId };
      } catch {
        return { status: 'failed', memoryId };
      }
    },
    async forget({ memoryId, expectedContent, signal }) {
      const validId = isMemoryId(memoryId);
      const notDeleted = (reason: ForgetReason): ForgetResult => ({
        status: 'not_deleted',
        ...(validId ? { memoryId } : {}),
        reason,
      });
      if (!validId || !isDeletionContent(expectedContent))
        return notDeleted('invalid_input');
      let submitted = false;
      try {
        signal.throwIfAborted();
        const { url, init } = request(memoryId, signal);
        const target = await readTarget(memoryId, url, init);
        init.signal.throwIfAborted();
        if (target.status !== 'found') return notDeleted('target_unavailable');
        if (target.content !== expectedContent)
          return notDeleted('target_changed');
        submitted = true;
        const response = await fetcher(url, { ...init, method: 'DELETE' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { status: 'unknown', memoryId };
        }
        JSON.parse(await readBoundedBody(response));
        const after = await readTarget(memoryId, url, init);
        init.signal.throwIfAborted();
        return {
          status: after.status === 'absent' ? 'deleted' : 'unknown',
          memoryId,
        };
      } catch {
        return submitted
          ? { status: 'unknown', memoryId }
          : notDeleted(signal.aborted ? 'cancelled' : 'verification_failed');
      }
    },
  };
}

function hasError(value: Record<string, unknown>): boolean {
  return ['error', 'errors'].some(
    (key) => value[key] !== undefined && value[key] !== null,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
