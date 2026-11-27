/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceContext } from './workspaceContext.js';
import { runLogger } from './runLogger.js';

// The share under test is not reachable, so registration has to be observed
// against a mocked filesystem: existsSync/statSync must report it as a valid
// directory, and realpathSync must stay a pass-through spy so the calls it does
// and does not receive are visible.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

describe('WorkspaceContext network directories', () => {
  let tempDir: string;
  let cwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-context-net-'));
    cwd = fs.realpathSync(tempDir);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Shape classification is platform-independent and WorkspaceContext does not
  // consult the Windows-only enforcement gate, so these run on every CI OS.
  it.each([
    ['backslash UNC', '\\\\server\\share'],
    ['slash UNC', '//server/share'],
    ['extended UNC', '\\\\?\\UNC\\server\\share'],
  ])('registers %s as a working directory', (_label, dir) => {
    const context = new WorkspaceContext(cwd);

    const result = context.addDirectories([dir]);

    expect(result.failed).toEqual([]);
    expect(context.getDirectories()).toContain(dir);
  });

  it.each([
    ['backslash UNC', '\\\\server\\share'],
    ['slash UNC', '//server/share'],
  ])('keeps the supplied spelling of %s rather than realpath-ing it', (_label, dir) => {
    // A DFS alias or a mapped drive resolves to a different UNC host. Letting
    // realpath rewrite the workspace entry would split one directory across two
    // names, so the trust lookup and the permission comparison would disagree
    // about which paths are inside the workspace.
    const context = new WorkspaceContext(cwd);

    context.addDirectories([dir]);

    expect(context.getDirectories()).toContain(dir);
    expect(fs.realpathSync).not.toHaveBeenCalledWith(dir);
  });

  it('accepts a network read-only path without realpath-ing it', () => {
    const context = new WorkspaceContext(cwd);

    context.addReadOnlyPath('//server/share');

    expect(runLogger.warn).not.toHaveBeenCalled();
    expect(fs.realpathSync).not.toHaveBeenCalledWith('//server/share');
  });

  it('still resolves a local directory through realpath', () => {
    // Guard against the network exemption being applied too broadly: a local
    // symlinked directory must keep collapsing to its real path, otherwise a
    // symlink escape out of the workspace would go undetected.
    const context = new WorkspaceContext(cwd);
    const local = path.join(cwd, 'local-dir');

    context.addDirectories([local]);

    expect(fs.realpathSync).toHaveBeenCalledWith(local);
  });
});
