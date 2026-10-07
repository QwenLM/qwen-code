/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadExtensionWorkflows,
  MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS,
  MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES,
} from './workflow-extension.js';
import { computeWorkflowScriptDigest } from './workflow-saved.js';

const isWindows = process.platform === 'win32';

function workflowSource(name: string, extra = ''): string {
  return `export const meta = { name: '${name}', description: 'Runs ${name}'${extra} };\nreturn 1;\n`;
}

const long = '😀'.repeat(MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS + 10);

describe('loadExtensionWorkflows', () => {
  let base: string;
  let root: string;
  let outside: string;
  const owner = { name: 'gcp', displayName: 'Google Cloud' };

  beforeEach(async () => {
    base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ext-')),
    );
    root = path.join(base, 'ext');
    outside = path.join(base, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  async function write(rel: string, body: string): Promise<string> {
    const filePath = path.join(root, rel);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body, 'utf8');
    return filePath;
  }

  /** Write `workflows/<name>.js` declaring the same meta name. */
  const writeWorkflow = (name: string, extra?: string) =>
    write(`workflows/${name}.js`, workflowSource(name, extra));
  const load = (declared?: unknown, options?: { followSymlinks?: boolean }) =>
    loadExtensionWorkflows(root, owner, declared, options);
  const names = async (declared?: unknown) =>
    (await load(declared)).map((w) => w.name);

  it('returns nothing when the extension ships no workflows directory', async () => {
    expect(await load()).toEqual([]);
  });

  it('reads the default directory, qualified and sorted by name', async () => {
    await writeWorkflow('b-audit');
    await writeWorkflow('a-review', ", whenToUse: 'on review'");

    const workflows = await load();

    expect(workflows).toEqual([
      {
        name: 'gcp:a-review',
        extensionName: 'gcp',
        extensionDisplayName: 'Google Cloud',
        scriptPath: path.join(root, 'workflows', 'a-review.js'),
        description: 'Runs a-review',
        whenToUse: 'on review',
        contentDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      {
        name: 'gcp:b-audit',
        extensionName: 'gcp',
        extensionDisplayName: 'Google Cloud',
        scriptPath: path.join(root, 'workflows', 'b-audit.js'),
        description: 'Runs b-audit',
        contentDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
  });

  // Install consent compares this digest, so it has to move with the code
  // even when the meta block, and so the consent text, stays the same.
  it('records a content digest that follows the script code', async () => {
    const source = workflowSource('audit');
    await write('workflows/audit.js', source);
    const [first] = await load();
    expect(first?.contentDigest).toBe(computeWorkflowScriptDigest(source));

    await write('workflows/audit.js', source.replace('return 1;', 'return 2;'));
    const [second] = await load();
    expect(second?.description).toBe(first?.description);
    expect(second?.contentDigest).not.toBe(first?.contentDigest);
  });

  it('reads one directory level only', async () => {
    await writeWorkflow('top');
    await write('workflows/sub/nested.js', workflowSource('nested'));

    expect(await names()).toEqual(['gcp:top']);
  });

  it('registers the meta name independently of the file name', async () => {
    const scriptPath = await write(
      'workflows/01.Child.js',
      workflowSource('child'),
    );

    expect(await load()).toEqual([
      expect.objectContaining({ name: 'gcp:child', scriptPath }),
    ]);
  });

  it('skips non-.js files and meta names that are not legal workflow names', async () => {
    await writeWorkflow('ok');
    await write('workflows/notes.md', workflowSource('notes'));
    await write('workflows/bad.js', workflowSource('Bad'));
    await write('workflows/number.js', workflowSource('1x'));

    expect(await names()).toEqual(['gcp:ok']);
  });

  it.skipIf(isWindows)('skips a symlinked workflow file', async () => {
    await writeWorkflow('ok');
    const target = path.join(outside, 'secret.js');
    await fs.writeFile(target, workflowSource('secret'));
    await fs.symlink(target, path.join(root, 'workflows', 'secret.js'));

    expect(await names()).toEqual(['gcp:ok']);
  });

  it.skipIf(isWindows)('refuses a symlinked workflows directory', async () => {
    await fs.writeFile(path.join(outside, 'leak.js'), workflowSource('leak'));
    await fs.symlink(outside, path.join(root, 'workflows'));

    expect(await load()).toEqual([]);
  });

  it('refuses declared paths that resolve outside the extension', async () => {
    await fs.writeFile(path.join(outside, 'leak.js'), workflowSource('leak'));

    expect(await load('../outside')).toEqual([]);
    expect(await load([outside])).toEqual([]);
    expect(await load(path.join(outside, 'leak.js'))).toEqual([]);
  });

  it('accepts an absolute declared path inside the extension (as ${extensionPath} produces)', async () => {
    await write('flows/deploy.js', workflowSource('deploy'));

    expect(await names(path.join(root, 'flows'))).toEqual(['gcp:deploy']);
  });

  it('reads exactly the declared paths, not the default directory', async () => {
    await writeWorkflow('default');
    await write('flows/custom.js', workflowSource('custom'));
    await write('single/one.js', workflowSource('one'));

    expect(await names(['flows', 'single/one.js'])).toEqual([
      'gcp:custom',
      'gcp:one',
    ]);
    expect(await load([])).toEqual([]);
  });

  it('ignores a declared file that is not a .js file', async () => {
    await write('flows/readme.txt', 'not a workflow');

    expect(await load('flows/readme.txt')).toEqual([]);
  });

  it('skips a file over the size cap', async () => {
    await writeWorkflow('ok');
    await write(
      'workflows/huge.js',
      workflowSource('huge') +
        '//'.padEnd(MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES, 'x'),
    );

    expect(await names()).toEqual(['gcp:ok']);
  });

  it('skips scripts without a readable meta block and keeps their siblings', async () => {
    await writeWorkflow('ok');
    await write('workflows/no-meta.js', 'return 1;\n');
    await write(
      'workflows/computed.js',
      'export const meta = { name: "x", description: String(1) };\n',
    );
    await write(
      'workflows/no-description.js',
      "export const meta = { name: 'no-description' };\n",
    );

    expect(await names()).toEqual(['gcp:ok']);
  });

  it('keeps distinct meta names from files with the same basename', async () => {
    await write('first/same.js', workflowSource('same-first'));
    await write('second/same.js', workflowSource('same-second'));

    const workflows = await load(['first', 'second']);
    expect(workflows.map((workflow) => workflow.name)).toEqual([
      'gcp:same-first',
      'gcp:same-second',
    ]);
    expect(workflows[0].scriptPath).toBe(path.join(root, 'first', 'same.js'));
    expect(workflows[1].scriptPath).toBe(path.join(root, 'second', 'same.js'));
  });

  it('keeps the first file when two declared paths ship the same meta name', async () => {
    await write('first/same.js', workflowSource('shared'));
    await write('second/other.js', workflowSource('shared'));

    const workflows = await load(['first', 'second']);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe('gcp:shared');
    expect(workflows[0].scriptPath).toBe(path.join(root, 'first', 'same.js'));
  });

  it('ignores a malformed workflows value without throwing', async () => {
    await writeWorkflow('ok');

    expect(await load(42)).toEqual([]);
    expect(await load({ dir: 'x' })).toEqual([]);
    expect(await names(['', 7, 'workflows'])).toEqual(['gcp:ok']);
  });

  it('returns nothing for an extension name that cannot prefix a workflow name', async () => {
    await writeWorkflow('ok');

    expect(
      await loadExtensionWorkflows(root, { name: 'has space' }, undefined),
    ).toEqual([]);
  });

  it('returns nothing rather than throwing for a missing extension root', async () => {
    expect(
      await loadExtensionWorkflows(path.join(base, 'missing'), owner, 'flows'),
    ).toEqual([]);
  });

  it.skipIf(isWindows || process.getuid?.() === 0)(
    'keeps later declared paths when an earlier one cannot be read',
    async () => {
      await write('good/x.js', workflowSource('x'));
      await fs.mkdir(path.join(root, 'bad'));
      await fs.chmod(path.join(root, 'bad'), 0o000);
      try {
        expect(await names(['bad', 'good'])).toEqual(['gcp:x']);
      } finally {
        await fs.chmod(path.join(root, 'bad'), 0o755);
      }
    },
  );

  it('shortens an overlong description without splitting a character', async () => {
    await write(
      'workflows/long.js',
      `export const meta = { name: 'long', description: '${long}' };\nreturn 1;\n`,
    );

    const [workflow] = await load();
    const chars = Array.from(workflow.description);
    expect(chars).toHaveLength(MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS);
    expect(chars.at(-1)).toBe('…');
    expect(chars.slice(0, -1).every((c) => c === '😀')).toBe(true);
  });

  // `whenToUse` decides whether the model may start the workflow on its own,
  // so a blank one must read as absent rather than as an empty condition.
  it('keeps whenToUse only when it says something, shortened like the description', async () => {
    await writeWorkflow('blank', ", whenToUse: '   '");
    await writeWorkflow('long', `, whenToUse: '  ${long}  '`);
    await writeWorkflow('none');

    const byName = new Map((await load()).map((w) => [w.name, w]));
    expect('whenToUse' in byName.get('gcp:blank')!).toBe(false);
    expect('whenToUse' in byName.get('gcp:none')!).toBe(false);
    const chars = Array.from(byName.get('gcp:long')!.whenToUse!);
    expect(chars).toHaveLength(MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS);
    expect(chars[0]).toBe('😀');
    expect(chars.at(-1)).toBe('…');
  });

  it.skipIf(isWindows)(
    'follows symlinks the way an install copy does when asked to',
    async () => {
      await write('shared/linked.js', workflowSource('linked'));
      await fs.writeFile(
        path.join(outside, 'external.js'),
        workflowSource('external'),
      );
      await fs.mkdir(path.join(root, 'workflows'));
      await fs.symlink(
        path.join(root, 'shared', 'linked.js'),
        path.join(root, 'workflows', 'linked.js'),
      );
      await fs.symlink(
        path.join(outside, 'external.js'),
        path.join(root, 'workflows', 'external.js'),
      );

      expect(await load()).toEqual([]);
      const copied = await load(undefined, { followSymlinks: true });
      expect(copied.map((w) => w.name)).toEqual(['gcp:external', 'gcp:linked']);
      expect(copied[1].scriptPath).toBe(
        path.join(root, 'workflows', 'linked.js'),
      );
      // Containment is still checked on the path as spelled.
      expect(await load('../outside', { followSymlinks: true })).toEqual([]);
    },
  );
});
