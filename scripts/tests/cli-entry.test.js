/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock, existsSyncMock, homedirMock, tmpdirMock } = vi.hoisted(
  () => ({
    spawnSyncMock: vi.fn(() => ({ status: 0, signal: null })),
    existsSyncMock: vi.fn(() => false),
    homedirMock: vi.fn(() => '/home/test-user'),
    tmpdirMock: vi.fn(() => '/tmp'),
  }),
);

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: existsSyncMock,
  realpathSync: vi.fn((p) => p),
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: homedirMock,
  tmpdir: tmpdirMock,
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/cli-entry.js production entry', () => {
  const originalArgv = process.argv;
  let exitSpy;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    homedirMock.mockReturnValue('/home/test-user');
    tmpdirMock.mockReturnValue('/tmp');
    // A non-fast-path command, so the entry takes the spawnSync branch (mocked)
    // instead of importing the real dist/cli.js in-process.
    process.argv = ['node', 'scripts/cli-entry.js', 'review', 'check'];
    // The entry exits after its child returns; the import must survive that.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  });

  it('stamps QWEN_CODE_CLI with its own path, overriding an inherited one', async () => {
    // The dev and start launchers had this pin; the production entry — the one
    // every npm install actually runs — did not, so a regression back to
    // honouring an inherited value would route installed review subprocesses to
    // an outer or stale CLI with every test green.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../cli-entry.js?stamps-own-cli');
      expect(normalizePath(process.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/cli-entry\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it('prefers the standalone launcher shim, which carries the bundled Node', async () => {
    // The standalone package launches this file through `bin/qwen`, a shim that
    // selects the BUNDLED Node — the host may have none — and announces itself
    // via QWEN_CODE_LAUNCHER_PATH. There, stamping this file would hand every
    // subprocess a `#!/usr/bin/env node` script on a machine where that resolves
    // to nothing. The shim is the entry that reaches this build; stamp it.
    const inheritedCli = process.env.QWEN_CODE_CLI;
    const inheritedShim = process.env.QWEN_CODE_LAUNCHER_PATH;
    process.env.QWEN_CODE_LAUNCHER_PATH = '/opt/qwen-standalone/bin/qwen';
    delete process.env.QWEN_CODE_CLI;
    existsSyncMock.mockImplementation(
      (p) => normalizePath(p) === '/opt/qwen-standalone/bin/qwen',
    );
    try {
      await import('../cli-entry.js?stamps-shim');
      expect(process.env.QWEN_CODE_CLI).toBe('/opt/qwen-standalone/bin/qwen');
      // And the hint is CONSUMED, not leaked: the serve/mcp fast path never
      // reaches the spawn branch that used to delete it, and a child qwen from
      // a different checkout would read the leftover shim and republish it as
      // its own entry — the wrong build, wearing this one's stamp.
      expect('QWEN_CODE_LAUNCHER_PATH' in process.env).toBe(false);
    } finally {
      if (inheritedCli === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inheritedCli;
      if (inheritedShim === undefined)
        delete process.env.QWEN_CODE_LAUNCHER_PATH;
      else process.env.QWEN_CODE_LAUNCHER_PATH = inheritedShim;
    }
  });

  it('falls back to tmpdir for tilde QWEN_HOME when homedir is unavailable', async () => {
    const inheritedHome = process.env.QWEN_HOME;
    homedirMock.mockReturnValue(undefined);
    process.env.QWEN_HOME = '~';
    try {
      await import('../cli-entry.js?tilde-home-fallback');
      expect(normalizePath(process.env.QWEN_CODE_MANAGED_NPM_ROOT)).toBe(
        '/tmp/updates/npm',
      );
    } finally {
      if (inheritedHome === undefined) delete process.env.QWEN_HOME;
      else process.env.QWEN_HOME = inheritedHome;
    }
  });
});
