/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNED_MANAGED_RUNTIME_ROUTES,
  ownedManagedRuntimeRouteGate,
} from './managed-runtime-attestation-contract.js';
import { MANAGED_CONTEXT_WORKER_ROUTES } from './managed-context-worker.js';

// A worker that predates managed-tool-result/1 must refuse every Tool v3
// route before a handler runs, so an old peer never executes a call that
// asked for capture. The v3 contract lives in core, next to the module that
// replays it; this test reads its fixtures by path.

interface Route {
  readonly key: string;
  readonly method: string;
  readonly path: string;
}

/** The route set that the worker's gate admits under each boot version. */
const GATES = [
  { boot: 'boot v1', routes: OWNED_MANAGED_RUNTIME_ROUTES },
  { boot: 'boot v2', routes: MANAGED_CONTEXT_WORKER_ROUTES },
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const v3Directory = path.resolve(
  here,
  '../../../core/src/managed-runtime/contracts',
);
const v3Fixtures = readJson(
  path.join(v3Directory, 'managed-tool-result-v1.fixtures.json'),
) as {
  readonly routes: readonly Route[];
  readonly requests: Record<string, Record<string, unknown>>;
};
const v3Schema = readJson(
  path.join(v3Directory, 'managed-tool-result-v1.schema.json'),
);
const v2Fixtures = readJson(
  path.join(here, 'contracts/managed-runtime-tool-v2.fixtures.json'),
) as {
  readonly identity: { token: string; leaseId: string; epoch: number };
  readonly suites: ReadonlyArray<{
    readonly route: string;
    readonly canonicalRequest: { readonly body: Record<string, unknown> };
  }>;
};
const v2Schema = readJson(
  path.join(here, 'contracts/managed-runtime-tool-v2.schema.json'),
);
const ajv = new Ajv2020({ strict: true });
ajv.addSchema(v2Schema);
ajv.addSchema(v3Schema);

function accepts(schema: object, definition: string, value: unknown) {
  const validate = ajv.getSchema(
    `${(schema as { $id: string }).$id}#/$defs/${definition}`,
  );
  if (!validate) throw new Error(`No ${definition} definition.`);
  return validate(value) as boolean;
}

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
});

describe('Tool v3 admission on a worker without managed-tool-result/1', () => {
  it.each(GATES)('declares no v3 tool route under $boot', ({ routes }) => {
    const declared = routes.map((route) => route.path);

    expect(v3Fixtures.routes).toHaveLength(4);
    for (const route of v3Fixtures.routes) {
      expect(declared).not.toContain(route.path);
    }
  });

  it.each(GATES)(
    'refuses every v3 tool route before any handler runs under $boot',
    async ({ routes }) => {
      const reached: string[] = [];
      const app = express();
      // Handlers that would execute stand behind the gate, as in the worker.
      app.use((req, res) => {
        reached.push(req.path);
        res.status(200).json({ executed: true });
      });
      const server = createServer(ownedManagedRuntimeRouteGate(app, routes));
      servers.add(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP test server address.');
      }
      const { token, leaseId, epoch } = v2Fixtures.identity;

      for (const route of v3Fixtures.routes) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}${route.path}`,
          {
            method: route.method,
            headers: {
              authorization: `Bearer ${token}`,
              'cache-control': 'no-store',
              'content-type': 'application/json',
              'x-qwen-managed-lease-id': leaseId,
              'x-qwen-managed-lease-epoch': String(epoch),
            },
            body: JSON.stringify(v3Fixtures.requests[route.key]),
          },
        );

        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
      }
      expect(reached).toEqual([]);

      // The same server still reaches the handler for its v2 execute route.
      const declared = routes.find((route) => route.key === 'execute');
      if (!declared) throw new Error('Expected a declared execute route.');
      const control = await fetch(
        `http://127.0.0.1:${address.port}${declared.path}`,
        { method: declared.method },
      );
      expect(control.status).toBe(200);
      expect(reached).toEqual([declared.path]);
    },
  );

  it('keeps v2 and v3 bodies apart in both directions', () => {
    for (const suite of v2Fixtures.suites) {
      const v3Body = v3Fixtures.requests[suite.route];

      expect(accepts(v2Schema, `${suite.route}RequestBody`, v3Body)).toBe(
        false,
      );
      expect(
        accepts(v3Schema, `${suite.route}Request`, suite.canonicalRequest.body),
      ).toBe(false);
      expect(
        accepts(
          v2Schema,
          `${suite.route}RequestBody`,
          suite.canonicalRequest.body,
        ),
      ).toBe(true);
      expect(accepts(v3Schema, `${suite.route}Request`, v3Body)).toBe(true);
    }
  });
});
