/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigParameters } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolResult } from './tools.js';
import {
  RecordArtifactTool,
  type RecordArtifactParams,
} from './record-artifact.js';
import { arePermissionBitsEnforced } from '../test-utils/permission-bits.js';

const signal = new AbortController().signal;
const RES = 'https://example.com/resource';
const RECORDED = 'Recorded artifact';
const WORKTREE = path.join('.qwen', 'worktrees', 'my-feature');

function makeTool(targetDir = '/', configParams?: Partial<ConfigParameters>) {
  return new RecordArtifactTool(
    makeFakeConfig({ targetDir, cwd: targetDir, ...configParams }),
  );
}

function run(params: RecordArtifactParams, tool = makeTool()) {
  return tool.build(params).execute(signal);
}

/** Building `params` (may be ill-typed on purpose) on a fresh tool throws. */
function expectBuildThrows(params: object, message: RegExp) {
  expect(() => makeTool().build(params as never)).toThrow(message);
}

async function tempDir(prefix: string) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** llmContent contains (or matches) every `has` and none of `lacks`. */
function expectText(
  result: ToolResult,
  has: Array<string | RegExp>,
  lacks: string[] = [],
) {
  const text = String(result.llmContent);
  for (const s of has) {
    if (typeof s === 'string') expect(text).toContain(s);
    else expect(text).toMatch(s);
  }
  for (const s of lacks) expect(text).not.toContain(s);
}

function expectFirst(result: ToolResult, artifact: object) {
  expect(result.error).toBeUndefined();
  expect(result.artifacts?.[0]).toMatchObject(artifact);
}

function expectAll(result: ToolResult, artifacts: object[]) {
  expect(result.error).toBeUndefined();
  expect(result.artifacts).toMatchObject(artifacts);
}

function expectFailed(result: ToolResult, type: ToolErrorType) {
  expect(result.error?.type).toBe(type);
  expect(result.artifacts).toBeUndefined();
}

async function createWorkspace(
  subdir?: string,
  configParams?: Partial<ConfigParameters>,
) {
  const root = await tempDir('record-artifact-');
  const cwd = subdir ? path.join(root, subdir) : root;
  if (subdir) {
    await mkdir(cwd, { recursive: true });
  }
  const tool = makeTool(cwd, configParams);
  return {
    root,
    cwd,
    tool,
    record: (title: string, workspacePath: string) =>
      run({ title, workspacePath }, tool),
    async write(rel: string, content = 'artifact-bytes', base = cwd) {
      const abs = path.join(base, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return abs;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('RecordArtifactTool', () => {
  const workspaces: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((workspace) => workspace.cleanup()),
    );
  });

  async function workspace(
    subdir?: string,
    configParams?: Partial<ConfigParameters>,
  ) {
    const created = await createWorkspace(subdir, configParams);
    workspaces.push(created);
    return created;
  }

  function removeLater(target: string, recursive = false) {
    workspaces.push({ cleanup: () => rm(target, { recursive, force: true }) });
  }

  /** A tmpdir symlink aliasing `root`, removed after the test. */
  async function aliasOf(root: string, label: string) {
    const alias = path.join(
      os.tmpdir(),
      `record-artifact-${label}-${process.pid}-${Date.now()}`,
    );
    await symlink(root, alias);
    removeLater(alias);
    return alias;
  }

  /** `secret.csv` in a fresh directory outside every workspace. */
  async function outsideSecret(prefix: string) {
    const outside = await tempDir(prefix);
    const secret = path.join(outside, 'secret.csv');
    await writeFile(secret, 'secret');
    removeLater(outside, true);
    return secret;
  }

  it('does not point the model at the Artifact tool', () => {
    expect(makeTool().description).not.toContain('Artifact tool');
  });

  it('records a link artifact without touching the resource', async () => {
    const url = 'https://example.com/tables/orders';
    const metadata = { table: 'orders' };
    const result = await run({ title: 'Table details', url, metadata });

    expectAll(result, [
      { title: 'Table details', storage: 'external_url', url, metadata },
    ]);
  });

  it('records a managed artifact with inferred storage', async () => {
    await expect(
      run({ title: 'Managed preview', managedId: 'ext-123' }),
    ).resolves.toMatchObject({
      artifacts: [
        { title: 'Managed preview', storage: 'managed', managedId: 'ext-123' },
      ],
    });
  });

  it('records a cwd-relative workspace file as a root-relative canonical path', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', '<html>ok</html>');

    const result = await ws.record('Workspace report', 'reports/summary.html');

    expectAll(result, [
      {
        title: 'summary.html',
        description: 'Workspace report',
        storage: 'workspace',
        workspacePath: 'reports/summary.html',
        sizeBytes: '<html>ok</html>'.length,
        metadata: { derivedFromTitle: true },
      },
    ]);
    expectText(result, [
      'Recorded artifact "summary.html".',
      'status: available',
      'workspacePath: reports/summary.html',
      `resolvedPath: ${path.join(ws.cwd, 'reports/summary.html')}`,
    ]);
  });

  it('keeps an explicit description for a workspace file', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', 'ok');

    const result = await run(
      {
        title: 'Workspace report',
        description: 'Daily export',
        workspacePath: 'reports/summary.html',
      },
      ws.tool,
    );

    expectFirst(result, {
      title: 'summary.html',
      description: 'Daily export',
    });
    expect(result.artifacts?.[0]?.metadata).toBeUndefined();
  });

  it('keeps caller metadata when the filename becomes the title', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', 'ok');

    const result = await run(
      {
        title: 'Workspace report',
        workspacePath: 'reports/summary.html',
        metadata: { note: 'kept' },
      },
      ws.tool,
    );

    expectFirst(result, {
      title: 'summary.html',
      description: 'Workspace report',
      metadata: { note: 'kept', derivedFromTitle: true },
    });
  });

  it('ignores a caller-supplied derivedFromTitle marker', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', 'ok');

    const result = await run(
      {
        title: 'summary.html',
        description: 'FINAL approved numbers',
        workspacePath: 'reports/summary.html',
        metadata: { derivedFromTitle: true, note: 'kept' },
      },
      ws.tool,
    );

    expectFirst(result, {
      title: 'summary.html',
      description: 'FINAL approved numbers',
      metadata: { note: 'kept' },
    });
  });

  it('records a full metadata bag without the derived-title marker', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', 'ok');
    const overhead = Buffer.byteLength('{"pad":""}', 'utf8');
    const metadata = { pad: 'x'.repeat(4096 - overhead) };
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBe(4096);

    const result = await run(
      {
        title: 'Q3 report',
        workspacePath: 'reports/summary.html',
        metadata,
      },
      ws.tool,
    );

    expect(result.error).toBeUndefined();
    const stored = result.artifacts?.[0];
    expect(stored).toMatchObject({
      title: 'summary.html',
      workspacePath: 'reports/summary.html',
      metadata,
    });
    expect(stored?.description).toBeUndefined();
    expect(stored?.metadata).not.toHaveProperty('derivedFromTitle');
    expect(
      Buffer.byteLength(JSON.stringify(stored?.metadata), 'utf8'),
    ).toBeLessThanOrEqual(4096);
  });

  it('describes a workspace recording by its filename', async () => {
    const ws = await workspace();

    expect(
      ws.tool
        .build({
          title: 'Workspace report',
          workspacePath: 'reports/summary.html',
        })
        .getDescription(),
    ).toBe('Recording artifact summary.html');
    expect(
      ws.tool.build({ title: 'Table details', url: RES }).getDescription(),
    ).toBe('Recording artifact Table details');
  });

  it('does not copy a filename that already matches the caller title into the description', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', 'ok');

    const result = await ws.record('summary.html', 'reports/summary.html');

    expectFirst(result, { title: 'summary.html' });
    expect(result.artifacts?.[0]).not.toHaveProperty('description');
  });

  it('keeps the caller title when the filename has leading whitespace', async () => {
    const ws = await workspace();
    await ws.write('reports/ summary.html', 'ok');

    const result = await ws.record('Workspace report', 'reports/ summary.html');

    expectFirst(result, {
      title: 'Workspace report',
      workspacePath: 'reports/ summary.html',
    });
    expect(result.artifacts?.[0]).not.toHaveProperty('description');
  });

  it('keeps the caller title when the filename is too long to store', async () => {
    const ws = await workspace();
    const name = 'a'.repeat(201);
    await ws.write(name, 'x');

    const result = await ws.record('Caller title', name);

    expectFirst(result, { title: 'Caller title', workspacePath: name });
    expect(result.artifacts?.[0]).not.toHaveProperty('description');
  });

  it('normalizes a cwd-absolute workspace path to the canonical relative path', async () => {
    const ws = await workspace();
    const abs = await ws.write('report.csv', 'a,b\n1,2\n');

    const result = await ws.record('CSV report', abs);

    expectFirst(result, { storage: 'workspace', workspacePath: 'report.csv' });
    expectText(result, ['status: available', 'workspacePath: report.csv']);
  });

  it('accepts a POSIX double-slash absolute locator inside the workspace', async () => {
    if (process.platform === 'win32') return;
    const ws = await workspace();
    const abs = await ws.write('report.csv', 'a,b\n');

    expectFirst(await ws.record('Double slash', `/${abs}`), {
      workspacePath: 'report.csv',
    });
  });

  it('accepts a long absolute locator when the canonical path is short', async () => {
    const deep = Array.from({ length: 50 }, () => 'dddddddddd').join(path.sep);
    const ws = await workspace(deep);
    const abs = await ws.write('a.csv', '1');
    expect(abs.length).toBeGreaterThan(500);

    expectFirst(await ws.record('Deep', abs), { workspacePath: 'a.csv' });
  });

  it('records a POSIX filename that contains a literal backslash', async () => {
    if (process.platform === 'win32') return;
    const ws = await workspace();
    await ws.write('reports\\summary.csv', 'a,b\n');

    expectFirst(await ws.record('Literal backslash', 'reports\\summary.csv'), {
      title: 'reports\\summary.csv',
      workspacePath: 'reports\\summary.csv',
    });
  });

  it('normalizes Windows-style relative separators to posix', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', '<html>ok</html>');

    expectFirst(
      await ws.record('Windows-style relative report', 'reports\\summary.html'),
      { workspacePath: 'reports/summary.html' },
    );
  });

  it('canonicalizes a worktree-relative path against the bound workspace root', async () => {
    const ws = await workspace(WORKTREE);
    await ws.write('report.csv', 'a,b\n');

    const result = await ws.record('Worktree report', 'report.csv');

    const canonical = '.qwen/worktrees/my-feature/report.csv';
    expectFirst(result, { workspacePath: canonical });
    expectText(result, [`workspacePath: ${canonical}`]);
  });

  it('does not fall back to the workspace root when a relative path misses in the worktree cwd', async () => {
    const ws = await workspace(WORKTREE);
    await ws.write('docs/review.md', '# review', ws.root);

    const result = await ws.record('Root review', 'docs/review.md');

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expectText(result, [], [RECORDED]);
  });

  it('accepts an absolute path inside the bound workspace from a worktree session', async () => {
    const ws = await workspace(WORKTREE);
    const abs = await ws.write('docs/review.md', '# review', ws.root);

    expectFirst(await ws.record('Absolute review', abs), {
      workspacePath: 'docs/review.md',
    });
  });

  it('judges worktree-session files with the bound-root ignore rules', async () => {
    const ws = await workspace(WORKTREE);
    await ws.write('.gitignore', 'build/\n', ws.root);
    await ws.write('build/report.csv', 'a,b\n');
    await ws.write('notes/report.csv', 'a,b\n');

    // The panel loads the bound root's ignore rules and matches the stored
    // bound-root-canonical path, so the gate does the same: the session's
    // worktree prefix is stripped for the skip-set and exemptions, while
    // the rule check runs against the stored path under the bound root's
    // rules (a rule local to the worktree itself is not a panel rule).
    expectFailed(
      await ws.record('Hidden in worktree', 'build/report.csv'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
    expectFirst(await ws.record('Visible in worktree', 'notes/report.csv'), {
      workspacePath: '.qwen/worktrees/my-feature/notes/report.csv',
    });
  });

  it('records worktree files when the bound root hides .qwen/', async () => {
    // The bound root's .gitignore hides .qwen/ — exactly what
    // `qwen /setup-github` writes — yet the worktree session's own files
    // are the panel's content: the gate judges the worktree-stripped
    // bound-root-relative path, so the .qwen/ rule cannot hide them.
    const ws = await workspace(WORKTREE);
    await ws.write('.gitignore', '.qwen/*\n', ws.root);
    await ws.write('notes/report.csv', 'a,b\n');

    expectFirst(await ws.record('Worktree report', 'notes/report.csv'), {
      workspacePath: '.qwen/worktrees/my-feature/notes/report.csv',
    });
  });

  it('applies bound-root anchored rules to worktree files', async () => {
    // An anchored pattern binds to the bound root, the namespace the gate
    // matches in: /notes/ hides the worktree's notes/report.csv (stripped
    // to notes/report.csv) even though the stored path nests it under
    // .qwen/worktrees/.
    const ws = await workspace(WORKTREE);
    await ws.write('.gitignore', '/notes/\n', ws.root);
    await ws.write('notes/report.csv', 'a,b\n');

    expectFailed(
      await ws.record('Anchored hidden', 'notes/report.csv'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('does not strip a worktree-shaped prefix for a session outside the worktree', async () => {
    const ws = await workspace();
    const foreign = path.join('.qwen', 'worktrees', 'other', 'report.csv');
    await ws.write(foreign, 'a,b\n');

    // The session's cwd is not inside a worktree, so the path is judged in
    // full: it sits under the .qwen skip directory and is refused.
    const result = await ws.record('Foreign worktree', foreign);
    expectFailed(result, ToolErrorType.INVALID_TOOL_PARAMS);
    expectText(result, ['hidden from the Artifacts panel'], [RECORDED]);
  });

  it('accepts an absolute path that names the workspace through a symlink prefix', async () => {
    const ws = await workspace();
    await ws.write('report.csv', 'a,b\n');
    const alias = await aliasOf(ws.root, 'alias');

    expectFirst(
      await ws.record('Symlink prefix', path.join(alias, 'report.csv')),
      { workspacePath: 'report.csv' },
    );
  });

  it('reports missing instead of outside when a symlink-root absolute path has no parent', async () => {
    const ws = await workspace();
    const alias = await aliasOf(ws.root, 'missing');

    const result = await ws.record(
      'Missing parent',
      path.join(alias, 'no-such-dir', 'a.csv'),
    );

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expectText(result, [], ['outside the workspace']);
  });

  it('rejects a canonical workspacePath that fails display safety checks', async () => {
    const ws = await workspace();
    const nasty = await ws.write('reports/actual\u202eforged.csv', 'x');
    await symlink(nasty, path.join(ws.cwd, 'safe.csv'));

    expectFailed(
      await ws.record('Safe link', 'safe.csv'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('rejects a fifo workspacePath', async () => {
    if (process.platform === 'win32') return;
    const ws = await workspace();
    const created = spawnSync('mkfifo', [path.join(ws.cwd, 'pipe.fifo')]);
    if (created.status !== 0) return;

    expectFailed(
      await ws.record('Fifo', 'pipe.fifo'),
      ToolErrorType.TARGET_NOT_REGULAR_FILE,
    );
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'classifies an unreadable path as permission denied',
    async () => {
      const ws = await workspace();
      await ws.write('hidden/a.csv', 'x');
      const hidden = path.join(ws.cwd, 'hidden');
      await chmod(hidden, 0);
      try {
        expectFailed(
          await ws.record('Hidden', 'hidden/a.csv'),
          ToolErrorType.PERMISSION_DENIED,
        );
      } finally {
        await chmod(hidden, 0o755);
      }
    },
  );

  it('rejects a wrong workspace-folder prefix instead of reporting success', async () => {
    const ws = await workspace();
    await ws.write('report.csv', 'a,b\n');

    const result = await ws.record('Wrong prefix', 'w/agent/report.csv');

    expectFailed(result, ToolErrorType.FILE_NOT_FOUND);
    expectText(
      result,
      ['file not found', 'report.csv', 'w/agent/'],
      [RECORDED],
    );
  });

  it('rejects a missing workspace file instead of reporting success', async () => {
    const ws = await workspace();

    const result = await ws.record('Missing', 'missing.csv');

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expectText(result, [], [RECORDED]);
  });

  it('refuses a file the workspace ignore rules hide from the Artifacts panel', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', '.qwen/\nnode_modules/\nbuild/\n');
    await ws.write('.qwen/tmp/shot.png', 'png');
    await ws.write('node_modules/pkg/index.js', 'js');
    await ws.write('build/report.html', 'html');

    const shot = await ws.record('Screenshot', '.qwen/tmp/shot.png');
    expectFailed(shot, ToolErrorType.INVALID_TOOL_PARAMS);
    expectText(
      shot,
      ['hidden from the Artifacts panel', 'ignore rules'],
      [RECORDED],
    );
    expectFailed(
      await ws.record('Deps file', 'node_modules/pkg/index.js'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
    expectFailed(
      await ws.record('Build report', 'build/report.html'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('refuses skipped-directory components without any ignore file', async () => {
    const ws = await workspace();
    await ws.write('.qwen/tmp/shot.png', 'png');
    await ws.write('__pycache__/mod.pyc', 'pyc');
    await ws.write('dist/bundle.js', 'js');
    await ws.write('node_modules/pkg/index.js', 'js');

    // The issue #17453 contract holds without ignore files: a proper
    // ancestor named in the skip list is never panel-visible.
    for (const rel of [
      '.qwen/tmp/shot.png',
      '__pycache__/mod.pyc',
      'dist/bundle.js',
      'node_modules/pkg/index.js',
    ]) {
      const result = await ws.record('Skip dir file', rel);
      expectFailed(result, ToolErrorType.INVALID_TOOL_PARAMS);
      expectText(result, ['hidden from the Artifacts panel'], [RECORDED]);
    }
  });

  it('records panel-visible files the ignore rules do not hide', async () => {
    const ws = await workspace();
    await ws.write('.github/workflows/ci.yml', 'yaml');
    await ws.write('.config/report.md', 'md');

    // No .gitignore/.qwenignore in this workspace, and .github/.config are
    // not skipped directories: the panel's file browser lists both paths,
    // so the gate records them.
    expectFirst(await ws.record('CI', '.github/workflows/ci.yml'), {
      title: 'ci.yml',
      workspacePath: '.github/workflows/ci.yml',
    });
    expectFirst(await ws.record('Config report', '.config/report.md'), {
      title: 'report.md',
      workspacePath: '.config/report.md',
    });
  });

  it('refuses a file hidden by .qwenignore', async () => {
    const ws = await workspace();
    await ws.write('.qwenignore', 'secrets/\n');
    await ws.write('secrets/creds.md', 'md');

    expectFailed(
      await ws.record('Secrets', 'secrets/creds.md'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('refuses a file a file-only ignore pattern hides', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', '*.png\n');
    await ws.write('shots/shot.png', 'png');

    expectFailed(
      await ws.record('Shot', 'shots/shot.png'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('records a .gitignore-hidden file when respectGitIgnore is false', async () => {
    // The gate loads the ignore files the session's fileFiltering
    // settings say the panel loads: with respectGitIgnore=false the
    // .gitignore is not among them, so the file stays recordable.
    const ws = await workspace(undefined, {
      fileFiltering: { respectGitIgnore: false },
    });
    await ws.write('.gitignore', 'build/\n');
    await ws.write('build/report.html', 'html');

    expectFirst(await ws.record('Build report', 'build/report.html'), {
      workspacePath: 'build/report.html',
    });
  });

  it('records a .qwenignore-hidden file when respectQwenIgnore is false', async () => {
    const ws = await workspace(undefined, {
      fileFiltering: { respectQwenIgnore: false },
    });
    await ws.write('.qwenignore', 'secrets/\n');
    await ws.write('secrets/creds.md', 'md');

    expectFirst(await ws.record('Secrets', 'secrets/creds.md'), {
      workspacePath: 'secrets/creds.md',
    });
  });

  it('refuses a file hidden by a configured custom ignore file', async () => {
    // The loader must read the session's configured customIgnoreFiles,
    // not only the built-in names: 'special.ignore' is not a default
    // name, so recording succeeds if the plumbing drops the configured
    // list.
    const ws = await workspace(undefined, {
      fileFiltering: { customIgnoreFiles: ['special.ignore'] },
    });
    await ws.write('special.ignore', 'vendored/\n');
    await ws.write('vendored/lib.md', 'md');

    expectFailed(
      await ws.record('Vendored', 'vendored/lib.md'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('still records code-review reports under .qwen/reviews', async () => {
    const ws = await workspace();
    await ws.write('.qwen/reviews/pr-1.json', '{"artifactType":"code_review"}');

    const result = await ws.record(
      'Code review result',
      '.qwen/reviews/pr-1.json',
    );

    expectFirst(result, {
      title: 'pr-1.json',
      workspacePath: '.qwen/reviews/pr-1.json',
    });
  });

  it('records .qwen/reviews reports even when .qwen/ is gitignored', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', '.qwen/\n');
    await ws.write('.qwen/reviews/pr-1.json', '{"artifactType":"code_review"}');

    const result = await ws.record(
      'Code review result',
      '.qwen/reviews/pr-1.json',
    );

    expectFirst(result, { workspacePath: '.qwen/reviews/pr-1.json' });
  });

  it('expands the .qwen/reviews directory into its report files', async () => {
    const ws = await workspace();
    await ws.write('.qwen/reviews/pr-1.json', '{"artifactType":"code_review"}');
    await ws.write('.qwen/reviews/pr-2.json', '{"artifactType":"code_review"}');

    const result = await ws.record('Code reviews', '.qwen/reviews');

    expectAll(result, [
      { workspacePath: '.qwen/reviews/pr-1.json' },
      { workspacePath: '.qwen/reviews/pr-2.json' },
    ]);
    expectText(result, ['Expanded directory'], [RECORDED]);
  });

  it('records the "Ask for details" deliverable even when .qwen/ is gitignored', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', '.qwen/\n');
    await ws.write('.qwen/tmp/ask-details.html', '<html></html>');
    await ws.write('.qwen/tmp/v31-verify/shot.png', 'png');

    // The shipped side-task prompt names this exact file, and write_file's
    // auto-record skips .qwen/tmp/, so the explicit record must work even
    // where `.qwen/` is ignored.
    expectFirst(await ws.record('Details', '.qwen/tmp/ask-details.html'), {
      workspacePath: '.qwen/tmp/ask-details.html',
    });
    // The exemption is the named file only: other `.qwen/tmp` files stay
    // refused where the ignore rules hide them (issue #17453).
    expectFailed(
      await ws.record('Screenshot', '.qwen/tmp/v31-verify/shot.png'),
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  });

  it('accepts files whose own names look hidden but live in visible paths', async () => {
    const ws = await workspace();
    await ws.write('dist', 'file');
    await ws.write('.gitignore', 'node_modules');
    await ws.write('notes/.draft.md', 'draft');

    expectFirst(await ws.record('File named dist', 'dist'), {
      title: 'dist',
      workspacePath: 'dist',
    });
    expectFirst(await ws.record('Dotfile', '.gitignore'), {
      title: '.gitignore',
      workspacePath: '.gitignore',
    });
    expectFirst(await ws.record('Draft note', 'notes/.draft.md'), {
      title: '.draft.md',
      workspacePath: 'notes/.draft.md',
    });
  });

  it('keeps accepting files in visible directories with similar names', async () => {
    const ws = await workspace();
    await ws.write('notes/qwen-tmp-report.md', 'md');

    const result = await ws.record('Notes', 'notes/qwen-tmp-report.md');

    expectFirst(result, {
      title: 'qwen-tmp-report.md',
      workspacePath: 'notes/qwen-tmp-report.md',
    });
  });

  it('rejects an empty directory workspacePath', async () => {
    const ws = await workspace();
    await mkdir(path.join(ws.cwd, 'reports'));

    const result = await ws.record('Directory', 'reports');

    expectFailed(result, ToolErrorType.TARGET_IS_DIRECTORY);
    expectText(result, ['no recordable files'], [RECORDED]);
  });

  it('expands a directory workspacePath into per-file artifacts', async () => {
    const ws = await workspace();
    await ws.write('reports/a.xlsx', 'xlsx');
    await ws.write('reports/b.docx', 'docx');
    await ws.write('reports/.hidden.xlsx', 'hidden');
    await ws.write('reports/~$lock.xlsx', 'lock');
    await ws.write('reports/nested/c.pptx', 'pptx');

    const result = await ws.record('Daily reports', 'reports');

    const expanded = (title: string, workspacePath: string) => ({
      title,
      storage: 'workspace',
      workspacePath,
      description: 'Daily reports',
    });
    expectAll(result, [
      expanded('a.xlsx', 'reports/a.xlsx'),
      expanded('b.docx', 'reports/b.docx'),
      {
        ...expanded('c.pptx', 'reports/nested/c.pptx'),
        metadata: { expandedFromDirectory: true },
      },
    ]);
    expectText(result, ['Expanded directory', 'reports/a.xlsx'], [RECORDED]);
  });

  it('discloses the 100-file cap when expanding a large directory', async () => {
    const ws = await workspace();
    for (let index = 0; index < 101; index++) {
      await ws.write(`reports/f${String(index).padStart(3, '0')}.txt`, 'x');
    }

    const result = await ws.record('Many', 'reports');

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toHaveLength(100);
    expectText(result, [/first 100 files/i]);
  });

  it('rejects expanding a junk directory root', async () => {
    const ws = await workspace();
    await ws.write('node_modules/pkg/index.js', 'js');

    expectFailed(
      await ws.record('Deps', 'node_modules'),
      ToolErrorType.TARGET_IS_DIRECTORY,
    );
  });

  it('rejects expanding a path nested under a junk directory', async () => {
    const ws = await workspace();
    await ws.write('node_modules/react/index.js', 'js');

    const result = await ws.record('React', 'node_modules/react');

    expectFailed(result, ToolErrorType.TARGET_IS_DIRECTORY);
    expectText(result, ['skipped directory']);
  });

  it('expands a dot-named directory the direct-file gate does not skip', async () => {
    // The pre-check applies the same 5-name skip contract as the
    // direct-file gate, so a panel-visible dot directory such as
    // .github expands into its recordable children instead of being
    // refused as "a skipped directory".
    const ws = await workspace();
    await ws.write('.github/workflows/ci.yml', 'yaml');

    const result = await ws.record('CI directory', '.github');

    expectAll(result, [{ workspacePath: '.github/workflows/ci.yml' }]);
    expectText(result, ['Expanded directory'], [RECORDED]);
  });

  it('expands a directory without files the direct-file gate hides', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', 'build/out/\n');
    await ws.write('build/out/report.html', 'html');
    await ws.write('build/ok.txt', 'txt');

    const result = await ws.record('Build', 'build');

    expectAll(result, [{ workspacePath: 'build/ok.txt' }]);
    expectText(result, ['build/ok.txt'], ['build/out/report.html']);
  });

  it('refuses to expand a directory whose files the direct-file gate hides entirely', async () => {
    const ws = await workspace();
    await ws.write('.gitignore', 'build/\n');
    await ws.write('build/report.html', 'html');

    const result = await ws.record('Build dir', 'build');

    expectFailed(result, ToolErrorType.TARGET_IS_DIRECTORY);
    expectText(result, ['no recordable files'], [RECORDED, 'report.html']);
  });

  it('skips expansion children whose names are not trim-stable', async () => {
    const ws = await workspace();
    await ws.write('notes/keep.txt', 'ok');
    await ws.write('notes/ report.txt', 'space');

    const result = await ws.record('Notes', 'notes');

    expectAll(result, [{ workspacePath: 'notes/keep.txt' }]);
    expectText(result, [/Skipped 1 files/i]);
  });

  it('rejects recording the worktree cwd as a directory', async () => {
    const ws = await workspace(WORKTREE);
    await ws.write('keep.xlsx', 'xlsx');

    const result = await ws.record('Worktree root', '.');

    expectFailed(result, ToolErrorType.TARGET_IS_DIRECTORY);
    expectText(result, ['workspace root']);
  });

  it('expands a subdirectory inside a worktree session', async () => {
    const ws = await workspace(WORKTREE);
    await ws.write('reports/a.xlsx', 'xlsx');
    await ws.write('reports/b.docx', 'docx');

    expectAll(await ws.record('Worktree reports', 'reports'), [
      { workspacePath: '.qwen/worktrees/my-feature/reports/a.xlsx' },
      { workspacePath: '.qwen/worktrees/my-feature/reports/b.docx' },
    ]);
  });

  it('skips junk directories and lock files when expanding a directory', async () => {
    const ws = await workspace();
    await ws.write('reports/keep.xlsx', 'xlsx');
    await ws.write('reports/node_modules/skip.txt', 'skip');
    await ws.write('reports/~$lock.xlsx', 'lock');

    const result = await ws.record('Reports', 'reports');

    expectAll(result, [{ workspacePath: 'reports/keep.xlsx' }]);
    expectText(result, [], ['node_modules']);
  });

  it('warns when directory expansion hits the depth limit', async () => {
    const ws = await workspace();
    await ws.write('reports/a/b/c/d/e/too-deep.xlsx', 'deep');
    await ws.write('reports/shallow.xlsx', 'xlsx');

    const result = await ws.record('Reports', 'reports');

    expectAll(result, [{ workspacePath: 'reports/shallow.xlsx' }]);
    expectText(result, [/deeper than 4 directory levels/i]);
  });

  it('rejects a workspace-relative path that escapes the execution directory', () => {
    for (const workspacePath of [
      '../secret.txt',
      '..\\secret.txt',
      '..\\..\\secret.txt',
      'reports\\..\\..\\secret.txt',
      'reports/..\\..\\secret.txt',
    ]) {
      expectBuildThrows({ title: 'Escape', workspacePath }, /workspacePath/);
    }
  });

  it('rejects UNC locators before resolving them', () => {
    const locators = [
      '\\\\attacker.example\\share\\report.csv',
      '\\\\?\\UNC\\attacker.example\\share\\report.csv',
      '\\??\\UNC\\attacker.example\\share\\report.csv',
      '\\\\?\\GLOBALROOT\\Device\\Mup\\attacker.example\\share\\report.csv',
    ];
    if (process.platform === 'win32') {
      locators.push('//attacker.example/share/report.csv');
    }
    for (const workspacePath of locators) {
      expectBuildThrows({ title: 'UNC', workspacePath }, /workspacePath/);
    }
  });

  it('rejects Windows drive and UNC locators on POSIX', () => {
    if (process.platform === 'win32') return;
    for (const workspacePath of [
      'C:\\tmp\\report.html',
      'C:/tmp/report.html',
      'C:tmp\\report.html',
      '\\\\server\\share\\report.html',
      '\\tmp\\report.html',
    ]) {
      expectBuildThrows({ title: 'Escape', workspacePath }, /workspacePath/);
    }
  });

  it('rejects an absolute path outside the execution directory', async () => {
    const ws = await workspace();
    const secret = await outsideSecret('record-artifact-outside-');

    expect(() =>
      ws.tool.build({ title: 'Outside', workspacePath: secret }),
    ).toThrow(/workspace/);
  });

  it('rejects a symlink that escapes the execution directory', async () => {
    const ws = await workspace();
    const secret = await outsideSecret('record-artifact-link-');
    await symlink(secret, path.join(ws.cwd, 'escape.csv'));

    const result = await ws.record('Escape link', 'escape.csv');

    expect(result.error?.type).toBe(ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expectText(result, [], [RECORDED]);
  });

  // Rows: title, record title, workspacePath, [target, link] symlinks in order.
  it.each([
    [
      'rejects a workspace symlink whose target is a UNC path',
      'UNC link',
      'report.csv',
      [['\\\\attacker.example\\share\\report.csv', 'report.csv']],
    ],
    [
      'rejects a UNC target reached through an intermediate directory symlink',
      'UNC dir',
      'docs/q3.csv',
      [['\\\\attacker.example\\share', 'docs']],
    ],
    [
      'rejects a two-hop symlink chain that ends at a UNC path',
      'UNC chain',
      'a.csv',
      [
        ['\\\\attacker.example\\share\\x.csv', 'b.csv'],
        ['b.csv', 'a.csv'],
      ],
    ],
  ])('%s', async (_name, title, workspacePath, links) => {
    const ws = await workspace();
    try {
      for (const [target, link] of links) {
        await symlink(target, path.join(ws.cwd, link));
      }
    } catch {
      return;
    }

    const result = await ws.record(title, workspacePath);

    expectFailed(result, ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expectText(result, [], [RECORDED]);
  });

  it('names the legacy path field instead of asking for a locator', () => {
    expectBuildThrows(
      { title: 'Legacy path', path: 'report.csv' },
      /"path" is not supported.*workspacePath/,
    );
  });

  it('rejects unknown fields such as artifactType', () => {
    expectBuildThrows(
      { title: 'Unknown field', url: RES, artifactType: 'csv' },
      /additional properties/,
    );
  });

  it('rejects published storage', () => {
    expectBuildThrows(
      {
        title: 'Forged',
        storage: 'published',
        url: 'https://example.com/artifact',
      },
      /allowed values/,
    );
  });

  it('requires exactly one locator', () => {
    expectBuildThrows(
      {
        title: 'Ambiguous',
        workspacePath: 'report.html',
        url: 'https://example.com/report',
      },
      /exactly one/,
    );
  });

  it('rejects unsafe urls before reporting success', () => {
    expectBuildThrows(
      { title: 'Credentials', url: 'https://user:pass@example.com/resource' },
      /credentials/,
    );
    expectBuildThrows(
      { title: 'FTP', url: 'ftp://example.com/resource' },
      /http or https/,
    );
  });

  it('rejects path-like managed ids before reporting success', () => {
    for (const managedId of ['../secret', 'folder/item', 'folder\\item']) {
      expectBuildThrows(
        { title: 'Managed path', managedId },
        /opaque managed resource id/,
      );
    }
  });

  it('rejects storage values that do not match the locator', () => {
    expectBuildThrows(
      {
        title: 'Workspace mismatch',
        storage: 'external_url',
        workspacePath: 'report.html',
      },
      /storage.*workspace/,
    );
  });

  it('rejects artifact metadata that the daemon store would drop', () => {
    expectBuildThrows(
      {
        title: 'Huge metadata',
        url: RES,
        metadata: { value: 'x'.repeat(4096) },
      },
      /metadata/,
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expectBuildThrows(
        { title: 'Non-finite metadata', url: RES, metadata: { value } },
        /metadata/,
      );
    }
  });

  it('rejects invalid artifact sizes before reporting success', () => {
    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectBuildThrows(
        { title: 'Sized artifact', url: RES, sizeBytes },
        /sizeBytes/,
      );
    }
  });

  it('rejects unsafe display markup before reporting success', () => {
    for (const params of [
      { title: '<script>alert(1)</script>', url: RES },
      {
        title: 'External style',
        description: '<style>body{display:none}</style>',
        url: RES,
      },
      { title: 'Entity payload', description: '&#x3c;script&#x3e;', url: RES },
      {
        title: 'Script data url',
        description: 'data:text/javascript,alert(1)',
        url: RES,
      },
      {
        title: 'SVG data url',
        description: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
        url: RES,
      },
      { title: 'HTML mime', mimeType: 'text/html<script>', url: RES },
      {
        title: 'Workspace payload',
        workspacePath: '<img src=x onerror=alert(1)>.html',
      },
      { title: 'Managed payload', managedId: '<script>alert(1)</script>' },
    ]) {
      expectBuildThrows(params, /unsafe markup/);
    }
    expectBuildThrows(
      {
        title: 'Metadata key',
        url: RES,
        metadata: { '<script>': 'unsafe key' },
      },
      /metadata/,
    );
    expectBuildThrows(
      {
        title: 'Metadata value',
        url: RES,
        metadata: { preview: 'data:text/javascript,alert(1)' },
      },
      /metadata/,
    );
  });

  it('allows benign words ending with on before equals signs', () => {
    expect(() =>
      makeTool().build({
        title: 'conversation=value',
        description: 'configuration=value',
        url: RES,
      }),
    ).not.toThrow();
  });

  it('rejects Unicode control characters before reporting success', () => {
    for (const title of [
      'Hidden\u202eTitle',
      'safe\u2028evil',
      'safe\u2066evil',
    ]) {
      expectBuildThrows({ title, url: RES }, /control characters/);
    }
    expectBuildThrows(
      {
        title: 'Metadata key',
        url: RES,
        metadata: { 'preview\u200b': 'hidden' },
      },
      /metadata/,
    );
  });

  it('accepts line whitespace in descriptions but not titles', async () => {
    const description = 'Line one\nLine two\tindented\r\nLine three';
    await expect(
      run({ title: 'Multiline report', description, url: RES }),
    ).resolves.toMatchObject({ artifacts: [{ description }] });

    expectBuildThrows({ title: 'Bad\nTitle', url: RES }, /control characters/);
  });
});
