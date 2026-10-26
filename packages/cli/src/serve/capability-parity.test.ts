/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PARITY,
  MANAGED_ONLY_NOT_A_GAP,
  MANAGED_ONLY_REPORTED,
  PARITY_COLUMNS,
  capabilityParityMatrix,
  managedOnlyLabels,
  type ManagedSurfaceSet,
} from './capability-parity.js';
import { SERVE_CAPABILITY_REGISTRY } from './capabilities.js';
import {
  HOSTED_MEMBER_BOARD_TOOLS,
  HOSTED_MEMBER_COMMAND_TOOL_NAMES,
  HOSTED_WORKFLOW_TOOL,
  HOSTED_WORKSPACE_FILE_TOOLS,
  HOSTED_WORKSPACE_READ_TOOLS,
  HOSTED_WORKSPACE_SHELL_TOOLS,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TEAM_PLAN_TOOL,
  HOSTED_TEAM_TOOLS,
} from './hosted-team-session.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const MANAGED_SURFACE_FILE = resolve(
  REPO,
  'packages/managed-agent-server/src/test/resources/capability-parity/managed-surface.txt',
);
const ROUTE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);
const SURFACES: ReadonlySet<string> = new Set([
  'public',
  'webshell',
  'internal',
]);

function toolNames(
  declarations: ReadonlyArray<{ name?: string | undefined }>,
): string[] {
  return declarations.flatMap((tool) => (tool.name ? [tool.name] : []));
}

const HOSTED_TOOLS = new Set([
  ...toolNames(HOSTED_WORKSPACE_FILE_TOOLS),
  ...toolNames(HOSTED_WORKSPACE_SHELL_TOOLS),
  ...toolNames(HOSTED_WORKSPACE_READ_TOOLS),
  ...toolNames(HOSTED_MEMBER_BOARD_TOOLS),
  ...HOSTED_MEMBER_COMMAND_TOOL_NAMES,
  ...toolNames(HOSTED_TEAM_TOOLS),
  HOSTED_TEAM_PLAN_TOOL.name,
  HOSTED_WORKFLOW_TOOL.name,
]);

/** The twin `label method template surface`, read without a Java build. */
function readManagedSurfaceSet(
  file: string = MANAGED_SURFACE_FILE,
): ManagedSurfaceSet {
  const labels = new Set<string>();
  const routes = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.trim().split(' ');
    if (parts.length !== 4) throw new Error(`malformed twin line: ${line}`);
    const [label, method, template, surface] = parts as [
      string,
      string,
      string,
      string,
    ];
    if (!ROUTE_METHODS.has(method)) {
      throw new Error(`unknown method in twin: ${line}`);
    }
    if (!SURFACES.has(surface)) {
      throw new Error(`unknown surface in twin: ${line}`);
    }
    labels.add(label);
    routes.add(template);
  }
  return { labels, routes };
}

/** sha256 over the sorted route lines, as `ManagedSurfaceCapture` computes it. */
function routeLinesDigest(lines: Iterable<string>): string {
  const hash = createHash('sha256');
  for (const line of [...lines].sort()) hash.update(`${line}\n`);
  return hash.digest('hex');
}

/**
 * Checks one evidence token against the code it names. Every kind fails
 * closed on a name that matches nothing: `docs:` must resolve to a file, and
 * `surface:` / `tool:` must be recorded, so the shape `'surface:X,docs:'` —
 * what a bad merge produces when a path drops out — cannot pass.
 */
function parseEvidence(token: string, surface: ManagedSurfaceSet): void {
  const match = /^([a-z]+):(.*)$/.exec(token);
  if (match === null) throw new Error(`malformed evidence ${token}`);
  const [, kind, name] = match as unknown as [string, string, string];
  switch (kind) {
    case 'tool':
      for (const tool of name.split('+')) {
        if (!HOSTED_TOOLS.has(tool)) throw new Error(`${token}: ${tool}`);
      }
      return;
    case 'surface':
      if (!surface.labels.has(name)) throw new Error(token);
      return;
    case 'docs': {
      const path = resolve(REPO, name);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`${token}: not a file`);
      }
      return;
    }
    default:
      throw new Error(`unknown evidence kind in ${token}`);
  }
}

function tokensOf(evidence: string): string[] {
  return evidence.split(',').map((token) => token.trim());
}

const SURFACE = readManagedSurfaceSet();

describe('capability parity matrix', () => {
  it('holds one row per legacy capability tag', () => {
    expect(Object.keys(CAPABILITY_PARITY).sort()).toEqual(
      Object.keys(SERVE_CAPABILITY_REGISTRY).sort(),
    );
  });

  it('reports three columns over tags the registry declares', () => {
    const matrix = capabilityParityMatrix(SURFACE);
    expect(Object.keys(matrix)).toEqual([...PARITY_COLUMNS]);
    const tags = new Set(Object.keys(SERVE_CAPABILITY_REGISTRY));
    for (const tag of [...matrix['legacy only'], ...matrix.both]) {
      expect(tags).toContain(tag);
    }
    expect(matrix['legacy only'].length + matrix.both.length).toBe(tags.size);
  });

  it.each(
    Object.entries(CAPABILITY_PARITY).filter(
      ([, row]) => row.standing !== 'managed',
    ),
  )('%s says why the Managed path does not stand behind it', (_tag, row) => {
    expect(row.evidence.trim().length).toBeGreaterThan(0);
  });

  it.each(
    Object.entries(CAPABILITY_PARITY).filter(
      ([, row]) => row.standing === 'managed',
    ),
  )('%s points at Managed evidence that exists', (_tag, row) => {
    for (const token of tokensOf(row.evidence)) parseEvidence(token, SURFACE);
  });

  it('keeps a documented Managed surface out of the legacy-only column', () => {
    expect(CAPABILITY_PARITY.web_shell_brand.standing).toBe('managed');
    expect(capabilityParityMatrix(SURFACE)['legacy only']).not.toContain(
      'web_shell_brand',
    );
  });

  it('derives the managed-only column from uncited route labels', () => {
    const cited = new Set(
      Object.values(CAPABILITY_PARITY).flatMap((row) =>
        tokensOf(row.evidence)
          .map((token) => /^surface:(.+)$/.exec(token)?.[1])
          .filter((label): label is string => label !== undefined),
      ),
    );
    const uncited = [...SURFACE.labels]
      .filter(
        (label) => !cited.has(label) && !MANAGED_ONLY_NOT_A_GAP.has(label),
      )
      .sort();
    expect(managedOnlyLabels(SURFACE)).toEqual(uncited);
    expect(uncited).toEqual([...MANAGED_ONLY_REPORTED].sort());
  });

  it('reports a Managed route with no legacy tag', () => {
    const extra = {
      labels: new Set([...SURFACE.labels, 'SOME_FUTURE_ROUTE']),
      routes: SURFACE.routes,
    };
    expect(capabilityParityMatrix(extra)['managed only']).toContain(
      'SOME_FUTURE_ROUTE',
    );
  });

  it('excludes only labels the twin actually records', () => {
    expect(
      [...MANAGED_ONLY_NOT_A_GAP].filter((label) => !SURFACE.labels.has(label)),
    ).toEqual([]);
  });
});

describe('evidence tokens', () => {
  it('rejects evidence that names nothing', () => {
    const accepted = ['docs:', 'surface:', 'tool:', 'route:'].filter(
      (token) => {
        try {
          parseEvidence(token, SURFACE);
          return true;
        } catch {
          return false;
        }
      },
    );
    expect(accepted).toEqual([]);
  });

  it('rejects a docs target that is a directory', () => {
    expect(() => parseEvidence('docs:docs/design', SURFACE)).toThrow();
  });

  it('rejects a route prefix, now that no row cites one', () => {
    const tokens = Object.values(CAPABILITY_PARITY).flatMap((row) =>
      tokensOf(row.evidence),
    );
    expect(tokens.filter((token) => token.startsWith('route:'))).toEqual([]);
  });

  it('fails a surface claim the twin does not record', () => {
    const withoutRead: ManagedSurfaceSet = {
      labels: new Set(
        [...SURFACE.labels].filter((label) => label !== 'WORKSPACE_FILES_READ'),
      ),
      routes: SURFACE.routes,
    };
    expect(() =>
      parseEvidence('surface:WORKSPACE_FILES_READ', withoutRead),
    ).toThrow();
    expect(() =>
      parseEvidence('surface:WORKSPACE_FILES_READ', SURFACE),
    ).not.toThrow();
  });
});

describe('committed Managed surface twin', () => {
  it('resolves to the fixture inside this repository', () => {
    expect(existsSync(MANAGED_SURFACE_FILE)).toBe(true);
  });

  it('records one four-field route per line', () => {
    const lines = readFileSync(MANAGED_SURFACE_FILE, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.split(' ')).toHaveLength(4);
  });

  it('records each route once', () => {
    const keys = readFileSync(MANAGED_SURFACE_FILE, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const [label, method, template] = line.trim().split(' ') as [
          string,
          string,
          string,
        ];
        expect(label).toMatch(/^[A-Z][A-Z0-9_]*$/);
        return `${method} ${template}`;
      });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pins the digest of its own route lines', () => {
    const lines = readFileSync(MANAGED_SURFACE_FILE, 'utf8').split('\n');
    const header = lines
      .map((line) =>
        /^# sha256 of the route lines below: ([0-9a-f]{64})$/.exec(line),
      )
      .find((match) => match !== null);
    expect(header).not.toBeNull();
    const committed = lines
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const [, method, template] = line.trim().split(' ') as [
          string,
          string,
          string,
        ];
        return `${method} ${template}`;
      });
    expect(header![1]).toBe(routeLinesDigest(committed));
  });
});
