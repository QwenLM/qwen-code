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
import { clearAutoMemoryRootCache } from '@qwen-code/qwen-code-core/memory/paths.js';
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

    const status = await collectWorkspaceAutoMemoryStatus(workspace);

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

    const status = await collectWorkspaceAutoMemoryStatus(workspace);

    expect(status.entries.map((entry) => path.basename(entry.path))).toEqual([
      'real.md',
    ]);
  });

  it('stops scanning below the depth limit', async () => {
    await writeFile(projectDir, 'a/b/c/at-limit.md', 'deep but listed\n');
    await writeFile(projectDir, 'a/b/c/d/below-limit.md', 'too deep\n');

    const status = await collectWorkspaceAutoMemoryStatus(workspace);

    expect(status.entries.map((entry) => entry.path)).toEqual([
      path.join(projectDir, 'a/b/c/at-limit.md'),
    ]);
  });
});

describe('readWorkspaceAutoMemoryFile', () => {
  it('refuses a path outside both managed roots', async () => {
    const outside = path.join(workspace, 'secret.md');
    await fs.writeFile(outside, 'secret\n');

    await expect(
      readWorkspaceAutoMemoryFile(workspace, outside),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('refuses a symlink planted inside a root that escapes it', async () => {
    const outside = path.join(tmp, 'outside.md');
    await fs.writeFile(outside, 'outside\n');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(outside, path.join(projectDir, 'link.md'));

    await expect(
      readWorkspaceAutoMemoryFile(workspace, path.join(projectDir, 'link.md')),
    ).rejects.toMatchObject({ code: 'outside' });
  });

  it('reports a missing entry as not_found', async () => {
    await fs.mkdir(projectDir, { recursive: true });

    await expect(
      readWorkspaceAutoMemoryFile(
        workspace,
        path.join(projectDir, 'missing.md'),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a non-regular path as not_a_file', async () => {
    await fs.mkdir(projectDir, { recursive: true });

    await expect(
      readWorkspaceAutoMemoryFile(workspace, projectDir),
    ).rejects.toMatchObject({ code: 'not_a_file' });
  });

  it('serves content with the scope and byte count', async () => {
    const file = path.join(projectDir, 'note.md');
    await writeFile(projectDir, 'note.md', 'hello\n');

    const result = await readWorkspaceAutoMemoryFile(workspace, file);

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

    const result = await readWorkspaceAutoMemoryFile(workspace, file);

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

    const bomResult = await readWorkspaceAutoMemoryFile(workspace, bomFile);
    expect(bomResult.content).toBeUndefined();
    expect(bomResult.bytes).toBe(8);

    const binaryResult = await readWorkspaceAutoMemoryFile(
      workspace,
      binaryFile,
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
    vi.spyOn(fs, 'lstat').mockImplementation((target) =>
      String(target) === file ? Promise.resolve(torn) : originalLstat(target),
    );

    const result = await readWorkspaceAutoMemoryFile(workspace, file);

    expect(result.content).toBeUndefined();
    expect(result.bytes).toBe(7);
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
});
