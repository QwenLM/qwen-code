/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface ManagedMcpOAuthReference {
  resourceUri: string;
  credentialId: string;
  credentialGeneration: number;
  configRevision: number;
  executionActorKey: string;
}

export interface ManagedMcpTokenContext {
  sessionKey: ManagedSessionKey;
  serverId: string;
  configRevision: number;
  oauth: ManagedMcpOAuthReference;
}

export interface ManagedMcpTokenAuthority {
  url: string;
  bindingId: string;
  generation: string;
}
export type ManagedMcpAccessTokenProvider = (
  context: ManagedMcpTokenContext,
  signal: AbortSignal,
) => Promise<string>;

export class ManagedMcpOAuthError extends Error {
  constructor(readonly code = 'managed_mcp_authorization_unavailable') {
    super(code);
  }
}

export function parseManagedMcpTokenAuthority(
  value: unknown,
  leaseId: string,
): ManagedMcpTokenAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedMcpOAuthError();
  const authority = value as Record<string, unknown>;
  if (
    Object.keys(authority).sort().join(',') !== 'bindingId,generation,url' ||
    typeof authority['bindingId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(authority['bindingId']) ||
    typeof authority['generation'] !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(authority['generation']) ||
    BigInt(authority['generation']) > 2n ** 63n - 1n ||
    typeof authority['url'] !== 'string'
  )
    throw new ManagedMcpOAuthError();
  const url = new URL(authority['url']);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/internal/runtime-broker/v1/runtime-leases/${encodeURIComponent(leaseId)}/mcp/token`
  )
    throw new ManagedMcpOAuthError();
  return {
    bindingId: authority['bindingId'],
    generation: authority['generation'],
    url: url.href,
  };
}

export function createManagedMcpLeaseTokenProvider(
  identity: {
    token: string;
    leaseId: string;
    epoch: number;
    tenantId: string;
    workspaceId: string;
    isolationClass: string;
  },
  authorityFor: (sessionId: string) => ManagedMcpTokenAuthority | undefined,
  fetchImpl: typeof fetch = fetch,
): ManagedMcpAccessTokenProvider {
  return async (context, signal) => {
    signal.throwIfAborted();
    const authority = authorityFor(context.sessionKey.sessionId);
    if (
      !authority ||
      identity.isolationClass !== 'session' ||
      context.sessionKey.tenantId !== identity.tenantId ||
      context.sessionKey.workspaceId !== identity.workspaceId ||
      context.configRevision !== context.oauth.configRevision
    )
      throw new ManagedMcpOAuthError();
    const response = await fetchImpl(authority.url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        bindingId: authority.bindingId,
        generation: authority.generation,
        epoch: identity.epoch,
        harnessSessionId: context.sessionKey.sessionId,
        configRevision: context.configRevision,
        serverId: context.serverId,
        credentialId: context.oauth.credentialId,
        credentialGeneration: context.oauth.credentialGeneration,
        executionActorKey: context.oauth.executionActorKey,
        resourceUri: context.oauth.resourceUri,
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ManagedMcpOAuthError();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 64 * 1024) {
          await reader.cancel();
          throw new ManagedMcpOAuthError();
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    signal.throwIfAborted();
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new ManagedMcpOAuthError();
    }
    if (
      !result ||
      typeof result !== 'object' ||
      Object.keys(result).sort().join(',') !== 'accessToken,protocolVersion' ||
      result['protocolVersion'] !== 1 ||
      typeof result['accessToken'] !== 'string' ||
      !/^[A-Za-z0-9._~+/-]+={0,}$/u.test(result['accessToken']) ||
      result['accessToken'].length > 16 * 1024
    )
      throw new ManagedMcpOAuthError();
    return result['accessToken'];
  };
}

export function createManagedMcpAuthorizedFetch(
  url: string,
  context: ManagedMcpTokenContext,
  active: () => boolean,
  token: ManagedMcpAccessTokenProvider | undefined,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const origin = new URL(url).origin;
  if (new URL(context.oauth.resourceUri).origin !== origin)
    throw new ManagedMcpOAuthError();
  return async (input, init) => {
    const destination = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      url,
    );
    const signal =
      init?.signal ??
      (input instanceof Request ? input.signal : undefined) ??
      new AbortController().signal;
    signal.throwIfAborted();
    if (
      !active() ||
      !token ||
      destination.origin !== origin ||
      destination.username ||
      destination.password
    )
      throw new ManagedMcpOAuthError();
    if (
      new Headers(init?.headers).has('Host') ||
      (input instanceof Request && input.headers.has('Host'))
    )
      throw new ManagedMcpOAuthError();
    const accessToken = await token(context, signal);
    signal.throwIfAborted();
    if (!active()) throw new ManagedMcpOAuthError();
    if (
      !/^[A-Za-z0-9._~+/-]+={0,}$/u.test(accessToken) ||
      accessToken.length > 16 * 1024
    )
      throw new ManagedMcpOAuthError();
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetchImpl(input, {
      ...init,
      headers,
      signal,
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ManagedMcpOAuthError(
        response.status === 401
          ? 'managed_mcp_authentication_required'
          : 'managed_mcp_authorization_unavailable',
      );
    }
    return response;
  };
}
