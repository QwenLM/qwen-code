/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import {
  listSavedWorkflows,
  resolveSavedWorkflowScript,
  validateWorkflowName,
  WORKFLOW_NAME_PATTERN,
} from './workflow-saved.js';

/**
 * Build a Config whose `.storage` points at `projectDir`, and point the
 * user scope (`~/.qwen`) at `userHome` via the QWEN_HOME env override so
 * tests never touch the real home directory.
 */
function fakeConfig(projectDir: string): Config {
  return { storage: new Storage(projectDir) } as unknown as Config;
}

async function writeWorkflow(
  dir: string,
  name: string,
  body: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.js`), body, 'utf8');
}

describe('workflow-saved', () => {
  let projectDir: string;
  let userHome: string;
  let prevQwenHome: string | undefined;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-proj-'));
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-user-'));
    prevQwenHome = process.env['QWEN_HOME'];
    // Storage.getGlobalQwenDir() reads QWEN_HOME, else ~/.qwen. Point it at
    // `<userHome>/.qwen` so the user scope is sandboxed.
    process.env['QWEN_HOME'] = path.join(userHome, '.qwen');
  });

  afterEach(async () => {
    if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevQwenHome;
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(userHome, { recursive: true, force: true });
  });

  describe('validateWorkflowName / WORKFLOW_NAME_PATTERN', () => {
    it.each([
      ['deep-research', true],
      ['audit2', true],
      ['a', true],
      ['Deep-Research', false], // upper-case
      ['1abc', false], // leading digit
      ['has space', false],
      ['has.dot', false],
      ['has/slash', false],
      ['', false],
    ])('"%s" valid=%s', (name, valid) => {
      expect(WORKFLOW_NAME_PATTERN.test(name)).toBe(valid);
      expect(validateWorkflowName(name) === null).toBe(valid);
    });
  });

  describe('resolveSavedWorkflowScript — by name', () => {
    it('resolves a project-scope workflow', async () => {
      await writeWorkflow(
        new Storage(projectDir).getProjectWorkflowsDir(),
        'foo',
        `return 'project-foo';`,
      );
      const resolved = await resolveSavedWorkflowScript(
        'foo',
        fakeConfig(projectDir),
      );
      expect(resolved.name).toBe('foo');
      expect(resolved.script).toBe(`return 'project-foo';`);
      expect(resolved.scriptPath).toContain('foo.js');
    });

    it('resolves a user-scope workflow when project lacks it', async () => {
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'bar',
        `return 'user-bar';`,
      );
      const resolved = await resolveSavedWorkflowScript(
        'bar',
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'user-bar';`);
    });

    it('project scope wins over user scope for the same name', async () => {
      await writeWorkflow(
        new Storage(projectDir).getProjectWorkflowsDir(),
        'dup',
        `return 'PROJECT';`,
      );
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'dup',
        `return 'USER';`,
      );
      const resolved = await resolveSavedWorkflowScript(
        'dup',
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'PROJECT';`);
    });

    it('throws with available names on a miss', async () => {
      await writeWorkflow(
        new Storage(projectDir).getProjectWorkflowsDir(),
        'alpha',
        `return 1;`,
      );
      await expect(
        resolveSavedWorkflowScript('missing', fakeConfig(projectDir)),
      ).rejects.toThrow(/no workflow with that name. Available: alpha/);
    });

    it('throws "(none)" when no saved workflows exist', async () => {
      await expect(
        resolveSavedWorkflowScript('missing', fakeConfig(projectDir)),
      ).rejects.toThrow(/Available: \(none\)/);
    });
  });

  describe('resolveSavedWorkflowScript — by {scriptPath}', () => {
    it('reads an explicit script path', async () => {
      const p = path.join(projectDir, 'custom.js');
      await fs.writeFile(p, `return 'custom';`, 'utf8');
      const resolved = await resolveSavedWorkflowScript(
        { scriptPath: p },
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'custom';`);
      expect(resolved.name).toBe('custom');
    });

    it('throws a clear error for an unreadable path', async () => {
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: path.join(projectDir, 'nope.js') },
          fakeConfig(projectDir),
        ),
      ).rejects.toThrow(/cannot read file/);
    });

    it('rejects an empty scriptPath', async () => {
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: '' },
          fakeConfig(projectDir),
        ),
      ).rejects.toThrow(/workflow name \(string\) or \{scriptPath/);
    });
  });

  describe('listSavedWorkflows', () => {
    it('merges both scopes, project shadows user, sorted by name', async () => {
      await writeWorkflow(
        new Storage(projectDir).getProjectWorkflowsDir(),
        'zeta',
        `return 1;`,
      );
      await writeWorkflow(
        new Storage(projectDir).getProjectWorkflowsDir(),
        'shared',
        `return 'P';`,
      );
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'alpha',
        `return 1;`,
      );
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'shared',
        `return 'U';`,
      );
      const list = await listSavedWorkflows(fakeConfig(projectDir));
      expect(list.map((e) => e.name)).toEqual(['alpha', 'shared', 'zeta']);
      const shared = list.find((e) => e.name === 'shared')!;
      expect(shared.source).toBe('project'); // project shadows user
    });

    it('skips files whose stem is not a legal workflow name', async () => {
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await writeWorkflow(dir, 'good-one', `return 1;`);
      // Illegal stem: leading digit. Should be skipped.
      await fs.writeFile(path.join(dir, '9bad.js'), `return 1;`, 'utf8');
      const list = await listSavedWorkflows(fakeConfig(projectDir));
      expect(list.map((e) => e.name)).toEqual(['good-one']);
    });

    it('returns empty when no workflows dir exists', async () => {
      const list = await listSavedWorkflows(fakeConfig(projectDir));
      expect(list).toEqual([]);
    });
  });
});
