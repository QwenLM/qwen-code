/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { isSubpath } from '../../utils/paths.js';
import { getShellContextEnvVars } from '../../services/shellContextEnv.js';
import {
  registerSessionProjectDir,
  sessionIdContext,
  unregisterSessionProjectDir,
} from '../../utils/sessionIdContext.js';
import {
  EXTENSION_WORKFLOW_NAME_PATTERN,
  findActiveExtensionWorkflowByPath,
  findActiveExtensionWorkflowByPathCanonical,
  getWorkflowScriptRoots,
  isWorkflowRunId,
  listSavedWorkflows,
  parseExtensionWorkflowName,
  persistInlineWorkflowScript,
  qualifyExtensionWorkflowName,
  resolveSavedWorkflowScript,
  saveWorkflowScript,
  validateWorkflowName,
  WORKFLOW_NAME_PATTERN,
} from './workflow-saved.js';
import {
  loadExtensionWorkflows,
  MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES,
  type ExtensionWorkflowDefinition,
} from './workflow-extension.js';

/**
 * A Config whose `.storage` points at `projectDir`. The user scope
 * (`~/.qwen`) is sandboxed via QWEN_HOME in beforeEach, so tests never touch
 * the real home directory.
 */
function fakeConfig(projectDir: string): Config {
  return { storage: new Storage(projectDir) } as unknown as Config;
}

async function put(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

const writeWorkflow = (dir: string, name: string, body: string) =>
  put(path.join(dir, `${name}.js`), body);

async function symlinkDir(target: string, link: string): Promise<void> {
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link, 'dir');
}

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const OUTSIDE_ROOTS = /outside the workflow script roots/;

const expectRefused = (
  ref: string | { scriptPath: string },
  config: Config,
  error: RegExp | string,
) => expect(resolveSavedWorkflowScript(ref, config)).rejects.toThrow(error);

describe('workflow-saved', () => {
  let projectDir: string;
  let userHome: string;
  let prevQwenHome: string | undefined;

  const config = () => fakeConfig(projectDir);
  const projectWorkflows = () =>
    new Storage(projectDir).getProjectWorkflowsDir();
  const resolveRef = (ref: string | { scriptPath: string }) =>
    resolveSavedWorkflowScript(ref, fakeConfig(projectDir));
  const refused = (ref: string | { scriptPath: string }, error: RegExp) =>
    expectRefused(ref, config(), error);
  const listedNames = async () =>
    (await listSavedWorkflows(config())).map((e) => e.name);
  /** Saves `script` as `name`, in the project scope unless `opts` say otherwise. */
  const save = (
    name: string,
    script: string,
    opts: { scope?: 'user'; overwrite?: boolean } = {},
  ) =>
    saveWorkflowScript(config(), { name, scope: 'project', script, ...opts });

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
      await writeWorkflow(projectWorkflows(), 'foo', `return 'project-foo';`);
      const resolved = await resolveRef('foo');
      expect(resolved.name).toBe('foo');
      expect(resolved.script).toBe(`return 'project-foo';`);
      expect(resolved.scriptPath).toContain('foo.js');
    });

    it('resolves a user-scope workflow when project lacks it', async () => {
      const userDir = Storage.getUserWorkflowsDir();
      await writeWorkflow(userDir, 'bar', `return 'user-bar';`);
      expect((await resolveRef('bar')).script).toBe(`return 'user-bar';`);
    });

    it('project scope wins over user scope for the same name', async () => {
      await writeWorkflow(projectWorkflows(), 'dup', `return 'PROJECT';`);
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'dup',
        `return 'USER';`,
      );
      expect((await resolveRef('dup')).script).toBe(`return 'PROJECT';`);
    });

    it('throws with available names on a miss', async () => {
      await writeWorkflow(projectWorkflows(), 'alpha', `return 1;`);
      await refused('missing', /no workflow with that name. Available: alpha/);
    });

    it('throws "(none)" when no saved workflows exist', async () => {
      await refused('missing', /Available: \(none\)/);
    });
  });

  describe('resolveSavedWorkflowScript — by {scriptPath}', () => {
    it('reads a script path inside a saved-workflow dir', async () => {
      const p = path.join(projectWorkflows(), 'custom.js');
      await put(p, `return 'custom';`);
      const resolved = await resolveRef({ scriptPath: p });
      expect(resolved.script).toBe(`return 'custom';`);
      expect(resolved.name).toBe('custom');
      expect(resolved.savedWorkflowName).toBe('custom');
    });

    it('throws a clear error for a missing path under a saved dir', async () => {
      const dir = projectWorkflows();
      await fs.mkdir(dir, { recursive: true });
      await refused({ scriptPath: path.join(dir, 'nope.js') }, /scriptPath/);
    });

    it('rejects an empty scriptPath', async () => {
      await refused(
        { scriptPath: '' },
        /workflow name \(string\) or \{scriptPath/,
      );
    });

    // Security (#2): a scriptPath resolving outside the saved-workflow dirs is
    // refused, even when the file exists.
    it('refuses a scriptPath outside the saved-workflow directories', async () => {
      const outside = path.join(projectDir, 'evil.js');
      await put(outside, `return 'pwned';`);
      await refused({ scriptPath: outside }, OUTSIDE_ROOTS);
    });
  });

  describe('resolveSavedWorkflowScript — generated-scripts root', () => {
    let generatedDir: string;

    beforeEach(() => {
      generatedDir = new Storage(projectDir).getGeneratedWorkflowsDir();
    });

    it('reads a {scriptPath} under the generated root', async () => {
      const p = path.join(generatedDir, 'qwen-review-1a2b3c.js');
      await put(p, `return 'generated';`);
      const resolved = await resolveRef({ scriptPath: p });
      expect(resolved.script).toBe(`return 'generated';`);
      expect(resolved.name).toBe('qwen-review-1a2b3c');
      expect(resolved.savedWorkflowName).toBeUndefined();
    });

    it('trusts the whole subtree, so a writer may nest per session', async () => {
      const nested = path.join(generatedDir, 's-abc', 'fanout.js');
      await put(nested, `return 'nested';`);
      expect((await resolveRef({ scriptPath: nested })).script).toBe(
        `return 'nested';`,
      );
    });

    it('is neither listed as a slash command nor resolvable by name', async () => {
      await put(path.join(generatedDir, 'emitted.js'), `return 'generated';`);
      expect(await listSavedWorkflows(config())).toEqual([]);
      await refused('emitted', /no workflow with that name.*\(none\)/);
    });

    it('refuses a sibling of the generated root (no prefix match)', async () => {
      // `<runs>/generated-evil/x.js` shares the string prefix `generated`
      // with the root but is not inside it.
      const sibling = path.join(`${generatedDir}-evil`, 'x.js');
      await put(sibling, `return 'pwned';`);
      const attempt = resolveRef({ scriptPath: sibling });
      await expect(attempt).rejects.toThrow(
        /outside the workflow script roots \(checked: /,
      );
      // The refusal names every root it checked — the generated one lives in
      // the runtime dir, which no debugger would guess from the path alone.
      await expect(attempt).rejects.toThrow(generatedDir);
    });

    it('refuses a file that symlinks out of the generated root', async () => {
      const outside = path.join(projectDir, 'secret.js');
      await put(outside, `return 'EXFILTRATED';`);
      await fs.mkdir(generatedDir, { recursive: true });
      const link = path.join(generatedDir, 'link.js');
      await fs.symlink(outside, link, 'file');
      await refused({ scriptPath: link }, OUTSIDE_ROOTS);
    });

    it('refuses a symlinked generated root', () =>
      withTempDir('wf-gen-evil-', async (external) => {
        await put(path.join(external, 'leak.js'), `return 'EXFILTRATED';`);
        await symlinkDir(external, generatedDir);
        const attempt = resolveRef({
          scriptPath: path.join(generatedDir, 'leak.js'),
        });
        await expect(attempt).rejects.toThrow(OUTSIDE_ROOTS);
        // The refused root stays visible in the message: a checked-list it
        // is silently absent from reads as if the loader never considered it.
        await expect(attempt).rejects.toThrow(
          `(checked: ${projectWorkflows()}, ${Storage.getUserWorkflowsDir()}; refused symlinked root: ${generatedDir})`,
        );
      }));
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
        await put(p, `return 'composed';`);
        expect((await resolveRef({ scriptPath: p })).script).toBe(
          `return 'composed';`,
        );
      } finally {
        unregisterSessionProjectDir(sessionId);
      }
    });
  });

  // Security (#2): the string-name form must not escape the saved dirs.
  describe('resolveSavedWorkflowScript — name traversal', () => {
    it('rejects a traversal name before any path join', async () => {
      await refused('../../outside', /Invalid workflow name|lower-case/);
    });
  });

  describe('listSavedWorkflows', () => {
    it('merges both scopes, project shadows user, sorted by name', async () => {
      await writeWorkflow(projectWorkflows(), 'zeta', `return 1;`);
      await writeWorkflow(projectWorkflows(), 'shared', `return 'P';`);
      await writeWorkflow(Storage.getUserWorkflowsDir(), 'alpha', `return 1;`);
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'shared',
        `return 'U';`,
      );
      const list = await listSavedWorkflows(config());
      expect(list.map((e) => e.name)).toEqual(['alpha', 'shared', 'zeta']);
      const shared = list.find((e) => e.name === 'shared')!;
      expect(shared.source).toBe('project'); // project shadows user
    });

    it('skips files whose stem is not a legal workflow name', async () => {
      await writeWorkflow(projectWorkflows(), 'good-one', `return 1;`);
      // Illegal stem (leading digit): skipped.
      await writeWorkflow(projectWorkflows(), '9bad', `return 1;`);
      expect(await listedNames()).toEqual(['good-one']);
    });

    it('returns empty when no workflows dir exists', async () => {
      expect(await listSavedWorkflows(config())).toEqual([]);
    });

    // Security (#4): a symlinked `<name>.js` could point at an arbitrary file
    // (e.g. credentials); discovery must skip it so it never reaches the
    // snapshot `script` field / telemetry.
    it('skips symlinked entries', async () => {
      const dir = projectWorkflows();
      await fs.mkdir(dir, { recursive: true });
      const secret = path.join(projectDir, 'secret.txt');
      await fs.writeFile(secret, 'TOP SECRET', 'utf8');
      await fs.symlink(secret, path.join(dir, 'leak.js'));
      await writeWorkflow(dir, 'real', `return 1;`);
      expect(await listedNames()).toEqual(['real']);
    });
  });

  describe('saveWorkflowScript', () => {
    it('writes a new project-scope workflow and reports the path', async () => {
      const result = await save('my-flow', 'return 42;');
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      expect(await fs.readFile(result.path, 'utf8')).toBe('return 42;');
      // Round-trips through discovery as a /<name> candidate.
      expect(await listedNames()).toContain('my-flow');
    });

    it('writes a user-scope workflow under the sandboxed QWEN_HOME', async () => {
      const result = await save('user-flow', 'return 1;', { scope: 'user' });
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      expect(result.path).toContain(path.join(userHome, '.qwen'));
      expect(result.scope).toBe('user');
    });

    it('refuses an invalid name without writing', async () => {
      const result = await save('Bad Name', 'return 1;');
      expect(result.status).toBe('invalid-name');
      expect(await listSavedWorkflows(config())).toEqual([]);
    });

    it('rejects an empty script', async () => {
      expect((await save('empty', '   ')).status).toBe('empty-script');
    });

    const saveDupTwice = async (opts: { overwrite?: boolean } = {}) => {
      await save('dup', 'return "original";');
      return save('dup', 'return "replacement";', opts);
    };

    it('reports `exists` for a collision and does not clobber by default', async () => {
      const result = await saveDupTwice();
      expect(result.status).toBe('exists');
      if (result.status !== 'exists') throw new Error('expected exists');
      // Original is untouched.
      expect(await fs.readFile(result.path, 'utf8')).toBe('return "original";');
    });

    it('overwrites when overwrite:true', async () => {
      const result = await saveDupTwice({ overwrite: true });
      expect(result.status).toBe('saved');
      if (result.status !== 'saved') throw new Error('expected saved');
      expect(await fs.readFile(result.path, 'utf8')).toBe(
        'return "replacement";',
      );
    });
  });

  // Security (round 3, r3451228756): a saved-workflow ROOT dir that is itself
  // a symlink must not make its external target the trusted boundary. Round 1
  // only guarded symlinked *files*; a symlinked dir exposes regular files, and
  // `readWorkflowFileSecurely` realpaths the root, laundering the link into
  // the allowed boundary. Refuse for discovery, read, and save.
  describe('security — symlinked root workflow dir', () => {
    let external: string;
    let projectWorkflowsDir: string;

    beforeEach(async () => {
      // Attacker-controlled external dir with a planted secret-bearing script,
      // linked at `<projectDir>/.qwen/workflows`.
      external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-evil-'));
      await put(path.join(external, 'leak.js'), `return 'EXFILTRATED';`);
      projectWorkflowsDir = projectWorkflows();
      await symlinkDir(external, projectWorkflowsDir);
    });

    afterEach(async () => {
      await fs.rm(external, { recursive: true, force: true });
    });

    it('discovery excludes scripts behind a symlinked project root', async () => {
      expect(await listSavedWorkflows(config())).toEqual([]);
    });

    it("workflow('leak') is refused, not read, through a symlinked root", async () => {
      await refused('leak', /no workflow with that name/);
    });

    it('{scriptPath} into a symlinked root is refused', async () => {
      const attempt = resolveRef({
        scriptPath: path.join(projectWorkflowsDir, 'leak.js'),
      });
      await expect(attempt).rejects.toThrow(OUTSIDE_ROOTS);
      await expect(attempt).rejects.toThrow(
        `refused symlinked root: ${projectWorkflowsDir}`,
      );
    });

    it('save into a symlinked root is refused (no write-through)', async () => {
      await expect(save('planted', 'return 1;')).rejects.toThrow(
        /symlinked saved-workflow director/i,
      );
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
    const generatedDir = () =>
      new Storage(projectDir).getGeneratedWorkflowsDir();
    const inlineDir = () => path.join(generatedDir(), 'inline');
    const persist = (script: string, runId = RUN_ID) =>
      persistInlineWorkflowScript(config(), runId, script);

    it('writes the script where a {scriptPath} run can load it back', async () => {
      const script = 'return "persisted"';

      const written = await persist(script);

      expect(written).toBe(path.join(inlineDir(), `${RUN_ID}.js`));
      await expect(fs.readFile(written!, 'utf8')).resolves.toBe(script);
      // The round trip: the loader's realpath boundary accepts it.
      await expect(resolveRef({ scriptPath: written! })).resolves.toMatchObject(
        { script },
      );
    });

    it('leaves no temp file behind', async () => {
      await persist('return 1');
      await expect(fs.readdir(inlineDir())).resolves.toEqual([`${RUN_ID}.js`]);
    });

    it('overwrites the previous copy when the same run is resumed', async () => {
      await persist('return "first"');
      const written = await persist('return "second"');

      await expect(fs.readFile(written!, 'utf8')).resolves.toBe(
        'return "second"',
      );
      await expect(fs.readdir(inlineDir())).resolves.toEqual([`${RUN_ID}.js`]);
    });

    // The run id becomes a path segment, so it is checked before it is
    // joined — the same `wf_<hex>` gate the tool's resumeFromRunId and the
    // snapshot pruner apply.
    it.each(['..', '../../etc/evil', 'wf_../escape', 'wf_NOTHEX', 'run1'])(
      'refuses the run id %s',
      async (runId) => {
        await expect(persist('return 1', runId)).resolves.toBeNull();
        await expect(fs.access(generatedDir())).rejects.toThrow();
      },
    );

    /** Links `link(generatedDir)` to an external dir; nothing may land there. */
    const expectNoWriteThrough = (link: (generated: string) => string) =>
      withTempDir('wf-ext-', async (external) => {
        await symlinkDir(external, link(generatedDir()));
        await expect(persist('return 1')).resolves.toBeNull();
        await expect(fs.readdir(external)).resolves.toEqual([]);
      });

    it('refuses a symlinked generated root and writes nothing through it', () =>
      expectNoWriteThrough((generated) => generated));

    it('refuses a symlinked inline root and writes nothing through it', () =>
      expectNoWriteThrough((generated) => path.join(generated, 'inline')));

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

describe('workflow-saved — extension tier', () => {
  let base: string;
  let projectDir: string;
  let extensionRoot: string;
  let prevQwenHome: string | undefined;

  beforeEach(async () => {
    base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ext-tier-')),
    );
    projectDir = path.join(base, 'project');
    extensionRoot = path.join(base, 'extensions', 'gcp');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(extensionRoot, { recursive: true });
    prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(base, 'home', '.qwen');
  });

  afterEach(async () => {
    if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevQwenHome;
    await fs.rm(base, { recursive: true, force: true });
  });

  const meta = (name: string) =>
    `export const meta = { name: '${name}', description: 'Runs ${name}' };\nreturn '${name}';\n`;

  async function loadGcp(): Promise<ExtensionWorkflowDefinition[]> {
    return loadExtensionWorkflows(extensionRoot, { name: 'gcp' }, undefined);
  }

  function configWith(workflows: ExtensionWorkflowDefinition[]): Config {
    return {
      storage: new Storage(projectDir),
      getActiveExtensions: () => [{ name: 'gcp', workflows }],
    } as unknown as Config;
  }

  const auditScript = () => path.join(extensionRoot, 'workflows', 'audit.js');

  /** Writes gcp's `audit` workflow; returns a config with gcp active. */
  async function auditConfig(): Promise<Config> {
    await put(auditScript(), meta('audit'));
    return configWith(await loadGcp());
  }

  it('parses and qualifies extension workflow names', () => {
    expect(qualifyExtensionWorkflowName('gcp', 'deep-research')).toBe(
      'gcp:deep-research',
    );
    expect(parseExtensionWorkflowName('My_Ext.v2:deep')).toEqual({
      extensionName: 'My_Ext.v2',
      workflowName: 'deep',
    });
    expect(parseExtensionWorkflowName('deep')).toBeNull();
    expect(parseExtensionWorkflowName('gcp:Deep')).toBeNull();
    expect(parseExtensionWorkflowName('has space:deep')).toBeNull();
    expect(parseExtensionWorkflowName('gcp:a:b')).toBeNull();
    expect(EXTENSION_WORKFLOW_NAME_PATTERN.test('gcp:deep-research')).toBe(
      true,
    );
  });

  it('lists all three tiers, with extension metadata on extension entries', async () => {
    await writeWorkflow(
      new Storage(projectDir).getProjectWorkflowsDir(),
      'local',
      meta('local'),
    );
    await writeWorkflow(Storage.getUserWorkflowsDir(), 'mine', meta('mine'));

    const entries = await listSavedWorkflows(await auditConfig());

    expect(entries.map((e) => [e.name, e.source])).toEqual([
      ['gcp:audit', 'extension'],
      ['local', 'project'],
      ['mine', 'user'],
    ]);
    expect(entries[0]).toMatchObject({
      extensionName: 'gcp',
      description: 'Runs audit',
      scriptPath: auditScript(),
    });
    expect('whenToUse' in entries[0]).toBe(false);
  });

  it('carries the whenToUse of an extension workflow onto its entry', async () => {
    await put(
      auditScript(),
      `export const meta = { name: 'audit', description: 'Runs audit', whenToUse: 'When the user asks for a dependency audit' };\nreturn 1;\n`,
    );
    const [entry] = await listSavedWorkflows(configWith(await loadGcp()));

    expect(entry).toMatchObject({
      name: 'gcp:audit',
      whenToUse: 'When the user asks for a dependency audit',
    });
  });

  it('resolves an extension workflow by its qualified name', async () => {
    const resolved = await resolveSavedWorkflowScript(
      'gcp:audit',
      await auditConfig(),
    );

    expect(resolved.script).toContain("return 'audit';");
    expect(resolved.savedWorkflowName).toBe('gcp:audit');
    expect(resolved.scriptPath).toBe(auditScript());
  });

  it('reports an unknown qualified name as not found, not as an invalid name', async () => {
    const config = await auditConfig();

    await expectRefused(
      'gcp:missing',
      config,
      /no workflow with that name\. Available: gcp:audit\./,
    );
    await expect(
      resolveSavedWorkflowScript('other:audit', config),
    ).rejects.not.toThrow(/Invalid workflow name/);
  });

  it('refuses both addressing forms once the extension is no longer active', async () => {
    await put(auditScript(), meta('audit'));
    const workflows = await loadGcp();
    // Loaded but disabled: listed by getExtensions(), absent from
    // getActiveExtensions(). Only the active list may contribute.
    const inactive = {
      storage: new Storage(projectDir),
      getExtensions: () => [{ name: 'gcp', isActive: false, workflows }],
      getActiveExtensions: () => [],
    } as unknown as Config;

    await expectRefused('gcp:audit', inactive, /no workflow with that name/);
    expect(
      (await listSavedWorkflows(inactive)).map((entry) => entry.name),
    ).not.toContain('gcp:audit');
    await expectRefused({ scriptPath: auditScript() }, inactive, OUTSIDE_ROOTS);
  });

  it('loads a discovered extension file by scriptPath and names it', async () => {
    const resolved = await resolveSavedWorkflowScript(
      { scriptPath: auditScript() },
      await auditConfig(),
    );

    expect(resolved.script).toContain("return 'audit';");
    expect(resolved.savedWorkflowName).toBe('gcp:audit');
  });

  // The extension directory is not a root: only discovered files are
  // readable, so a manifest pointing `workflows` at the extension root cannot
  // expose its `.env` settings or any other file beside the scripts.
  it('refuses every other file in the extension, even with "workflows": "."', async () => {
    await put(path.join(extensionRoot, 'audit.js'), meta('audit'));
    await put(path.join(extensionRoot, '.env'), 'SECRET=1\n');
    await put(
      path.join(extensionRoot, 'huge.js'),
      meta('huge') + '//'.padEnd(MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES, 'x'),
    );
    const workflows = await loadExtensionWorkflows(
      extensionRoot,
      { name: 'gcp' },
      '.',
    );
    expect(workflows.map((w) => w.name)).toEqual(['gcp:audit']);
    const config = configWith(workflows);

    for (const file of ['.env', 'huge.js']) {
      await expectRefused(
        { scriptPath: path.join(extensionRoot, file) },
        config,
        OUTSIDE_ROOTS,
      );
    }
    expect(getWorkflowScriptRoots(config)).not.toContain(extensionRoot);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a discovered file that was swapped for a symlink after load',
    async () => {
      const scriptPath = auditScript();
      const config = await auditConfig();
      const outside = path.join(base, 'outside.js');
      await put(outside, meta('audit'));
      await fs.rm(scriptPath);
      await fs.symlink(outside, scriptPath);

      await expectRefused({ scriptPath }, config, OUTSIDE_ROOTS);
      // The name form reports the refusal too, rather than calling a listed
      // name missing.
      await expectRefused(
        'gcp:audit',
        config,
        /^workflow\('gcp:audit'\): refusing to load a workflow file outside the workflow script roots/,
      );
    },
  );

  it('carries the owner display name from discovery to the listing', async () => {
    await put(auditScript(), meta('audit'));
    const workflows = await loadExtensionWorkflows(
      extensionRoot,
      { name: 'gcp', displayName: 'Google Cloud' },
      undefined,
    );

    const [entry] = await listSavedWorkflows(configWith(workflows));

    expect(entry).toMatchObject({
      name: 'gcp:audit',
      extensionName: 'gcp',
      extensionDisplayName: 'Google Cloud',
    });
  });

  it('matches a script path only to the extension workflow at that path', async () => {
    const extensionScript = auditScript();
    const projectScript = path.join(
      new Storage(projectDir).getProjectWorkflowsDir(),
      'deploy.js',
    );
    await put(projectScript, meta('deploy'));
    const config = await auditConfig();

    expect(
      findActiveExtensionWorkflowByPath(config, extensionScript)?.name,
    ).toBe('gcp:audit');
    expect(
      findActiveExtensionWorkflowByPath(config, projectScript),
    ).toBeUndefined();
    expect(
      (
        await findActiveExtensionWorkflowByPathCanonical(
          config,
          extensionScript,
        )
      )?.name,
    ).toBe('gcp:audit');
    expect(
      await findActiveExtensionWorkflowByPathCanonical(config, projectScript),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'matches a script path spelled through a symlinked ancestor in both finders',
    async () => {
      const config = await auditConfig();
      const alias = path.join(base, 'alias');
      await fs.symlink(extensionRoot, alias);
      const aliased = path.join(alias, 'workflows', 'audit.js');

      expect(findActiveExtensionWorkflowByPath(config, aliased)?.name).toBe(
        'gcp:audit',
      );
      expect(
        (await findActiveExtensionWorkflowByPathCanonical(config, aliased))
          ?.name,
      ).toBe('gcp:audit');
    },
  );

  it('keeps unqualified names on the project/user rules', async () => {
    const config = configWith([]);
    await expectRefused('Not-Valid', config, /Invalid workflow name/);
  });
});

describe('isWorkflowRunId', () => {
  it('accepts the generated wf_<hex> shape and nothing that could leave its directory', () => {
    expect(isWorkflowRunId('wf_0123abcdef456789')).toBe(true);
    for (const value of [
      '',
      'wf_',
      'wf_ABCD',
      'wf_zz',
      '../wf_1234',
      'wf_1234/../x',
      'wf_1234\0',
      ' wf_1234',
      'run_1234',
    ]) {
      expect(isWorkflowRunId(value)).toBe(false);
    }
  });
});

describe('workflow-saved — local ancestor discovery', () => {
  let base: string;
  let repo: string;
  let target: string;
  let previousHome: string | undefined;
  const trust = vi.fn(async (dirs: readonly string[]) => dirs.map(() => true));
  const workflows = (dir: string) => path.join(dir, '.qwen', 'workflows');
  const config = (storageTarget = target): Config =>
    ({
      storage: new Storage(storageTarget),
      getTargetDir: () => target,
      getWorkflowAncestorTrustProvider: () => trust,
    }) as unknown as Config;

  beforeEach(async () => {
    base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ancestor-')),
    );
    repo = path.join(base, 'repo');
    target = path.join(repo, 'packages', 'a');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(repo, '.git'));
    previousHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(base, 'home', '.qwen');
    trust.mockReset();
    trust.mockImplementation(async (dirs) => dirs.map(() => true));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  });

  it('C01: resolves nearest scope and refreshes layout and trust next call', async () => {
    const parent = path.dirname(target);
    const scopes = [
      [target, "return 'DW01_TARGET_7F3A';"],
      [parent, "return 'DW01_PACKAGES_6B2E';"],
      [repo, "return 'DW01_ROOT_4C8D';"],
    ];
    await writeWorkflow(
      Storage.getUserWorkflowsDir(),
      'shared',
      "return 'DW01_USER_9A1F';",
    );
    for (const [dir, script] of scopes.toReversed()) {
      await writeWorkflow(workflows(dir), 'shared', script);
    }
    for (const [dir, script] of scopes) {
      const entry = (await listSavedWorkflows(config())).find(
        (e) => e.name === 'shared',
      );
      expect(entry?.scriptPath).toBe(path.join(workflows(dir), 'shared.js'));
      expect(
        await resolveSavedWorkflowScript('shared', config()),
      ).toMatchObject({
        script,
        scriptPath: path.join(workflows(dir), 'shared.js'),
        source: 'project',
      });
      await fs.unlink(path.join(workflows(dir), 'shared.js'));
    }
    expect((await resolveSavedWorkflowScript('shared', config())).script).toBe(
      "return 'DW01_USER_9A1F';",
    );
    await writeWorkflow(workflows(repo), 'root-only', 'return 4;');
    trust.mockImplementation(async (dirs) => dirs.map(() => false));
    expect((await listSavedWorkflows(config())).map((e) => e.name)).toEqual([
      'shared',
    ]);
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(repo), 'root-only.js') },
        config(),
      ),
    ).rejects.toThrow(OUTSIDE_ROOTS);
  });

  it('C05/R01: absent provider does not expand ordinary Config scope', async () => {
    await writeWorkflow(workflows(repo), 'hidden', 'return 1;');
    const ordinary = {
      storage: new Storage(target),
      getTargetDir: () => target,
    } as unknown as Config;
    expect(await listSavedWorkflows(ordinary)).toEqual([]);
    expect(trust).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      async () => {
        throw new Error('unavailable');
      },
    ],
    ['wrong length', async () => [true]],
    ['non boolean', async () => [true, 'yes']],
    ['first deny', async () => [false, true]],
  ])(
    'C05: rejects invalid or denied provider response: %s',
    async (_label, provider) => {
      await writeWorkflow(workflows(repo), 'hidden', 'return 1;');
      const cfg = {
        ...config(),
        getWorkflowAncestorTrustProvider: () => provider,
      } as unknown as Config;
      expect(await listSavedWorkflows(cfg)).toEqual([]);
    },
  );

  it('C05: includes only the continuously trusted nearest prefix', async () => {
    const parent = path.dirname(target);
    await writeWorkflow(workflows(parent), 'near', 'return 2;');
    await writeWorkflow(workflows(repo), 'far', 'return 3;');
    trust.mockResolvedValue([true, false]);
    expect((await listSavedWorkflows(config())).map((e) => e.name)).toEqual([
      'near',
    ]);
    expect(trust).toHaveBeenCalledExactlyOnceWith([parent, repo], target);
  });

  it('C03: no Git root and a nested Git boundary do not expose outer definitions', async () => {
    await writeWorkflow(workflows(repo), 'outer', 'return 1;');
    await fs.rm(path.join(repo, '.git'), { recursive: true });
    const original = fs.lstat.bind(fs);
    const outerProbes: string[] = [];
    const gitProbe = vi.spyOn(fs, 'lstat').mockImplementation(((
      file,
      ...args
    ) => {
      if (
        path.basename(String(file)) === '.git' &&
        !isSubpath(base, String(file))
      ) {
        outerProbes.push(String(file));
        return Promise.reject(
          Object.assign(new Error('fixture: no outer Git marker'), {
            code: 'ENOENT',
          }),
        );
      }
      return original(file, ...args);
    }) as typeof fs.lstat);
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(outerProbes).toContain(path.join(path.parse(base).root, '.git'));
    gitProbe.mockRestore();
    await fs.mkdir(path.join(repo, '.git'));
    await fs.writeFile(
      path.join(path.dirname(target), '.git'),
      'gitdir: /elsewhere',
    );
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(trust).toHaveBeenLastCalledWith([path.dirname(target)], target);
  });

  it('C04: refuses uncertain Git boundaries instead of walking past them', async () => {
    await writeWorkflow(workflows(repo), 'outer', 'return 1;');
    const gitLink = path.join(path.dirname(target), '.git');
    await fs.symlink(path.join(repo, '.git'), gitLink, 'dir');
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(trust).not.toHaveBeenCalled();
    await fs.unlink(gitLink);
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(((p, ...args) => {
      if (String(p) === gitLink)
        return Promise.reject(
          Object.assign(new Error('git EIO'), { code: 'EIO' }),
        );
      return original(p, ...args);
    }) as typeof fs.lstat);
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(trust).not.toHaveBeenCalled();
  });

  it('C06: lists and names only direct ordinary candidates, with ancestor path equally bounded', async () => {
    const dir = workflows(repo);
    await writeWorkflow(dir, 'good', 'return 1;');
    await writeWorkflow(dir, '9bad', 'return 2;');
    await put(path.join(dir, 'nested', 'nested.js'), 'return 3;');
    await put(path.join(dir, '.env'), 'SECRET');
    await fs.mkdir(path.join(dir, 'folder.js'));
    await fs.symlink(path.join(dir, 'good.js'), path.join(dir, 'linked.js'));
    expect((await listSavedWorkflows(config())).map((e) => e.name)).toEqual([
      'good',
    ]);
    for (const file of [
      '9bad.js',
      'nested/nested.js',
      '.env',
      'folder.js',
      'linked.js',
    ]) {
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: path.join(dir, file) },
          config(),
        ),
      ).rejects.toThrow();
    }
    await writeWorkflow(Storage.getUserWorkflowsDir(), 'folder', 'return 5;');
    expect((await resolveSavedWorkflowScript('folder', config())).script).toBe(
      'return 5;',
    );
  });

  it.each(['.qwen', 'workflows'])(
    'C06: ancestor %s symlink grants no discovery or explicit path access',
    async (segment) => {
      const external = path.join(base, 'external');
      const externalWorkflows =
        segment === '.qwen' ? path.join(external, 'workflows') : external;
      await writeWorkflow(externalWorkflows, 'leak', "return 'SECRET';");
      const link =
        segment === '.qwen' ? path.join(repo, '.qwen') : workflows(repo);
      await symlinkDir(external, link);
      expect(await listSavedWorkflows(config())).toEqual([]);
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: path.join(workflows(repo), 'leak.js') },
          config(),
        ),
      ).rejects.toThrow(OUTSIDE_ROOTS);
    },
  );

  it('C07: a selected near file failing to read never falls back to a farther namesake', async () => {
    const near = path.join(workflows(path.dirname(target)), 'shared.js');
    await put(near, "return 'NEAR';");
    await writeWorkflow(workflows(repo), 'shared', "return 'FAR';");
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(((p) => {
      if (String(p) === near)
        return Promise.reject(
          Object.assign(new Error('selected file vanished'), {
            code: 'ENOENT',
          }),
        );
      return original(p);
    }) as typeof fs.realpath);
    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow(/selected file vanished/);
  });

  it('C07: listing skips an unreadable root, while a nearest named hit ignores farther I/O', async () => {
    await writeWorkflow(workflows(target), 'shared', "return 'TARGET';");
    const far = workflows(repo);
    await writeWorkflow(far, 'far', 'return 2;');
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(((p, ...args) => {
      if (String(p) === far)
        return Promise.reject(
          Object.assign(new Error('far EIO'), { code: 'EIO' }),
        );
      return original(p, ...args);
    }) as typeof fs.lstat);
    expect((await resolveSavedWorkflowScript('shared', config())).script).toBe(
      "return 'TARGET';",
    );
    expect(
      (await listSavedWorkflows(config())).map((entry) => entry.name),
    ).toEqual(['shared']);
  });

  it('C08: target .qwen cannot launder an untrusted ancestor for reads or saves', async () => {
    await writeWorkflow(workflows(repo), 'hidden', "return 'SECRET';");
    await symlinkDir(path.join(repo, '.qwen'), path.join(target, '.qwen'));
    trust.mockImplementation(async (dirs) => dirs.map(() => false));
    expect(await listSavedWorkflows(config())).toEqual([]);
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(target), 'hidden.js') },
        config(),
      ),
    ).rejects.toThrow(OUTSIDE_ROOTS);
    await expect(
      saveWorkflowScript(config(), {
        name: 'hidden',
        scope: 'project',
        script: 'return 9;',
        overwrite: true,
      }),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(workflows(repo), 'hidden.js'), 'utf8'),
    ).toBe("return 'SECRET';");
  });

  it('C08: keeps project aliases inside target and user parent aliases usable', async () => {
    const local = path.join(target, 'config');
    await writeWorkflow(path.join(local, 'workflows'), 'local', 'return 1;');
    await symlinkDir(local, path.join(target, '.qwen'));
    const userAlias = path.join(base, 'user-config');
    await writeWorkflow(path.join(userAlias, 'workflows'), 'user', 'return 2;');
    await symlinkDir(userAlias, Storage.getGlobalQwenDir());
    expect((await listSavedWorkflows(config())).map((e) => e.name)).toEqual([
      'local',
      'user',
    ]);
    expect((await resolveSavedWorkflowScript('local', config())).script).toBe(
      'return 1;',
    );
    expect((await resolveSavedWorkflowScript('user', config())).script).toBe(
      'return 2;',
    );
    expect(
      (
        await saveWorkflowScript(config(), {
          name: 'saved',
          scope: 'project',
          script: 'return 3;',
        })
      ).status,
    ).toBe('saved');
  });

  it('C08: explicit base paths retain contained file aliases without making them named workflows', async () => {
    const dir = workflows(target);
    await put(path.join(dir, 'nested', 'wf_abcdef.js'), 'return 8;');
    await fs.symlink(
      path.join(dir, 'nested', 'wf_abcdef.js'),
      path.join(dir, 'alias.js'),
    );
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(
      await resolveSavedWorkflowScript(
        { scriptPath: path.join(dir, 'alias.js') },
        config(),
      ),
    ).toMatchObject({ script: 'return 8;' });
    await expect(resolveSavedWorkflowScript('alias', config())).rejects.toThrow(
      /no workflow/,
    );
  });

  it('C04/R01: an unverifiable target denies project and ancestors while independent scopes remain readable', async () => {
    await writeWorkflow(workflows(repo), 'ancestor', 'return 1;');
    await writeWorkflow(workflows(target), 'local', 'return 2;');
    await writeWorkflow(Storage.getUserWorkflowsDir(), 'user', 'return 3;');
    const extensionScript = path.join(base, 'extension', 'check.js');
    await put(extensionScript, 'return 4;');
    const cfg = {
      ...config(),
      getActiveExtensions: () => [
        {
          workflows: [
            {
              name: 'audit:check',
              extensionName: 'audit',
              description: 'Check',
              scriptPath: extensionScript,
            },
          ],
        },
      ],
    } as unknown as Config;
    const generated = await persistInlineWorkflowScript(
      cfg,
      'wf_abc012',
      'return 5;',
    );
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(((file) =>
      String(file) === target
        ? Promise.reject(
            Object.assign(new Error('target EIO'), { code: 'EIO' }),
          )
        : original(file)) as typeof fs.realpath);
    expect((await listSavedWorkflows(cfg)).map((entry) => entry.name)).toEqual([
      'audit:check',
      'user',
    ]);
    expect((await resolveSavedWorkflowScript('user', cfg)).script).toBe(
      'return 3;',
    );
    expect((await resolveSavedWorkflowScript('audit:check', cfg)).script).toBe(
      'return 4;',
    );
    expect(
      (await resolveSavedWorkflowScript({ scriptPath: generated! }, cfg))
        .script,
    ).toBe('return 5;');
    expect(trust).not.toHaveBeenCalled();
  });

  it('C04: canonicalizes target and ancestor script paths through a system-style parent alias', async () => {
    const alias = path.join(base, 'alias');
    await symlinkDir(repo, alias);
    target = path.join(alias, 'packages', 'a');
    await writeWorkflow(workflows(repo), 'root-only', 'return 6;');
    expect(
      (await resolveSavedWorkflowScript('root-only', config())).scriptPath,
    ).toBe(path.join(workflows(repo), 'root-only.js'));
    expect(
      (
        await resolveSavedWorkflowScript(
          { scriptPath: path.join(workflows(alias), 'root-only.js') },
          config(),
        )
      ).script,
    ).toBe('return 6;');
    expect(trust).toHaveBeenLastCalledWith(
      [path.join(repo, 'packages'), repo],
      await fs.realpath(target),
    );
  });

  it('C07: a selected file swapped for a symlink does not read the link or a farther namesake', async () => {
    const near = path.join(workflows(path.dirname(target)), 'shared.js');
    const secret = path.join(base, 'secret.js');
    await put(near, "return 'NEAR';");
    await put(secret, "return 'SECRET';");
    await writeWorkflow(workflows(repo), 'shared', "return 'FAR';");
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === near) {
        await fs.unlink(near);
        await fs.symlink(secret, near);
      }
      return original(file, flags, mode);
    });
    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow();
  });

  it('C07: a selected file read error does not fall back to a farther namesake', async () => {
    const near = path.join(workflows(path.dirname(target)), 'shared.js');
    await put(near, "return 'NEAR';");
    await writeWorkflow(workflows(repo), 'shared', "return 'FAR';");
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode);
      if (String(file) === near)
        vi.spyOn(handle, 'readFile').mockRejectedValueOnce(
          new Error('selected read EIO'),
        );
      return handle;
    });
    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow('selected read EIO');
  });

  it('C10: rechecks project containment after mkdir before saving', async () => {
    const external = path.join(base, 'external');
    await fs.mkdir(external);
    const dir = workflows(target);
    const original = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation((async (file, opts) => {
      const result = await original(file, opts);
      if (String(file) === dir) {
        await fs.rm(path.dirname(dir), { recursive: true });
        await fs.symlink(external, path.dirname(dir), 'dir');
      }
      return result;
    }) as typeof fs.mkdir);
    await expect(
      saveWorkflowScript(config(), {
        name: 'saved',
        scope: 'project',
        script: 'return 1;',
      }),
    ).rejects.toThrow(/outside the project target/);
    expect(await fs.readdir(external)).toEqual([]);
  });

  it('C09: derived target discovery and save ignore inherited project Storage', async () => {
    await writeWorkflow(workflows(repo), 'parent', 'return 1;');
    await writeWorkflow(workflows(target), 'child', 'return 2;');
    trust.mockImplementation(async (dirs) => dirs.map(() => false));
    const cfg = config(repo);
    expect((await listSavedWorkflows(cfg)).map((e) => e.name)).toEqual([
      'child',
    ]);
    const saved = await saveWorkflowScript(cfg, {
      name: 'saved',
      scope: 'project',
      script: 'return 3;',
    });
    expect(saved).toMatchObject({
      status: 'saved',
      path: path.join(workflows(target), 'saved.js'),
    });
    await expect(
      fs.access(path.join(workflows(repo), 'saved.js')),
    ).rejects.toThrow();
  });

  it('C10: overwrite never writes through a workflow file symlink', async () => {
    const secret = path.join(base, 'secret');
    await put(secret, 'KEEP');
    await fs.mkdir(workflows(target), { recursive: true });
    await fs.symlink(secret, path.join(workflows(target), 'saved.js'));
    await expect(
      saveWorkflowScript(config(), {
        name: 'saved',
        scope: 'project',
        script: 'return 1;',
        overwrite: true,
      }),
    ).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(secret, 'utf8')).toBe('KEEP');
  });

  it('P01: name lookup probes only that filename without enumerating unrelated scripts', async () => {
    await writeWorkflow(workflows(repo), 'selected', 'return 1;');
    await writeWorkflow(workflows(repo), 'unrelated', 'return 2;');
    const readdir = vi.spyOn(fs, 'readdir');
    const lstat = vi.spyOn(fs, 'lstat');
    expect(
      (await resolveSavedWorkflowScript('selected', config())).script,
    ).toBe('return 1;');
    expect(readdir).not.toHaveBeenCalled();
    expect(
      lstat.mock.calls.some(([p]) => String(p).endsWith('unrelated.js')),
    ).toBe(false);
    expect(trust).toHaveBeenCalledTimes(1);
  });

  it('C05: a not-found message reuses one ancestor trust snapshot', async () => {
    await writeWorkflow(workflows(repo), 'available', 'return 1;');
    await expect(
      resolveSavedWorkflowScript('missing', config()),
    ).rejects.toThrow('Available: available');
    expect(trust).toHaveBeenCalledTimes(1);
  });

  it.each(['root', 'readdir', 'candidate', 'vanished-candidate'])(
    'R1-1: a %s listing error preserves extension and nearer entries without exposing farther namesakes',
    async (failure) => {
      const broken = workflows(path.dirname(target));
      const brokenFile = path.join(broken, 'broken.js');
      const extensionFile = path.join(base, 'extension', 'check.js');
      await put(brokenFile, 'return "BROKEN";');
      await writeWorkflow(workflows(repo), 'broken', 'return "FAR";');
      await put(extensionFile, 'return "EXTENSION";');
      await writeWorkflow(workflows(target), 'local', 'return "LOCAL";');
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'mine',
        'return "USER";',
      );
      const cfg = {
        ...config(),
        getActiveExtensions: () => [
          {
            workflows: [
              {
                name: 'audit:check',
                extensionName: 'audit',
                description: 'Check',
                scriptPath: extensionFile,
              },
            ],
          },
        ],
      } as unknown as Config;
      const error = Object.assign(new Error('listing EACCES'), {
        code: 'EACCES',
      });
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation(((file, ...args) => {
        if (
          (failure === 'root' && String(file) === broken) ||
          (failure === 'candidate' && String(file) === brokenFile)
        ) {
          return Promise.reject(error);
        }
        return lstat(file, ...args);
      }) as typeof fs.lstat);
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(((dir, ...args) =>
        failure === 'readdir' && String(dir) === broken
          ? Promise.reject(error)
          : Reflect.apply(readdir, fs, [dir, ...args])) as typeof fs.readdir);
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation(((file, ...args) =>
        failure === 'vanished-candidate' && String(file) === brokenFile
          ? Promise.reject(
              Object.assign(new Error('selected candidate vanished'), {
                code: 'ENOENT',
              }),
            )
          : Reflect.apply(realpath, fs, [
              file,
              ...args,
            ])) as typeof fs.realpath);

      expect(
        (await listSavedWorkflows(cfg)).map((entry) => entry.name),
      ).toEqual(['audit:check', 'local']);
      expect(
        (await resolveSavedWorkflowScript('audit:check', cfg)).script,
      ).toBe('return "EXTENSION";');
    },
  );

  it.each(['missing', 'audit:missing'])(
    'R1-1: %s keeps its not-found message and available names when only enumeration fails',
    async (name) => {
      const broken = workflows(path.dirname(target));
      await writeWorkflow(broken, 'hidden', 'return "HIDDEN";');
      await writeWorkflow(workflows(target), 'local', 'return "LOCAL";');
      await writeWorkflow(
        Storage.getUserWorkflowsDir(),
        'mine',
        'return "USER";',
      );
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(((dir, ...args) =>
        String(dir) === broken
          ? Promise.reject(
              Object.assign(new Error('listing EACCES'), { code: 'EACCES' }),
            )
          : Reflect.apply(readdir, fs, [dir, ...args])) as typeof fs.readdir);

      const error = await resolveSavedWorkflowScript(name, config()).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `workflow('${name}'): no workflow with that name. Available: local.`,
      );
      expect((error as Error).message).toContain(broken);
      expect((error as Error).message).toContain('EACCES');
      expect(trust).toHaveBeenCalledTimes(1);
    },
  );

  it('R1-1: an unreadable nearer root still refuses a farther namesake instead of falling back', async () => {
    const broken = workflows(path.dirname(target));
    await writeWorkflow(broken, 'shared', 'return "NEAR";');
    await writeWorkflow(workflows(repo), 'shared', 'return "FAR";');
    await writeWorkflow(
      Storage.getUserWorkflowsDir(),
      'shared',
      'return "USER";',
    );
    const lstat = fs.lstat.bind(fs);
    const probe = vi
      .spyOn(fs, 'lstat')
      .mockImplementation(((file, ...args) =>
        String(file) === broken
          ? Promise.reject(
              Object.assign(new Error('near root EACCES'), { code: 'EACCES' }),
            )
          : lstat(file, ...args)) as typeof fs.lstat);

    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow('near root EACCES');
    expect(
      probe.mock.calls.some(
        ([file]) => String(file) === path.join(workflows(repo), 'shared.js'),
      ),
    ).toBe(false);
    await expect(
      resolveSavedWorkflowScript('missing', config()),
    ).rejects.toThrow('near root EACCES');
    await fs.access(path.join(workflows(repo), 'shared.js'));
  });

  it('C06: a target beneath an ancestor workflow directory retains its own name and path admission', async () => {
    target = path.join(workflows(repo), 'editor');
    await fs.mkdir(target, { recursive: true });
    const scriptPath = path.join(workflows(target), 'local.js');
    await put(scriptPath, "return 'OVERLAPPING_TARGET';");
    expect(
      (await listSavedWorkflows(config())).find(
        (entry) => entry.name === 'local',
      ),
    ).toMatchObject({ scriptPath });
    for (const ref of ['local', { scriptPath }]) {
      expect(await resolveSavedWorkflowScript(ref, config())).toMatchObject({
        scriptPath,
        script: "return 'OVERLAPPING_TARGET';",
        source: 'project',
      });
    }
  });

  it('C06: an independently configured user scope beneath an ancestor workflow directory stays readable', async () => {
    process.env['QWEN_HOME'] = path.join(
      workflows(repo),
      'user-config',
      '.qwen',
    );
    const scriptPath = path.join(
      Storage.getUserWorkflowsDir(),
      'user-overlap.js',
    );
    await put(scriptPath, "return 'OVERLAPPING_USER';");
    for (const ref of ['user-overlap', { scriptPath }]) {
      expect(await resolveSavedWorkflowScript(ref, config())).toMatchObject({
        scriptPath,
        script: "return 'OVERLAPPING_USER';",
        source: 'user',
      });
    }
  });

  it('R03: a generated runtime beneath an ancestor workflow directory retains nested inline run ids', async () => {
    const cfg = {
      ...config(),
      storage: new Storage(target, path.join(workflows(repo), 'runtime')),
    } as unknown as Config;
    const scriptPath = await persistInlineWorkflowScript(
      cfg,
      'wf_abcdef02',
      "return 'OVERLAPPING_GENERATED';",
    );
    expect(scriptPath).not.toBeNull();
    const resolved = await resolveSavedWorkflowScript(
      { scriptPath: scriptPath! },
      cfg,
    );
    expect(resolved).toMatchObject({
      scriptPath,
      script: "return 'OVERLAPPING_GENERATED';",
    });
    expect(resolved.savedWorkflowName).toBeUndefined();
  });

  it('C06: an exact registered extension file beneath an ancestor workflow directory stays readable', async () => {
    const scriptPath = path.join(
      workflows(repo),
      'extension',
      'nested',
      'check.js',
    );
    await put(scriptPath, "return 'OVERLAPPING_EXTENSION';");
    const cfg = {
      ...config(),
      getActiveExtensions: () => [
        {
          workflows: [
            {
              name: 'audit:check',
              extensionName: 'audit',
              description: 'Check',
              scriptPath,
            },
          ],
        },
      ],
    } as unknown as Config;
    for (const ref of ['audit:check', { scriptPath }]) {
      expect(await resolveSavedWorkflowScript(ref, cfg)).toMatchObject({
        scriptPath,
        script: "return 'OVERLAPPING_EXTENSION';",
        source: 'extension',
      });
    }
  });

  it.each(['.qwen', 'workflows', 'file'])(
    'C06: an ancestor %s link into the independent user scope grants no ancestor path',
    async (segment) => {
      const userFile = path.join(Storage.getUserWorkflowsDir(), 'user-only.js');
      await put(userFile, "return 'USER_ONLY';");
      if (segment === '.qwen') {
        await symlinkDir(Storage.getGlobalQwenDir(), path.join(repo, '.qwen'));
      } else if (segment === 'workflows') {
        await symlinkDir(Storage.getUserWorkflowsDir(), workflows(repo));
      } else {
        await fs.mkdir(workflows(repo), { recursive: true });
        await fs.symlink(userFile, path.join(workflows(repo), 'user-only.js'));
      }
      expect(
        (await resolveSavedWorkflowScript('user-only', config())).script,
      ).toBe("return 'USER_ONLY';");
      await expect(
        resolveSavedWorkflowScript(
          { scriptPath: path.join(workflows(repo), 'user-only.js') },
          config(),
        ),
      ).rejects.toThrow(OUTSIDE_ROOTS);
    },
  );

  it('C06: spelling an ancestor root through a parent alias cannot launder its workflows link into user scope', async () => {
    const userFile = path.join(Storage.getUserWorkflowsDir(), 'user-only.js');
    await put(userFile, "return 'USER_ONLY';");
    await symlinkDir(Storage.getUserWorkflowsDir(), workflows(repo));
    const alias = path.join(base, 'repo-alias');
    await symlinkDir(repo, alias);
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(alias), 'user-only.js') },
        config(),
      ),
    ).rejects.toThrow(OUTSIDE_ROOTS);
  });

  it('P2-CASE: list and direct name probes reject the same physical filename case', async ({
    skip,
  }) => {
    await writeWorkflow(
      workflows(repo),
      'Audit',
      "return 'ANCESTOR_INVALID_CASE';",
    );
    const lowercase = path.join(workflows(repo), 'audit.js');
    if (
      !(await fs.lstat(lowercase).then(
        () => true,
        () => false,
      ))
    )
      skip();
    const userPath = path.join(Storage.getUserWorkflowsDir(), 'audit.js');
    await put(userPath, "return 'USER_VALID_CASE';");
    expect(
      (await listSavedWorkflows(config())).find(
        (entry) => entry.name === 'audit',
      )?.scriptPath,
    ).toBe(userPath);
    expect(await resolveSavedWorkflowScript('audit', config())).toMatchObject({
      scriptPath: userPath,
      script: "return 'USER_VALID_CASE';",
      source: 'user',
    });
    const readdir = vi.spyOn(fs, 'readdir');
    await resolveSavedWorkflowScript('audit', config());
    expect(readdir).not.toHaveBeenCalled();
  });

  it.each(['project', 'user'])(
    'P2-IO: an inaccessible unrelated %s root does not block independent explicit or extension admission',
    async (brokenScope) => {
      const projectFile = path.join(workflows(target), 'local.js');
      const userFile = path.join(Storage.getUserWorkflowsDir(), 'user.js');
      const extensionFile = path.join(base, 'extension', 'check.js');
      await put(projectFile, 'return 1;');
      await put(userFile, 'return 2;');
      await put(extensionFile, 'return 3;');
      const cfg = {
        ...config(),
        getActiveExtensions: () => [
          {
            workflows: [
              {
                name: 'audit:check',
                extensionName: 'audit',
                description: 'Check',
                scriptPath: extensionFile,
              },
            ],
          },
        ],
      } as unknown as Config;
      const generated = await persistInlineWorkflowScript(
        cfg,
        'wf_ab1234',
        'return 4;',
      );
      const unavailable =
        brokenScope === 'project'
          ? workflows(target)
          : Storage.getUserWorkflowsDir();
      const original = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation(((file, ...args) =>
        String(file) === unavailable
          ? Promise.reject(
              Object.assign(new Error('root EACCES'), { code: 'EACCES' }),
            )
          : original(file, ...args)) as typeof fs.lstat);
      const independent = brokenScope === 'project' ? userFile : projectFile;
      expect(
        (await resolveSavedWorkflowScript({ scriptPath: independent }, cfg))
          .script,
      ).toBe(brokenScope === 'project' ? 'return 2;' : 'return 1;');
      expect(
        (await resolveSavedWorkflowScript({ scriptPath: generated! }, cfg))
          .script,
      ).toBe('return 4;');
      expect(
        (await resolveSavedWorkflowScript({ scriptPath: extensionFile }, cfg))
          .script,
      ).toBe('return 3;');
      expect(
        (await resolveSavedWorkflowScript('audit:check', cfg)).script,
      ).toBe('return 3;');
      expect(
        (await listSavedWorkflows(cfg)).map((entry) => entry.name),
      ).toEqual(['audit:check', ...(brokenScope === 'user' ? ['local'] : [])]);
      await expect(
        resolveSavedWorkflowScript(
          brokenScope === 'project' ? 'local' : 'user',
          cfg,
        ),
      ).rejects.toThrow('root EACCES');
    },
  );

  it('R1-2: an unverifiable save target is intentionally refused before mkdir', async () => {
    await fs.rm(target, { recursive: true });
    const mkdir = vi.spyOn(fs, 'mkdir');
    await expect(
      saveWorkflowScript(config(), {
        name: 'saved',
        scope: 'project',
        script: 'return 1;',
      }),
    ).rejects.toThrow(
      `refusing to save into an unverifiable project target: '${target}'`,
    );
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('R1-3: Windows marker matching preserves Unicode owner and filename offsets', async () => {
    repo = path.join(base, 'İİ', 'repo');
    target = path.join(repo, 'packages', 'a');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(repo, '.git'));
    const scriptPath = path.join(workflows(repo), 'shared.js');
    await put(scriptPath, 'return 6;');
    const cfg = config();
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    try {
      expect(
        (await resolveSavedWorkflowScript({ scriptPath }, cfg)).script,
      ).toBe('return 6;');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    'R1-11: an ancestor coinciding with user scope keeps user identity with parent alias=%s',
    async (alias) => {
      const userRepo = alias ? path.join(base, 'repo-alias') : repo;
      if (alias) await symlinkDir(repo, userRepo);
      process.env['QWEN_HOME'] = path.join(userRepo, '.qwen');
      const scriptPath = path.join(Storage.getUserWorkflowsDir(), 'global.js');
      await put(scriptPath, 'return 7;');
      const readdir = vi.spyOn(fs, 'readdir');
      expect(
        (await listSavedWorkflows(config())).find(
          (entry) => entry.name === 'global',
        ),
      ).toMatchObject({ scriptPath, source: 'user' });
      expect(
        readdir.mock.calls.filter(
          ([dir]) => String(dir) === Storage.getUserWorkflowsDir(),
        ),
      ).toHaveLength(1);
      expect(
        await resolveSavedWorkflowScript('global', config()),
      ).toMatchObject({
        scriptPath,
        source: 'user',
      });
      expect(
        await resolveSavedWorkflowScript({ scriptPath }, config()),
      ).toMatchObject({ scriptPath, source: 'user' });
    },
  );

  it('R1-19: an overlapping base file alias retains independent canonical base admission', async () => {
    target = path.join(workflows(repo), 'editor');
    const userFile = path.join(Storage.getUserWorkflowsDir(), 'allowed.js');
    await put(userFile, "return 'AUTHORIZED_USER';");
    const scriptPath = path.join(workflows(target), 'alias.js');
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.symlink(userFile, scriptPath);
    const ordinary = {
      ...config(),
      getWorkflowAncestorTrustProvider: () => undefined,
    } as unknown as Config;
    for (const cfg of [ordinary, config()]) {
      expect(
        await resolveSavedWorkflowScript({ scriptPath }, cfg),
      ).toMatchObject({
        scriptPath,
        script: "return 'AUTHORIZED_USER';",
        source: 'user',
      });
    }
  });

  it('R1-29: a refused project boundary is distinguished from considered and missing roots', async () => {
    const outside = path.join(base, 'outside', '.qwen');
    await writeWorkflow(path.join(outside, 'workflows'), 'hidden', 'return 9;');
    await symlinkDir(outside, path.join(target, '.qwen'));
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(target), 'hidden.js') },
        config(),
      ),
    ).rejects.toThrow(
      `refused roots: ${workflows(target)} (outside project target)`,
    );
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(target), 'hidden.js') },
        config(),
      ),
    ).rejects.not.toThrow(`checked: ${workflows(target)}`);
  });

  it('R1-19: an external file alias into an authorized base subtree retains path admission', async () => {
    const actual = path.join(workflows(target), 'nested', 'allowed.js');
    const alias = path.join(base, 'file-alias.js');
    await put(actual, 'return 11;');
    await fs.symlink(actual, alias);
    expect(
      (await resolveSavedWorkflowScript({ scriptPath: alias }, config()))
        .script,
    ).toBe('return 11;');
  });

  it('R1-19: an explicit base directory is refused before opening it as a script', async () => {
    const scriptPath = path.join(workflows(target), 'folder.js');
    await fs.mkdir(scriptPath, { recursive: true });
    const open = vi.spyOn(fs, 'open');
    await expect(
      resolveSavedWorkflowScript({ scriptPath }, config()),
    ).rejects.toThrow('not an ordinary file');
    expect(open).not.toHaveBeenCalled();
  });

  it('R1-19: a symlink replacing an eligible named file is refused before open', async () => {
    const near = path.join(workflows(path.dirname(target)), 'shared.js');
    const other = path.join(path.dirname(near), 'other.js');
    await put(near, "return 'NEAR';");
    await put(other, "return 'OTHER';");
    await writeWorkflow(workflows(repo), 'shared', "return 'FAR';");
    const original = fs.realpath.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'realpath').mockImplementation((async (file) => {
      const real = await original(file);
      if (String(file) === near && !swapped) {
        swapped = true;
        await fs.unlink(near);
        await fs.symlink(other, near);
      }
      return real;
    }) as typeof fs.realpath);
    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow('refusing symlinked workflow file');
  });

  it('R1-19: replacing a selected file with a different ordinary inode never runs the replacement or farther name', async () => {
    const near = path.join(workflows(path.dirname(target)), 'shared.js');
    const replacement = path.join(path.dirname(near), 'replacement.js');
    await put(near, "return 'NEAR';");
    await put(replacement, "return 'REPLACEMENT';");
    await writeWorkflow(workflows(repo), 'shared', "return 'FAR';");
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === near) await fs.rename(replacement, near);
      return original(file, flags, mode);
    });
    await expect(
      resolveSavedWorkflowScript('shared', config()),
    ).rejects.toThrow('changed while reading');
  });

  it('R1-28: an existing escaping project alias is rejected before mkdir creates external directories', async () => {
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await symlinkDir(outside, path.join(target, '.qwen'));
    const mkdir = vi.spyOn(fs, 'mkdir');
    await expect(
      saveWorkflowScript(config(), {
        name: 'saved',
        scope: 'project',
        script: 'return 12;',
      }),
    ).rejects.toThrow('outside the project target');
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('R1-32: a target .qwen ordinary file permits independent user discovery without widening read or write scope', async () => {
    await put(path.join(target, '.qwen'), 'ordinary file');
    const userPath = path.join(Storage.getUserWorkflowsDir(), 'user.js');
    await put(userPath, 'return 13;');
    expect(await listSavedWorkflows(config())).toEqual([
      { name: 'user', scriptPath: userPath, source: 'user' },
    ]);
    expect((await resolveSavedWorkflowScript('user', config())).script).toBe(
      'return 13;',
    );
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(target), 'hidden.js') },
        config(),
      ),
    ).rejects.toThrow();
    await expect(
      saveWorkflowScript(config(), {
        name: 'saved',
        scope: 'project',
        script: 'return 14;',
      }),
    ).rejects.toThrow();
  });

  it('R1-35: relinking an ancestor after its ordinary-directory probes cannot admit an external workflow tree', async () => {
    await fs.mkdir(workflows(repo), { recursive: true });
    const outside = path.join(base, 'outside');
    await writeWorkflow(workflows(outside), 'leak', "return 'EXTERNAL';");
    const original = fs.realpath.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'realpath').mockImplementation((async (file) => {
      if (String(file) === workflows(repo) && !swapped) {
        swapped = true;
        await fs.rename(repo, path.join(base, 'repo-original'));
        await fs.symlink(outside, repo, 'dir');
      }
      return original(file);
    }) as typeof fs.realpath);
    expect(await listSavedWorkflows(config())).toEqual([]);
    expect(swapped).toBe(true);
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(workflows(repo), 'leak.js') },
        config(),
      ),
    ).rejects.toThrow(OUTSIDE_ROOTS);
  });

  it('R03: persisted nested inline paths keep underscore run ids and no saved name', async () => {
    const cfg = config();
    const scriptPath = await persistInlineWorkflowScript(
      cfg,
      'wf_abcdef01',
      'return 7;',
    );
    expect(scriptPath).not.toBeNull();
    expect(
      await resolveSavedWorkflowScript({ scriptPath: scriptPath! }, cfg),
    ).toMatchObject({
      script: 'return 7;',
      name: 'wf_abcdef01',
    });
    expect(
      (await resolveSavedWorkflowScript({ scriptPath: scriptPath! }, cfg))
        .savedWorkflowName,
    ).toBeUndefined();
  });
});
