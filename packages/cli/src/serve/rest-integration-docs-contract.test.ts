/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_TRANSCRIPT_MAX_LIMIT } from '@qwen-code/qwen-code-core';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SERVE_CAPABILITY_REGISTRY } from './capabilities.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const GUIDE = path.join(REPO_ROOT, 'docs/developers/rest-api-integration.md');
const PROTOCOL = path.join(REPO_ROOT, 'docs/developers/qwen-serve-protocol.md');
const REFERENCE = path.join(
  REPO_ROOT,
  'docs/developers/daemon-rest-api-reference.md',
);
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
const REGISTERED_METHODS = new Set<string>([...HTTP_METHODS, 'all']);
const ROUTE_METHODS = '(GET|POST|PATCH|PUT|DELETE)';
const SCOPES = new Set([
  'process-global',
  'selected-runtime',
  'persisted-workspace',
  'live-session-owner',
  'legacy-primary',
]);
/** Media types the published document is allowed to claim. */
const CONTENT_TYPES = new Set([
  'application/json',
  'application/jsonl',
  'text/event-stream',
  'text/html',
  'text/markdown',
]);

interface OpenApiOperation {
  operationId?: string;
  requestBody?: unknown;
  parameters?: Array<{
    name?: string;
    in?: string;
    schema?: { minimum?: number; maximum?: number };
  }>;
  responses?: Record<
    string,
    { description?: string; content?: Record<string, unknown> }
  >;
  security?: Array<Record<string, unknown>>;
  externalDocs?: { url?: string };
  'x-qwen-capability'?: string | null;
  'x-qwen-scope'?: string;
  'x-qwen-stability'?: string;
  'x-qwen-sdk-method'?: string;
}

interface OpenApiDocument {
  openapi?: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<
    string,
    Partial<Record<(typeof HTTP_METHODS)[number], OpenApiOperation>>
  >;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

/** The Route column of a guide table row. */
function routeCell(row: string): string {
  return row.split('|')[1] ?? '';
}

/** Table rows whose Route column names at least one backticked route. */
function guideRouteRows(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('|') &&
        new RegExp('`' + ROUTE_METHODS + ' \\/').test(routeCell(line)),
    );
}

function rowToOperations(row: string): string[] {
  const found: string[] = [];
  const cell = routeCell(row);
  for (const match of cell.matchAll(
    new RegExp('`' + ROUTE_METHODS + ' (\\/[^`]+)`', 'g'),
  )) {
    if (!match[1] || !match[2]) {
      continue;
    }
    found.push(`${match[1]} ${match[2]}`);
  }
  return found;
}

function guideOperations(source: string = GUIDE): string[] {
  return guideRouteRows(readFileSync(source, 'utf8')).flatMap(rowToOperations);
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
      const source = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          ['app', 'router'].includes(node.expression.expression.text)
        ) {
          const method = node.expression.name.text;
          const target = node.arguments[0];
          if (
            REGISTERED_METHODS.has(method) &&
            target !== undefined &&
            ts.isStringLiteral(target) &&
            method !== 'all'
          ) {
            found.add(`${method.toUpperCase()} ${target.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
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

/**
 * GitHub heading slug, so anchor links can be checked. Matches github-slugger:
 * punctuation is dropped, but underscores survive and each space becomes one
 * hyphen (a run of spaces is not collapsed).
 */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/** Protocol headings outside fenced code blocks, where # starts a comment. */
function protocolHeadings(): string[] {
  const headings: string[] = [];
  let fence: string | undefined;
  for (const line of readFileSync(PROTOCOL, 'utf8').split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) {
      fence = fence === undefined ? marker : undefined;
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    const match = /^#{1,6} (.+)$/.exec(line);
    if (match) {
      headings.push(match[1]);
    }
  }
  return headings;
}

function protocolAnchors(): Set<string> {
  return new Set(protocolHeadings().map((heading) => slug(heading)));
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

/** Resolve a JSON Pointer, so any in-document target is accepted. */
function resolveRef(
  document: OpenApiDocument,
  ref: string,
): Record<string, unknown> {
  let node: unknown = document;
  for (const step of ref.replace(/^#\//, '').split('/')) {
    node = (node as Record<string, unknown>)[step];
  }
  return node as Record<string, unknown>;
}

function resolvesPointer(document: unknown, ref: string): boolean {
  if (!ref.startsWith('#/')) {
    return false;
  }
  const target = ref
    .slice(2)
    .split('/')
    .reduce<unknown>((node, token) => {
      if (typeof node !== 'object' || node === null) {
        return undefined;
      }
      return (node as Record<string, unknown>)[
        token.replace(/~1/g, '/').replace(/~0/g, '~')
      ];
    }, document);
  return target !== undefined;
}

/** Every member the client exposes, including inherited accessors. */
function sdkMethods(): Set<string> {
  const names = new Set<string>();
  for (
    let proto: object | null = DaemonClient.prototype;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    Object.getOwnPropertyNames(proto).forEach((name) => names.add(name));
  }
  return names;
}

describe('REST integration documentation contract', () => {
  it('keeps the guide, OpenAPI document, and daemon registrations aligned', () => {
    const expected = [...GUIDE_OPERATIONS].sort();
    expect(guideOperations().sort()).toEqual(expected);

    const routeRows = guideRouteRows(readFileSync(GUIDE, 'utf8'));
    expect(
      routeRows.filter((row) => rowToOperations(row).length === 0),
    ).toEqual([]);

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
    const anchors = protocolAnchors();
    const capabilities = new Set(Object.keys(SERVE_CAPABILITY_REGISTRY));
    const schemes = new Set(
      Object.keys(openApi.components?.securitySchemes ?? {}),
    );
    const methods = sdkMethods();
    const operationIds: string[] = [];
    for (const operation of openApiOperations(openApi).values()) {
      const operationId = operation.operationId;
      expect(operationId).toBeTruthy();
      if (operationId) {
        operationIds.push(operationId);
      }
      expect(operation).toHaveProperty('x-qwen-capability');
      const capability = operation['x-qwen-capability'];
      expect(
        capability === null || capabilities.has(capability as string),
      ).toBe(true);
      expect(SCOPES.has(operation['x-qwen-scope'] as string)).toBe(true);
      expect(operation['x-qwen-stability']).toBe('stable');
      expect(
        methods.has(
          (operation['x-qwen-sdk-method'] ?? '').replace(/^DaemonClient\./, ''),
        ),
      ).toBe(true);
      const anchor = operation.externalDocs?.url?.match(
        /qwen-serve-protocol\/#([a-z0-9_-]+)$/,
      )?.[1];
      expect(anchor).toBeTruthy();
      if (anchor) {
        expect(anchors.has(anchor)).toBe(true);
      }
      const security = operation.security ?? [];
      expect(security.length).toBeGreaterThan(0);
      for (const requirement of security) {
        const names = Object.keys(requirement);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(schemes.has(name)).toBe(true);
        }
      }
      const successful = Object.entries(operation.responses ?? {}).filter(
        ([code]) => /^2\d\d$/.test(code),
      );
      expect(successful.length).toBeGreaterThan(0);
      for (const [code, response] of successful) {
        if (code === '204' || code === '205') {
          continue;
        }
        const mediaTypes = Object.keys(response.content ?? {});
        expect(mediaTypes.length).toBeGreaterThan(0);
        expect(mediaTypes.every((type) => CONTENT_TYPES.has(type))).toBe(true);
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(
      Object.keys(
        openApi.paths?.['/session/{id}/events']?.get?.responses?.['200']
          ?.content ?? {},
      ),
    ).toEqual(['text/event-stream']);
    expect(
      Object.keys(
        openApi.paths?.['/session/{id}/export']?.get?.responses?.['200']
          ?.content ?? {},
      ).sort(),
    ).toEqual([
      'application/json',
      'application/jsonl',
      'text/html',
      'text/markdown',
    ]);
    const closeResponses =
      openApi.paths?.['/session/{id}']?.delete?.responses ?? {};
    expect(closeResponses['404']?.description).toContain('session_closing');
    expect(closeResponses['409']?.description).toContain('live_session_active');
    expect(closeResponses['409']?.description).not.toContain('session_closing');

    const schemas = openApi.components?.schemas ?? {};
    const metadataProperties = (
      schemas['SessionMetadataRequest'] as {
        properties?: Record<string, { pattern?: string }>;
      }
    ).properties;
    const displayNamePattern = metadataProperties?.['displayName']?.pattern;
    expect(displayNamePattern).toBeTruthy();
    expect(new RegExp(displayNamePattern as string).test('bad\nname')).toBe(
      false,
    );
    for (const schemaName of ['SessionPrInput', 'SessionPr', 'SessionIssue']) {
      const urlPattern = (
        schemas[schemaName] as {
          properties?: Record<string, { pattern?: string }>;
        }
      ).properties?.['url']?.pattern;
      expect(urlPattern).toBeTruthy();
      expect(
        new RegExp(urlPattern as string).test('https://example.com\n'),
      ).toBe(false);
    }

    const refs = new Set<string>();
    collectRefs(openApi, refs);
    expect([...refs].filter((ref) => !resolvesPointer(openApi, ref))).toEqual(
      [],
    );
  });

  it('keeps the published reference index in step with the OpenAPI document', () => {
    const openApi = JSON.parse(
      readFileSync(OPENAPI, 'utf8'),
    ) as OpenApiDocument;
    const operations = openApiOperations(openApi);
    const anchors = protocolAnchors();
    const rows = readFileSync(REFERENCE, 'utf8')
      .split('\n')
      .filter((line) => /^\| \[`/.test(line));
    expect(rows.length).toBe(operations.size);
    const seen = new Set<string>();
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      const link = cells[1]?.match(
        /^\[`([^`]+)`\]\(\.\/qwen-serve-protocol\.md#([a-z0-9_-]+)\)$/,
      );
      expect(link).toBeTruthy();
      if (!link) {
        continue;
      }
      const operation = operations.get(link[1]);
      expect(operation).toBeTruthy();
      if (!operation) {
        continue;
      }
      seen.add(link[1]);
      expect(anchors.has(link[2])).toBe(true);
      expect(link[2]).toBe(
        operation.externalDocs?.url?.match(
          /qwen-serve-protocol\/#([a-z0-9_-]+)$/,
        )?.[1],
      );
      const capability = operation['x-qwen-capability'];
      expect(cells[2]).toBe(capability === null ? '—' : `\`${capability}\``);
      expect(cells[3]).toBe(`\`${operation['x-qwen-scope']}\``);
      expect(cells[4]).toBe(`\`${operation['x-qwen-sdk-method']}\``);
    }
    expect([...operations.keys()].filter((key) => !seen.has(key))).toEqual([]);
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

    const repoLinks = [
      ...guide.matchAll(
        /\]\((https:\/\/github\.com\/QwenLM\/qwen-code\/(?:blob|tree)\/main\/[^#)\s]+)(?:#[^)]*)?\)/g,
      ),
    ].map((match) => match[1].replace(/^.*\/main\//, ''));
    expect(repoLinks.length).toBeGreaterThan(0);
    expect(
      repoLinks.filter((target) => !existsSync(path.join(REPO_ROOT, target))),
    ).toEqual([]);

    const anchors = protocolAnchors();
    const protocolLinks = [
      ...guide.matchAll(/\]\(\.\/qwen-serve-protocol\.md#([a-z0-9_-]+)\)/g),
    ].map((match) => match[1]);
    expect(protocolLinks.length).toBeGreaterThan(0);
    expect(protocolLinks.filter((anchor) => !anchors.has(anchor))).toEqual([]);
  });

  it('points every guide flow command at the published server', () => {
    const guide = readFileSync(GUIDE, 'utf8');
    const openApi = JSON.parse(
      readFileSync(OPENAPI, 'utf8'),
    ) as OpenApiDocument;
    const published = new URL(openApi.servers?.[0]?.url ?? '').host;
    const hosts = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(
      (fence) =>
        [...fence[1].matchAll(/https?:\/\/([^/\s'"]+)/g)].map(
          (match) => match[1],
        ),
    );
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)].filter((host) => host !== published)).toEqual(
      [],
    );
    const origins = new Set(
      [...guide.matchAll(/http:\/\/[^/\s"')`\],;]+/g)].map((match) =>
        match[0].replace(/\.$/, ''),
      ),
    );
    expect(
      [...origins].filter((origin) => origin !== openApi.servers?.[0]?.url),
    ).toEqual([]);
  });

  it('gives every supported operation a dedicated protocol heading', () => {
    const headings = new Set(
      [
        ...readFileSync(PROTOCOL, 'utf8').matchAll(
          /^#{3,4} `(GET|POST|PATCH|PUT|DELETE) ([^`]+)`/gm,
        ),
      ].map((match) => `${match[1]} ${match[2]}`),
    );
    const unfenced = readFileSync(PROTOCOL, 'utf8').replace(
      /```[\s\S]*?```/g,
      '',
    );
    const outside = new Set(
      [...unfenced.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1])),
    );
    expect([...protocolAnchors()].sort()).toEqual([...outside].sort());
    expect(GUIDE_OPERATIONS.filter((entry) => !headings.has(entry))).toEqual(
      [],
    );
  });

  it('publishes the resume request schema without the load-only fields', () => {
    const openApi = JSON.parse(
      readFileSync(OPENAPI, 'utf8'),
    ) as OpenApiDocument;
    const requestFields = (
      operation: OpenApiOperation | undefined,
    ): string[] => {
      const ref = (
        operation?.requestBody as
          | { content?: Record<string, { schema?: { $ref?: string } }> }
          | undefined
      )?.content?.['application/json']?.schema?.$ref;
      expect(ref).toBeTruthy();
      const schema = resolveRef(openApi, ref as string);
      return Object.keys(
        (schema['properties'] ?? {}) as Record<string, unknown>,
      ).sort();
    };
    expect(
      requestFields(openApi.paths?.['/session/{id}/resume']?.post),
    ).toEqual(['approvalMode', 'cwd', 'sourceId', 'sourceType']);
    const loadPost = openApi.paths?.['/session/{id}/load']?.post;
    expect(requestFields(loadPost)).toEqual([
      'approvalMode',
      'cwd',
      'historyPageSize',
      'liveReplayMode',
      'sourceId',
      'sourceType',
    ]);
    const loadSchema = resolveRef(
      openApi,
      (
        loadPost?.requestBody as
          | { content?: Record<string, { schema?: { $ref?: string } }> }
          | undefined
      )?.content?.['application/json']?.schema?.$ref as string,
    ) as { properties?: Record<string, { maximum?: number }> };
    expect(loadSchema.properties?.['historyPageSize']?.maximum).toBe(
      SESSION_TRANSCRIPT_MAX_LIMIT,
    );
    const transcriptLimit = (
      openApi.paths?.['/session/{id}/transcript']?.get?.parameters ?? []
    ).find(
      (parameter) => parameter.in === 'query' && parameter.name === 'limit',
    );
    expect(transcriptLimit?.schema?.maximum).toBe(SESSION_TRANSCRIPT_MAX_LIMIT);
  });

  it('still sees the bulk of the route surface', () => {
    expect(registeredOperations().size).toBeGreaterThan(100);
  });
});
