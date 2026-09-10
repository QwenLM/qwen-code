/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `docs/developers/rest-api-integration.md` tells integrators that a specific
 * 25-route subset is the surface they should build on. That claim has no
 * mechanical backing: the daemon registers 237 routes, and a rename upstream
 * would leave the guide promising a route that no longer answers, with nothing
 * failing.
 *
 * This is the same shape as `capabilities-docs-contract.test.ts`, which guards
 * the protocol doc's conditional-tag table against the capability registry.
 * Scope is deliberately the guide's own promises rather than all 237 routes: a
 * full inventory would need a ~174-entry "known undocumented" baseline, which
 * is bulk in service of a problem nobody has reported. Widen it when that
 * changes.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const GUIDE = path.join(REPO_ROOT, 'docs/developers/rest-api-integration.md');
const PROTOCOL = path.join(REPO_ROOT, 'docs/developers/qwen-serve-protocol.md');
const SERVE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Routes the guide presents as the integration surface. */
const GUIDE_ROUTES: readonly string[] = [
  '/health',
  '/capabilities',
  '/session',
  '/session/:id',
  '/session/:id/prompt',
  '/session/:id/cancel',
  '/session/:id/events',
  '/session/:id/status',
  '/session/:id/transcript',
  '/session/:id/context',
  '/session/:id/export',
  '/session/:id/pending-prompts',
  '/session/:id/heartbeat',
  '/session/:id/metadata',
  '/session/:id/model',
  '/session/:id/load',
  '/session/:id/resume',
  '/session/:id/permission/:requestId',
  '/permission/:requestId',
  '/workspace/tools',
  '/file',
  '/file/bytes',
  '/stat',
  '/list',
  '/glob',
];

/**
 * Collect every path the serve tree registers on an Express app or router.
 * Reading the sources rather than instantiating the app keeps this independent
 * of the bridge/deps wiring `createServeApp` needs, and covers route groups
 * that only mount under specific options.
 */
function registeredPaths(): Set<string> {
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
      // The path literal is often on its own line after the method call.
      const re =
        /\b(?:app|router)\.(?:get|post|patch|put|delete|all)\(\s*\n?\s*'([^']+)'/g;
      for (const match of src.matchAll(re)) {
        // Workspace-qualified routes mirror their primary-workspace form.
        found.add(match[1].replace(/^\/workspaces\/:workspace/, '/workspace'));
      }
    }
  };
  walk(SERVE_DIR);
  return found;
}

/** GitHub/Nextra heading slug, so anchor links in the guide can be checked. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

describe('REST integration guide contract', () => {
  it('matches the routes and missing-section notes in the guide tables', () => {
    const rows = readFileSync(GUIDE, 'utf8')
      .split('\n')
      .filter((line) => /^\| .*`(?:GET|POST|PATCH|DELETE) \//.test(line));
    const routes = rows.flatMap((row) =>
      [
        ...row
          .split('|')[1]
          .matchAll(/`(?:GET |POST |PATCH |DELETE )?(\/[^`]+)`/g),
      ].map((match) => ({
        route: match[1] === '/resume' ? '/session/:id/resume' : match[1],
        undocumented: /no dedicated/i.test(row),
      })),
    );
    expect(routes.map(({ route }) => route).sort()).toEqual(
      [...GUIDE_ROUTES].sort(),
    );
    expect(
      routes
        .filter(({ undocumented }) => undocumented)
        .map(({ route }) => route)
        .sort(),
    ).toEqual([
      '/glob',
      '/list',
      '/session/:id/export',
      '/session/:id/pending-prompts',
      '/session/:id/permission/:requestId',
      '/session/:id/status',
      '/stat',
      '/workspace/tools',
    ]);
  });

  it('links only to documentation files that exist', () => {
    const targets = [
      ...readFileSync(GUIDE, 'utf8').matchAll(
        /\]\((\.\.?\/[^)#\s]+\.md)(?:#[^)]*)?\)/g,
      ),
    ].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(
      targets.filter(
        (target) => !existsSync(path.resolve(path.dirname(GUIDE), target)),
      ),
    ).toEqual([]);
  });

  it('promises only routes the daemon still registers', () => {
    const registered = registeredPaths();
    expect(GUIDE_ROUTES.filter((route) => !registered.has(route))).toEqual([]);
  });

  it('links only to anchors the protocol reference actually has', () => {
    const anchors = new Set(
      [...readFileSync(PROTOCOL, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        (match) => slug(match[1]),
      ),
    );
    const broken = [
      ...readFileSync(GUIDE, 'utf8').matchAll(
        /\]\(\.\/qwen-serve-protocol\.md#([a-z0-9-]+)\)/g,
      ),
    ]
      .map((match) => match[1])
      .filter((anchor) => !anchors.has(anchor));
    expect(broken).toEqual([]);
  });

  it('keeps its "no dedicated section yet" notes honest', () => {
    // The guide marks 8 of the 25 as lacking a reference section. When someone
    // writes one, this fails so the note gets removed instead of going stale.
    const protocol = readFileSync(PROTOCOL, 'utf8');
    const documented = new Set(
      [
        ...protocol.matchAll(
          /^#{3,4} `(?:GET|POST|PATCH|PUT|DELETE) ([^`]+)`/gm,
        ),
      ].map((match) => match[1]),
    );
    const undocumented = GUIDE_ROUTES.filter((route) => !documented.has(route));
    expect(undocumented.sort()).toEqual(
      [
        '/glob',
        '/list',
        '/session/:id/export',
        '/session/:id/pending-prompts',
        '/session/:id/permission/:requestId',
        '/session/:id/status',
        '/stat',
        '/workspace/tools',
      ].sort(),
    );
  });

  it('still sees the bulk of the route surface', () => {
    // Guards the walker itself: if registrations move to a style this regex
    // cannot match, the route check above would pass vacuously on an empty set.
    expect(registeredPaths().size).toBeGreaterThan(100);
  });
});
