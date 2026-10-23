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
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  collectWorkspaceAutoMemoryStatus,
  mountWorkspaceAutoMemoryRoutes,
  readWorkspaceAutoMemoryFile,
} from './workspace-auto-memory.js';

const ONE_MIB = 1024 * 1024;

async function writeFile(dir: string, rel: string, content: string | Buffer) {
  const absolute = path.join(dir, rel);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

function mountApp(opts: { boundWorkspace: string; trusted?: boolean }) {
  const app = express();
  const trusted = opts.trusted;
  mountWorkspaceAutoMemoryRoutes(app, {
    boundWorkspace: opts.boundWorkspace,
    ...(trusted === undefined ? {} : { isWorkspaceTrusted: () => trusted }),
  });
  return app;
}

let tmp: string;
let workspace: string;
let globalBase: string;
let projectDir: string;
let userDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-auto-memory-'));
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
      projectDir,
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

    const result = await readWorkspaceAutoMemoryFile(
      workspace,
      path.join(projectDir, 'repo-local.md'),
      { trusted: true },
    );
    expect(result.scope).toBe('project');
    expect(result.content).toBe('repo local note\n');
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
  });
});
