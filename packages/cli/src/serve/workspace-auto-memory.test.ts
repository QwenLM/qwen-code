/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVE_ERROR_KINDS } from '@qwen-code/acp-bridge/status';
import { DAEMON_ERROR_KINDS } from '@qwen-code/sdk/daemon';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { sanitizeCwd } from '@qwen-code/qwen-code-core/utils/paths.js';
import {
  AUTO_MEMORY_ERROR_KINDS,
  collectWorkspaceAutoMemoryStatus,
  mountWorkspaceAutoMemoryRoutes,
  mountWorkspaceQualifiedAutoMemoryRoutes,
  readWorkspaceAutoMemoryFile,
  type AutoMemoryRuntime,
} from './workspace-auto-memory.js';
import type {
  WorkspaceEntry,
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

// Lets tests make core's no-follow open reject the way it does on a volume
// that cannot prove file identity (inode 0, Windows-only), or substitute a
// handle whose stat() answers differ between the open and the post-read stat
// (to drive the torn-read post-check arm).
const noFollow = vi.hoisted(() => ({
  reject: undefined as Error | undefined,
  handle: undefined as unknown,
}));
vi.mock('@qwen-code/qwen-code-core/noFollowOpen', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/qwen-code-core/noFollowOpen')
    >();
  return {
    ...actual,
    openNoFollow: (...args: Parameters<typeof actual.openNoFollow>) => {
      if (noFollow.reject) return Promise.reject(noFollow.reject);
      if (noFollow.handle !== undefined) {
        return Promise.resolve(noFollow.handle);
      }
      return actual.openNoFollow(...args);
    },
  };
});

const ONE_MIB = 1024 * 1024;

async function writeFile(dir: string, rel: string, content: string | Buffer) {
  const absolute = path.join(dir, rel);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

function mountApp(opts: {
  boundWorkspace: string;
  trusted?: boolean;
  runtime?: AutoMemoryRuntime;
}) {
  const app = express();
  const trusted = opts.trusted;
  mountWorkspaceAutoMemoryRoutes(app, {
    boundWorkspace: opts.boundWorkspace,
    ...(trusted === undefined ? {} : { isWorkspaceTrusted: () => trusted }),
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  });
  return app;
}

/** A runtime whose sessions run with exactly the daemon's memory env. */
function overlayRuntime(
  sessionRuntimeBaseDir: string,
  env: Record<string, string | undefined> = {},
): AutoMemoryRuntime {
  return {
    sessionRuntimeBaseDir,
    env: {
      mode: 'runtime-overlay',
      effectiveEnv: {
        QWEN_CODE_MEMORY_LOCAL: process.env['QWEN_CODE_MEMORY_LOCAL'],
        QWEN_CODE_MEMORY_BASE_DIR: process.env['QWEN_CODE_MEMORY_BASE_DIR'],
        ...env,
      },
    },
  };
}

let tmp: string;
let workspace: string;
let globalBase: string;
let projectDir: string;
let userDir: string;

beforeEach(async () => {
  // Canonical temp root: the resolver canonicalizes roots with realpath,
  // so a symlinked TMPDIR (macOS /var -> /private/var) must not leak
  // into the literal fixture paths.
  tmp = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 'qwen-serve-auto-memory-'),
  );
  workspace = path.join(tmp, 'workspace');
  globalBase = path.join(tmp, 'global');
  // QWEN_CODE_MEMORY_LOCAL pins the project root to `<workspace>/.qwen/memory`;
  // QWEN_CODE_MEMORY_BASE_DIR pins the user root to `<globalBase>/memories`.
  projectDir = path.join(workspace, '.qwen', 'memory');
  userDir = path.join(globalBase, 'memories');
  await fs.mkdir(workspace, { recursive: true });
  process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
  process.env['QWEN_CODE_MEMORY_BASE_DIR'] = globalBase;
  clearAutoMemoryRootCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  noFollow.reject = undefined;
  noFollow.handle = undefined;
  delete process.env['QWEN_CODE_MEMORY_LOCAL'];
  delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  clearAutoMemoryRootCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('collectWorkspaceAutoMemoryStatus', () => {
  it('reports an idle status when neither managed root exists', async () => {
    const status = await collectWorkspaceAutoMemoryStatus(workspace);

    expect(status).toEqual({
      v: 1,
      workspaceCwd: workspace,
      initialized: false,
      userDir,
      userDirExists: false,
      projectDir,
      projectDirs: [],
      entries: [],
      totalBytes: 0,
      fileCount: 0,
    });
  });

  it('lists entries per scope with frontmatter metadata, totals, and sort order', async () => {
    await writeFile(
      projectDir,
      'project/build.md',
      '---\ntitle: Build notes\ndescription: How the project builds\ntype: project\n---\n\nbody\n',
    );
    await writeFile(projectDir, 'notes.md', 'no frontmatter\n');
    await writeFile(userDir, 'preferences.md', 'prefs\n');

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.initialized).toBe(true);
    expect(status.fileCount).toBe(3);
    const sizes = await Promise.all(
      [
        path.join(projectDir, 'project/build.md'),
        path.join(projectDir, 'notes.md'),
        path.join(userDir, 'preferences.md'),
      ].map((file) => fs.stat(file).then((stat) => stat.size)),
    );
    expect(status.totalBytes).toBe(sizes[0] + sizes[1] + sizes[2]);
    // Project scope is scanned first, sorted by relative path inside it.
    expect(status.entries.map((entry) => entry.scope)).toEqual([
      'project',
      'project',
      'user',
    ]);
    expect(status.entries[0].path).toBe(path.join(projectDir, 'notes.md'));
    expect(status.entries[0].title).toBe('notes');
    expect(status.entries[1].title).toBe('Build notes');
    expect(status.entries[1].description).toBe('How the project builds');
    expect(status.entries[1].type).toBe('project');
    expect(status.entries[2].path).toBe(path.join(userDir, 'preferences.md'));
    for (const entry of status.entries) {
      expect(entry.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('reads name and category frontmatter keys on an isolated entry', async () => {
    await writeFile(
      projectDir,
      'named.md',
      '---\nname: Named entry\ncategory: decision\n---\n\nbody\n',
    );

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.fileCount).toBe(1);
    expect(status.entries[0].title).toBe('Named entry');
    expect(status.entries[0].category).toBe('decision');
  });

  it('parses a block-scalar description via core YAML, not a literal pipe', async () => {
    await writeFile(
      projectDir,
      'block.md',
      '---\nname: Block note\ndescription: |\n  How the project builds\ntype: project\n---\n\nbody\n',
    );

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    // The old line-regex garbled `description: |` into the literal `|`;
    // core's YAML parser yields the block text (sanitizer collapses the
    // trailing newline clip-chomp keeps).
    expect(status.entries[0].description).toBe('How the project builds');
  });

  it('strips bidi and zero-width chars and caps hostile frontmatter fields', async () => {
    // U+202E (bidi override) and U+200B (zero-width space) are the two
    // characters a repo-tracked memory file could use to reorder or hide
    // the rendered title/description. Built with fromCharCode so no
    // invisible codepoint lands in this source file.
    const bidi = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const content = [
      '---',
      `name: ${bidi}Evil${zwsp}title`,
      `description: ${bidi}${'x'.repeat(200)}${zwsp}`,
      'type: project',
      '---',
      '',
      'body',
    ].join('\n');
    await writeFile(projectDir, 'hostile.md', content);

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    const entry = status.entries[0];
    expect(entry.title).toBe('Eviltitle');
    expect(entry.description).toBeDefined();
    expect(entry.description).not.toContain(bidi);
    expect(entry.description).not.toContain(zwsp);
    expect((entry.description ?? '').length).toBeLessThanOrEqual(120);
  });

  it('skips dotfiles, non-markdown files, and symlinked entries', async () => {
    await writeFile(projectDir, '.hidden.md', 'hidden\n');
    await writeFile(projectDir, 'notes.txt', 'not markdown\n');
    await writeFile(projectDir, 'real.md', 'real\n');
    const outside = path.join(tmp, 'outside.md');
    await fs.writeFile(outside, 'outside\n');
    await fs.symlink(outside, path.join(projectDir, 'link.md'));

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.entries.map((entry) => path.basename(entry.path))).toEqual([
      'real.md',
    ]);
  });

  it('scans the full tree without a depth limit', async () => {
    await writeFile(projectDir, 'a/b/c/at-limit.md', 'deep but listed\n');
    await writeFile(
      projectDir,
      'a/b/c/d/below-limit.md',
      'deeper, still listed\n',
    );

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.entries.map((entry) => entry.path).sort()).toEqual(
      [
        path.join(projectDir, 'a/b/c/at-limit.md'),
        path.join(projectDir, 'a/b/c/d/below-limit.md'),
      ].sort(),
    );
  });

  it('refuses a symlinked project root: no entries, error recorded, read rejected', async () => {
    const outside = path.join(tmp, 'outside-mem');
    await writeFile(outside, 'secret.md', 'top secret\n');
    // A repo-shipped .qwen/memory symlink pointing outside the workspace.
    await fs.mkdir(path.dirname(projectDir), { recursive: true });
    await fs.symlink(outside, projectDir);

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });
    expect(status.entries).toEqual([]);
    expect(
      status.errors?.some((error) => error.errorKind === 'symlinked_root'),
    ).toBe(true);

    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, 'secret.md'),
        { trusted: true },
      ),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('lists both project roots for a trusted workspace in non-local mode', async () => {
    // Non-local mode: the configured root lives under the memory base
    // dir and the repo-local root under the workspace; core exposes
    // both to a trusted workspace, and the listing must walk both.
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    const configuredRoot = getAutoMemoryRoot(workspace);
    await writeFile(configuredRoot, 'notes.md', 'configured note\n');
    await writeFile(projectDir, 'repo-local.md', 'repo local note\n');

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.fileCount).toBe(2);
    expect(status.entries.map((entry) => entry.scope)).toEqual([
      'project',
      'project',
    ]);
    // The payload names every walked root, so the panel can show and
    // open the directory that really holds each entry.
    expect(status.projectDir).toBe(configuredRoot);
    expect(status.projectDirs).toEqual([configuredRoot, projectDir]);
    expect(
      status.entries.map((entry) => path.dirname(entry.path)).sort(),
    ).toEqual([configuredRoot, projectDir].sort());

    const result = await readWorkspaceAutoMemoryFile(
      workspace,
      path.join(projectDir, 'repo-local.md'),
      { trusted: true },
    );
    expect(result.scope).toBe('project');
    expect(result.content).toBe('repo local note\n');
  });

  it('refuses a project root reached through a symlinked .qwen ancestor', async () => {
    // A repo-tracked `.qwen -> /outside`: lstat of `.qwen/memory` sees a
    // real directory, only the whole-chain check sees the escape.
    const outside = path.join(tmp, 'outside-qwen');
    await writeFile(path.join(outside, 'memory'), 'planted.md', 'planted\n');
    await fs.symlink(outside, path.join(workspace, '.qwen'));

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });
    expect(status.entries).toEqual([]);
    expect(status.projectDirs).toEqual([]);
    expect(status.errors).toEqual([
      expect.objectContaining({
        errorKind: 'symlinked_root',
        hint: projectDir,
      }),
    ]);

    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, 'planted.md'),
        { trusted: true },
      ),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('publishes a relative path present in both project roots once, first root wins', async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    const configuredRoot = getAutoMemoryRoot(workspace);
    await writeFile(configuredRoot, 'shared.md', 'configured copy\n');
    await writeFile(projectDir, 'shared.md', 'repo copy, longer\n');

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.entries.map((entry) => entry.path)).toEqual([
      path.join(configuredRoot, 'shared.md'),
    ]);
    expect(status.fileCount).toBe(1);
    expect(status.totalBytes).toBe('configured copy\n'.length);
  });

  it('never lists the MEMORY.md index, at any depth', async () => {
    await writeFile(projectDir, 'MEMORY.md', '- [notes](notes.md)\n');
    await writeFile(projectDir, 'nested/MEMORY.md', '- index\n');
    await writeFile(projectDir, 'notes.md', 'a note\n');

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.entries.map((entry) => entry.path)).toEqual([
      path.join(projectDir, 'notes.md'),
    ]);
    expect(status.fileCount).toBe(1);
    expect(status.totalBytes).toBe('a note\n'.length);
  });

  it('emits only error kinds of the closed serve and SDK taxonomies', () => {
    for (const kind of AUTO_MEMORY_ERROR_KINDS) {
      expect(SERVE_ERROR_KINDS).toContain(kind);
      expect(DAEMON_ERROR_KINDS).toContain(kind);
    }
  });

  it('records a stat-failed root and keeps the scope initialized', async () => {
    await writeFile(projectDir, 'note.md', 'note\n');
    await writeFile(userDir, 'prefs.md', 'prefs\n');
    const originalStat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation((target) =>
      String(target) === userDir
        ? Promise.reject(
            Object.assign(new Error('EACCES: permission denied, stat'), {
              code: 'EACCES',
            }),
          )
        : originalStat(target),
    );

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.initialized).toBe(true);
    expect(status.entries.map((entry) => path.basename(entry.path))).toEqual([
      'note.md',
    ]);
    expect(status.errors).toEqual([
      expect.objectContaining({
        kind: 'auto_memory_file',
        status: 'error',
        hint: userDir,
        errorKind: 'stat_failed',
      }),
    ]);
  });

  it('records a readdir-failed root and keeps the surviving entries', async () => {
    // The errors[] PRODUCER side: a root that exists but cannot be listed
    // must surface as a readdir_failed cell, not drop the whole listing or
    // 500 the route (the finding's "one unreadable dir -> 500 for the
    // whole listing" regression).
    await writeFile(projectDir, 'note.md', 'note\n');
    await fs.mkdir(userDir, { recursive: true });
    const originalReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((target, opts) =>
      String(target) === userDir
        ? Promise.reject(
            Object.assign(new Error('EACCES: permission denied, scandir'), {
              code: 'EACCES',
            }),
          )
        : originalReaddir(target, opts),
    );

    const status = await collectWorkspaceAutoMemoryStatus(workspace, {
      trusted: true,
    });

    expect(status.initialized).toBe(true);
    expect(status.entries.map((entry) => path.basename(entry.path))).toEqual([
      'note.md',
    ]);
    expect(status.errors).toEqual([
      expect.objectContaining({
        kind: 'auto_memory_file',
        status: 'error',
        hint: userDir,
        errorKind: 'readdir_failed',
      }),
    ]);
  });
});

describe('readWorkspaceAutoMemoryFile', () => {
  it('refuses a path outside both managed roots', async () => {
    const outside = path.join(workspace, 'secret.md');
    await fs.writeFile(outside, 'secret\n');

    await expect(
      readWorkspaceAutoMemoryFile(workspace, outside, { trusted: true }),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('refuses a symlink planted inside a root that escapes it', async () => {
    const outside = path.join(tmp, 'outside.md');
    await fs.writeFile(outside, 'outside\n');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(outside, path.join(projectDir, 'link.md'));

    await expect(
      readWorkspaceAutoMemoryFile(workspace, path.join(projectDir, 'link.md'), {
        trusted: true,
      }),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('reports a missing entry as not_found', async () => {
    await fs.mkdir(projectDir, { recursive: true });

    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, 'missing.md'),
        { trusted: true },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a non-regular path as not_a_file', async () => {
    await fs.mkdir(projectDir, { recursive: true });

    await expect(
      readWorkspaceAutoMemoryFile(workspace, projectDir, { trusted: true }),
    ).rejects.toMatchObject({ code: 'not_a_file' });
  });

  it('serves content with the scope and byte count', async () => {
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'hello\n');

    const result = await readWorkspaceAutoMemoryFile(workspace, file, {
      trusted: true,
    });

    expect(result).toEqual({
      scope: 'project',
      path: file,
      bytes: 6,
      modifiedAt: expect.any(String),
      content: 'hello\n',
    });
  });

  it('truncates content above the 1 MiB cap and flags it', async () => {
    const file = path.join(projectDir, 'big.md');
    await writeFile(projectDir, 'big.md', Buffer.alloc(ONE_MIB + 16, 0x61));

    const result = await readWorkspaceAutoMemoryFile(workspace, file, {
      trusted: true,
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toBe('a'.repeat(ONE_MIB));
    expect(result.bytes).toBe(ONE_MIB + 16);
  });

  it('never serves BOM-prefixed or non-UTF-8 bytes as content', async () => {
    const bomFile = path.join(projectDir, 'bom.md');
    await writeFile(
      projectDir,
      'bom.md',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text\n')]),
    );
    const binaryFile = path.join(projectDir, 'binary.md');
    await writeFile(
      projectDir,
      'binary.md',
      Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01]),
    );

    const bomResult = await readWorkspaceAutoMemoryFile(workspace, bomFile, {
      trusted: true,
    });
    expect(bomResult.content).toBeUndefined();
    expect(bomResult.bytes).toBe(8);

    const binaryResult = await readWorkspaceAutoMemoryFile(
      workspace,
      binaryFile,
      { trusted: true },
    );
    expect(binaryResult.content).toBeUndefined();
    expect(binaryResult.bytes).toBe(6);
  });

  it('refuses a torn read instead of serving partial content', async () => {
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'stable\n');
    const realStat = await fs.stat(file);
    // Simulate the file growing between the pre-read lstat and the read.
    const torn = Object.assign(realStat, { size: realStat.size + 100 });
    const originalLstat = fs.lstat.bind(fs);
    const canonicalFile = await fs.realpath(file);
    vi.spyOn(fs, 'lstat').mockImplementation((target) =>
      String(target) === canonicalFile
        ? Promise.resolve(torn)
        : originalLstat(target),
    );

    const result = await readWorkspaceAutoMemoryFile(workspace, file, {
      trusted: true,
    });

    expect(result.content).toBeUndefined();
    expect(result.bytes).toBe(7);
  });

  it('refuses a torn read when the file changes between open and the post-read stat', async () => {
    // Drives the POST-READ arm of the torn check (after.size/mtimeMs vs the
    // open-time stat), which the lstat-mocked test above short-circuits via
    // tornPre: a write landing between the two handle.stat() calls must be
    // withheld, not served as a stale prefix with no truncated flag.
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'stable\n');
    const realHandle = await fs.open(file, 'r');
    try {
      const s = await realHandle.stat();
      const openedStat = {
        isFile: () => s.isFile(),
        dev: s.dev,
        ino: s.ino,
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
      const afterStat = {
        ...openedStat,
        size: s.size + 5,
        mtimeMs: s.mtimeMs + 1000,
      };
      let statCalls = 0;
      noFollow.handle = {
        stat: async () => {
          statCalls += 1;
          return statCalls === 1 ? openedStat : afterStat;
        },
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => realHandle.read(buffer, offset, length, position),
        close: () => realHandle.close(),
      };
      const result = await readWorkspaceAutoMemoryFile(workspace, file, {
        trusted: true,
      });
      expect(statCalls).toBe(2);
      expect(result.content).toBeUndefined();
      expect(result.contentUnavailable).toBe('torn');
    } finally {
      await realHandle.close();
      noFollow.handle = undefined;
    }
  });

  it('discriminates a torn read from an undecodable file', async () => {
    const bomFile = path.join(projectDir, 'bom.md');
    await writeFile(
      projectDir,
      'bom.md',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text\n')]),
    );
    const tornFile = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'stable\n');
    const realStat = await fs.stat(tornFile);
    const canonicalTorn = await fs.realpath(tornFile);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((target) =>
      String(target) === canonicalTorn
        ? Promise.resolve(
            Object.assign(realStat, { size: realStat.size + 100 }),
          )
        : originalLstat(target),
    );

    const torn = await readWorkspaceAutoMemoryFile(workspace, tornFile, {
      trusted: true,
    });
    const bom = await readWorkspaceAutoMemoryFile(workspace, bomFile, {
      trusted: true,
    });

    expect(torn.content).toBeUndefined();
    expect(torn.contentUnavailable).toBe('torn');
    expect(bom.content).toBeUndefined();
    expect(bom.contentUnavailable).toBe('undecodable');
  });

  it('answers not_found for a path through a regular-file component or an over-long name', async () => {
    await writeFile(projectDir, 'note.md', 'hello\n');

    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, 'note.md', 'child.md'),
        { trusted: true },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, `${'n'.repeat(5000)}.md`),
        { trusted: true },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('classifies an unverifiable-identity open refusal as read_failed', async () => {
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'hello\n');
    noFollow.reject = Object.assign(
      new Error('cannot verify file identity (inode 0)'),
      { code: 'EUNVERIFIABLE' },
    );

    await expect(
      readWorkspaceAutoMemoryFile(workspace, file, { trusted: true }),
    ).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('classifies a non-searchable root directory as read_failed, not outside', async () => {
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'hello\n');
    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation((target) =>
      String(target) === file
        ? Promise.reject(
            Object.assign(
              new Error(`EACCES: permission denied, realpath '${file}'`),
              { code: 'EACCES' },
            ),
          )
        : originalRealpath(target),
    );

    await expect(
      readWorkspaceAutoMemoryFile(workspace, file, { trusted: true }),
    ).rejects.toMatchObject({ code: 'read_failed' });
  });
});

describe('mountWorkspaceAutoMemoryRoutes', () => {
  it('fails closed for an untrusted or unknown workspace', async () => {
    const untrusted = mountApp({ boundWorkspace: workspace, trusted: false });
    const noDep = mountApp({ boundWorkspace: workspace });

    expect(
      (await request(untrusted).get('/workspace/auto-memory')).status,
    ).toBe(403);
    expect((await request(noDep).get('/workspace/auto-memory')).status).toBe(
      403,
    );
    const fileRes = await request(noDep)
      .get('/workspace/auto-memory/file')
      .query({ path: '/any/file.md' });
    expect(fileRes.status).toBe(403);
    expect(fileRes.body.code).toBe('untrusted_workspace');
  });

  it('lists entries on GET /workspace/auto-memory', async () => {
    await writeFile(projectDir, 'notes.md', 'listed\n');
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const res = await request(app).get('/workspace/auto-memory');

    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(true);
    expect(res.body.fileCount).toBe(1);
    expect(res.body.entries[0].title).toBe('notes');
  });

  it('serves a readable entry on GET /workspace/auto-memory/file', async () => {
    await writeFile(projectDir, 'note.md', 'served\n');
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const res = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(projectDir, 'note.md') });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('served\n');
    expect(res.body.scope).toBe('project');
  });

  it('maps read failures to HTTP statuses', async () => {
    const outside = path.join(workspace, 'secret.md');
    await fs.writeFile(outside, 'secret\n');
    await fs.mkdir(projectDir, { recursive: true });
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const missingPath = await request(app).get('/workspace/auto-memory/file');
    expect(missingPath.status).toBe(400);
    expect(missingPath.body.code).toBe('missing_path');

    const outsideRes = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: outside });
    expect(outsideRes.status).toBe(400);
    expect(outsideRes.body.code).toBe('outside');

    const notFound = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(projectDir, 'missing.md') });
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('not_found');
  });

  it('answers 404 not_found when the file vanishes before the open', async () => {
    // The entry was admitted and lstat'ed, then rotated away before
    // openNoFollow: a GONE file is a 404, not a 500 with a stack dump.
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'served\n');
    const canonicalFile = await fs.realpath(file);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (target) => {
      const result = await originalLstat(target);
      if (String(target) === canonicalFile) {
        await fs.rm(file, { force: true });
      }
      return result;
    });
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const res = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: file });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('refuses a relative path input instead of resolving it against a managed root', async () => {
    // The entry exists in the project root, so a relative `?path=` that were
    // resolved against either root would be served; with the process cwd
    // outside both roots it must be refused as outside.
    await writeFile(projectDir, 'note.md', 'served\n');
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const res = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: 'note.md' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('outside');
  });

  it('serves a project entry created after an earlier read warmed the cache with the literal root', async () => {
    // The bound workspace is reached THROUGH A SYMLINK so the literal
    // project-root path differs from its canonical form (a portable stand-in
    // for /tmp -> /private/tmp). Reading a user entry first, while the
    // project root does not exist yet, must not pin a stale literal that
    // later refuses the now-existing project root.
    const realWs = path.join(tmp, 'real-ws');
    await fs.mkdir(realWs, { recursive: true });
    const wsLink = path.join(tmp, 'ws-link');
    await fs.symlink(realWs, wsLink);
    const app = mountApp({ boundWorkspace: wsLink, trusted: true });

    // Warm the canonicalization cache with the absent project root via a
    // user-scope read.
    await writeFile(userDir, 'user-note.md', 'user memory\n');
    const userRes = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(userDir, 'user-note.md') });
    expect(userRes.status).toBe(200);
    expect(userRes.body.content).toBe('user memory\n');

    // The project root is created afterwards; its entry must still be served
    // (the stale literal must not have pinned the containment boundary).
    await writeFile(
      path.join(realWs, '.qwen', 'memory'),
      'note.md',
      'project memory\n',
    );
    const projectRes = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(wsLink, '.qwen', 'memory', 'note.md') });
    expect(projectRes.status).toBe(200);
    expect(projectRes.body.content).toBe('project memory\n');
    expect(projectRes.body.scope).toBe('project');
  });

  it('re-resolves the user root created after an earlier read cached the literal', async () => {
    // The memory base sits under a symlink so the literal user root differs
    // from its canonical form. A read while memories/ does not exist yet
    // warms the canonicalization cache with the literal root; creating the
    // entry through the real base afterwards must still be served — a bare
    // cached literal would answer 400 outside, because the file resolves to
    // the real base, not the symlinked literal.
    const realBase = path.join(tmp, 'real-base');
    await fs.mkdir(realBase, { recursive: true });
    const baseLink = path.join(tmp, 'base-link');
    await fs.symlink(realBase, baseLink);
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = baseLink;
    clearAutoMemoryRootCache();
    const literalRoot = path.join(baseLink, 'memories');
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    // (1) warm the cache with the literal user root while it is absent.
    const res1 = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(literalRoot, 'note.md') });
    expect(res1.status).toBe(404);
    expect(res1.body.code).toBe('not_found');

    // (2) create the entry through the REAL base and re-request the same
    // literal path; the route must re-canonicalize the root at request time.
    await writeFile(realBase, 'memories/note.md', 'created later\n');
    const res2 = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(literalRoot, 'note.md') });
    expect(res2.status).toBe(200);
    expect(res2.body.scope).toBe('user');
    expect(res2.body.content).toBe('created later\n');
  });

  it('resolves the roots under the runtime storage scope when a runtime is mounted', async () => {
    // With the memory-base env cleared, the ambient user root is the global
    // qwen dir; the mounted runtime's session base dir must pin a different
    // one, and the listing must reflect it.
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    clearAutoMemoryRootCache();
    const runtimeBase = path.join(tmp, 'runtime-base');
    await writeFile(path.join(runtimeBase, 'memories'), 'prefs.md', 'prefs\n');
    const app = express();
    mountWorkspaceAutoMemoryRoutes(app, {
      boundWorkspace: workspace,
      isWorkspaceTrusted: () => true,
      runtime: { sessionRuntimeBaseDir: runtimeBase },
    });

    const res = await request(app).get('/workspace/auto-memory');

    expect(res.status).toBe(200);
    expect(res.body.userDir).toBe(path.join(runtimeBase, 'memories'));
    expect(res.body.fileCount).toBe(1);
    expect(res.body.entries[0].title).toBe('prefs');

    // The read route resolves under the same runtime scope as the listing:
    // the entry it advertised is served.
    const fileRes = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(runtimeBase, 'memories', 'prefs.md') });
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.scope).toBe('user');
    expect(fileRes.body.content).toBe('prefs\n');
  });

  it('resolves the PROJECT root under the runtime storage scope outside local mode', async () => {
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    clearAutoMemoryRootCache();
    const runtimeBase = path.join(tmp, 'runtime-base');
    const app = mountApp({
      boundWorkspace: workspace,
      trusted: true,
      runtime: { sessionRuntimeBaseDir: runtimeBase },
    });

    const res = await request(app).get('/workspace/auto-memory');

    expect(res.status).toBe(200);
    expect(res.body.projectDir).toBe(
      path.join(runtimeBase, 'projects', sanitizeCwd(workspace), 'memory'),
    );
  });

  it('resolves the project root on the runtime memory project scope, not the daemon ambient one', async () => {
    // A workspace bound to a git-repo SUBDIRECTORY (the monorepo case):
    // the daemon's ambient scope (unset -> git-root) keys the partition
    // by the repo root, while the runtime's sessions run with
    // QWEN_CODE_MEMORY_PROJECT_SCOPE=workspace and write the
    // workspace-keyed partition. The routes must follow the sessions.
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
    clearAutoMemoryRootCache();
    const repo = path.join(tmp, 'repo');
    const subWorkspace = path.join(repo, 'packages', 'app');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(subWorkspace, { recursive: true });
    const workspaceKeyed = path.join(
      globalBase,
      'projects',
      sanitizeCwd(subWorkspace),
      'memory',
    );
    const gitRootKeyed = path.join(
      globalBase,
      'projects',
      sanitizeCwd(repo),
      'memory',
    );
    await writeFile(workspaceKeyed, 'session.md', 'from the session\n');
    await writeFile(gitRootKeyed, 'other.md', 'another partition\n');
    const app = mountApp({
      boundWorkspace: subWorkspace,
      trusted: true,
      runtime: overlayRuntime(path.join(tmp, 'runtime-base'), {
        QWEN_CODE_MEMORY_PROJECT_SCOPE: 'workspace',
      }),
    });

    const res = await request(app).get('/workspace/auto-memory');
    expect(res.status).toBe(200);
    expect(res.body.projectDir).toBe(workspaceKeyed);
    expect(
      res.body.entries.map((entry: { path: string }) => entry.path),
    ).toEqual([path.join(workspaceKeyed, 'session.md')]);

    const served = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(workspaceKeyed, 'session.md') });
    expect(served.status).toBe(200);
    const refused = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(gitRootKeyed, 'other.md') });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('outside');
  });

  it('refuses a runtime whose sessions pin a different process-global memory override', async () => {
    const app = mountApp({
      boundWorkspace: workspace,
      trusted: true,
      runtime: overlayRuntime(path.join(tmp, 'runtime-base'), {
        QWEN_CODE_MEMORY_BASE_DIR: path.join(tmp, 'elsewhere'),
      }),
    });

    const listing = await request(app).get('/workspace/auto-memory');
    expect(listing.status).toBe(409);
    expect(listing.body).toMatchObject({
      code: 'auto_memory_env_override_unsupported',
      key: 'QWEN_CODE_MEMORY_BASE_DIR',
    });
    const read = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(userDir, 'x.md') });
    expect(read.status).toBe(409);
  });

  it('answers 404 for a path through a regular-file component', async () => {
    await writeFile(projectDir, 'note.md', 'hello\n');
    const app = mountApp({ boundWorkspace: workspace, trusted: true });

    const res = await request(app)
      .get('/workspace/auto-memory/file')
      .query({ path: path.join(projectDir, 'note.md', 'child.md') });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('mountWorkspaceQualifiedAutoMemoryRoutes', () => {
  function registryOf(
    runtimes: Array<
      Pick<
        WorkspaceRuntime,
        'workspaceId' | 'workspaceCwd' | 'sessionRuntimeBaseDir' | 'trusted'
      > & { env: WorkspaceRuntime['env'] }
    >,
  ): WorkspaceRegistry {
    const entries = runtimes.map(
      (runtime) =>
        ({
          workspaceId: runtime.workspaceId,
          workspaceCwd: runtime.workspaceCwd,
          state: 'active',
          current: { runtime },
        }) as unknown as WorkspaceEntry,
    );
    return {
      getEntryByWorkspaceId: (id: string) =>
        entries.find((entry) => entry.workspaceId === id),
      getEntryByWorkspaceCwd: (cwd: string) =>
        entries.find((entry) => entry.workspaceCwd === cwd),
      listEntries: () => entries,
    } as unknown as WorkspaceRegistry;
  }

  it('serves the SELECTED workspace, never the primary', async () => {
    const primaryWs = path.join(tmp, 'primary');
    const secondaryWs = path.join(tmp, 'secondary');
    await writeFile(
      path.join(primaryWs, '.qwen', 'memory'),
      'primary.md',
      'primary note\n',
    );
    await writeFile(
      path.join(secondaryWs, '.qwen', 'memory'),
      'secondary.md',
      'secondary note\n',
    );
    const env = {
      mode: 'parent-process' as const,
      overlayKeys: [],
    };
    const app = express();
    mountWorkspaceQualifiedAutoMemoryRoutes(app, {
      workspaceRegistry: registryOf([
        {
          workspaceId: 'primary-id',
          workspaceCwd: primaryWs,
          sessionRuntimeBaseDir: path.join(tmp, 'rt-primary'),
          trusted: true,
          env,
        },
        {
          workspaceId: 'secondary-id',
          workspaceCwd: secondaryWs,
          sessionRuntimeBaseDir: path.join(tmp, 'rt-secondary'),
          trusted: true,
          env,
        },
      ]),
    });

    const res = await request(app).get(
      `/workspaces/${encodeURIComponent(secondaryWs)}/auto-memory`,
    );
    expect(res.status).toBe(200);
    expect(res.body.workspaceCwd).toBe(secondaryWs);
    expect(res.body.projectDir).toBe(path.join(secondaryWs, '.qwen', 'memory'));
    expect(
      res.body.entries.map((entry: { path: string }) =>
        path.basename(entry.path),
      ),
    ).toEqual(['secondary.md']);

    const file = await request(app)
      .get('/workspaces/secondary-id/auto-memory/file')
      .query({
        path: path.join(secondaryWs, '.qwen', 'memory', 'secondary.md'),
      });
    expect(file.status).toBe(200);
    expect(file.body.content).toBe('secondary note\n');
    const crossRead = await request(app)
      .get('/workspaces/secondary-id/auto-memory/file')
      .query({ path: path.join(primaryWs, '.qwen', 'memory', 'primary.md') });
    expect(crossRead.status).toBe(400);
    expect(crossRead.body.code).toBe('outside');
  });

  it('refuses an untrusted workspace', async () => {
    const app = express();
    mountWorkspaceQualifiedAutoMemoryRoutes(app, {
      workspaceRegistry: registryOf([
        {
          workspaceId: 'ws-id',
          workspaceCwd: workspace,
          sessionRuntimeBaseDir: path.join(tmp, 'rt'),
          trusted: false,
          env: { mode: 'parent-process', overlayKeys: [] },
        },
      ]),
    });

    const res = await request(app).get('/workspaces/ws-id/auto-memory');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
  });
});
