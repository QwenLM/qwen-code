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
import { makeFakeConfig } from '../test-utils/config.js';
import { ToolErrorType } from './tool-error.js';
import { RecordArtifactTool } from './record-artifact.js';

const signal = new AbortController().signal;

function makeTool(targetDir = '/') {
  return new RecordArtifactTool(makeFakeConfig({ targetDir, cwd: targetDir }));
}

async function createWorkspace(subdir?: string) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'record-artifact-')),
  );
  const cwd = subdir ? path.join(root, subdir) : root;
  if (subdir) {
    await mkdir(cwd, { recursive: true });
  }
  return {
    root,
    cwd,
    tool: makeTool(cwd),
    async write(rel: string, content = 'artifact-bytes') {
      const abs = path.join(cwd, rel);
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

  async function workspace(subdir?: string) {
    const created = await createWorkspace(subdir);
    workspaces.push(created);
    return created;
  }

  it('records a link artifact without touching the resource', async () => {
    const tool = makeTool();
    const result = await tool
      .build({
        title: 'Table details',
        url: 'https://example.com/tables/orders',
        metadata: { table: 'orders' },
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      {
        title: 'Table details',
        storage: 'external_url',
        url: 'https://example.com/tables/orders',
        metadata: { table: 'orders' },
      },
    ]);
  });

  it('records a managed artifact with inferred storage', async () => {
    const tool = makeTool();

    await expect(
      tool
        .build({
          title: 'Managed preview',
          managedId: 'ext-123',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [
        {
          title: 'Managed preview',
          storage: 'managed',
          managedId: 'ext-123',
        },
      ],
    });
  });

  it('records a cwd-relative workspace file as a root-relative canonical path', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', '<html>ok</html>');

    const result = await ws.tool
      .build({
        title: 'Workspace report',
        workspacePath: 'reports/summary.html',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      {
        title: 'Workspace report',
        storage: 'workspace',
        workspacePath: 'reports/summary.html',
        sizeBytes: '<html>ok</html>'.length,
      },
    ]);
    expect(String(result.llmContent)).toContain('status: available');
    expect(String(result.llmContent)).toContain(
      'workspacePath: reports/summary.html',
    );
    expect(String(result.llmContent)).toContain(
      `resolvedPath: ${path.join(ws.cwd, 'reports/summary.html')}`,
    );
  });

  it('normalizes a cwd-absolute workspace path to the canonical relative path', async () => {
    const ws = await workspace();
    const abs = await ws.write('report.csv', 'a,b\n1,2\n');

    const result = await ws.tool
      .build({
        title: 'CSV report',
        workspacePath: abs,
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      storage: 'workspace',
      workspacePath: 'report.csv',
    });
    expect(String(result.llmContent)).toContain('status: available');
    expect(String(result.llmContent)).toContain('workspacePath: report.csv');
  });

  it('accepts a POSIX double-slash absolute locator inside the workspace', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const ws = await workspace();
    await ws.write('report.csv', 'a,b\n');
    const doubled = `/${path.join(ws.cwd, 'report.csv')}`;

    const result = await ws.tool
      .build({
        title: 'Double slash',
        workspacePath: doubled,
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'report.csv',
    });
  });

  it('accepts a long absolute locator when the canonical path is short', async () => {
    const deep = Array.from({ length: 50 }, () => 'dddddddddd').join(path.sep);
    const ws = await workspace(deep);
    const abs = await ws.write('a.csv', '1');
    expect(abs.length).toBeGreaterThan(500);

    const result = await ws.tool
      .build({
        title: 'Deep',
        workspacePath: abs,
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'a.csv',
    });
  });

  it('records a POSIX filename that contains a literal backslash', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const ws = await workspace();
    const literal = 'reports\\summary.csv';
    await writeFile(path.join(ws.cwd, literal), 'a,b\n');

    const result = await ws.tool
      .build({
        title: 'Literal backslash',
        workspacePath: literal,
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'reports\\summary.csv',
    });
  });

  it('normalizes Windows-style relative separators to posix', async () => {
    const ws = await workspace();
    await ws.write('reports/summary.html', '<html>ok</html>');

    const result = await ws.tool
      .build({
        title: 'Windows-style relative report',
        workspacePath: 'reports\\summary.html',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'reports/summary.html',
    });
  });

  it('canonicalizes a worktree-relative path against the bound workspace root', async () => {
    const ws = await workspace(path.join('.qwen', 'worktrees', 'my-feature'));
    await ws.write('report.csv', 'a,b\n');

    const result = await ws.tool
      .build({
        title: 'Worktree report',
        workspacePath: 'report.csv',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: '.qwen/worktrees/my-feature/report.csv',
    });
    expect(String(result.llmContent)).toContain(
      'workspacePath: .qwen/worktrees/my-feature/report.csv',
    );
  });

  it('does not fall back to the workspace root when a relative path misses in the worktree cwd', async () => {
    const ws = await workspace(path.join('.qwen', 'worktrees', 'my-feature'));
    await mkdir(path.join(ws.root, 'docs'), { recursive: true });
    await writeFile(path.join(ws.root, 'docs/review.md'), '# review');

    const result = await ws.tool
      .build({
        title: 'Root review',
        workspacePath: 'docs/review.md',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('accepts an absolute path inside the bound workspace from a worktree session', async () => {
    const ws = await workspace(path.join('.qwen', 'worktrees', 'my-feature'));
    const abs = path.join(ws.root, 'docs/review.md');
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '# review');

    const result = await ws.tool
      .build({
        title: 'Absolute review',
        workspacePath: abs,
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'docs/review.md',
    });
  });

  it('accepts an absolute path that names the workspace through a symlink prefix', async () => {
    const ws = await workspace();
    await ws.write('report.csv', 'a,b\n');
    const aliasRoot = path.join(
      os.tmpdir(),
      `record-artifact-alias-${process.pid}-${Date.now()}`,
    );
    await symlink(ws.root, aliasRoot);
    workspaces.push({
      cleanup: async () => {
        await rm(aliasRoot, { force: true });
      },
    });

    const result = await ws.tool
      .build({
        title: 'Symlink prefix',
        workspacePath: path.join(aliasRoot, 'report.csv'),
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'report.csv',
    });
  });

  it('reports missing instead of outside when a symlink-root absolute path has no parent', async () => {
    const ws = await workspace();
    const aliasRoot = path.join(
      os.tmpdir(),
      `record-artifact-missing-${process.pid}-${Date.now()}`,
    );
    await symlink(ws.root, aliasRoot);
    workspaces.push({
      cleanup: async () => {
        await rm(aliasRoot, { force: true });
      },
    });

    const result = await ws.tool
      .build({
        title: 'Missing parent',
        workspacePath: path.join(aliasRoot, 'no-such-dir', 'a.csv'),
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expect(String(result.llmContent)).not.toContain('outside the workspace');
  });

  it('rejects a canonical workspacePath that fails display safety checks', async () => {
    const ws = await workspace();
    const nasty = path.join(ws.cwd, 'reports', 'actual\u202eforged.csv');
    await mkdir(path.dirname(nasty), { recursive: true });
    await writeFile(nasty, 'x');
    await symlink(nasty, path.join(ws.cwd, 'safe.csv'));

    const result = await ws.tool
      .build({
        title: 'Safe link',
        workspacePath: 'safe.csv',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
  });

  it('rejects a fifo workspacePath', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const ws = await workspace();
    const fifo = path.join(ws.cwd, 'pipe.fifo');
    const created = spawnSync('mkfifo', [fifo]);
    if (created.status !== 0) {
      return;
    }

    const result = await ws.tool
      .build({
        title: 'Fifo',
        workspacePath: 'pipe.fifo',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.TARGET_NOT_REGULAR_FILE);
  });

  it('classifies an unreadable path as permission denied', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return;
    }
    const ws = await workspace();
    const hidden = path.join(ws.cwd, 'hidden');
    await mkdir(hidden);
    await writeFile(path.join(hidden, 'a.csv'), 'x');
    await chmod(hidden, 0);
    try {
      const result = await ws.tool
        .build({
          title: 'Hidden',
          workspacePath: 'hidden/a.csv',
        })
        .execute(signal);
      expect(result.error?.type).toBe(ToolErrorType.PERMISSION_DENIED);
      expect(result.artifacts).toBeUndefined();
    } finally {
      await chmod(hidden, 0o755);
    }
  });

  it('rejects a wrong workspace-folder prefix instead of reporting success', async () => {
    const ws = await workspace();
    await ws.write('report.csv', 'a,b\n');

    const result = await ws.tool
      .build({
        title: 'Wrong prefix',
        workspacePath: 'w/agent/report.csv',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
    expect(String(result.llmContent)).toContain('file not found');
    expect(String(result.llmContent)).toContain('report.csv');
    expect(String(result.llmContent)).toContain('w/agent/');
  });

  it('rejects a missing workspace file instead of reporting success', async () => {
    const ws = await workspace();

    const result = await ws.tool
      .build({
        title: 'Missing',
        workspacePath: 'missing.csv',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('rejects an empty directory workspacePath', async () => {
    const ws = await workspace();
    await mkdir(path.join(ws.cwd, 'reports'));

    const result = await ws.tool
      .build({
        title: 'Directory',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.artifacts).toBeUndefined();
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
    expect(String(result.llmContent)).toContain('no recordable files');
  });

  it('expands a directory workspacePath into per-file artifacts', async () => {
    const ws = await workspace();
    await ws.write('reports/a.xlsx', 'xlsx');
    await ws.write('reports/b.docx', 'docx');
    await ws.write('reports/.hidden.xlsx', 'hidden');
    await ws.write('reports/~$lock.xlsx', 'lock');
    await ws.write('reports/nested/c.pptx', 'pptx');

    const result = await ws.tool
      .build({
        title: 'Daily reports',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toContain('Expanded directory');
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
    expect(String(result.llmContent)).toContain('reports/a.xlsx');
    expect(result.artifacts).toMatchObject([
      {
        title: 'a.xlsx',
        storage: 'workspace',
        workspacePath: 'reports/a.xlsx',
        description: 'Daily reports',
      },
      {
        title: 'b.docx',
        storage: 'workspace',
        workspacePath: 'reports/b.docx',
        description: 'Daily reports',
      },
      {
        title: 'c.pptx',
        storage: 'workspace',
        workspacePath: 'reports/nested/c.pptx',
        description: 'Daily reports',
        metadata: { expandedFromDirectory: true },
      },
    ]);
  });

  it('discloses the 100-file cap when expanding a large directory', async () => {
    const ws = await workspace();
    for (let index = 0; index < 101; index++) {
      await ws.write(`reports/f${String(index).padStart(3, '0')}.txt`, 'x');
    }

    const result = await ws.tool
      .build({
        title: 'Many',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toHaveLength(100);
    expect(String(result.llmContent)).toMatch(/first 100 files/i);
  });

  it('rejects expanding a junk directory root', async () => {
    const ws = await workspace();
    await ws.write('node_modules/pkg/index.js', 'js');

    const result = await ws.tool
      .build({
        title: 'Deps',
        workspacePath: 'node_modules',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.artifacts).toBeUndefined();
  });

  it('rejects expanding a path nested under a junk directory', async () => {
    const ws = await workspace();
    await ws.write('node_modules/react/index.js', 'js');

    const result = await ws.tool
      .build({
        title: 'React',
        workspacePath: 'node_modules/react',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.artifacts).toBeUndefined();
    expect(String(result.llmContent)).toContain('skipped directory');
  });

  it('skips expansion children whose names are not trim-stable', async () => {
    const ws = await workspace();
    await ws.write('notes/keep.txt', 'ok');
    await writeFile(path.join(ws.cwd, 'notes', ' report.txt'), 'space');

    const result = await ws.tool
      .build({
        title: 'Notes',
        workspacePath: 'notes',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      { workspacePath: 'notes/keep.txt' },
    ]);
    expect(String(result.llmContent)).toMatch(/Skipped 1 files/i);
  });

  it('rejects recording the worktree cwd as a directory', async () => {
    const ws = await workspace(path.join('.qwen', 'worktrees', 'my-feature'));
    await ws.write('keep.xlsx', 'xlsx');

    const result = await ws.tool
      .build({
        title: 'Worktree root',
        workspacePath: '.',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.artifacts).toBeUndefined();
    expect(String(result.llmContent)).toContain('workspace root');
  });

  it('expands a subdirectory inside a worktree session', async () => {
    const ws = await workspace(path.join('.qwen', 'worktrees', 'my-feature'));
    await ws.write('reports/a.xlsx', 'xlsx');
    await ws.write('reports/b.docx', 'docx');

    const result = await ws.tool
      .build({
        title: 'Worktree reports',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      {
        workspacePath: '.qwen/worktrees/my-feature/reports/a.xlsx',
      },
      {
        workspacePath: '.qwen/worktrees/my-feature/reports/b.docx',
      },
    ]);
  });

  it('skips junk directories and lock files when expanding a directory', async () => {
    const ws = await workspace();
    await ws.write('reports/keep.xlsx', 'xlsx');
    await ws.write('reports/node_modules/skip.txt', 'skip');
    await ws.write('reports/~$lock.xlsx', 'lock');

    const result = await ws.tool
      .build({
        title: 'Reports',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      { workspacePath: 'reports/keep.xlsx' },
    ]);
    expect(String(result.llmContent)).not.toContain('node_modules');
  });

  it('warns when directory expansion hits the depth limit', async () => {
    const ws = await workspace();
    await ws.write('reports/a/b/c/d/e/too-deep.xlsx', 'deep');
    await ws.write('reports/shallow.xlsx', 'xlsx');

    const result = await ws.tool
      .build({
        title: 'Reports',
        workspacePath: 'reports',
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      { workspacePath: 'reports/shallow.xlsx' },
    ]);
    expect(String(result.llmContent)).toMatch(
      /deeper than 4 directory levels/i,
    );
  });

  it('rejects a workspace-relative path that escapes the execution directory', () => {
    const tool = makeTool();

    for (const workspacePath of [
      '../secret.txt',
      '..\\secret.txt',
      '..\\..\\secret.txt',
      'reports\\..\\..\\secret.txt',
      'reports/..\\..\\secret.txt',
    ]) {
      expect(() =>
        tool.build({
          title: 'Escape',
          workspacePath,
        }),
      ).toThrow(/workspacePath/);
    }
  });

  it('rejects UNC locators before resolving them', () => {
    const tool = makeTool();

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
      expect(() =>
        tool.build({
          title: 'UNC',
          workspacePath,
        }),
      ).toThrow(/workspacePath/);
    }
  });

  it('rejects Windows drive and UNC locators on POSIX', () => {
    if (process.platform === 'win32') {
      return;
    }
    const tool = makeTool();

    for (const workspacePath of [
      'C:\\tmp\\report.html',
      'C:/tmp/report.html',
      'C:tmp\\report.html',
      '\\\\server\\share\\report.html',
      '\\tmp\\report.html',
    ]) {
      expect(() =>
        tool.build({
          title: 'Escape',
          workspacePath,
        }),
      ).toThrow(/workspacePath/);
    }
  });

  it('rejects an absolute path outside the execution directory', async () => {
    const ws = await workspace();
    const outside = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'record-artifact-outside-')),
    );
    const outsideFile = path.join(outside, 'secret.csv');
    await writeFile(outsideFile, 'secret');
    workspaces.push({
      cleanup: async () => {
        await rm(outside, { recursive: true, force: true });
      },
    });

    expect(() =>
      ws.tool.build({
        title: 'Outside',
        workspacePath: outsideFile,
      }),
    ).toThrow(/workspace/);
  });

  it('rejects a symlink that escapes the execution directory', async () => {
    const ws = await workspace();
    const outside = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'record-artifact-link-')),
    );
    const secret = path.join(outside, 'secret.csv');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(ws.cwd, 'escape.csv'));
    workspaces.push({
      cleanup: async () => {
        await rm(outside, { recursive: true, force: true });
      },
    });

    const result = await ws.tool
      .build({
        title: 'Escape link',
        workspacePath: 'escape.csv',
      })
      .execute(signal);

    expect(result.error?.type).toBe(ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('rejects a workspace symlink whose target is a UNC path', async () => {
    const ws = await workspace();
    try {
      await symlink(
        '\\\\attacker.example\\share\\report.csv',
        path.join(ws.cwd, 'report.csv'),
      );
    } catch {
      return;
    }

    const result = await ws.tool
      .build({
        title: 'UNC link',
        workspacePath: 'report.csv',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('rejects a UNC target reached through an intermediate directory symlink', async () => {
    const ws = await workspace();
    try {
      await symlink('\\\\attacker.example\\share', path.join(ws.cwd, 'docs'));
    } catch {
      return;
    }

    const result = await ws.tool
      .build({
        title: 'UNC dir',
        workspacePath: 'docs/q3.csv',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('rejects a two-hop symlink chain that ends at a UNC path', async () => {
    const ws = await workspace();
    try {
      await symlink(
        '\\\\attacker.example\\share\\x.csv',
        path.join(ws.cwd, 'b.csv'),
      );
      await symlink('b.csv', path.join(ws.cwd, 'a.csv'));
    } catch {
      return;
    }

    const result = await ws.tool
      .build({
        title: 'UNC chain',
        workspacePath: 'a.csv',
      })
      .execute(signal);

    expect(result.artifacts).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.PATH_NOT_IN_WORKSPACE);
    expect(String(result.llmContent)).not.toContain('Recorded artifact');
  });

  it('names the legacy path field instead of asking for a locator', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Legacy path',
        path: 'report.csv',
      } as never),
    ).toThrow(/"path" is not supported.*workspacePath/);
  });

  it('rejects unknown fields such as artifactType', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Unknown field',
        url: 'https://example.com/resource',
        artifactType: 'csv',
      } as never),
    ).toThrow(/additional properties/);
  });

  it('rejects published storage', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Forged',
        storage: 'published' as never,
        url: 'https://example.com/artifact',
      }),
    ).toThrow(/allowed values/);
  });

  it('requires exactly one locator', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Ambiguous',
        workspacePath: 'report.html',
        url: 'https://example.com/report',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects unsafe urls before reporting success', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Credentials',
        url: 'https://user:pass@example.com/resource',
      }),
    ).toThrow(/credentials/);

    expect(() =>
      tool.build({
        title: 'FTP',
        url: 'ftp://example.com/resource',
      }),
    ).toThrow(/http or https/);
  });

  it('rejects path-like managed ids before reporting success', () => {
    const tool = makeTool();

    for (const managedId of ['../secret', 'folder/item', 'folder\\item']) {
      expect(() =>
        tool.build({
          title: 'Managed path',
          managedId,
        }),
      ).toThrow(/opaque managed resource id/);
    }
  });

  it('rejects storage values that do not match the locator', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Workspace mismatch',
        storage: 'external_url',
        workspacePath: 'report.html',
      }),
    ).toThrow(/storage.*workspace/);
  });

  it('rejects artifact metadata that the daemon store would drop', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Huge metadata',
        url: 'https://example.com/resource',
        metadata: { value: 'x'.repeat(4096) },
      }),
    ).toThrow(/metadata/);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        tool.build({
          title: 'Non-finite metadata',
          url: 'https://example.com/resource',
          metadata: { value },
        }),
      ).toThrow(/metadata/);
    }
  });

  it('rejects invalid artifact sizes before reporting success', () => {
    const tool = makeTool();

    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        tool.build({
          title: 'Sized artifact',
          url: 'https://example.com/resource',
          sizeBytes,
        }),
      ).toThrow(/sizeBytes/);
    }
  });

  it('rejects unsafe display markup before reporting success', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: '<script>alert(1)</script>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'External style',
        description: '<style>body{display:none}</style>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Entity payload',
        description: '&#x3c;script&#x3e;',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Script data url',
        description: 'data:text/javascript,alert(1)',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'SVG data url',
        description: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'HTML mime',
        mimeType: 'text/html<script>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Workspace payload',
        workspacePath: '<img src=x onerror=alert(1)>.html',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Managed payload',
        managedId: '<script>alert(1)</script>',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Metadata key',
        url: 'https://example.com/resource',
        metadata: { '<script>': 'unsafe key' },
      }),
    ).toThrow(/metadata/);

    expect(() =>
      tool.build({
        title: 'Metadata value',
        url: 'https://example.com/resource',
        metadata: { preview: 'data:text/javascript,alert(1)' },
      }),
    ).toThrow(/metadata/);
  });

  it('allows benign words ending with on before equals signs', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'conversation=value',
        description: 'configuration=value',
        url: 'https://example.com/resource',
      }),
    ).not.toThrow();
  });

  it('rejects Unicode control characters before reporting success', () => {
    const tool = makeTool();

    expect(() =>
      tool.build({
        title: 'Hidden\u202eTitle',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      tool.build({
        title: 'safe\u2028evil',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      tool.build({
        title: 'safe\u2066evil',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      tool.build({
        title: 'Metadata key',
        url: 'https://example.com/resource',
        metadata: { 'preview\u200b': 'hidden' },
      }),
    ).toThrow(/metadata/);
  });

  it('accepts line whitespace in descriptions but not titles', async () => {
    const tool = makeTool();

    await expect(
      tool
        .build({
          title: 'Multiline report',
          description: 'Line one\nLine two\tindented\r\nLine three',
          url: 'https://example.com/resource',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [
        {
          description: 'Line one\nLine two\tindented\r\nLine three',
        },
      ],
    });

    expect(() =>
      tool.build({
        title: 'Bad\nTitle',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);
  });
});
