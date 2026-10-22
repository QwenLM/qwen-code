/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PARITY,
  MANAGED_ONLY_NOT_A_GAP,
  MANAGED_ONLY_REPORTED,
  managedOnlyLabels,
  MANAGED_SURFACE_FILE,
  MANAGED_SURFACE_SOURCE,
  PARITY_COLUMNS,
  capabilityParityMatrix,
  readManagedSurfaceSet,
  routeLinesDigest,
} from './capability-parity.js';
import { SERVE_CAPABILITY_REGISTRY } from './capabilities.js';
import {
  HOSTED_MEMBER_BOARD_TOOLS,
  HOSTED_MEMBER_COMMAND_TOOL_NAMES,
  HOSTED_WORKFLOW_TOOL,
  HOSTED_WORKSPACE_FILE_TOOLS,
  HOSTED_WORKSPACE_FILE_TOOLS_V2,
  HOSTED_WORKSPACE_READ_TOOLS,
  HOSTED_WORKSPACE_SHELL_TOOLS,
  HOSTED_WORKSPACE_SHELL_TOOLS_V2,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TEAM_PLAN_TOOL,
  HOSTED_TEAM_TOOLS,
} from './hosted-team-session.js';

const REPO = resolve(import.meta.dirname, '../../../..');

function tools(
  declarations: ReadonlyArray<{ name?: string | undefined }>,
): string[] {
  return declarations.map((tool) => tool.name ?? '');
}

const HOSTED_TOOLS = new Set([
  ...tools(HOSTED_WORKSPACE_FILE_TOOLS),
  ...tools(HOSTED_WORKSPACE_SHELL_TOOLS),
  ...tools(HOSTED_WORKSPACE_FILE_TOOLS_V2),
  ...tools(HOSTED_WORKSPACE_SHELL_TOOLS_V2),
  ...tools(HOSTED_WORKSPACE_READ_TOOLS),
  ...tools(HOSTED_MEMBER_BOARD_TOOLS),
  ...HOSTED_MEMBER_COMMAND_TOOL_NAMES,
  ...tools(HOSTED_TEAM_TOOLS),
  HOSTED_TEAM_PLAN_TOOL.name,
  HOSTED_WORKFLOW_TOOL.name,
]);

/**
 * The `SurfaceRegistry.Capability` names the committed twin records: a route
 * answers with its first declared capability, a twin repeats it.
 */
function managedCapabilities(): ReadonlySet<string> {
  return readManagedSurfaceSet().labels;
}

function parseEvidence(token: string): void {
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
      if (!managedCapabilities().has(name)) throw new Error(token);
      return;
    case 'route':
      if (
        ![...readManagedSurfaceSet().routes].some((route) =>
          route.startsWith(name),
        )
      )
        throw new Error(token);
      return;
    case 'docs':
      if (!existsSync(resolve(REPO, name))) throw new Error(token);
      return;
    default:
      throw new Error(`unknown evidence kind in ${token}`);
  }
}

describe('capability parity matrix', () => {
  it('holds one row per legacy capability tag', () => {
    expect(Object.keys(CAPABILITY_PARITY).sort()).toEqual(
      Object.keys(SERVE_CAPABILITY_REGISTRY).sort(),
    );
  });

  it('reports three columns over tags the registry declares', () => {
    const matrix = capabilityParityMatrix();
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
    for (const token of row.evidence.split(',')) parseEvidence(token);
  });

  it('keeps a documented Managed surface out of the legacy-only column', () => {
    expect(CAPABILITY_PARITY.web_shell_brand.standing).toBe('managed');
    expect(capabilityParityMatrix()['legacy only']).not.toContain(
      'web_shell_brand',
    );
  });

  it('derives the managed-only column from uncited route labels', () => {
    const surface = readManagedSurfaceSet();
    const cited = new Set(
      Object.values(CAPABILITY_PARITY).flatMap((row) =>
        row.evidence
          .split(',')
          .map((token) => /^surface:(.+)$/.exec(token.trim())?.[1])
          .filter((label): label is string => label !== undefined),
      ),
    );
    const uncited = [...surface.labels]
      .filter(
        (label) => !cited.has(label) && !MANAGED_ONLY_NOT_A_GAP.has(label),
      )
      .sort();
    expect(managedOnlyLabels(surface)).toEqual(uncited);
    expect(uncited).toEqual([...MANAGED_ONLY_REPORTED].sort());
  });

  it('reports a Managed route with no legacy tag', () => {
    const surface = readManagedSurfaceSet();
    const extra = {
      labels: new Set([...surface.labels, 'SOME_FUTURE_ROUTE']),
      routes: surface.routes,
    };
    expect(capabilityParityMatrix(extra)['managed only']).toContain(
      'SOME_FUTURE_ROUTE',
    );
  });

  it('excludes only labels the twin actually records', () => {
    const surface = readManagedSurfaceSet();
    expect(
      [...MANAGED_ONLY_NOT_A_GAP].filter((l) => !surface.labels.has(l)),
    ).toEqual([]);
  });
});

describe('committed Managed surface twin', () => {
  it('records one route per line', () => {
    const lines = readFileSync(MANAGED_SURFACE_FILE, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.split(' ')).toHaveLength(4);
  });

  it('stays identical to the SurfaceRegistry it was captured from', () => {
    const java = readFileSync(resolve(REPO, MANAGED_SURFACE_SOURCE), 'utf8');
    const body = java.slice(
      java.indexOf('public enum SurfaceRegistry'),
      java.indexOf('private final String method;'),
    );
    const declared = new Set<string>();
    for (const [, method, literal] of body.matchAll(
      /^\s{4}[A-Z][A-Z0-9_]*\(Method\.([A-Z]+),\s*((?:\s*"[^"]*"\s*\+)*\s*"[^"]+")\s*,\s*Surface\./gm,
    )) {
      const template = [...literal!.matchAll(/"([^"]*)"/g)]
        .map(([, part]) => part)
        .join('');
      declared.add(`${method} ${template}`);
    }
    const committed = new Set<string>();
    let recorded = '';
    for (const line of readFileSync(MANAGED_SURFACE_FILE, 'utf8').split('\n')) {
      const digest = /^# sha256 of the route lines below: ([0-9a-f]{64})$/.exec(
        line,
      );
      if (digest) recorded = digest[1]!;
      if (line === '' || line.startsWith('#')) continue;
      const [label, method, template] = line.trim().split(' ') as [
        string,
        string,
        string,
      ];
      committed.add(`${method} ${template}`);
      expect(label).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect([...committed].sort()).toEqual([...declared].sort());
    expect(recorded).toBe(routeLinesDigest(committed));
  });
});
