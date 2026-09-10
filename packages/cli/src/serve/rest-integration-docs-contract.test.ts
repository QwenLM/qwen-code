/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const GUIDE = path.join(REPO_ROOT, 'docs/developers/rest-api-integration.md');
const PROTOCOL = path.join(REPO_ROOT, 'docs/developers/qwen-serve-protocol.md');
const OPENAPI = path.join(
  REPO_ROOT,
  'docs/developers/daemon-rest-api.openapi.json',
);
const SERVE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Operations the guide presents as the supported integration surface. */
const GUIDE_OPERATIONS: readonly string[] = [
  'GET /health',
  'GET /capabilities',
  'POST /session',
  'DELETE /session/:id',
  'POST /session/:id/prompt',
  'POST /session/:id/cancel',
  'GET /session/:id/events',
  'GET /session/:id/status',
  'GET /session/:id/transcript',
  'GET /session/:id/context',
  'GET /session/:id/export',
  'GET /session/:id/pending-prompts',
  'POST /session/:id/heartbeat',
  'PATCH /session/:id/metadata',
  'POST /session/:id/model',
  'POST /session/:id/load',
  'POST /session/:id/resume',
  'POST /session/:id/permission/:requestId',
  'POST /permission/:requestId',
  'GET /workspace/tools',
  'GET /file',
  'GET /file/bytes',
  'GET /stat',
  'GET /list',
  'GET /glob',
];

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, unknown>;
  security?: unknown[];
  externalDocs?: { url?: string };
  'x-qwen-capability'?: string | null;
  'x-qwen-scope'?: string;
  'x-qwen-stability'?: string;
  'x-qwen-sdk-method'?: string;
}

interface OpenApiDocument {
  openapi?: string;
  paths?: Record<
    string,
    Partial<Record<(typeof HTTP_METHODS)[number], OpenApiOperation>>
  >;
  components?: { schemas?: Record<string, unknown> };
}

function guideOperations(): string[] {
  return readFileSync(GUIDE, 'utf8')
    .split('\n')
    .filter((line) => /^\| .*`(?:GET|POST|PATCH|DELETE) \//.test(line))
    .flatMap((row) =>
      [...row.split('|')[1].matchAll(/`(GET|POST|PATCH|DELETE) ([^`]+)`/g)].map(
        (match) => `${match[1]} ${match[2]}`,
      ),
    );
}

/** Collect every operation registered on an Express app or router. */
function registeredOperations(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) {
        continue;
      }
      const src = readFileSync(full, 'utf8');
      const re =
        /\b(?:app|router)\.(get|post|patch|put|delete|all)\(\s*\n?\s*'([^']+)'/g;
      for (const match of src.matchAll(re)) {
        if (match[1] !== 'all') {
          found.add(`${match[1].toUpperCase()} ${match[2]}`);
        }
      }
    }
  };
  walk(SERVE_DIR);
  return found;
}

function openApiOperations(
  document: OpenApiDocument,
): Map<string, OpenApiOperation> {
  const found = new Map<string, OpenApiOperation>();
  for (const [openApiPath, pathItem] of Object.entries(document.paths ?? {})) {
    const expressPath = openApiPath.replace(/\{([^}]+)\}/g, ':$1');
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) {
        found.set(`${method.toUpperCase()} ${expressPath}`, operation);
      }
    }
  }
  return found;
}

/** GitHub/Nextra heading slug, so anchor links can be checked. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function collectRefs(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRefs(entry, found));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') {
      found.add(entry);
    } else {
      collectRefs(entry, found);
    }
  }
}

describe('REST integration documentation contract', () => {
  it('keeps the guide, OpenAPI document, and daemon registrations aligned', () => {
    const expected = [...GUIDE_OPERATIONS].sort();
    expect(guideOperations().sort()).toEqual(expected);

    const registered = registeredOperations();
    expect(GUIDE_OPERATIONS.filter((entry) => !registered.has(entry))).toEqual(
      [],
    );

    const openApi = JSON.parse(
      readFileSync(OPENAPI, 'utf8'),
    ) as OpenApiDocument;
    expect([...openApiOperations(openApi).keys()].sort()).toEqual(expected);
  });

  it('keeps the OpenAPI contract self-describing', () => {
    const openApi = JSON.parse(
      readFileSync(OPENAPI, 'utf8'),
    ) as OpenApiDocument;
    expect(openApi.openapi).toBe('3.1.0');
    const protocolAnchors = new Set(
      [...readFileSync(PROTOCOL, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        (match) => slug(match[1]),
      ),
    );
    const operationIds: string[] = [];
    for (const operation of openApiOperations(openApi).values()) {
      const operationId = operation.operationId;
      expect(operationId).toBeTruthy();
      if (operationId) {
        operationIds.push(operationId);
      }
      expect(operation).toHaveProperty('x-qwen-capability');
      expect(operation['x-qwen-scope']).toBeTruthy();
      expect(operation['x-qwen-stability']).toBe('stable');
      expect(operation['x-qwen-sdk-method']).toMatch(/^DaemonClient\./);
      const anchor = operation.externalDocs?.url?.match(
        /qwen-serve-protocol\/#([a-z0-9-]+)$/,
      )?.[1];
      expect(anchor).toBeTruthy();
      if (anchor) {
        expect(protocolAnchors.has(anchor)).toBe(true);
      }
      expect(operation.security?.length).toBeGreaterThan(0);
      expect(
        Object.keys(operation.responses ?? {}).some((code) =>
          /^2\d\d$/.test(code),
        ),
      ).toBe(true);
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const refs = new Set<string>();
    collectRefs(openApi, refs);
    const schemas = openApi.components?.schemas ?? {};
    expect(
      [...refs].filter(
        (ref) =>
          !ref.startsWith('#/components/schemas/') ||
          !(ref.slice('#/components/schemas/'.length) in schemas),
      ),
    ).toEqual([]);
  });

  it('links only to documentation files and protocol anchors that exist', () => {
    const guide = readFileSync(GUIDE, 'utf8');
    const targets = [
      ...guide.matchAll(/\]\((\.\.?\/[^)#\s]+\.md)(?:#[^)]*)?\)/g),
    ].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(
      targets.filter(
        (target) => !existsSync(path.resolve(path.dirname(GUIDE), target)),
      ),
    ).toEqual([]);

    const anchors = new Set(
      [...readFileSync(PROTOCOL, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        (match) => slug(match[1]),
      ),
    );
    const broken = [
      ...guide.matchAll(/\]\(\.\/qwen-serve-protocol\.md#([a-z0-9-]+)\)/g),
    ]
      .map((match) => match[1])
      .filter((anchor) => !anchors.has(anchor));
    expect(broken).toEqual([]);
  });

  it('gives every supported operation a dedicated protocol heading', () => {
    const headings = new Set(
      [
        ...readFileSync(PROTOCOL, 'utf8').matchAll(
          /^#{3,4} `(GET|POST|PATCH|PUT|DELETE) ([^`]+)`/gm,
        ),
      ].map((match) => `${match[1]} ${match[2]}`),
    );
    expect(GUIDE_OPERATIONS.filter((entry) => !headings.has(entry))).toEqual(
      [],
    );
  });

  it('still sees the bulk of the route surface', () => {
    expect(registeredOperations().size).toBeGreaterThan(100);
  });
});
