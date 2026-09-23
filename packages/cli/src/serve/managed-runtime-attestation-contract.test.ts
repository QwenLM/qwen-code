/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import express from 'express';
import type { Application } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
  OWNED_MANAGED_RUNTIME_ROUTES,
  ownedManagedRuntimeRouteGate,
  registerManagedRuntimeAttestationRoute,
  type ManagedRuntimeAttestationIdentity,
} from './managed-runtime-attestation-contract.js';

interface FixtureRequest {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly omitHeader?: string;
  readonly replaceHeader?: { readonly name: string; readonly value: string };
  readonly replaceBody?: { readonly name: string; readonly value: unknown };
  readonly paddingBytes?: number;
  readonly rawBody?: string;
  readonly pathSuffix?: string;
  readonly pathOverride?: string;
  readonly method?: string;
}

interface FixtureCase {
  readonly id: string;
  readonly request: FixtureRequest;
  readonly expected: {
    readonly status: number;
    readonly classification: string;
    readonly code?: string;
    readonly body?: Readonly<Record<string, unknown>>;
  };
}

interface FixtureSuite {
  readonly contractVersion: number;
  readonly route: {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly protocolVersion: number;
    readonly requestBodyLimitBytes: number;
    readonly responseBodyLimitBytes: number;
    readonly cacheControl: string;
  };
  readonly identity: ManagedRuntimeAttestationIdentity;
  readonly cases: readonly FixtureCase[];
}

const contractDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts',
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      contractDirectory,
      'managed-runtime-attestation-v2.fixtures.json',
    ),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-runtime-attestation-v2.schema.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const success = fixtures.cases.find((fixture) => fixture.id === 'success');
if (
  !success?.request.headers ||
  !success.request.body ||
  !success.expected.body
) {
  throw new Error('The success fixture must define the canonical request.');
}
const successHeaders = success.request.headers;
const successBody = success.request.body;
const successResponseBody = success.expected.body;

const openServers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  openServers.clear();
});

async function startServer(
  options: {
    readonly identity?: ManagedRuntimeAttestationIdentity;
    readonly configureApp?: (app: Application) => void;
  } = {},
): Promise<string> {
  const app = express();
  options.configureApp?.(app);
  registerManagedRuntimeAttestationRoute(
    app,
    options.identity ?? fixtures.identity,
  );
  const server = createServer(ownedManagedRuntimeRouteGate(app));
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

function materializeRequest(fixture: FixtureCase): {
  headers: Record<string, string>;
  body: string;
  pathSuffix: string;
  path: string;
  method: string;
} {
  const headers = { ...successHeaders };
  const body: Record<string, unknown> = { ...successBody };
  if (fixture.request.omitHeader) delete headers[fixture.request.omitHeader];
  if (fixture.request.replaceHeader) {
    headers[fixture.request.replaceHeader.name] =
      fixture.request.replaceHeader.value;
  }
  if (fixture.request.replaceBody) {
    body[fixture.request.replaceBody.name] = fixture.request.replaceBody.value;
  }
  if (fixture.request.paddingBytes) {
    body['padding'] = 'x'.repeat(fixture.request.paddingBytes);
  }
  return {
    headers,
    body: fixture.request.rawBody ?? JSON.stringify(body),
    pathSuffix: fixture.request.pathSuffix ?? '',
    path: fixture.request.pathOverride ?? fixtures.route.path,
    method: fixture.request.method ?? fixtures.route.method,
  };
}

function classify(status: number): string {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'credentials';
  if (status === 400 || status === 413) return 'protocol';
  if (status === 409) return 'identity';
  if (status === 404 || status === 405) return 'incompatible';
  throw new Error(`Fixture returned unclassified status ${status}.`);
}

describe('Managed Runtime attestation contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    const validate = new Ajv2020({ strict: true }).compile(schema);

    expect(validate(fixtures)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('uses one manifest for route admission and registration', () => {
    expect(OWNED_MANAGED_RUNTIME_ROUTES).toEqual([fixtures.route]);
    expect(Object.isFrozen(OWNED_MANAGED_RUNTIME_ROUTES)).toBe(true);
    expect(Object.isFrozen(OWNED_MANAGED_RUNTIME_ROUTES[0])).toBe(true);
    expect(MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES).toBe(16 * 1024);
  });

  it.each(fixtures.cases)(
    '$id conforms through a real raw HTTP gate',
    async (fixture) => {
      const origin = await startServer();
      const request = materializeRequest(fixture);
      const response = await fetch(
        `${origin}${request.path}${request.pathSuffix}`,
        {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' ? undefined : request.body,
        },
      );

      expect(response.status).toBe(fixture.expected.status);
      expect(classify(response.status)).toBe(fixture.expected.classification);
      expect(response.headers.get('cache-control')).toBe(
        fixtures.route.cacheControl,
      );
      if (fixture.expected.code) {
        expect(response.headers.get('content-type')).toMatch(
          /^application\/json/u,
        );
        expect(await response.clone().json()).toMatchObject({
          code: fixture.expected.code,
        });
      }
      if (fixture.expected.body) {
        const text = await response.text();
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
          fixtures.route.responseBodyLimitBytes,
        );
        expect(JSON.parse(text)).toEqual(fixture.expected.body);
      }
    },
  );

  it('authenticates before parsing the JSON body', async () => {
    const origin = await startServer();
    const headers = { ...successHeaders };
    delete headers['authorization'];

    const response = await fetch(`${origin}${fixtures.route.path}`, {
      method: fixtures.route.method,
      headers,
      body: '{not-json',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'managed_runtime_unauthorized',
    });
  });

  it('rejects an identity whose response exceeds the manifest limit', () => {
    const app = express();

    expect(() =>
      registerManagedRuntimeAttestationRoute(app, {
        ...fixtures.identity,
        workspaceCwd: `/${'x'.repeat(
          MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
        )}`,
      }),
    ).toThrow('Managed Runtime attestation response exceeds 16 KiB.');
  });

  it('sends the exact response bytes that passed the manifest limit', async () => {
    const emptyPathResponse = JSON.stringify({
      ...successResponseBody,
      workspaceCwd: '',
    });
    const workspaceCwd = `/${'x'.repeat(
      MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES -
        Buffer.byteLength(emptyPathResponse) -
        33,
    )}`;
    const expectedResponse = JSON.stringify({
      ...successResponseBody,
      workspaceCwd,
    });
    expect(Buffer.byteLength(expectedResponse)).toBe(
      MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES - 32,
    );
    const origin = await startServer({
      identity: { ...fixtures.identity, workspaceCwd },
      configureApp: (app) => app.set('json spaces', 10),
    });

    const response = await fetch(`${origin}${fixtures.route.path}`, {
      method: fixtures.route.method,
      headers: successHeaders,
      body: JSON.stringify({ ...successBody, workspaceCwd }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(responseText)).toBeLessThanOrEqual(
      MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
    );
    expect(responseText).toBe(expectedResponse);
  });

  it('uses one defensive identity snapshot after registration', async () => {
    const mutableIdentity = { ...fixtures.identity };
    const origin = await startServer({ identity: mutableIdentity });
    mutableIdentity.workspaceId = 'workspace-mutated-after-registration';

    const response = await fetch(`${origin}${fixtures.route.path}`, {
      method: fixtures.route.method,
      headers: successHeaders,
      body: JSON.stringify(successBody),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successResponseBody);
  });

  it.each([
    ['empty token', { token: '' }],
    ['zero epoch', { epoch: 0 }],
    ['fractional epoch', { epoch: 1.5 }],
    ['uppercase digest', { capabilityDigest: `sha256:${'A'.repeat(64)}` }],
    ['unknown isolation class', { isolationClass: 'tenant' }],
  ])('rejects an invalid identity at registration: %s', (_label, patch) => {
    expect(() =>
      registerManagedRuntimeAttestationRoute(express(), {
        ...fixtures.identity,
        ...(patch as Partial<ManagedRuntimeAttestationIdentity>),
      }),
    ).toThrow('Managed Runtime attestation identity is invalid.');
  });

  it('keeps request and response objects closed in the shared schema', () => {
    const definitions = schema['$defs'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(definitions['requestBody']?.['unevaluatedProperties']).toBe(false);
    expect(definitions['responseBody']?.['unevaluatedProperties']).toBe(false);
    expect(definitions['route']?.['additionalProperties']).toBe(false);
  });
});
