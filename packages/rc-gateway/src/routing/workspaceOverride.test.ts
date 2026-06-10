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
  mergeRoutingConfigs,
  loadLayeredRoutingMatcher,
  compileRouting,
  type RoutingConfig,
} from './rules.js';

/** A config of one event-global drop rule matching kind `permission.required`. */
function dropRule(id: string): RoutingConfig {
  return {
    rules: [
      { id, match: { kind: 'permission.required' }, route: { drop: true } },
    ],
  };
}

const EV = { kind: 'permission.required' };

describe('mergeRoutingConfigs', () => {
  it('returns null when both inputs are null', () => {
    expect(mergeRoutingConfigs(null, null)).toBeNull();
  });

  it('passes the lone non-null layer through', () => {
    expect(mergeRoutingConfigs(dropRule('w'), null)?.rules).toHaveLength(1);
    expect(mergeRoutingConfigs(null, dropRule('u'))?.rules).toHaveLength(1);
  });

  it('concatenates with workspace rules first', () => {
    const merged = mergeRoutingConfigs(dropRule('w'), dropRule('u'));
    expect(merged?.rules.map((r) => r.id)).toEqual(['w', 'u']);
  });

  it('compiles so the WORKSPACE rule id wins when both layers match (order proof)', () => {
    const merged = mergeRoutingConfigs(dropRule('ws'), dropRule('user'))!;
    expect(compileRouting(merged).firstDrop(EV)).toBe('ws');
  });
});

describe('loadLayeredRoutingMatcher', () => {
  let dir: string;
  let userPath: string;
  let workspaceCwd: string;
  let workspaceFile: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-wsroute-'));
    userPath = join(dir, 'routing.yaml');
    workspaceCwd = join(dir, 'ws');
    workspaceFile = join(workspaceCwd, '.qwen', 'routing.yaml');
    await mkdir(join(workspaceCwd, '.qwen'), { recursive: true });
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const yml = (id: string) =>
    `rules:\n  - id: ${id}\n    match: { kind: permission.required }\n    route: { drop: true }\n`;

  it('returns no matcher when neither file exists', async () => {
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.matcher).toBeUndefined();
    expect(r.ruleCount).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it('returns no matcher when workspaceCwd is undefined and no user file', async () => {
    const r = await loadLayeredRoutingMatcher(userPath, undefined, warn);
    expect(r.matcher).toBeUndefined();
    expect(r.ruleCount).toBe(0);
  });

  it('compiles user-only rules', async () => {
    await writeFile(userPath, yml('u'));
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.ruleCount).toBe(1);
    expect(r.matcher?.firstDrop(EV)).toBe('u');
  });

  it('compiles workspace-only rules', async () => {
    await writeFile(workspaceFile, yml('w'));
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.ruleCount).toBe(1);
    expect(r.matcher?.firstDrop(EV)).toBe('w');
  });

  it('merges both with workspace first (ruleCount sums, workspace id wins)', async () => {
    await writeFile(userPath, yml('u'));
    await writeFile(workspaceFile, yml('w'));
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.ruleCount).toBe(2);
    expect(r.matcher?.firstDrop(EV)).toBe('w');
  });

  it('fail-open: a malformed workspace file is ignored; user rules still apply', async () => {
    await writeFile(userPath, yml('u'));
    await writeFile(workspaceFile, 'rules: not-a-sequence\n');
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.ruleCount).toBe(1);
    expect(r.matcher?.firstDrop(EV)).toBe('u');
    expect(warnings.some((w) => w.includes('workspace routing.yaml'))).toBe(
      true,
    );
  });

  it('fail-open: a malformed user file is ignored; workspace rules still apply', async () => {
    await writeFile(userPath, 'rules: 5\n');
    await writeFile(workspaceFile, yml('w'));
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.ruleCount).toBe(1);
    expect(r.matcher?.firstDrop(EV)).toBe('w');
    // The user-layer label is 'ignoring routing.yaml:'; the workspace label is
    // 'ignoring workspace routing.yaml:' — assert the user one specifically.
    expect(warnings.some((w) => w.includes('ignoring routing.yaml'))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes('workspace routing.yaml'))).toBe(
      false,
    );
  });

  it('fail-open: both malformed → no matcher, never throws', async () => {
    await writeFile(userPath, 'rules: 5\n');
    await writeFile(workspaceFile, 'rules: 5\n');
    const r = await loadLayeredRoutingMatcher(userPath, workspaceCwd, warn);
    expect(r.matcher).toBeUndefined();
    expect(r.ruleCount).toBe(0);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
