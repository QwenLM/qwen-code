/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mcpRequire = createRequire(
  require.resolve('@modelcontextprotocol/sdk/server/mcp.js'),
);
const expressRequire = createRequire(mcpRequire.resolve('express'));
const ajvRequire = createRequire(mcpRequire.resolve('ajv'));
const limiterRequire = createRequire(mcpRequire.resolve('express-rate-limit'));
const qs = expressRequire('qs') as typeof import('qs');
const uri = ajvRequire('fast-uri') as typeof import('fast-uri');
const { Hono } = mcpRequire('hono') as typeof import('hono');
const { serveStatic: honoStatic } = mcpRequire(
  'hono/serve-static',
) as typeof import('hono/serve-static');
const nodeServerRequire = createRequire(
  mcpRequire.resolve('@hono/node-server'),
);
const { serveStatic: nodeStatic } = nodeServerRequire(
  '@hono/node-server/serve-static',
) as typeof import('@hono/node-server/serve-static');

it.each([false, true])(
  'Express qs handles hostile comma-array coercion (encodeValuesOnly=%s)',
  (encodeValuesOnly) => {
    expect(
      qs.stringify(
        { a: [{ toString: 'x' }] },
        { arrayFormat: 'comma', encodeValuesOnly },
      ),
    ).toBe('a=%5Bobject%20Object%5D');
    expect(qs.stringify({ a: ['x', 'y'] }, { arrayFormat: 'comma' })).toBe(
      'a=x%2Cy',
    );
    expect(qs.parse('a%5B0%5D=x&a%5B1%5D=y')).toEqual({ a: ['x', 'y'] });
  },
);

it('Express qs encodes empty-array keys without injecting query parameters', () => {
  const query = qs.stringify(
    { q: 'hi', 'x&apiKey=evil&y': [], 'hash#': [] },
    { allowEmptyArrays: true },
  );
  expect(query).toBe('q=hi&x%26apiKey%3Devil%26y[]&hash%23[]');
  expect(qs.parse(query)).not.toHaveProperty('apiKey');
  expect(new URL(`https://example.test/?${query}`).hash).toBe('');
  expect(qs.stringify({ a: [] }, { allowEmptyArrays: true })).toBe('a[]');
});

it('AJV fast-uri preserves relative references and rejects ambiguous URI components', () => {
  const encodedScheme = '%6Aavascript:alert(1)';
  expect(uri.parse(encodedScheme).error).toBeTruthy();
  expect(uri.normalize(encodedScheme)).toBe(encodedScheme);
  expect(uri.parse('http://a@b@evil.example/').error).toBeTruthy();
  expect(uri.parse('http://examp\tle.test/').error).toBeTruthy();
  expect(
    uri.serialize(
      { scheme: 'http', path: 'javascript:alert(1)' },
      { reference: 'suffix' },
    ),
  ).toBe('javascript%3Aalert(1)');
  expect(uri.normalize('../x')).toBe('../x');
  expect(uri.normalize('a/../b')).toBe('b');
  expect(uri.resolve('https://example.test/a/b', '../c')).toBe(
    'https://example.test/c',
  );
  const Ajv = mcpRequire('ajv') as typeof import('ajv').default;
  const ajv = new Ajv();
  ajv.addSchema({
    $id: 'https://example.test/schemas/common.json',
    definitions: { value: { type: 'integer' } },
  });
  const validate = ajv.compile({
    $id: 'https://example.test/schemas/nested/tool.json',
    type: 'object',
    properties: { value: { $ref: '../common.json#/definitions/value' } },
    required: ['value'],
  });
  expect(validate({ value: 1 })).toBe(true);
  expect(validate({ value: 'bad' })).toBe(false);
});

it('rate-limit ip-address rejects a long malformed zone without stalling', () => {
  const addressModule = limiterRequire.resolve('ip-address');
  expect(() =>
    execFileSync(
      process.execPath,
      [
        '-e',
        `const assert = require('node:assert/strict');
         const { Address6 } = require(${JSON.stringify(addressModule)});
         assert.equal(Address6.isValid('%'.repeat(200_000) + '\\n'), false);
         assert.equal(new Address6('2001:db8::1').canonicalForm(),
           '2001:0db8:0000:0000:0000:0000:0000:0001');`,
      ],
      { timeout: 5_000, stdio: 'pipe' },
    ),
  ).not.toThrow();
});

it.each([
  ['hono', false],
  ['hono', true],
  ['node-server', false],
  ['node-server', true],
] as const)(
  '%s static serving keeps encoded paths behind prefix authentication (allowPercentInPath=%s)',
  async (adapter, allowPercentInPath) => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-static-security-'));
    try {
      await mkdir(join(root, 'static/admin'), { recursive: true });
      await writeFile(join(root, 'static/admin/secret.txt'), 'secret');
      await writeFile(join(root, 'static/hello world.txt'), 'public');
      await writeFile(join(root, 'static/炎.txt'), 'unicode');
      await writeFile(join(root, 'static/100%.txt'), 'percent');
      const files: Record<string, string> = {
        'static/admin/secret.txt': 'secret',
        'static/hello world.txt': 'public',
        'static/炎.txt': 'unicode',
        'static/100%.txt': 'percent',
      };
      const app = new Hono();
      app.use('/static/admin/*', (c) => c.text('Unauthorized', 401));
      app.use(
        '/static/*',
        adapter === 'hono'
          ? honoStatic({
              getContent: async (path) => files[path] ?? null,
              allowPercentInPath,
            })
          : nodeStatic({ root, allowPercentInPath }),
      );
      expect((await app.request('/static/admin/secret.txt')).status).toBe(401);
      const attack = await app.request('/static/%%36%31dmin/secret.txt');
      expect(attack.status).toBe(404);
      expect(await attack.text()).not.toContain('secret');
      for (const [path, body] of [
        ['/static/hello%20world.txt', 'public'],
        ['/static/%E7%82%8E.txt', 'unicode'],
      ]) {
        const response = await app.request(path);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(body);
      }
      if (allowPercentInPath) {
        const percent = await app.request('/static/100%25.txt');
        expect(percent.status).toBe(200);
        expect(await percent.text()).toBe('percent');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
