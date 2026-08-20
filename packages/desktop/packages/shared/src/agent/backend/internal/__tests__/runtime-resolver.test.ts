import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBackendRuntimePaths } from '../runtime-resolver.ts';

const originalQwenCodeCli = process.env.QWEN_CODE_CLI;
const originalQwenCodePath = process.env.QWEN_CODE_PATH;
const originalQwenCodeRoot = process.env.QWEN_CODE_ROOT;

function makeExecutable(path: string): void {
  writeFileSync(path, '');
  chmodSync(path, 0o755);
}

function makeRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  mkdirSync(join(root, 'packages', 'desktop'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), '');
  writeFileSync(join(root, 'scripts', 'dev.js'), '');
  writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{}');
  writeFileSync(join(root, 'packages', 'desktop', 'package.json'), '{}');
  return root;
}

describe('resolveBackendRuntimePaths', () => {
  beforeEach(() => {
    delete process.env.QWEN_CODE_CLI;
    delete process.env.QWEN_CODE_PATH;
    delete process.env.QWEN_CODE_ROOT;
  });

  afterEach(() => {
    if (originalQwenCodeCli === undefined) {
      delete process.env.QWEN_CODE_CLI;
    } else {
      process.env.QWEN_CODE_CLI = originalQwenCodeCli;
    }
    if (originalQwenCodePath === undefined) {
      delete process.env.QWEN_CODE_PATH;
    } else {
      process.env.QWEN_CODE_PATH = originalQwenCodePath;
    }
    if (originalQwenCodeRoot === undefined) {
      delete process.env.QWEN_CODE_ROOT;
    } else {
      process.env.QWEN_CODE_ROOT = originalQwenCodeRoot;
    }
  });

  it('prefers the current checkout Qwen CLI source entry in dev mode', () => {
    const root = makeRuntimeFixture();
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    mkdirSync(appRoot, { recursive: true });

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.qwenCliPath).toBe(join(root, 'scripts', 'dev.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the current checkout Qwen CLI bundle when source dev entry is absent', () => {
    const root = makeRuntimeFixture();
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    mkdirSync(appRoot, { recursive: true });
    rmSync(join(root, 'scripts', 'dev.js'));

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.qwenCliPath).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not silently fall back to an unrelated Qwen CLI from a source checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    const originalCwd = process.cwd();
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    mkdirSync(join(root, 'packages', 'desktop'), { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{}');
    writeFileSync(join(root, 'packages', 'desktop', 'package.json'), '{}');

    try {
      process.chdir(root);
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.qwenCliPath).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a vendored desktop CLI in standalone dev checkouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const originalCwd = process.cwd();
    const cliPath = join(
      root,
      'apps',
      'electron',
      'vendor',
      'qwen-code',
      'dist',
      'cli.js',
    );
    mkdirSync(join(root, 'apps', 'electron', 'vendor', 'qwen-code', 'dist'), {
      recursive: true,
    });
    writeFileSync(cliPath, '');

    try {
      process.chdir(root);
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
      });

      expect(resolved.qwenCliPath).toBe(cliPath);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses bundled Node instead of Bun as the Node runtime', () => {
    const root = makeRuntimeFixture();
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const bunPath = join(root, 'vendor', 'bun', bunName);
    const nodePath =
      process.platform === 'win32'
        ? join(root, 'vendor', 'node', nodeName)
        : join(root, 'vendor', 'node', 'bin', nodeName);

    mkdirSync(join(root, 'vendor', 'bun'), { recursive: true });
    mkdirSync(
      process.platform === 'win32'
        ? join(root, 'vendor', 'node')
        : join(root, 'vendor', 'node', 'bin'),
      { recursive: true },
    );
    makeExecutable(bunPath);
    makeExecutable(nodePath);

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
      });

      expect(resolved.bundledRuntimePath).toBe(bunPath);
      expect(resolved.nodeRuntimePath).toBe(nodePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit Node runtime override before bundled Bun', () => {
    const root = makeRuntimeFixture();
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const bunPath = join(root, 'vendor', 'bun', bunName);
    const binDir = join(root, 'bin');
    const nodePath = join(binDir, nodeName);

    mkdirSync(join(root, 'vendor', 'bun'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    makeExecutable(bunPath);
    makeExecutable(nodePath);

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
        nodeRuntimePath: nodePath,
      });

      expect(resolved.bundledRuntimePath).toBe(bunPath);
      expect(resolved.nodeRuntimePath).toBe(nodePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
