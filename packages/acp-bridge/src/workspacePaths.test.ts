/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _setSandboxMountExistsForTest,
  canonicalizeWorkspaces,
  translateAndCheckAbsoluteWorkspacePath,
  translateWindowsWorkspaceForPosixSandbox,
} from './workspacePaths.js';

const scratches: string[] = [];

async function mkScratch(): Promise<string> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-wp-'));
  scratches.push(scratch);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((scratch) => fsp.rm(scratch, { recursive: true, force: true })),
  );
});

describe('canonicalizeWorkspaces', () => {
  it('deduplicates canonical-equivalent inputs and preserves order', async () => {
    const scratch = await mkScratch();
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    await fsp.mkdir(first);
    await fsp.mkdir(second);
    const firstAlias = path.join(scratch, 'first-alias');
    await fsp.symlink(first, firstAlias, 'dir');

    expect(canonicalizeWorkspaces([firstAlias, second, first])).toEqual([
      realpathSync.native(first),
      realpathSync.native(second),
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(canonicalizeWorkspaces([])).toEqual([]);
  });
});

// The single ingestion-ordering enforcement point: translation before the
// absolute-path check, shared by all five workspace-ingestion sites.
describe('translateAndCheckAbsoluteWorkspacePath', () => {
  it('returns the translated mount for Windows-shaped input in a sandbox', () => {
    vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
    _setSandboxMountExistsForTest((p) => p === '/c/qwen-repro');
    try {
      expect(translateAndCheckAbsoluteWorkspacePath('C:\\qwen-repro')).toBe(
        '/c/qwen-repro',
      );
    } finally {
      vi.unstubAllEnvs();
      _setSandboxMountExistsForTest(undefined);
    }
  });

  it('returns null for non-absolute input (untranslated Windows shape included)', () => {
    vi.stubEnv('SANDBOX', '');
    try {
      expect(translateAndCheckAbsoluteWorkspacePath('C:\\qwen-repro')).toBe(
        null,
      );
      expect(translateAndCheckAbsoluteWorkspacePath('relative/dir')).toBe(null);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes POSIX absolute paths through unchanged', () => {
    expect(translateAndCheckAbsoluteWorkspacePath('/work/a')).toBe('/work/a');
  });
});

// Regression for #7139: a Windows host relaunching `qwen serve` into a Linux
// Docker sandbox forwards `--workspace C:\…` (and client/persisted workspace
// registrations) in host shape; every ACP child then failed with
// `chdir(2) ENOENT`. These tests pin the container-side translation.
describe('translateWindowsWorkspaceForPosixSandbox', () => {
  const sandboxOpts = (exists: boolean) => ({
    platform: 'linux' as NodeJS.Platform,
    sandboxEnv: 'qwen-code-sandbox-0',
    exists: () => exists,
  });

  it('maps a Windows-absolute path to its bind-mount location', () => {
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'C:\\qwen-repro',
        sandboxOpts(true),
      ),
    ).toBe('/c/qwen-repro');
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'D:/Work/proj sub',
        sandboxOpts(true),
      ),
    ).toBe('/d/Work/proj sub');
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'C:\\nested\\dir\\leaf',
        sandboxOpts(true),
      ),
    ).toBe('/c/nested/dir/leaf');
  });

  it('leaves the path alone when the translated mount does not exist', () => {
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'C:\\qwen-repro',
        sandboxOpts(false),
      ),
    ).toBe('C:\\qwen-repro');
  });

  it('refuses ..-laden input that escapes the drive mount', () => {
    // existsSync would resolve /c/../../etc to /etc and return true — the
    // guard must refuse before the probe can bless an out-of-mount path.
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'C:\\..\\..\\etc',
        sandboxOpts(true),
      ),
    ).toBe('C:\\..\\..\\etc');
    // In-mount .. that stays under the drive prefix is still fine.
    expect(
      translateWindowsWorkspaceForPosixSandbox(
        'C:\\work\\..\\proj',
        sandboxOpts(true),
      ),
    ).toBe('/c/work/../proj');
  });

  it('leaves non-Windows-shaped paths alone', () => {
    for (const p of ['/c/qwen-repro', 'relative/dir', 'C:', 'CC:\\x', '']) {
      expect(
        translateWindowsWorkspaceForPosixSandbox(p, sandboxOpts(true)),
      ).toBe(p);
    }
  });

  it('is inert on Windows hosts, outside sandboxes, and under seatbelt', () => {
    expect(
      translateWindowsWorkspaceForPosixSandbox('C:\\qwen-repro', {
        platform: 'win32',
        sandboxEnv: 'qwen-code-sandbox-0',
        exists: () => true,
      }),
    ).toBe('C:\\qwen-repro');
    expect(
      translateWindowsWorkspaceForPosixSandbox('C:\\qwen-repro', {
        platform: 'linux',
        sandboxEnv: undefined,
        exists: () => true,
      }),
    ).toBe('C:\\qwen-repro');
    expect(
      translateWindowsWorkspaceForPosixSandbox('C:\\qwen-repro', {
        platform: 'darwin',
        sandboxEnv: 'sandbox-exec',
        exists: () => true,
      }),
    ).toBe('C:\\qwen-repro');
  });
});
