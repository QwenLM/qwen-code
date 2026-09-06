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
import { getShellContextEnvVars } from '../../services/shellContextEnv.js';
import {
  registerSessionProjectDir,
  sessionIdContext,
  unregisterSessionProjectDir,
} from '../../utils/sessionIdContext.js';
import {
  listSavedWorkflows,
  persistInlineWorkflowScript,
  resolveSavedWorkflowScript,
  saveWorkflowScript,
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
    it('reads a script path inside a saved-workflow dir', async () => {
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(dir, { recursive: true });
      const p = path.join(dir, 'custom.js');
      await fs.writeFile(p, `return 'custom';`, 'utf8');
      const resolved = await resolveSavedWorkflowScript(
        { scriptPath: p },
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'custom';`);
      expect(resolved.name).toBe('custom');
      expect(resolved.savedWorkflowName).toBe('custom');
    });

    it('throws a clear error for a missing path under a saved dir', async () => {
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(dir, { recursive: true });
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: path.join(dir, 'nope.js') },
          fakeConfig(projectDir),
        ),
      ).rejects.toThrow(/scriptPath/);
    });

    it('rejects an empty scriptPath', async () => {
      await expect(
        resolveSavedWorkflowScript({ scriptPath: '' }, fakeConfig(projectDir)),
      ).rejects.toThrow(/workflow name \(string\) or \{scriptPath/);
    });

    // Security (#2): a scriptPath resolving outside the saved-workflow dirs is
    // refused, even when the file exists.
    it('refuses a scriptPath outside the saved-workflow directories', async () => {
      const outside = path.join(projectDir, 'evil.js');
      await fs.writeFile(outside, `return 'pwned';`, 'utf8');
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: outside },
          fakeConfig(projectDir),
        ),
      ).rejects.toThrow(/outside the workflow script roots/);
    });
  });

  describe('resolveSavedWorkflowScript — generated-scripts root', () => {
    let generatedDir: string;

    beforeEach(() => {
      generatedDir = new Storage(projectDir).getGeneratedWorkflowsDir();
    });

    it('reads a {scriptPath} under the generated root', async () => {
      await fs.mkdir(generatedDir, { recursive: true });
      const p = path.join(generatedDir, 'qwen-review-1a2b3c.js');
      await fs.writeFile(p, `return 'generated';`, 'utf8');
      const resolved = await resolveSavedWorkflowScript(
        { scriptPath: p },
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'generated';`);
      expect(resolved.name).toBe('qwen-review-1a2b3c');
      expect(resolved.savedWorkflowName).toBeUndefined();
    });

    it('trusts the whole subtree, so a writer may nest per session', async () => {
      const nested = path.join(generatedDir, 's-abc', 'fanout.js');
      await fs.mkdir(path.dirname(nested), { recursive: true });
      await fs.writeFile(nested, `return 'nested';`, 'utf8');
      const resolved = await resolveSavedWorkflowScript(
        { scriptPath: nested },
        fakeConfig(projectDir),
      );
      expect(resolved.script).toBe(`return 'nested';`);
    });

    it('is neither listed as a slash command nor resolvable by name', async () => {
      await fs.mkdir(generatedDir, { recursive: true });
      await fs.writeFile(
        path.join(generatedDir, 'emitted.js'),
        `return 'generated';`,
        'utf8',
      );
      expect(await listSavedWorkflows(fakeConfig(projectDir))).toEqual([]);
      await expect(
        resolveSavedWorkflowScript('emitted', fakeConfig(projectDir)),
      ).rejects.toThrow(/no workflow with that name.*\(none\)/);
    });

    it('refuses a sibling of the generated root (no prefix match)', async () => {
      // `<runs>/generated-evil/x.js` shares the string prefix `generated`
      // with the root but is not inside it.
      const sibling = path.join(`${generatedDir}-evil`, 'x.js');
      await fs.mkdir(path.dirname(sibling), { recursive: true });
      await fs.writeFile(sibling, `return 'pwned';`, 'utf8');
      const attempt = resolveSavedWorkflowScript(
        { scriptPath: sibling },
        fakeConfig(projectDir),
      );
      await expect(attempt).rejects.toThrow(
        /outside the workflow script roots \(checked: /,
      );
      // The refusal names every root it checked — the generated one lives in
      // the runtime dir, which no debugger would guess from the path alone.
      await expect(attempt).rejects.toThrow(generatedDir);
    });

    it('refuses a file that symlinks out of the generated root', async () => {
      const outside = path.join(projectDir, 'secret.js');
      await fs.writeFile(outside, `return 'EXFILTRATED';`, 'utf8');
      await fs.mkdir(generatedDir, { recursive: true });
      const link = path.join(generatedDir, 'link.js');
      await fs.symlink(outside, link, 'file');
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: link },
          fakeConfig(projectDir),
        ),
      ).rejects.toThrow(/outside the workflow script roots/);
    });

    it('refuses a symlinked generated root', async () => {
      const external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-gen-evil-'));
      try {
        await fs.writeFile(
          path.join(external, 'leak.js'),
          `return 'EXFILTRATED';`,
          'utf8',
        );
        await fs.mkdir(path.dirname(generatedDir), { recursive: true });
        await fs.symlink(external, generatedDir, 'dir');
        const attempt = resolveSavedWorkflowScript(
          { scriptPath: path.join(generatedDir, 'leak.js') },
          fakeConfig(projectDir),
        );
        await expect(attempt).rejects.toThrow(
          /outside the workflow script roots/,
        );
        // The refused root stays visible in the message: a checked-list it
        // is silently absent from reads as if the loader never considered it.
        await expect(attempt).rejects.toThrow(
          `(checked: ${new Storage(projectDir).getProjectWorkflowsDir()}, ${Storage.getUserWorkflowsDir()}; refused symlinked root: ${generatedDir})`,
        );
      } finally {
        await fs.rm(external, { recursive: true, force: true });
      }
    });
  });

  describe('resolveSavedWorkflowScript — subprocess reachability contract', () => {
    it('loads a script at $QWEN_CODE_PROJECT_DIR/workflows/generated', async () => {
      const sessionId = 'wf-contract';
      // Mirror Config at session start: publish the storage project dir
      // under the session id, then read back what a subprocess is handed.
      registerSessionProjectDir(
        sessionId,
        new Storage(projectDir).getProjectDir(),
      );
      try {
        const env = sessionIdContext.run(sessionId, () =>
          getShellContextEnvVars(),
        );
        expect(env['QWEN_CODE_PROJECT_DIR']).toBeDefined();
        // Literal path segments on purpose: this test must fail if EITHER
        // half of the contract moves — the env export or the loader root.
        const p = path.join(
          env['QWEN_CODE_PROJECT_DIR'],
          'workflows',
          'generated',
          'x.js',
        );
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, `return 'composed';`, 'utf8');
        const resolved = await resolveSavedWorkflowScript(
          { scriptPath: p },
          fakeConfig(projectDir),
        );
        expect(resolved.script).toBe(`return 'composed';`);
      } finally {
        unregisterSessionProjectDir(sessionId);
      }
    });
  });

  // Security (#2): the string-name form must not escape the saved dirs.
  describe('resolveSavedWorkflowScript — name traversal', () => {
    it('rejects a traversal name before any path join', async () => {
      await expect(
        resolveSavedWorkflowScript('../../outside', fakeConfig(projectDir)),
      ).rejects.toThrow(/Invalid workflow name|lower-case/);
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
      await writeWorkflow(Storage.getUserWorkflowsDir(), 'alpha', `return 1;`);
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

    // Security (#4): a symlinked `<name>.js` could point at an arbitrary file
    // (e.g. credentials); discovery must skip it so it never reaches the
    // snapshot `script` field / telemetry.
    it('skips symlinked entries', async () => {
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(dir, { recursive: true });
      const secret = path.join(projectDir, 'secret.txt');
      await fs.writeFile(secret, 'TOP SECRET', 'utf8');
      await fs.symlink(secret, path.join(dir, 'leak.js'));
      await writeWorkflow(dir, 'real', `return 1;`);
      const list = await listSavedWorkflows(fakeConfig(projectDir));
      expect(list.map((e) => e.name)).toEqual(['real']);
    });
  });

  describe('saveWorkflowScript', () => {
    it('writes a new project-scope workflow and reports the path', async () => {
      const config = fakeConfig(projectDir);
      const result = await saveWorkflowScript(config, {
        name: 'my-flow',
        scope: 'project',
        script: 'return 42;',
      });
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      const written = await fs.readFile(result.path, 'utf8');
      expect(written).toBe('return 42;');
      // Round-trips through discovery as a /<name> candidate.
      const list = await listSavedWorkflows(config);
      expect(list.map((e) => e.name)).toContain('my-flow');
    });

    it('writes a user-scope workflow under the sandboxed QWEN_HOME', async () => {
      const config = fakeConfig(projectDir);
      const result = await saveWorkflowScript(config, {
        name: 'user-flow',
        scope: 'user',
        script: 'return 1;',
      });
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      expect(result.path).toContain(path.join(userHome, '.qwen'));
      expect(result.scope).toBe('user');
    });

    it('refuses an invalid name without writing', async () => {
      const config = fakeConfig(projectDir);
      const result = await saveWorkflowScript(config, {
        name: 'Bad Name',
        scope: 'project',
        script: 'return 1;',
      });
      expect(result.status).toBe('invalid-name');
      expect(await listSavedWorkflows(config)).toEqual([]);
    });

    it('rejects an empty script', async () => {
      const result = await saveWorkflowScript(fakeConfig(projectDir), {
        name: 'empty',
        scope: 'project',
        script: '   ',
      });
      expect(result.status).toBe('empty-script');
    });

    it('reports `exists` for a collision and does not clobber by default', async () => {
      const config = fakeConfig(projectDir);
      await saveWorkflowScript(config, {
        name: 'dup',
        scope: 'project',
        script: 'return "original";',
      });
      const result = await saveWorkflowScript(config, {
        name: 'dup',
        scope: 'project',
        script: 'return "replacement";',
      });
      expect(result.status).toBe('exists');
      if (result.status !== 'exists') throw new Error('expected exists');
      // Original is untouched.
      expect(await fs.readFile(result.path, 'utf8')).toBe('return "original";');
    });

    it('overwrites when overwrite:true', async () => {
      const config = fakeConfig(projectDir);
      await saveWorkflowScript(config, {
        name: 'dup',
        scope: 'project',
        script: 'return "original";',
      });
      const result = await saveWorkflowScript(config, {
        name: 'dup',
        scope: 'project',
        script: 'return "replacement";',
        overwrite: true,
      });
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      expect(await fs.readFile(result.path, 'utf8')).toBe(
        'return "replacement";',
      );
    });
  });

  // Security (round 3, r3451228756): the saved-workflow ROOT dir itself being a
  // symlink must not turn its external target into the trusted boundary. Round 1
  // only guarded symlinked *files* inside the dir; a symlinked dir slips past
  // that guard because the entries it exposes are regular files, and
  // `readWorkflowFileSecurely` realpaths the root — laundering the link into the
  // allowed boundary. Refuse for discovery, read, and save.
  describe('security — symlinked root workflow dir', () => {
    let external: string;
    let projectWorkflowsDir: string;

    beforeEach(async () => {
      // Attacker-controlled external dir with a planted secret-bearing script.
      external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-evil-'));
      await fs.writeFile(
        path.join(external, 'leak.js'),
        `return 'EXFILTRATED';`,
        'utf8',
      );
      // Make `<projectDir>/.qwen/workflows` a symlink to that external dir.
      projectWorkflowsDir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(path.dirname(projectWorkflowsDir), { recursive: true });
      await fs.symlink(external, projectWorkflowsDir, 'dir');
    });

    afterEach(async () => {
      await fs.rm(external, { recursive: true, force: true });
    });

    it('discovery excludes scripts behind a symlinked project root', async () => {
      const list = await listSavedWorkflows(fakeConfig(projectDir));
      expect(list).toEqual([]);
    });

    it("workflow('leak') is refused, not read, through a symlinked root", async () => {
      await expect(
        resolveSavedWorkflowScript('leak', fakeConfig(projectDir)),
      ).rejects.toThrow(/no workflow with that name/);
    });

    it('{scriptPath} into a symlinked root is refused', async () => {
      const p = path.join(projectWorkflowsDir, 'leak.js');
      const attempt = resolveSavedWorkflowScript(
        { scriptPath: p },
        fakeConfig(projectDir),
      );
      await expect(attempt).rejects.toThrow(
        /outside the workflow script roots/,
      );
      await expect(attempt).rejects.toThrow(
        `refused symlinked root: ${projectWorkflowsDir}`,
      );
    });

    it('save into a symlinked root is refused (no write-through)', async () => {
      await expect(
        saveWorkflowScript(fakeConfig(projectDir), {
          name: 'planted',
          scope: 'project',
          script: 'return 1;',
        }),
      ).rejects.toThrow(/symlinked saved-workflow director/i);
      // Nothing was written through the link.
      await expect(
        fs.access(path.join(external, 'planted.js')),
      ).rejects.toThrow();
    });
  });
  // An inline `Workflow({script})` has no file behind it, which cost the
  // model its only route back into the run: resuming meant re-sending the
  // source. The copy lands in the generated root so the loader takes it back
  // by path — that round trip is the contract, not just the write.
  describe('persistInlineWorkflowScript', () => {
    const RUN_ID = 'wf_0123456789abcdef';

    it('writes the script where a {scriptPath} run can load it back', async () => {
      const config = fakeConfig(projectDir);
      const script = 'return "persisted"';

      const written = await persistInlineWorkflowScript(config, RUN_ID, script);

      expect(written).toBe(
        path.join(
          config.storage.getGeneratedWorkflowsDir(),
          'inline',
          `${RUN_ID}.js`,
        ),
      );
      await expect(fs.readFile(written!, 'utf8')).resolves.toBe(script);
      // The round trip: the loader's realpath boundary accepts it.
      await expect(
        resolveSavedWorkflowScript({ scriptPath: written! }, config),
      ).resolves.toMatchObject({ script });
    });

    it('leaves no temp file behind', async () => {
      const config = fakeConfig(projectDir);
      await persistInlineWorkflowScript(config, RUN_ID, 'return 1');
      const dir = path.join(
        config.storage.getGeneratedWorkflowsDir(),
        'inline',
      );
      await expect(fs.readdir(dir)).resolves.toEqual([`${RUN_ID}.js`]);
    });

    it('overwrites the previous copy when the same run is resumed', async () => {
      const config = fakeConfig(projectDir);
      await persistInlineWorkflowScript(config, RUN_ID, 'return "first"');
      const written = await persistInlineWorkflowScript(
        config,
        RUN_ID,
        'return "second"',
      );

      await expect(fs.readFile(written!, 'utf8')).resolves.toBe(
        'return "second"',
      );
      const dir = path.join(
        config.storage.getGeneratedWorkflowsDir(),
        'inline',
      );
      await expect(fs.readdir(dir)).resolves.toEqual([`${RUN_ID}.js`]);
    });

    // The run id becomes a path segment, so it is checked before it is
    // joined — the same `wf_<hex>` gate the tool's resumeFromRunId and the
    // snapshot pruner apply.
    it.each([
      ['..'],
      ['../../etc/evil'],
      ['wf_../escape'],
      ['wf_NOTHEX'],
      ['run1'],
    ])('refuses the run id %s', async (runId) => {
      const config = fakeConfig(projectDir);
      await expect(
        persistInlineWorkflowScript(config, runId, 'return 1'),
      ).resolves.toBeNull();
      await expect(
        fs.access(config.storage.getGeneratedWorkflowsDir()),
      ).rejects.toThrow();
    });

    it('refuses a symlinked generated root and writes nothing through it', async () => {
      const config = fakeConfig(projectDir);
      const external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ext-'));
      const generated = config.storage.getGeneratedWorkflowsDir();
      await fs.mkdir(path.dirname(generated), { recursive: true });
      await fs.symlink(external, generated, 'dir');

      try {
        await expect(
          persistInlineWorkflowScript(config, RUN_ID, 'return 1'),
        ).resolves.toBeNull();
        await expect(fs.readdir(external)).resolves.toEqual([]);
      } finally {
        await fs.rm(external, { recursive: true, force: true });
      }
    });

    it('refuses a symlinked inline root and writes nothing through it', async () => {
      const config = fakeConfig(projectDir);
      const external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ext-'));
      const generated = config.storage.getGeneratedWorkflowsDir();
      await fs.mkdir(generated, { recursive: true });
      await fs.symlink(external, path.join(generated, 'inline'), 'dir');

      try {
        await expect(
          persistInlineWorkflowScript(config, RUN_ID, 'return 1'),
        ).resolves.toBeNull();
        await expect(fs.readdir(external)).resolves.toEqual([]);
      } finally {
        await fs.rm(external, { recursive: true, force: true });
      }
    });

    it('returns null rather than throwing when the config has no storage', async () => {
      await expect(
        persistInlineWorkflowScript(
          {} as unknown as Config,
          RUN_ID,
          'return 1',
        ),
      ).resolves.toBeNull();
    });

    it('returns null when a partial storage lacks the inline accessor', async () => {
      const config = {
        storage: {
          getWorkflowRunJournalPath: () => '/tmp/journal.jsonl',
        },
      } as unknown as Config;

      await expect(
        persistInlineWorkflowScript(config, RUN_ID, 'return 1'),
      ).resolves.toBeNull();
    });
  });
});
