/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser as tsParser } from 'typescript-eslint';
import { afterEach, describe, expect, it } from 'vitest';
import { relayedHeaders } from './hosted-relay-headers.js';

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

// The sdk-java workflow step runs this file after `cd integration-tests`
// while the repo-root integration lanes use `--root ./integration-tests`, so
// resolve the drivers relative to this file, never process.cwd().
const helpersDir = dirname(fileURLToPath(import.meta.url));

function driverSources(): Array<[string, string]> {
  return readdirSync(helpersDir, { recursive: true })
    .map(String)
    .filter((name) => /(?:^|[/\\])hosted-.+-driver\.ts$/.test(name))
    .sort()
    .map((name): [string, string] => [
      name,
      readFileSync(join(helpersDir, name), 'utf8'),
    ]);
}

// A ServerResponse receives headers only through writeHead's headers argument
// or the per-key mutators, so an AST scan over those two sites covers every
// spelling of a wholesale upstream-header relay — a source regex can only
// enumerate the spellings someone has already thought of.
interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const SKIP_KEYS = new Set([
  'loc',
  'range',
  'parent',
  'tokens',
  'comments',
  'leadingComments',
  'trailingComments',
]);

function asNode(value: unknown): AstNode | null {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as AstNode).type === 'string'
    ? (value as AstNode)
    : null;
}

function* walk(node: AstNode): Generator<AstNode> {
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = asNode(item);
        if (child) yield* walk(child);
      }
    } else {
      const child = asNode(value);
      if (child) yield* walk(child);
    }
  }
}

type ParseForESLint = (
  code: string,
  options: { sourceType: 'module' },
) => { ast: unknown };

function parseSource(source: string): AstNode {
  const { ast } = (
    tsParser as unknown as { parseForESLint: ParseForESLint }
  ).parseForESLint(source, { sourceType: 'module' });
  return ast as AstNode;
}

function memberCalleeName(callee: AstNode | null): string | null {
  if (!callee || callee.type !== 'MemberExpression') return null;
  const property = asNode(callee.property);
  if (callee.computed) {
    return property?.type === 'Literal' && typeof property.value === 'string'
      ? property.value
      : null;
  }
  return property?.type === 'Identifier' ? (property.name as string) : null;
}

function isStringLiteral(node: AstNode | null): boolean {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

function isRelayedHeadersCall(node: AstNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = asNode(node.callee);
  if (callee?.type === 'Identifier') return callee.name === 'relayedHeaders';
  return memberCalleeName(callee) === 'relayedHeaders';
}

// Only a literal of named, non-computed properties: a spread can enumerate
// the upstream headers wholesale, and a computed key can smuggle a name in.
function isPlainHeaderLiteral(node: AstNode): boolean {
  if (node.type !== 'ObjectExpression') return false;
  return (node.properties as unknown[]).every((property) => {
    const entry = asNode(property);
    return entry?.type === 'Property' && entry.computed !== true;
  });
}

function constInits(ast: AstNode): Map<string, AstNode[]> {
  const inits = new Map<string, AstNode[]>();
  for (const node of walk(ast)) {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') continue;
    for (const declaration of node.declarations as unknown[]) {
      const declarator = asNode(declaration);
      const id = asNode(declarator?.id);
      const init = asNode(declarator?.init);
      if (id?.type === 'Identifier' && init) {
        const name = id.name as string;
        inits.set(name, [...(inits.get(name) ?? []), init]);
      }
    }
  }
  return inits;
}

function passesThroughHelper(
  arg: AstNode,
  inits: Map<string, AstNode[]>,
): boolean {
  if (isRelayedHeadersCall(arg)) return true;
  return (
    arg.type === 'Identifier' &&
    (inits.get(arg.name as string) ?? []).some(isRelayedHeadersCall)
  );
}

function isSafeHeadersArg(
  arg: AstNode,
  inits: Map<string, AstNode[]>,
): boolean {
  if (isPlainHeaderLiteral(arg) || isRelayedHeadersCall(arg)) return true;
  return (
    arg.type === 'Identifier' && bindsToSafeInit(arg.name as string, inits)
  );
}

function bindsToSafeInit(name: string, inits: Map<string, AstNode[]>): boolean {
  return (inits.get(name) ?? []).some(
    (init) => isPlainHeaderLiteral(init) || isRelayedHeadersCall(init),
  );
}

interface RelayScan {
  violations: string[];
  usesHelper: boolean;
}

const HEADER_MUTATORS = [
  'setHeader',
  'appendHeader',
  'setHeaders',
  'addTrailers',
];

function scanRelaySites(source: string): RelayScan {
  const ast = parseSource(source);
  const inits = constInits(ast);
  const violations: string[] = [];
  let usesHelper = false;
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression') continue;
    const method = memberCalleeName(asNode(node.callee));
    const line = node.loc?.start.line ?? 0;
    if (method && HEADER_MUTATORS.includes(method)) {
      violations.push(
        `line ${line}: ${method}() copies headers key by key — ` +
          'relay through writeHead(..., relayedHeaders(...)) instead',
      );
      continue;
    }
    if (method !== 'writeHead') continue;
    const args = (node.arguments as unknown[])
      .map(asNode)
      .filter((arg): arg is AstNode => arg !== null);
    // writeHead(status[, statusMessage], headers)
    const headerIndex =
      args.length === 2
        ? 1
        : args.length === 3 && isStringLiteral(args[1] ?? null)
          ? 2
          : -1;
    if (
      args.some((arg) => arg.type === 'SpreadElement') ||
      (args.length > 1 && headerIndex === -1)
    ) {
      violations.push(
        `line ${line}: unrecognised writeHead form — ` +
          'expected writeHead(status[, statusMessage], headers)',
      );
      continue;
    }
    if (headerIndex === -1) continue;
    const headersArg = args[headerIndex];
    if (!headersArg) continue;
    if (passesThroughHelper(headersArg, inits)) usesHelper = true;
    if (!isSafeHeadersArg(headersArg, inits)) {
      violations.push(
        `line ${line}: writeHead headers must be a literal of named ` +
          'properties, relayedHeaders(...), or a const bound to one',
      );
    }
  }
  return { violations, usesHelper };
}

describe('Hosted proxy header relay', () => {
  it('keeps only the end-to-end headers that describe the buffered body', () => {
    expect(
      relayedHeaders(
        new Headers({
          'cache-control': 'no-store',
          // Two mixed-case tokens after ", " pin the dynamic branch's
          // split/trim/lowercase; keep them out of the expectation, and keep
          // 'keep-alive' out of this list — the dynamic branch would mask
          // the static NOT_RELAYED entry this case witnesses.
          connection: 'X-Upstream-Hop, X-Second-Hop',
          'content-encoding': 'identity',
          'content-length': '11',
          'content-type': 'application/json',
          'keep-alive': 'timeout=60',
          'proxy-authenticate': 'Basic',
          'proxy-authorization': 'Basic upstream-proxy-credential',
          'proxy-connection': 'keep-alive',
          te: 'trailers',
          trailer: 'x-qwen-trailer',
          'transfer-encoding': 'chunked',
          upgrade: 'h2c',
          'x-qwen-resource-digest': 'sha256',
          'x-qwen-resource-kind': 'workspace',
          'x-qwen-resource-schema-version': '1',
          'x-second-hop': '2',
          'x-upstream-hop': '1',
        }),
      ),
    ).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-qwen-resource-digest': 'sha256',
      'x-qwen-resource-kind': 'workspace',
      'x-qwen-resource-schema-version': '1',
    });
  });

  it("advertises the proxy's own keep-alive window, not the upstream's", async () => {
    // A raw TCP origin: Node's own server would append
    // `Connection: keep-alive` to the reply, and the filter's dynamic branch
    // would then drop the advertised Keep-Alive even with the static
    // 'keep-alive' entry deleted, leaving this case green on that mutant.
    const sockets = new Set<Socket>();
    const raw = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => {
        // Hold the socket open: with a short-lived origin the mutant dies on
        // a socket-reuse race instead of on the assertion.
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
            'Cache-Control: no-store\r\n' +
            'Keep-Alive: timeout=60\r\n' +
            'Content-Length: 2\r\n' +
            '\r\n' +
            '{}',
        );
      });
    });
    raw.listen(0, '127.0.0.1');
    await once(raw, 'listening');
    try {
      const upstream = `http://127.0.0.1:${
        (raw.address() as AddressInfo).port
      }`;
      const proxy = createServer(async (_req, res) => {
        const response = await fetch(upstream);
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, relayedHeaders(response.headers));
        res.end(body);
      });
      const response = await fetch(await listen(proxy));
      expect(await response.text()).toBe('{}');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('keep-alive')).toBe(
        `timeout=${proxy.keepAliveTimeout / 1000}`,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      const closed = once(raw, 'close');
      raw.close();
      await closed;
    }
  });

  it('routes every wholesale upstream-header relay through relayedHeaders', () => {
    for (const [name, source] of driverSources()) {
      expect(scanRelaySites(source).violations, name).toEqual([]);
    }
  });

  it('keeps the five store relays calling the shared helper', () => {
    const callers = driverSources()
      .filter(([, source]) => scanRelaySites(source).usesHelper)
      .map(([name]) => name);
    expect(callers).toEqual([
      'hosted-latency-driver.ts',
      'hosted-process-crash-driver.ts',
      'hosted-shell-output-driver.ts',
      'hosted-store-failure-driver.ts',
      'hosted-workspace-tool-turn-driver.ts',
    ]);
  });

  // Each probe pins one branch of scanRelaySites: the flagged spellings are
  // wholesale relays the gate must catch; the allowed ones are forms the
  // real drivers use or a readability refactor would naturally produce.
  it.each([
    [
      'an Object.fromEntries spread',
      'res.writeHead(upstream.status, { ...Object.fromEntries(upstream.headers) });',
    ],
    [
      'a forEach copy into setHeader',
      'upstream.headers.forEach((value, name) => res.setHeader(name, value));',
    ],
    [
      'an entries() loop into setHeader',
      'for (const [name, value] of upstream.headers.entries()) res.setHeader(name, value);',
    ],
    [
      'a statusCode spelling',
      'res.writeHead(upstream.statusCode, Object.fromEntries(upstream.headers));',
    ],
    [
      'destructured upstream headers',
      'const { headers } = upstream;\n' +
        'res.writeHead(upstream.status, { ...Object.fromEntries(headers) });',
    ],
    [
      'a wholesale copy bound to a const',
      'const copy = Object.fromEntries(upstream.headers);\n' +
        'res.writeHead(upstream.status, copy);',
    ],
    [
      'a setHeader far from its loop',
      `for (const [name, value] of upstream.headers) {\n` +
        `  // ${'x'.repeat(240)}\n` +
        '  res.setHeader(name, value);\n' +
        '}',
    ],
    [
      'a wholesale relay in the three-argument form',
      "res.writeHead(upstream.status, 'OK', Object.fromEntries(upstream.headers));",
    ],
    ['spread arguments', 'res.writeHead(...args);'],
    [
      'a computed writeHead key',
      "res['writeHead'](upstream.status, Object.fromEntries(upstream.headers));",
    ],
  ])('flags %s', (label, source) => {
    expect(scanRelaySites(source).violations, label).toHaveLength(1);
  });

  it.each([
    [
      'the inline relayedHeaders call',
      'res.writeHead(upstream.status, relayedHeaders(upstream.headers));',
    ],
    [
      'relayedHeaders bound to a const',
      'const relay = relayedHeaders(response.headers);\n' +
        'res.writeHead(response.status, relay);',
    ],
    [
      'a header literal bound to a const',
      "const headers = { 'content-type': 'application/json' };\n" +
        'res.writeHead(200, headers);',
    ],
    [
      'a literal reading single upstream keys',
      'res.writeHead(upstream.status, {\n' +
        "  'cache-control': upstream.headers.get('cache-control') ?? '',\n" +
        '});',
    ],
    ['a status-only writeHead', 'res.writeHead(503);'],
    [
      'a three-argument writeHead with a literal',
      "res.writeHead(200, 'OK', { 'content-type': 'application/json' });",
    ],
    [
      'a request-direction header copy',
      'for (const [name, value] of Object.entries(req.headers)) out[name] = value;',
    ],
  ])('allows %s', (label, source) => {
    expect(scanRelaySites(source).violations, label).toEqual([]);
  });

  it('keeps a hoisted relayedHeaders call inside the caller pin', () => {
    expect(
      scanRelaySites(
        'const relay = relayedHeaders(response.headers);\n' +
          'res.writeHead(response.status, relay);',
      ).usesHelper,
    ).toBe(true);
    expect(
      scanRelaySites(
        "res.writeHead(200, { 'content-type': 'application/json' });",
      ).usesHelper,
    ).toBe(false);
  });
});
