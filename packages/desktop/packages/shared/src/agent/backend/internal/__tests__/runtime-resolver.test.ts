import { describe, expect, it } from 'bun:test';
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

function makeExecutable(path: string): void {
  writeFileSync(path, '');
  chmodSync(path, 0o755);
}

function makeRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), '');
  return root;
}

describe('resolveBackendRuntimePaths', () => {
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
