/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAutoMemoryTopicDocument } from '@qwen-code/qwen-code-core/memory/scan.js';
import { runCodexImport } from './codex-import.js';

vi.mock('../../serve/fast-path-settings.js', () => ({
  loadServeFastPathSettings: vi.fn(() => ({})),
}));

let temporary: string;
let source: string;
let runtime: string;
let project: string;
const handbook = (
  content = 'Check the deployment dashboard before declaring a release complete.',
) =>
  `# Task Group: Atlas releases\n\nscope: release acceptance\napplies_to: cwd=/source/atlas; reuse_rule=verify current state\n\n## Task 1: Release\n\n### rollout_summary_files\n\n- rollout_summaries/example.md (cwd=/source/atlas, updated_at=2025-04-01T10:00:00Z)\n\n## Reusable knowledge\n\n- ${content} [Task 1]\n`;
const native = (name: string, content: string) =>
  `---\nname: ${name}\ndescription: Synthetic existing memory\ntype: project\n---\n${content}\n`;
const options = () => ({ source, projectMap: { '/source/atlas': project } });
const preview = () => runCodexImport({ ...options(), dryRun: true });
async function files(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { recursive: true })).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-import-test-'));
  source = path.join(temporary, 'source');
  runtime = path.join(temporary, 'runtime');
  project = path.join(temporary, 'atlas');
  await fs.mkdir(source);
  await fs.mkdir(project);
  await fs.writeFile(path.join(source, 'MEMORY.md'), handbook());
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', runtime);
  vi.stubEnv('QWEN_RUNTIME_DIR', runtime);
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '');
  vi.stubEnv('QWEN_CODE_MEMORY_PROJECT_SCOPE', 'workspace');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('Codex import', () => {
  it('repairs an interrupted index write on the same selected import without rewriting its topic', async () => {
    const entry = (await preview()).entries[0];
    const root = entry.targetRoot!;
    const index = path.join(root, 'MEMORY.md');
    await fs.mkdir(index, { recursive: true });
    await expect(
      runCodexImport({ ...options(), selectedIds: [entry.id] }),
    ).rejects.toThrow();
    const topic = path.join(root, 'codex-' + entry.id + '.md');
    const content = await fs.readFile(topic, 'utf8');
    const mtime = (await fs.stat(topic)).mtimeMs;
    const ledger = await fs.readFile(
      path.join(root, '.codex-import.json'),
      'utf8',
    );
    await fs.rmdir(index);
    await runCodexImport({
      ...options(),
      selectedIds: [entry.id],
      dryRun: true,
    });
    await expect(fs.stat(index)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await runCodexImport({
      ...options(),
      selectedIds: [entry.id],
    });
    expect(retry.entries[0].status).toBe('previously-imported');
    expect(await fs.readFile(index, 'utf8')).toContain(
      'codex-' + entry.id + '.md',
    );
    expect(await fs.readFile(topic, 'utf8')).toBe(content);
    expect((await fs.stat(topic)).mtimeMs).toBe(mtime);
    expect(
      await fs.readFile(path.join(root, '.codex-import.json'), 'utf8'),
    ).toBe(ledger);
    await expect(
      fs.stat(path.join(root, '.codex-import.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('previews by default and with selected IDs without creating destination files', async () => {
    const before = await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8');
    const result = await runCodexImport(options());
    expect(result.dryRun).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('ready');
    await runCodexImport({
      ...options(),
      selectedIds: [result.entries[0].id],
      dryRun: true,
    });
    expect(await files(runtime)).toEqual([]);
    expect(await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8')).toBe(
      before,
    );
  });

  async function gitProject() {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
    git(project, 'init');
    git(
      project,
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const first = path.join(temporary, 'atlas-one');
    const second = path.join(temporary, 'atlas-two');
    git(project, 'worktree', 'add', '-b', 'one', first);
    git(project, 'worktree', 'add', '--detach', second);
    return { git, first, second };
  }

  it('normalizes main and linked worktree subdirectories before duplicate and conflict checks', async () => {
    const { first, second } = await gitProject();
    const nested = path.join(second, 'nested');
    await fs.mkdir(nested);
    const before = (await preview()).entries[0];
    for (const target of [project, first, nested]) {
      const result = await runCodexImport({
        source,
        dryRun: true,
        projectMap: { '/source/atlas': target },
      });
      expect(result.entries[0]).toMatchObject({
        id: before.id,
        content: before.content,
        sourceProject: '/source/atlas',
        resolvedProject: await fs.realpath(project),
        targetRoot: before.targetRoot,
      });
    }
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      [project, first, second]
        .map((cwd, index) =>
          handbook()
            .replaceAll('/source/atlas', cwd)
            .replaceAll('Atlas releases', `Release group ${index}`),
        )
        .join('\n'),
    );
    const combined = await runCodexImport({ source, dryRun: true });
    expect(combined.entries.map((entry) => entry.status)).toEqual([
      'ready',
      'duplicate',
      'duplicate',
    ]);
    expect(
      new Set(combined.entries.map((entry) => entry.targetRoot)).size,
    ).toBe(1);
    expect(combined.entries.map((entry) => entry.sourceProject)).toEqual([
      project,
      first,
      second,
    ]);
    expect(await files(runtime)).toEqual([]);
    const root = combined.entries[0].targetRoot!;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'existing.md'),
      native(
        combined.entries[1].name,
        'Different existing main-project guidance.',
      ),
    );
    const conflict = await runCodexImport({ source, dryRun: true });
    expect(conflict.entries[1].status).toBe('conflict');
    expect(await fs.readFile(path.join(root, 'existing.md'), 'utf8')).toContain(
      'Different existing main-project guidance.',
    );
  });

  it('keeps separate clones, submodules, and separate Git directories in their own projects', async () => {
    const { git } = await gitProject();
    const clone = path.join(temporary, 'clone');
    git(temporary, 'clone', project, clone);
    const submodule = path.join(project, 'module');
    git(
      project,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      clone,
      'module',
    );
    const separate = path.join(temporary, 'separate');
    git(
      temporary,
      'init',
      '--separate-git-dir',
      path.join(temporary, 'git-store'),
      separate,
    );
    const roots = [];
    for (const target of [project, clone, submodule, separate]) {
      const result = await runCodexImport({
        source,
        dryRun: true,
        projectMap: { '/source/atlas': target },
      });
      expect(result.entries[0].resolvedProject).toBe(await fs.realpath(target));
      roots.push(result.entries[0].targetRoot);
    }
    expect(new Set(roots).size).toBe(4);
    expect(await files(runtime)).toEqual([]);
  });

  it.each([
    'backlink',
    'commondir',
    'gitfile',
    'bare',
    'worktree',
    'include',
    'config.worktree',
    'continuation',
  ])(
    'marks unverifiable %s metadata as global fallback and permits an exact main-project mapping',
    async (kind) => {
      const { first } = await gitProject();
      const admin = path.join(project, '.git', 'worktrees', 'atlas-one');
      if (kind === 'backlink')
        await fs.writeFile(
          path.join(admin, 'gitdir'),
          path.join(project, '.git'),
        );
      else if (kind === 'commondir')
        await fs.writeFile(path.join(admin, 'commondir'), '../../../missing');
      else if (kind === 'gitfile')
        await fs.writeFile(path.join(first, '.git'), 'not a git pointer');
      else if (kind === 'config.worktree')
        await fs.writeFile(path.join(admin, kind), '[core]\nbare = false\n');
      else
        await fs.appendFile(
          path.join(project, '.git', 'config'),
          kind === 'include'
            ? '\n[include]\npath = elsewhere\n'
            : kind === 'continuation'
              ? '\n[core]\nbare = false \\\n'
              : `\n[core]\n${kind} = ${kind === 'bare' ? 'true' : project}\n`,
        );
      await fs.writeFile(
        path.join(source, 'MEMORY.md'),
        handbook().replaceAll('/source/atlas', first),
      );
      const fallback = await runCodexImport({ source, dryRun: true });
      expect(fallback.entries[0]).toMatchObject({
        status: 'ready',
        scope: 'user',
        sourceProject: first,
      });
      expect(fallback.entries[0].scopeReason).toContain(
        'Cannot verify the Git main checkout',
      );
      expect(fallback.entries[0].targetRoot).toBe(
        path.join(await fs.realpath(temporary), 'runtime', 'memories'),
      );
      expect(fallback.entries[0].resolvedProject).toBeUndefined();
      const mapped = await runCodexImport({
        source,
        dryRun: true,
        projectMap: { [first]: project },
      });
      expect(mapped.entries[0]).toMatchObject({
        status: 'ready',
        scope: 'project',
        resolvedProject: await fs.realpath(project),
      });
      expect(await files(runtime)).toEqual([]);
    },
  );

  it('uses global fallback for a bare repository and its linked worktree', async () => {
    const { git } = await gitProject();
    const bare = path.join(temporary, 'bare.git');
    git(temporary, 'clone', '--bare', project, bare);
    const linked = path.join(temporary, 'bare-linked');
    git(bare, 'worktree', 'add', '--detach', linked);
    for (const target of [bare, linked]) {
      const result = await runCodexImport({
        source,
        dryRun: true,
        projectMap: { '/source/atlas': target },
      });
      expect(result.entries[0]).toMatchObject({
        status: 'ready',
        scope: 'user',
      });
      expect(result.entries[0].scopeReason).toBeTruthy();
      expect(result.entries[0].resolvedProject).toBeUndefined();
      expect(result.entries[0].targetRoot).toBe(
        path.join(await fs.realpath(temporary), 'runtime', 'memories'),
      );
    }
  });

  it('previews missing projects globally without assigning cwd or implicitly importing', async () => {
    const result = await runCodexImport({ source });
    const entry = result.entries[0];
    expect(result.dryRun).toBe(true);
    expect(entry).toMatchObject({
      status: 'ready',
      scope: 'user',
      sourceProject: '/source/atlas',
    });
    expect(entry.scopeReason).toContain(
      'Project target directory does not exist',
    );
    expect(entry.reason).toBeUndefined();
    expect(entry.resolvedProject).toBeUndefined();
    expect(entry.targetRoot).toBe(
      path.join(await fs.realpath(temporary), 'runtime', 'memories'),
    );
    await runCodexImport({ source, selectedIds: [entry.id], dryRun: true });
    expect(await files(runtime)).toEqual([]);
    await runCodexImport({ source, selectedIds: [entry.id] });
    const target = path.join(entry.targetRoot!, `codex-${entry.id}.md`);
    expect(
      parseAutoMemoryTopicDocument(target, await fs.readFile(target, 'utf8'))
        ?.body,
    ).toBe(entry.content);
    expect(await files(project)).toEqual([]);
  });

  it.each([
    '',
    'applies_to: cwd=/source/*',
    'applies_to: cwd=/source/atlas and /source/borealis',
    'applies_to: cwd=relative/project',
    'applies_to: cwd=/source/atlas with unknown explanation',
  ])(
    'keeps ownership failure separate from user-memory deduplication and conflicts: %s',
    async (scope) => {
      await fs.writeFile(
        path.join(source, 'MEMORY.md'),
        `# Task Group: Atlas
${scope}
## Reusable knowledge
- Shared synthetic guidance.
`,
      );
      await fs.writeFile(
        path.join(source, 'memory_summary.md'),
        '# User preferences\n- Shared synthetic guidance.\n',
      );
      const result = await runCodexImport({ source, dryRun: true });
      const entry = result.entries.find((entry) => entry.scopeReason)!;
      expect(entry).toMatchObject({ status: 'duplicate', scope: 'user' });
      expect(
        new Set(result.entries.map((entry) => entry.targetRoot)).size,
      ).toBe(1);
      expect(entry.scopeReason).toBeTruthy();
      expect(entry.reason).toContain('Duplicate of another candidate');
      expect(await files(runtime)).toEqual([]);
      await fs.unlink(path.join(source, 'memory_summary.md'));
      await fs.mkdir(entry.targetRoot!, { recursive: true });
      const existing = path.join(entry.targetRoot!, 'native.md');
      await fs.writeFile(
        existing,
        native('Existing global guidance', entry.content),
      );
      const duplicate = (await runCodexImport({ source })).entries[0];
      expect(duplicate).toMatchObject({
        status: 'duplicate',
        scopeReason: entry.scopeReason,
      });
      await fs.writeFile(
        existing,
        native(entry.name, 'Different native global guidance.'),
      );
      const conflict = (await runCodexImport({ source })).entries[0];
      expect(conflict).toMatchObject({
        status: 'conflict',
        scope: 'user',
        scopeReason: entry.scopeReason,
      });
      expect(conflict.reason).not.toBe(entry.scopeReason);
      await expect(
        runCodexImport({ source, selectedIds: [entry.id] }),
      ).rejects.toThrow('conflict');
      expect(await fs.readFile(existing, 'utf8')).toContain(
        'Different native global guidance.',
      );
      expect(await files(entry.targetRoot!)).toEqual(['native.md']);
    },
  );

  it('resolves annotated cwd through project mapping without changing identity or writing files', async () => {
    const plain = (await preview()).entries[0];
    const annotated = handbook().replace(
      'cwd=/source/atlas;',
      'cwd=/source/atlas with worktree=/tmp/atlas-feature;',
    );
    await fs.writeFile(path.join(source, 'MEMORY.md'), annotated);
    const result = await preview();
    expect(result.entries[0]).toEqual(plain);
    expect(await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8')).toBe(
      annotated,
    );
    expect(await files(runtime)).toEqual([]);
  });

  it('distinguishes missing directories, non-directory targets, and parser errors', async () => {
    const missing = await runCodexImport({ source, dryRun: true });
    expect(missing.entries[0].scopeReason).toContain(
      'Project target directory does not exist',
    );
    const notDirectory = await runCodexImport({
      source,
      dryRun: true,
      projectMap: { '/source/atlas': path.join(source, 'MEMORY.md') },
    });
    expect(notDirectory.entries[0].scopeReason).toContain(
      'Project target is not a directory',
    );
    const invalidParent = await runCodexImport({
      source,
      dryRun: true,
      projectMap: { '/source/atlas': path.join(source, 'MEMORY.md', 'child') },
    });
    expect(invalidParent.entries[0].scopeReason).toContain(
      'Project target is not a directory',
    );
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook().replace(
        'applies_to: cwd=/source/atlas; reuse_rule=verify current state',
        'applies_to: cwd=/source/atlas or /source/borealis',
      ),
    );
    const ambiguous = await preview();
    expect(ambiguous.entries[0].scopeReason).toContain(
      'Multiple or alternative project scopes',
    );
    for (const result of [missing, notDirectory, invalidParent, ambiguous]) {
      expect(result.entries[0]).toMatchObject({
        status: 'ready',
        scope: 'user',
      });
      expect(result.entries[0].scopeReason).toBeTruthy();
      expect(result.entries[0].resolvedProject).toBeUndefined();
      expect(result.entries[0].targetRoot).toBe(
        path.join(await fs.realpath(temporary), 'runtime', 'memories'),
      );
    }
    expect(await files(runtime)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'explains paths from a different platform without suggesting an unusable mapping',
    async () => {
      await fs.writeFile(
        path.join(source, 'MEMORY.md'),
        handbook().replace('cwd=/source/atlas;', 'cwd=C:\\work\\atlas;'),
      );
      const result = await runCodexImport({ source, dryRun: true });
      expect(result.entries[0]).toMatchObject({
        status: 'ready',
        scope: 'user',
        sourceProject: 'C:\\work\\atlas',
        scopeReason:
          'Project path is not absolute on this platform. Use a local absolute cwd in a reviewed source export.',
      });
      expect(await files(runtime)).toEqual([]);
    },
  );

  it('imports only selected entries into native format and preserves source time', async () => {
    await fs.writeFile(
      path.join(source, 'memory_summary.md'),
      '# User preferences\n\n- Use concise answers.\n',
    );
    const result = await preview();
    const entry = result.entries.find((entry) => entry.sourceProject)!;
    const applied = await runCodexImport({
      ...options(),
      selectedIds: [entry.id],
    });
    expect(
      applied.entries.find((candidate) => candidate.id === entry.id)?.status,
    ).toBe('imported');
    const target = path.join(entry.targetRoot!, `codex-${entry.id}.md`);
    const text = await fs.readFile(target, 'utf8');
    expect(parseAutoMemoryTopicDocument(target, text)?.body).toBe(
      entry.content,
    );
    expect((await fs.stat(target)).mtime.toISOString()).toBe(
      '2025-04-01T10:00:00.000Z',
    );
    expect(
      await fs.readFile(path.join(entry.targetRoot!, 'MEMORY.md'), 'utf8'),
    ).toContain(`codex-${entry.id}.md`);
    expect(await files(path.join(runtime, 'memories'))).toEqual([]);
    expect(await fs.readFile(path.join(source, 'MEMORY.md'), 'utf8')).toBe(
      handbook(),
    );
  });

  it('quotes free text so YAML punctuation remains readable by native memory', async () => {
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Deploy: use the staging dashboard before production.'),
    );
    const entry = (await preview()).entries[0];
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    const target = path.join(entry.targetRoot!, `codex-${entry.id}.md`);
    const parsed = parseAutoMemoryTopicDocument(
      target,
      await fs.readFile(target, 'utf8'),
    );
    expect(parsed?.title).toBe(entry.name);
    expect(parsed?.body).toBe(entry.content);
    expect(
      await fs.readFile(path.join(entry.targetRoot!, 'MEMORY.md'), 'utf8'),
    ).toContain(`codex-${entry.id}.md`);
  });

  it('keeps global and project memories in separate native roots', async () => {
    await fs.writeFile(
      path.join(source, 'memory_summary.md'),
      '# User preferences\n\n- Use concise answers.\n',
    );
    const result = await preview();
    expect(new Set(result.entries.map((entry) => entry.targetRoot)).size).toBe(
      2,
    );
    const entry = result.entries.find((entry) => entry.scope === 'user')!;
    expect(entry.targetRoot).toBe(
      path.join(await fs.realpath(temporary), 'runtime', 'memories'),
    );
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    expect(
      (await files(runtime)).filter((file) => file.endsWith('.md')),
    ).toHaveLength(2);
  });

  it.each([false, true])(
    'keeps a surviving entry identity after a predecessor is removed (imported: %s)',
    async (importBoth) => {
      await fs.writeFile(
        path.join(source, 'MEMORY.md'),
        handbook('Synthetic Alpha.\n- Synthetic Beta.'),
      );
      const [alpha, beta] = (await preview()).entries;
      await runCodexImport({
        ...options(),
        selectedIds: importBoth ? [alpha.id, beta.id] : [alpha.id],
      });
      const original = await fs.readFile(
        path.join(alpha.targetRoot!, `codex-${alpha.id}.md`),
        'utf8',
      );
      await fs.writeFile(
        path.join(source, 'MEMORY.md'),
        handbook('Synthetic Beta.'),
      );
      const result = (await preview()).entries[0];
      expect(result.id).toBe(beta.id);
      expect(result.status).toBe(importBoth ? 'previously-imported' : 'ready');
      await runCodexImport({ ...options(), selectedIds: [result.id] });
      expect(
        await fs.readFile(
          path.join(beta.targetRoot!, `codex-${beta.id}.md`),
          'utf8',
        ),
      ).toContain('Synthetic Beta.');
      expect(
        await fs.readFile(
          path.join(alpha.targetRoot!, `codex-${alpha.id}.md`),
          'utf8',
        ),
      ).toBe(original);
    },
  );

  it('preserves forgotten and edited documents when source entries swap', async () => {
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic Alpha.\n- Synthetic Beta.'),
    );
    const [alpha, beta] = (await preview()).entries;
    await runCodexImport({ ...options(), selectedIds: [alpha.id, beta.id] });
    await fs.unlink(path.join(alpha.targetRoot!, `codex-${alpha.id}.md`));
    await fs.appendFile(
      path.join(beta.targetRoot!, `codex-${beta.id}.md`),
      '\nQwen correction.',
    );
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic Beta.\n- Synthetic Alpha.'),
    );
    const entries = (await preview()).entries;
    expect(entries.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: beta.id, status: 'conflict' },
      { id: alpha.id, status: 'previously-imported' },
    ]);
  });

  it('keeps unknown moved content conservative without assigning one ID twice', async () => {
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic Alpha.\n- Synthetic Beta.'),
    );
    const [alpha] = (await preview()).entries;
    await runCodexImport({ ...options(), selectedIds: [alpha.id] });
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic New.\n- Synthetic Alpha.\n- Synthetic Beta.'),
    );
    const entries = (await preview()).entries;
    expect(new Set(entries.map(({ id }) => id)).size).toBe(3);
    expect(entries.map(({ status }) => status)).toEqual([
      'conflict',
      'previously-imported',
      'ready',
    ]);
  });

  it('refuses ambiguous identity reuse across project destinations', async () => {
    const otherProject = path.join(temporary, 'borealis');
    await fs.mkdir(otherProject);
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic Alpha.\n- Synthetic Other.'),
    );
    const [alpha, other] = (await preview()).entries;
    await runCodexImport({ ...options(), selectedIds: [other.id] });
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Synthetic New.').replaceAll(
        '/source/atlas',
        '/source/borealis',
      ) +
        handbook('Synthetic Alpha.').replace(
          'Task Group: Atlas releases',
          'Task Group: Moved',
        ),
    );
    const mapped = {
      source,
      projectMap: {
        '/source/atlas': project,
        '/source/borealis': otherProject,
      },
    };
    const result = await runCodexImport({ ...mapped, dryRun: true });
    expect(new Set(result.entries.map(({ id }) => id)).size).toBe(2);
    expect(result.entries.map(({ status }) => status)).toEqual([
      'conflict',
      'conflict',
    ]);
    await expect(
      runCodexImport({ ...mapped, selectedIds: [result.entries[0].id] }),
    ).rejects.toThrow('conflict');
    expect(await files(result.entries[0].targetRoot!)).toEqual([]);
    expect(await files(alpha.targetRoot!)).not.toContain(
      `codex-${alpha.id}.md`,
    );
  });

  it('rejects unsafe candidate identity keys from a ledger', async () => {
    const entry = (await preview()).entries[0];
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    const ledgerPath = path.join(entry.targetRoot!, '.codex-import.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    ledger.candidates['../../unsafe'] = ledger.candidates[entry.id];
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    await expect(preview()).rejects.toThrow('Invalid Codex import ledger');
  });

  it('does not duplicate imports or resurrect forgotten content even if source changes', async () => {
    const entry = (await preview()).entries[0];
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    expect((await preview()).entries[0].status).toBe('previously-imported');
    await fs.unlink(path.join(entry.targetRoot!, `codex-${entry.id}.md`));
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Use the replacement deployment dashboard.'),
    );
    const retry = await runCodexImport({
      ...options(),
      selectedIds: [entry.id],
    });
    expect(retry.entries[0].status).toBe('previously-imported');
    expect(await files(entry.targetRoot!)).not.toContain(
      `codex-${entry.id}.md`,
    );
  });

  it('conflicts when source changes and preserves the previously imported document', async () => {
    const entry = (await preview()).entries[0];
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    const target = path.join(entry.targetRoot!, `codex-${entry.id}.md`);
    const before = await fs.readFile(target, 'utf8');
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook('Use a new dashboard instead.'),
    );
    expect((await preview()).entries[0].status).toBe('conflict');
    await expect(
      runCodexImport({ ...options(), selectedIds: [entry.id] }),
    ).rejects.toThrow('conflict');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('does not overwrite a Qwen edit', async () => {
    const entry = (await preview()).entries[0];
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    const target = path.join(entry.targetRoot!, `codex-${entry.id}.md`);
    await fs.appendFile(target, '\nA later correction by Qwen.\n');
    expect((await preview()).entries[0].status).toBe('conflict');
    await expect(
      runCodexImport({ ...options(), selectedIds: [entry.id] }),
    ).rejects.toThrow('conflict');
    expect(await fs.readFile(target, 'utf8')).toContain('later correction');
  });

  it('keeps repository-local documents out of private deduplication and index generation', async () => {
    const entry = (await preview()).entries[0];
    const localRoot = path.join(project, '.qwen', 'memory');
    await fs.mkdir(localRoot, { recursive: true });
    await fs.writeFile(
      path.join(localRoot, 'repo-only.md'),
      native(entry.name, entry.content),
    );
    expect((await preview()).entries[0].status).toBe('ready');
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    const index = await fs.readFile(
      path.join(entry.targetRoot!, 'MEMORY.md'),
      'utf8',
    );
    expect(index).toContain(`codex-${entry.id}.md`);
    expect(index).not.toContain('repo-only.md');
  });

  it('finds duplicates beyond the normal 200-document index cap', async () => {
    const entry = (await preview()).entries[0];
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        fs.writeFile(
          path.join(entry.targetRoot!, `note-${index}.md`),
          native(`Note ${index}`, `Synthetic fact ${index}.`),
        ),
      ),
    );
    await fs.writeFile(
      path.join(entry.targetRoot!, 'old.md'),
      native('Existing equivalent', entry.content.replaceAll(' ', '  ')),
    );
    await fs.utimes(
      path.join(entry.targetRoot!, 'old.md'),
      new Date(0),
      new Date(0),
    );
    expect((await preview()).entries[0].status).toBe('duplicate');
  });

  it('rejects an entire selection with a same-title conflict', async () => {
    await fs.writeFile(
      path.join(source, 'memory_summary.md'),
      '# User preferences\n\n- Use concise answers.\n',
    );
    const result = await preview();
    const entry = result.entries.find((entry) => entry.sourceProject)!;
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    await fs.writeFile(
      path.join(entry.targetRoot!, 'existing.md'),
      native(entry.name, 'Different existing content.'),
    );
    await expect(
      runCodexImport({
        ...options(),
        selectedIds: result.entries.map((entry) => entry.id),
      }),
    ).rejects.toThrow('conflict');
    expect(await files(path.join(runtime, 'memories'))).toEqual([]);
    expect(await files(entry.targetRoot!)).toEqual(['existing.md']);
  });

  it('requires explicit review of unchanged supplemental notes before applying', async () => {
    const notes = path.join(source, 'extensions/ad_hoc/notes');
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(
      path.join(notes, 'correction.md'),
      'Delete the obsolete release advice.',
    );
    const result = await preview();
    const selectedIds = [result.entries[0].id];
    expect(result.reviewNotes[0].content).toContain('Delete');
    await expect(runCodexImport({ ...options(), selectedIds })).rejects.toThrow(
      '--review-source',
    );
    expect(await files(runtime)).toEqual([]);
    await fs.appendFile(
      path.join(notes, 'correction.md'),
      '\nAnother correction.',
    );
    await expect(
      runCodexImport({
        ...options(),
        selectedIds,
        reviewedSource: result.sourceDigest,
      }),
    ).rejects.toThrow('--review-source');
    const reviewed = await preview();
    const applied = await runCodexImport({
      ...options(),
      selectedIds,
      reviewedSource: reviewed.sourceDigest,
    });
    expect(applied.entries[0].status).toBe('imported');
  });

  it.each(['content', 'note-added', 'note-removed'])(
    'refuses a source changed after interactive review before creating memory files: %s',
    async (change) => {
      const notes = path.join(source, 'extensions/ad_hoc/notes');
      const note = path.join(notes, 'amendment.md');
      if (change === 'note-removed') {
        await fs.mkdir(notes, { recursive: true });
        await fs.writeFile(note, 'Review synthetic amendment.');
      }
      const reviewed = await preview();
      if (change === 'content')
        await fs.writeFile(
          path.join(source, 'MEMORY.md'),
          handbook('Changed synthetic guidance.'),
        );
      else if (change === 'note-added') {
        await fs.mkdir(notes, { recursive: true });
        await fs.writeFile(note, 'New synthetic amendment.');
      } else await fs.unlink(note);
      await expect(
        runCodexImport({
          ...options(),
          selectedIds: [reviewed.entries[0].id],
          reviewedSource: reviewed.sourceDigest,
        }),
      ).rejects.toThrow('Source changed since preview');
      expect(await files(runtime)).toEqual([]);
    },
  );

  it('blocks known credentials without echoing them in the preview', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook(`Use token ${secret}.`),
    );
    const result = await runCodexImport({ source, dryRun: true });
    expect(result.entries[0].status).toBe('blocked');
    expect(result.entries[0].scopeReason).toBeUndefined();
    expect(result.entries[0].targetRoot).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await files(runtime)).toEqual([]);
  });

  it('refuses local and checkout destinations and malformed ledgers', async () => {
    vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '1');
    await expect(preview()).rejects.toThrow('repository-local');
    vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '');
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', path.join(project, '.qwen'));
    await expect(preview()).rejects.toThrow('private');
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', runtime);
    const entry = (await preview()).entries[0];
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    await fs.writeFile(
      path.join(entry.targetRoot!, '.codex-import.json'),
      '{"version":2,"records":{}}',
    );
    await expect(preview()).rejects.toThrow('Invalid Codex import ledger');
  });

  it('refuses symlinked source and ledger files', async () => {
    const original = path.join(source, 'MEMORY.md');
    await fs.rename(original, path.join(source, 'other.md'));
    await fs.symlink(path.join(source, 'other.md'), original);
    await expect(preview()).rejects.toThrow();
    await fs.unlink(original);
    await fs.rename(path.join(source, 'other.md'), original);
    const entry = (await preview()).entries[0];
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    await fs.writeFile(
      path.join(temporary, 'ledger.json'),
      '{"version":1,"records":{}}',
    );
    await fs.symlink(
      path.join(temporary, 'ledger.json'),
      path.join(entry.targetRoot!, '.codex-import.json'),
    );
    await expect(preview()).rejects.toThrow();
  });

  it('imports a selected duplicate candidate even when its earlier twin is unselected', async () => {
    await fs.writeFile(
      path.join(source, 'MEMORY.md'),
      handbook() +
        '\n- Check the deployment dashboard before declaring a release complete. [Task 1]\n',
    );
    const candidates = (await preview()).entries;
    expect(candidates).toHaveLength(2);
    expect(candidates[1].status).toBe('duplicate');
    const result = await runCodexImport({
      ...options(),
      selectedIds: [candidates[1].id],
    });
    expect(
      result.entries.find((entry) => entry.id === candidates[1].id)?.status,
    ).toBe('imported');
    expect(
      (await files(candidates[1].targetRoot!)).filter((file) =>
        file.startsWith('codex-'),
      ),
    ).toHaveLength(1);
  });

  it('remembers explicitly selected native duplicates after their native copy is deleted', async () => {
    const entry = (await preview()).entries[0];
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    const existing = path.join(entry.targetRoot!, 'native.md');
    await fs.writeFile(existing, native('Existing fact', entry.content));
    expect((await preview()).entries[0].status).toBe('duplicate');
    await runCodexImport({ ...options(), selectedIds: [entry.id] });
    await fs.unlink(existing);
    expect((await preview()).entries[0].status).toBe('previously-imported');
  });

  it('refuses concurrent imports without removing another importer lock', async () => {
    const entry = (await preview()).entries[0];
    await fs.mkdir(entry.targetRoot!, { recursive: true });
    const lock = path.join(entry.targetRoot!, '.codex-import.lock');
    await fs.writeFile(lock, 'another writer');
    await expect(
      runCodexImport({ ...options(), selectedIds: [entry.id] }),
    ).rejects.toThrow();
    expect(await fs.readFile(lock, 'utf8')).toBe('another writer');
    expect(await files(entry.targetRoot!)).toEqual(['.codex-import.lock']);
  });
});
