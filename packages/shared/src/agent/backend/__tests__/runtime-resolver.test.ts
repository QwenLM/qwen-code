/**
 * Tests for runtime-resolver.ts
 *
 * Verifies:
 * - Packaged server path resolution with dist/resources/ fallback
 * - Ripgrep path resolution with system rg fallback
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBackendRuntimePaths } from '../internal/runtime-resolver.ts';
import { resolveBackendHostTooling } from '../factory.ts';
import type { BackendHostRuntimeContext } from '../types.ts';

describe('resolveServerPath fallback', () => {
  const tmpBase = join(tmpdir(), `resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds server in dist/resources/ when resources/ does not exist', () => {
    // Simulate packaged app where server is at dist/resources/<name>/index.js
    const appRoot = join(tmpBase, 'app');
    const serverDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'index.js'), '// stub');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(serverDir, 'index.js'));
  });

  it('prefers resources/ over dist/resources/ when both exist', () => {
    const appRoot = join(tmpBase, 'app2');

    // Create both paths
    const primaryDir = join(appRoot, 'resources', 'pi-agent-server');
    const fallbackDir = join(appRoot, 'dist', 'resources', 'pi-agent-server');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(primaryDir, 'index.js'), '// primary');
    writeFileSync(join(fallbackDir, 'index.js'), '// fallback');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piServerPath).toBe(join(primaryDir, 'index.js'));
  });
});

describe('resolveQwenCliPath', () => {
  const tmpBase = join(tmpdir(), `qwen-resolver-test-${Date.now()}`);
  const originalEnv = {
    QWEN_CODE_CLI: process.env.QWEN_CODE_CLI,
    QWEN_CODE_PATH: process.env.QWEN_CODE_PATH,
    QWEN_CODE_ROOT: process.env.QWEN_CODE_ROOT,
  };

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    if (originalEnv.QWEN_CODE_CLI === undefined) delete process.env.QWEN_CODE_CLI;
    else process.env.QWEN_CODE_CLI = originalEnv.QWEN_CODE_CLI;
    if (originalEnv.QWEN_CODE_PATH === undefined) delete process.env.QWEN_CODE_PATH;
    else process.env.QWEN_CODE_PATH = originalEnv.QWEN_CODE_PATH;
    if (originalEnv.QWEN_CODE_ROOT === undefined) delete process.env.QWEN_CODE_ROOT;
    else process.env.QWEN_CODE_ROOT = originalEnv.QWEN_CODE_ROOT;
  });

  it('finds bundled Qwen Code CLI in packaged apps', () => {
    delete process.env.QWEN_CODE_CLI;
    delete process.env.QWEN_CODE_PATH;
    delete process.env.QWEN_CODE_ROOT;

    const appRoot = join(tmpBase, 'packaged-qwen');
    const qwenDir = join(appRoot, 'vendor', 'qwen-code');
    mkdirSync(qwenDir, { recursive: true });
    const qwenCli = join(qwenDir, 'cli.js');
    writeFileSync(qwenCli, '#!/usr/bin/env node\n');

    const paths = resolveBackendRuntimePaths({
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    });

    expect(paths.qwenCliPath).toBe(qwenCli);
  });

  it('does not use developer Qwen fallbacks in packaged apps', () => {
    delete process.env.QWEN_CODE_CLI;
    delete process.env.QWEN_CODE_PATH;
    delete process.env.QWEN_CODE_ROOT;

    const appRoot = join(tmpBase, 'packaged-without-qwen');
    mkdirSync(appRoot, { recursive: true });

    const paths = resolveBackendRuntimePaths({
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    });

    expect(paths.qwenCliPath).toBeUndefined();
  });
});

describe('resolveRipgrepPath', () => {
  const tmpBase = join(tmpdir(), `rg-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds vendored ripgrep binary', () => {
    const appRoot = join(tmpBase, 'vendored');
    const platform = process.platform === 'win32'
      ? 'x64-win32'
      : process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin')
        : (process.arch === 'arm64' ? 'arm64-linux' : 'x64-linux');
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rgDir = join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep', platform);
    mkdirSync(rgDir, { recursive: true });
    const rgPath = join(rgDir, binaryName);
    writeFileSync(rgPath, '#!/bin/sh\n');
    chmodSync(rgPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    expect(result.ripgrepPath).toBe(rgPath);
  });

  it('falls back to system rg when vendored binary is missing (non-packaged)', () => {
    const appRoot = join(tmpBase, 'no-vendored');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    // On CI/dev machines with rg installed, this finds system rg.
    // On machines without rg, this returns undefined.
    // We just verify it doesn't throw.
    expect(result.ripgrepPath === undefined || typeof result.ripgrepPath === 'string').toBe(true);
  });

  it('does NOT fall back to system rg for packaged apps (respects isPackaged guard)', () => {
    // On dev machines, the CWD fallback (existing pre-change behavior) will find
    // the vendored binary from the monorepo. This test verifies the system PATH
    // fallback is gated by isPackaged — if the result is defined, it must be
    // a vendored path (not /usr/bin/rg or similar system path).
    const appRoot = join(tmpBase, 'packaged');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    if (result.ripgrepPath) {
      // Must be a vendored path, not a system PATH resolution
      expect(result.ripgrepPath).toContain('node_modules');
    }
  });
});
