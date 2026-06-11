/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadResolvedRoutingRules,
  formatResolvedRouting,
  type ResolvedRoutingRule,
} from './rules.js';

const yml = (id: string) =>
  `rules:\n  - id: ${id}\n    match: { kind: permission.required }\n    route: { drop: true }\n`;

describe('loadResolvedRoutingRules', () => {
  let dir: string;
  let userPath: string;
  let workspaceCwd: string;
  let workspaceFile: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-routingrules-'));
    userPath = join(dir, 'routing.yaml');
    workspaceCwd = join(dir, 'ws');
    workspaceFile = join(workspaceCwd, '.qwen', 'routing.yaml');
    await mkdir(join(workspaceCwd, '.qwen'), { recursive: true });
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when neither file exists', async () => {
    expect(
      await loadResolvedRoutingRules(userPath, workspaceCwd, warn),
    ).toEqual([]);
  });

  it('lists user rules tagged with the user path when no workspace cwd is given', async () => {
    await writeFile(userPath, yml('u'));
    const r = await loadResolvedRoutingRules(userPath, undefined, warn);
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe(userPath);
    expect(r[0].rule.id).toBe('u');
  });

  it('lists WORKSPACE rules first (tagged workspace path), then user rules', async () => {
    await writeFile(userPath, yml('u'));
    await writeFile(workspaceFile, yml('w'));
    const r = await loadResolvedRoutingRules(userPath, workspaceCwd, warn);
    expect(r.map((x) => [x.source, x.rule.id])).toEqual([
      [workspaceFile, 'w'],
      [userPath, 'u'],
    ]);
  });

  it('fail-open: a malformed workspace file is logged + omitted; user rules still list', async () => {
    await writeFile(userPath, yml('u'));
    await writeFile(workspaceFile, 'rules: not-a-sequence\n');
    const r = await loadResolvedRoutingRules(userPath, workspaceCwd, warn);
    expect(r.map((x) => x.rule.id)).toEqual(['u']);
    expect(warnings.some((w) => w.includes('workspace routing.yaml'))).toBe(
      true,
    );
  });
});

describe('formatResolvedRouting', () => {
  const rule = (
    source: string,
    id: string | undefined,
    match: ResolvedRoutingRule['rule']['match'],
  ): ResolvedRoutingRule => ({
    source,
    rule: { ...(id !== undefined ? { id } : {}), match, route: { drop: true } },
  });

  it('renders (no routing rules) for an empty list', () => {
    expect(formatResolvedRouting([])).toBe('(no routing rules)');
  });

  it('renders source, id, match summary and drop for a rule', () => {
    const out = formatResolvedRouting([
      rule('/u.yaml', 'r1', {
        kind: 'permission.required',
        scopeIn: ['share'],
      }),
    ]);
    expect(out).toContain('/u.yaml');
    expect(out).toContain('r1');
    expect(out).toContain('kind=permission.required');
    expect(out).toContain('scopeIn=[share]');
    expect(out).toContain('drop:true');
  });

  it('renders <unnamed> for an id-less rule and match: any for an empty match', () => {
    const out = formatResolvedRouting([rule('/u.yaml', undefined, {})]);
    expect(out).toContain('<unnamed>');
    expect(out).toContain('match: any');
  });
});
