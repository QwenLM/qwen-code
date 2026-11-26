/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectWorkflowsDir } from './workflow-storage.js';
import { WorkflowRegistry } from './workflow-registry.js';
import * as workflowParser from './workflow-parser.js';
import * as workflowStorage from './workflow-storage.js';
import {
  getWorkflowScriptCacheBytesForTesting,
  parseWorkflowMetaCached,
  readWorkflowScriptFileCached,
  resetWorkflowScriptCaches,
  setWorkflowScriptCacheBudgetForTesting,
} from './workflow-script-cache.js';

function script(name: string, description = 'desc'): string {
  return `export const meta = { name: "${name}", description: "${description}", phases: [{ title: "One" }] };`;
}

describe('workflow script cache', () => {
  let tmpDir: string;
  let projectRoot: string;
  let workflowsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-cache-'));
    projectRoot = path.join(tmpDir, 'project');
    workflowsDir = getProjectWorkflowsDir(projectRoot);
    await fs.mkdir(workflowsDir, { recursive: true });
    resetWorkflowScriptCaches();
    setWorkflowScriptCacheBudgetForTesting();
  });

  afterEach(async () => {
    resetWorkflowScriptCaches();
    setWorkflowScriptCacheBudgetForTesting();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // AC11
  it('reads and parses each file exactly once, then zero times on later calls', async () => {
    await fs.writeFile(path.join(workflowsDir, 'alpha.js'), script('alpha'));
    await fs.writeFile(path.join(workflowsDir, 'beta.js'), script('beta'));

    const readSpy = vi.spyOn(workflowStorage, 'readWorkflowScriptFile');
    const parseSpy = vi.spyOn(workflowParser, 'parseWorkflowScript');

    const registry = new WorkflowRegistry({ projectRoot, homeDir: tmpDir });

    const first = await registry.listAvailable();
    expect(first.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(parseSpy).toHaveBeenCalledTimes(2);

    readSpy.mockClear();
    parseSpy.mockClear();

    for (let i = 0; i < 4; i++) {
      await registry.listAvailable();
    }
    expect(readSpy).toHaveBeenCalledTimes(0);
    expect(parseSpy).toHaveBeenCalledTimes(0);
  });

  // AC12
  it('picks up edits, additions and deletions on the next call', async () => {
    const alphaPath = path.join(workflowsDir, 'alpha.js');
    await fs.writeFile(alphaPath, script('alpha', 'original'));
    const registry = new WorkflowRegistry({ projectRoot, homeDir: tmpDir });

    const initial = await registry.listAvailable();
    expect(initial.entries[0]?.description).toBe('original');

    // Edit: content length differs, so both mtime and size change.
    await fs.writeFile(alphaPath, script('alpha', 'edited-and-longer'));
    const afterEdit = await registry.listAvailable();
    expect(afterEdit.entries[0]?.description).toBe('edited-and-longer');

    // Addition.
    await fs.writeFile(path.join(workflowsDir, 'gamma.js'), script('gamma'));
    const afterAdd = await registry.listAvailable();
    expect(afterAdd.entries.map((e) => e.name).sort()).toEqual([
      'alpha',
      'gamma',
    ]);

    // Deletion.
    await fs.rm(alphaPath);
    const afterDelete = await registry.listAvailable();
    expect(afterDelete.entries.map((e) => e.name)).toEqual(['gamma']);
  });

  // AC14
  it('freezes memoized meta so shared entries cannot alias-mutate', () => {
    const source = script('frozen');
    const first = parseWorkflowMetaCached(source);
    const second = parseWorkflowMetaCached(source);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.phases)).toBe(true);
    expect(() => {
      (first as { description: string }).description = 'mutated';
    }).toThrow();
    expect(() => {
      (first.phases as Array<{ title: string }>).push({ title: 'Two' });
    }).toThrow();
  });

  it('does not memoize parse failures, so diagnostics keep being produced', async () => {
    const badPath = path.join(workflowsDir, 'bad.js');
    await fs.writeFile(badPath, 'const notMetaFirst = 1;');
    const registry = new WorkflowRegistry({ projectRoot, homeDir: tmpDir });

    const parseSpy = vi.spyOn(workflowParser, 'parseWorkflowScript');

    const first = await registry.listAvailable();
    const second = await registry.listAvailable();

    expect(first.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'invalid', scriptPath: badPath }),
    );
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'invalid', scriptPath: badPath }),
    );
    // Re-parsed every time rather than served from the memo.
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // And a fix is picked up immediately.
    await fs.writeFile(badPath, script('bad'));
    const third = await registry.listAvailable();
    expect(third.entries.map((e) => e.name)).toEqual(['bad']);
    expect(third.diagnostics).toEqual([]);
  });

  // AC16
  it('bounds each memo by retained bytes and evicts oldest first', async () => {
    const aPath = path.join(workflowsDir, 'a.js');
    const bPath = path.join(workflowsDir, 'b.js');
    const aScript = script('a', 'a'.repeat(200));
    const bScript = script('b', 'b'.repeat(200));
    await fs.writeFile(aPath, aScript);
    await fs.writeFile(bPath, bScript);

    // Budget fits one script but not two.
    setWorkflowScriptCacheBudgetForTesting(aScript.length + 10);

    await readWorkflowScriptFileCached(aPath, projectRoot);
    expect(getWorkflowScriptCacheBytesForTesting().read).toBeLessThanOrEqual(
      aScript.length + 10,
    );

    await readWorkflowScriptFileCached(bPath, projectRoot);
    const bytes = getWorkflowScriptCacheBytesForTesting();
    expect(bytes.read).toBeLessThanOrEqual(aScript.length + 10);

    // `a` was evicted, so reading it again hits the disk.
    const readSpy = vi.spyOn(workflowStorage, 'readWorkflowScriptFile');
    await readWorkflowScriptFileCached(aPath, projectRoot);
    expect(readSpy).toHaveBeenCalledTimes(1);

    parseWorkflowMetaCached(aScript);
    parseWorkflowMetaCached(bScript);
    expect(getWorkflowScriptCacheBytesForTesting().meta).toBeLessThanOrEqual(
      aScript.length + 10,
    );
  });

  it('keys the read cache by projectRoot so relative paths do not collide', async () => {
    const otherRoot = path.join(tmpDir, 'other');
    const otherWorkflows = getProjectWorkflowsDir(otherRoot);
    await fs.mkdir(otherWorkflows, { recursive: true });

    await fs.writeFile(path.join(workflowsDir, 'rel.js'), script('from-a'));
    await fs.writeFile(path.join(otherWorkflows, 'rel.js'), script('from-b'));
    // Same relative path under two different roots — resolves to different files.
    const relative = path.relative(
      projectRoot,
      path.join(workflowsDir, 'rel.js'),
    );

    const fromA = await readWorkflowScriptFileCached(relative, projectRoot);
    const fromB = await readWorkflowScriptFileCached(relative, otherRoot);

    expect(fromA.script).toContain('from-a');
    expect(fromB.script).toContain('from-b');
  });
});
