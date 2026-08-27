/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePresetProbeArgs,
  renderPresetProbeReport,
  runPresetProbe,
} from './preset-probe.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface Deployment {
  /** Fields the search schema declares at the request root. */
  rootFields?: readonly string[];
  /** Reject undeclared fields, the way a strict Pydantic model does. */
  strict?: boolean;
  /** Reject a search whose identity never reached the root. */
  rootIdentityOnly?: boolean;
  memories?: ReadonlyArray<{ id: string; memory: string }>;
  openApi?: boolean;
}

const DEFAULT_MEMORIES = [
  { id: 'm1', memory: 'first' },
  { id: 'm2', memory: 'second' },
];

async function startDeployment(deployment: Deployment): Promise<string> {
  const rootFields = new Set(
    deployment.rootFields ?? [
      'query',
      'filters',
      'top_k',
      'user_id',
      'agent_id',
    ],
  );
  const memories = deployment.memories ?? DEFAULT_MEMORIES;
  const server = createServer((request, response) => {
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.url?.endsWith('/openapi.json')) {
      if (deployment.openApi !== true) {
        return send(404, { detail: 'Not Found' });
      }
      return send(200, {
        components: {
          schemas: {
            SearchRequest: {
              properties: Object.fromEntries(
                [...rootFields].map((field) => [field, { type: 'string' }]),
              ),
              ...(deployment.strict === true
                ? { additionalProperties: false }
                : {}),
            },
          },
        },
      });
    }
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const extra = Object.keys(body).filter((key) => !rootFields.has(key));
      if (deployment.strict === true && extra.length > 0) {
        return send(422, {
          detail: [{ type: 'extra_forbidden', loc: ['body', extra[0]] }],
        });
      }
      const filters = (body['filters'] ?? {}) as Record<string, unknown>;
      const identity = deployment.rootIdentityOnly
        ? body['user_id']
        : (body['user_id'] ?? filters['user_id']);
      if (typeof identity !== 'string') {
        return send(500, {
          detail:
            "At least one of 'user_id', 'agent_id', or 'run_id' must be provided.",
        });
      }
      send(200, { results: memories });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
  }
  return raw;
}

const probe = (origin: string) =>
  runPresetProbe({
    preset: 'aliyun-polardb-mysql-2026-08',
    origin,
    allowInsecureHttp: true,
    scope: { userId: 'fixed-user' },
    credential: 'probe-credential',
    signal: AbortSignal.timeout(5000),
  });

describe('runPresetProbe', () => {
  it('clears dual placement when the deployment reads identity from either position', async () => {
    const report = await probe(await startDeployment({}));

    expect(report.baseline).toEqual({ ok: true, itemCount: 2 });
    expect(report.unknownFieldPolicy).toBe('ignored');
    expect(report.placements?.both.ids).toEqual(['m1', 'm2']);
    expect(report.verdict).toBe('dual-placement-safe');
  });

  it('clears dual placement when a strict schema declares the root identity', async () => {
    const report = await probe(await startDeployment({ strict: true }));

    expect(report.unknownFieldPolicy).toBe('rejected');
    expect(report.verdict).toBe('dual-placement-safe');
  });

  it('refuses dual placement when a strict schema has no root identity field', async () => {
    const report = await probe(
      await startDeployment({
        strict: true,
        rootFields: ['query', 'filters', 'top_k'],
      }),
    );

    expect(report.placements?.both.status).toBe(422);
    expect(report.placements?.both.detail).toContain('extra_forbidden');
    expect(report.verdict).toBe('dual-placement-unsafe');
  });

  // The failure this whole tool exists to catch: a build that never reads
  // identity out of `filters` rejects the preset's own search outright.
  it('reports a preset mismatch when the preset search itself fails', async () => {
    const report = await probe(
      await startDeployment({ rootIdentityOnly: true }),
    );

    expect(report.baseline.ok).toBe(false);
    expect(report.verdict).toBe('preset-mismatch');
  });

  // Three equally empty result sets look like agreement and are not.
  it('refuses to conclude anything from an empty corpus', async () => {
    const report = await probe(await startDeployment({ memories: [] }));

    expect(report.baseline).toEqual({ ok: true, itemCount: 0 });
    expect(report.verdict).toBe('empty-corpus');
  });

  it('reports the declared search schema when the deployment serves one', async () => {
    const report = await probe(
      await startDeployment({ strict: true, openApi: true }),
    );

    expect(report.declaredSearchFields).toContain('user_id');
    expect(report.declaredAdditionalProperties).toBe('false');
  });

  it('skips the comparison for a preset that already sends both positions', async () => {
    const report = await runPresetProbe({
      preset: 'mem0-server-rest-2026-08',
      origin: await startDeployment({}),
      allowInsecureHttp: true,
      scope: { userId: 'fixed-user' },
      credential: 'probe-credential',
      signal: AbortSignal.timeout(5000),
    });

    expect(report.placements).toBeUndefined();
    expect(report.verdict).toBe('already-dual-placement');
  });

  it('rejects a scope the preset does not accept before sending anything', async () => {
    await expect(
      runPresetProbe({
        preset: 'aliyun-polardb-mysql-2026-08',
        origin: 'https://mem0.example.com',
        scope: { appId: 'unused' },
        credential: 'probe-credential',
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('requires "userId"');
  });

  it('applies the endpoint URL policy', async () => {
    await expect(
      runPresetProbe({
        preset: 'aliyun-polardb-mysql-2026-08',
        origin: 'http://192.0.2.1:8080',
        scope: { userId: 'fixed-user' },
        credential: 'probe-credential',
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('must use HTTPS or loopback HTTP');
  });
});

describe('renderPresetProbeReport', () => {
  it('never renders the credential', async () => {
    const report = await probe(await startDeployment({}));

    expect(renderPresetProbeReport(report)).not.toContain('probe-credential');
  });

  it('names the rejected field so the operator can act on it', async () => {
    const report = await probe(
      await startDeployment({
        strict: true,
        rootFields: ['query', 'filters', 'top_k'],
      }),
    );

    const rendered = renderPresetProbeReport(report);
    expect(rendered).toContain('extra_forbidden');
    expect(rendered).toContain('UNSAFE');
  });
});

describe('parsePresetProbeArgs', () => {
  it('reads the preset, endpoint, and scope', () => {
    expect(
      parsePresetProbeArgs(
        [
          '--preset',
          'aliyun-polardb-mysql-2026-08',
          '--origin',
          'https://mem0.example.com',
          '--base-path',
          '/proxy',
          '--user-id',
          'fixed-user',
          '--allow-insecure-http',
        ],
        { MEM0_API_KEY: 'secret-value' },
      ),
    ).toEqual({
      preset: 'aliyun-polardb-mysql-2026-08',
      origin: 'https://mem0.example.com',
      basePath: '/proxy',
      allowInsecureHttp: true,
      scope: { userId: 'fixed-user' },
      credential: 'secret-value',
    });
  });

  it.each([
    {
      label: 'an unknown preset',
      argv: [
        '--preset',
        'mem0-oss-rest-2026-08',
        '--origin',
        'https://m.example.com',
      ],
      env: { MEM0_API_KEY: 'secret-value' },
      message: '--preset must be one of',
    },
    {
      label: 'a missing origin',
      argv: ['--preset', 'mem0-platform-v3'],
      env: { MEM0_API_KEY: 'secret-value' },
      message: '--origin is required.',
    },
    {
      label: 'an unavailable credential',
      argv: [
        '--preset',
        'mem0-platform-v3',
        '--origin',
        'https://m.example.com',
      ],
      env: {},
      message: 'MEM0_API_KEY must hold the provider credential.',
    },
  ])('rejects $label', ({ argv, env, message }) => {
    expect(() => parsePresetProbeArgs(argv, env)).toThrow(message);
  });
});
