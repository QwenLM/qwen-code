/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { errors, jwtVerify } from 'jose';
import { z } from 'zod';
import type { MemoryScope } from './domain.js';
import type { MemoryService } from './memory-service.js';
import type { PersonalMemoryPreferenceStore } from './privacy-mode-store.js';
import { readBoundedJson } from './http-json.js';

type VerificationKey = Parameters<typeof jwtVerify>[1];

const memoryIdSchema = z.string().uuid();
const repositoryIdSchema = z.string().min(1).max(512);
const approvalSchema = z
  .object({ expected_version: z.number().int().positive() })
  .strict();
const personalDeletionSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.enum(['user_request', 'candidate_rejected']),
  })
  .strict();
const repositoryDeletionSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.enum(['maintainer_request', 'candidate_rejected']),
  })
  .strict();
const preferenceSchema = z
  .object({ mode: z.enum(['off', 'read_only', 'read_write']) })
  .strict();

export interface ManagementPrincipal {
  tenantId: string;
  principalId: string;
}

export interface ManagementTokenVerifierOptions {
  issuer: string;
  audience: string;
  expectedTenantId: string;
  key: VerificationKey;
  now?: () => Date;
}

export class ManagementTokenVerifier {
  private readonly now: () => Date;

  constructor(private readonly options: ManagementTokenVerifierOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async verify(token: string): Promise<ManagementPrincipal> {
    const result = await jwtVerify(token, this.options.key, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ['ES256', 'RS256'],
      currentDate: this.now(),
    });
    const tenantId = requireClaim(result.payload['tenant_id'], 'tenant_id');
    if (tenantId !== this.options.expectedTenantId) {
      throw new ManagementAuthorizationError('Management tenant mismatch');
    }
    return {
      tenantId,
      principalId: requireClaim(result.payload.sub, 'sub'),
    };
  }
}

export interface RepositoryMaintainerAuthorizer {
  authorize(
    principal: ManagementPrincipal,
    repositoryId: string,
  ): Promise<void>;
}

export interface ScmMaintainerAuthorizerOptions {
  baseUrl: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  maxLeaseMs?: number;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

export class ScmMaintainerAuthorizer implements RepositoryMaintainerAuthorizer {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ScmMaintainerAuthorizerOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== 'https:') {
      throw new Error('SCM authorization service must use https');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async authorize(
    principal: ManagementPrincipal,
    repositoryId: string,
  ): Promise<void> {
    const response = await this.fetchImplementation(
      new URL('/v1/repositories:authorize-maintainer', this.options.baseUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tenant_id: principal.tenantId,
          principal_id: principal.principalId,
          repository_id: repositoryId,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 3_000),
      },
    );
    if ([401, 403, 404].includes(response.status)) {
      throw new ManagementAuthorizationError();
    }
    if (!response.ok) {
      throw new Error('SCM authorization service is unavailable');
    }
    let result: {
      authorized: true;
      tenant_id: string;
      principal_id: string;
      repository_id: string;
      expires_at: string;
    };
    try {
      result = z
        .object({
          authorized: z.literal(true),
          tenant_id: z.string(),
          principal_id: z.string(),
          repository_id: z.string(),
          expires_at: z.string().datetime(),
        })
        .strict()
        .parse(await readBoundedJson<unknown>(response, 16 * 1024));
    } catch {
      throw new Error('SCM authorization service returned an invalid response');
    }
    const expiresAt = new Date(result.expires_at);
    const now = this.now();
    if (
      result.tenant_id !== principal.tenantId ||
      result.principal_id !== principal.principalId ||
      result.repository_id !== repositoryId ||
      expiresAt <= now ||
      expiresAt.getTime() - now.getTime() > (this.options.maxLeaseMs ?? 60_000)
    ) {
      throw new ManagementAuthorizationError();
    }
  }
}

export interface ManagementDependencies {
  tokens: ManagementTokenVerifier;
  maintainers: RepositoryMaintainerAuthorizer;
  preferences: PersonalMemoryPreferenceStore;
  memory: MemoryService;
}

export interface ManagementHandlerOptions {
  maxBodyBytes?: number;
}

class ManagementAuthorizationError extends Error {}
class RequestBodyTooLargeError extends Error {}

export function createManagementHandler(
  dependencies: ManagementDependencies,
  options: ManagementHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024;
  return async (request, response) => {
    try {
      const method = request.method?.toUpperCase() ?? 'GET';
      const path = new URL(request.url ?? '/', 'https://management.invalid')
        .pathname;
      if (method === 'GET' && path === '/healthz') {
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      const route = parseManagementRoute(method, path);
      if (!route) {
        writeJson(response, 404, { error: 'route_not_found' });
        return;
      }
      const principal = await dependencies.tokens.verify(
        readBearer(request.headers.authorization),
      );
      const body = parseJson(await readBoundedBody(request, maxBodyBytes));

      if (route.kind === 'preference') {
        const input = preferenceSchema.parse(body);
        await dependencies.preferences.setPersonalMode(principal, input.mode);
        writeJson(response, 200, { mode: input.mode });
        return;
      }

      if (route.scope === 'repository') {
        await dependencies.maintainers.authorize(principal, route.repositoryId);
      }
      const managementIdentity = {
        tenantId: principal.tenantId,
        principalId: principal.principalId,
        repositoryId:
          route.scope === 'repository' ? route.repositoryId : '__personal__',
        authority:
          route.scope === 'repository'
            ? ('repository_maintainer' as const)
            : ('data_subject' as const),
      };
      if (route.kind === 'review') {
        const candidate = await dependencies.memory.getCandidateForReview(
          managementIdentity,
          route.memoryId,
        );
        if (!candidate) {
          writeJson(response, 404, { error: 'candidate_not_found' });
          return;
        }
        writeJson(response, 200, candidate);
        return;
      }
      if (route.kind === 'approve') {
        const input = approvalSchema.parse(body);
        const active = await dependencies.memory.approveCandidate(
          managementIdentity,
          route.memoryId,
          input.expected_version,
        );
        writeJson(response, 200, {
          memory_id: active.id,
          version: active.version,
          state: active.lifecycleState,
        });
        return;
      }
      const input =
        route.scope === 'personal'
          ? personalDeletionSchema.parse(body)
          : repositoryDeletionSchema.parse(body);
      await dependencies.memory.eraseMemory(
        managementIdentity,
        route.memoryId,
        input.expected_version,
        route.scope,
        input.reason,
      );
      writeJson(response, 202, { state: 'pending_or_erased' });
    } catch (error) {
      if (
        error instanceof ManagementAuthorizationError ||
        error instanceof errors.JOSEError
      ) {
        writeJson(response, 401, { error: 'request_not_authorized' });
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(response, 413, { error: 'request_too_large' });
        return;
      }
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError
      ) {
        writeJson(response, 400, { error: 'invalid_request' });
        return;
      }
      writeJson(response, 503, { error: 'management_unavailable' });
    }
  };
}

export interface ManagementTlsOptions {
  certPath: string;
  keyPath: string;
}

export function createManagementServer(
  dependencies: ManagementDependencies,
  tls: ManagementTlsOptions,
): Server {
  const handler = createManagementHandler(dependencies);
  const server = createServer(
    {
      cert: readFileSync(tls.certPath),
      key: readFileSync(tls.keyPath),
      minVersion: 'TLSv1.3',
    },
    (request, response) => {
      void handler(request, response);
    },
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

type ManagementRoute =
  | { kind: 'preference' }
  | {
      kind: 'review' | 'approve' | 'delete';
      scope: MemoryScope;
      repositoryId: string;
      memoryId: string;
    };

function parseManagementRoute(
  method: string,
  path: string,
): ManagementRoute | null {
  if (method === 'PUT' && path === '/v1/manage/personal-memory-mode') {
    return { kind: 'preference' };
  }
  const personal =
    /^\/v1\/manage\/personal\/memories\/([^/:]+)(:approve)?$/.exec(path);
  if (personal) {
    return parseMemoryAction(method, 'personal', '__personal__', personal);
  }
  const repository =
    /^\/v1\/manage\/repositories\/([^/]+)\/memories\/([^/:]+)(:approve)?$/.exec(
      path,
    );
  if (!repository) {
    return null;
  }
  const repositoryId = repositoryIdSchema.parse(
    decodeURIComponent(repository[1] ?? ''),
  );
  return parseMemoryAction(method, 'repository', repositoryId, [
    repository[0],
    repository[2],
    repository[3],
  ]);
}

function parseMemoryAction(
  method: string,
  scope: MemoryScope,
  repositoryId: string,
  match: readonly (string | undefined)[],
): ManagementRoute | null {
  const memoryId = memoryIdSchema.parse(decodeURIComponent(match[1] ?? ''));
  if (method === 'POST' && match[2] === ':approve') {
    return { kind: 'approve', scope, repositoryId, memoryId };
  }
  if (method === 'GET' && !match[2]) {
    return { kind: 'review', scope, repositoryId, memoryId };
  }
  if (method === 'DELETE' && !match[2]) {
    return { kind: 'delete', scope, repositoryId, memoryId };
  }
  return null;
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Uint8Array): unknown {
  return body.byteLength === 0
    ? {}
    : (JSON.parse(Buffer.from(body).toString('utf8')) as unknown);
}

function readBearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new ManagementAuthorizationError();
  }
  return header.slice('Bearer '.length);
}

function requireClaim(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManagementAuthorizationError(`Invalid ${name}`);
  }
  return value;
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.headersSent) {
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
