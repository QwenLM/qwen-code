/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import { ToolErrorType } from '../tool-error.js';
import {
  NodeReplAddNodeModuleDirTool,
  NodeReplResetTool,
  NodeReplSession,
  NodeReplTool,
} from './tool.js';

let workDir: string;
let session: NodeReplSession;

function fakeConfig(directory: string): Config {
  return {
    isTrustedFolder: () => true,
    getTargetDir: () => directory,
    storage: {
      getProjectTempDir: () => path.join(directory, '.tmp'),
    },
    getWorkspaceContext: () => ({
      getDirectories: () => [directory],
    }),
  } as unknown as Config;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-tool-'));
  session = new NodeReplSession(fakeConfig(workDir));
});

afterEach(() => {
  session.dispose();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('NodeReplTool', () => {
  it('has the deferred strict-schema contract and scoped guidance', () => {
    const tool = new NodeReplTool(session);
    expect(tool.name).toBe('node_repl');
    expect(tool.shouldDefer).toBe(true);
    const schema = tool.parameterSchema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['code']);
    expect(tool.description).toContain('top-level await');
    expect(tool.description).toContain('nodeRepl.getHeapStatus()');
    expect(tool.description).not.toMatch(/browser|chrome/i);
  });

  it('validates code, timeout, title, and unknown properties', () => {
    const tool = new NodeReplTool(session);
    expect(() => tool.build({ code: '' })).toThrow();
    expect(() => tool.build({ code: '1;', timeout_ms: 0 })).toThrow();
    expect(() => tool.build({ code: '1;', timeout_ms: 1.5 })).toThrow();
    expect(() =>
      tool.build({ code: '1;', timeout_ms: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => tool.build({ code: '1;', timeout_ms: 2 ** 31 })).not.toThrow();
    expect(() => tool.build({ code: '1;', title: '' })).toThrow();
    expect(() => tool.build({ code: '1;', title: '界'.repeat(81) })).toThrow();
    expect(() => tool.build({ code: '1;', extra: true } as never)).toThrow();
    expect(() =>
      tool.build({ code: '1;', title: '界'.repeat(80) }),
    ).not.toThrow();
  });

  it('uses title or the first source line as the invocation description', () => {
    const tool = new NodeReplTool(session);
    expect(
      tool.build({ code: '1 + 1;', title: 'add numbers' }).getDescription(),
    ).toBe('add numbers');
    expect(
      tool.build({ code: 'const value = 1;\nvalue;' }).getDescription(),
    ).toBe('const value = 1;');
  });

  it('asks permission and remains process-lazy until execution', async () => {
    const tool = new NodeReplTool(session);
    const invocation = tool.build({ code: '1;' });
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
    expect(session.hasManager()).toBe(false);
  });

  it('denies execution in an untrusted workspace without starting a manager', async () => {
    const untrusted = new NodeReplSession({
      ...fakeConfig(workDir),
      isTrustedFolder: () => false,
    } as Config);
    const invocation = new NodeReplTool(untrusted).build({ code: '1;' });
    await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(untrusted.hasManager()).toBe(false);
    untrusted.dispose();
  });

  it('executes through the child and converts success and failure results', async () => {
    const tool = new NodeReplTool(session);
    const ok = await tool
      .build({ code: 'nodeRepl.write("via tool"); const done = true;' })
      .execute(new AbortController().signal);
    expect(ok.error).toBeUndefined();
    expect(ok.llmContent).toBe('via tool');

    const failed = await tool
      .build({ code: 'throw new Error("nope");' })
      .execute(new AbortController().signal);
    expect(failed.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(String(failed.llmContent)).toContain('nope');
  }, 30_000);

  it('disposes the shared session', async () => {
    const tool = new NodeReplTool(session);
    await tool.build({ code: '1;' }).execute(new AbortController().signal);
    tool.dispose();
    expect(() => session.getManager()).toThrow(/disposed/);
  }, 30_000);
});

describe('NodeReplResetTool', () => {
  it('is auto-allowed and does not create a manager for an empty session', async () => {
    const tool = new NodeReplResetTool(session);
    const invocation = tool.build({});
    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toMatch(/already empty/);
    expect(session.hasManager()).toBe(false);
    expect(() => tool.build({ unexpected: true } as never)).toThrow();
  });

  it('performs process-level reset without disposing the session', async () => {
    const repl = new NodeReplTool(session);
    await repl
      .build({ code: 'const value = 1;' })
      .execute(new AbortController().signal);
    const manager = session.getManager();
    const oldPid = manager.getKernelPid();

    const reset = await new NodeReplResetTool(session)
      .build({})
      .execute(new AbortController().signal);
    expect(reset.error).toBeUndefined();
    expect(reset.llmContent).toMatch(/process reset/);
    expect(manager.getKernelPid()).toBeNull();

    const after = await repl
      .build({ code: 'nodeRepl.write(typeof value);' })
      .execute(new AbortController().signal);
    expect(after.llmContent).toBe('undefined');
    expect(manager.getKernelPid()).not.toBe(oldPid);
  }, 30_000);
});

describe('NodeReplAddNodeModuleDirTool', () => {
  it('requires an absolute path named node_modules', () => {
    const tool = new NodeReplAddNodeModuleDirTool(session);
    expect(() => tool.build({ path: '' })).toThrow();
    expect(() => tool.build({ path: 'relative/node_modules' })).toThrow();
    expect(() => tool.build({ path: workDir })).toThrow(/node_modules/);
    const futureRoot = path.join(workDir, 'missing', 'node_modules');
    const canonicalFutureRoot = path.join(
      fs.realpathSync(workDir),
      'missing',
      'node_modules',
    );
    expect(tool.build({ path: futureRoot }).getDescription()).toContain(
      canonicalFutureRoot,
    );
    expect(tool.toAutoClassifierInput({ path: futureRoot })).toEqual({
      path: canonicalFutureRoot,
    });
  });

  it('asks permission, registers canonically, and does not start a child', async () => {
    const root = path.join(workDir, 'node_modules');
    fs.mkdirSync(root);
    const tool = new NodeReplAddNodeModuleDirTool(session);
    const invocation = tool.build({ path: root });
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
    expect(invocation.getDescription()).toContain(root);
    expect(tool.toAutoClassifierInput({ path: root })).toEqual({
      path: fs.realpathSync(root),
    });

    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe('true');
    expect(session.getManager().getModuleRoots()).toEqual([
      fs.realpathSync(root),
    ]);
    expect(session.getManager().getKernelPid()).toBeNull();

    const repeated = await tool
      .build({ path: root })
      .execute(new AbortController().signal);
    expect(repeated.llmContent).toBe('false');
  });

  it.skipIf(process.platform === 'win32')(
    'registers a node_modules symlink by its stable canonical target',
    async () => {
      const target = path.join(workDir, 'packages');
      fs.mkdirSync(target);
      const aliasParent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-tool-root-alias-'),
      );
      const alias = path.join(aliasParent, 'node_modules');
      fs.symlinkSync(target, alias, 'dir');
      try {
        const tool = new NodeReplAddNodeModuleDirTool(session);
        const invocation = tool.build({ path: alias });
        expect(invocation.getDescription()).toContain(fs.realpathSync(target));
        const result = await invocation.execute(new AbortController().signal);
        expect(result.error).toBeUndefined();
        expect(session.getManager().getModuleRoots()).toEqual([
          fs.realpathSync(target),
        ]);
      } finally {
        fs.rmSync(aliasParent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a module root whose canonical target changes after approval',
    async () => {
      const root = path.join(workDir, 'node_modules');
      fs.mkdirSync(root);
      const invocation = new NodeReplAddNodeModuleDirTool(session).build({
        path: root,
      });
      const approvedPath = invocation.getDescription();

      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-tool-root-swap-'),
      );
      const replacement = path.join(outside, 'node_modules');
      fs.mkdirSync(replacement);
      try {
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(replacement, root, 'dir');
        const result = await invocation.execute(new AbortController().signal);
        expect(approvedPath).not.toContain(replacement);
        expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
        expect(result.error?.message).toMatch(/target changed/);
        expect(session.getManager().getModuleRoots()).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('denies new roots in an untrusted workspace', async () => {
    const root = path.join(workDir, 'missing', 'node_modules');
    const untrusted = new NodeReplSession({
      ...fakeConfig(workDir),
      isTrustedFolder: () => false,
    } as Config);
    const invocation = new NodeReplAddNodeModuleDirTool(untrusted).build({
      path: root,
    });
    expect(
      new NodeReplAddNodeModuleDirTool(untrusted).toAutoClassifierInput({
        path: root,
      }),
    ).toBe('');
    await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(untrusted.hasManager()).toBe(false);
    untrusted.dispose();
  });
});
