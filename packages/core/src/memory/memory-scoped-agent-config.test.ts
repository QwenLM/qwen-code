/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  createMemoryScopedAgentConfig,
  isAllowedMemoryPath,
  type MemoryScopedAgentConfigOptions,
} from './memory-scoped-agent-config.js';
import {
  AUTO_MEMORY_PINNED_DIRNAME as PINNED,
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';

const { EDIT, GREP, LS, READ_FILE, SHELL, WEB_FETCH, WRITE_FILE } = ToolNames;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('createMemoryScopedAgentConfig', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-scoped-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    await fs.mkdir(path.join(getAutoMemoryRoot(projectRoot), 'project'), {
      recursive: true,
    });
    await fs.mkdir(path.join(getUserAutoMemoryRoot(), 'user'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    restoreEnv('QWEN_CODE_MEMORY_BASE_DIR', originalMemoryBase);
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** The scoped config's permission manager, optionally over a base PM. */
  function scopedPm(
    options?: MemoryScopedAgentConfigOptions,
    base?: Partial<PermissionManager>,
  ): PermissionManager {
    const config = base
      ? ({ getPermissionManager: () => base as PermissionManager } as Config)
      : ({} as Config);
    const pm = createMemoryScopedAgentConfig(
      config,
      projectRoot,
      options,
    ).getPermissionManager?.();
    if (!pm) throw new Error('missing permission manager');
    return pm;
  }

  const projectPinnedPm = () =>
    scopedPm({ includeUserMemory: false, protectPinnedMemory: true });
  const readOnly = (tool: string) =>
    `ManagedAutoMemory(${tool}: pinned memory is read-only)`;

  const projMem = (...segs: string[]) =>
    path.join(getAutoMemoryRoot(projectRoot), ...segs);
  const userMem = (...segs: string[]) =>
    path.join(getUserAutoMemoryRoot(), ...segs);

  const evalIs = (
    pm: PermissionManager,
    toolName: string,
    filePath: string,
    decision: string,
  ) => expect(pm.evaluate({ toolName, filePath })).resolves.toBe(decision);

  const denyRuleIs = (
    pm: PermissionManager,
    toolName: string,
    filePath: string,
    rule: string,
  ) => expect(pm.findMatchingDenyRule({ toolName, filePath })).toBe(rule);

  /** A base PM whose rules are all relevant and whose tools are enabled. */
  const basePm = (
    askRule: boolean,
    denyRule: string | undefined,
    decision: string,
  ) => ({
    hasRelevantRules: vi.fn().mockReturnValue(true),
    hasMatchingAskRule: vi.fn().mockReturnValue(askRule),
    findMatchingDenyRule: vi.fn().mockReturnValue(denyRule),
    evaluate: vi.fn().mockResolvedValue(decision),
    isToolEnabled: vi.fn().mockResolvedValue(true),
  });

  it('restricts reads to memory paths only when requested', async () => {
    const transcript = path.join(projectRoot, 'transcripts', 'latest.jsonl');
    await evalIs(scopedPm(), READ_FILE, transcript, 'default');

    const restricted = scopedPm({ restrictReadsToMemoryPaths: true });
    await evalIs(restricted, READ_FILE, transcript, 'deny');
    await evalIs(restricted, GREP, getAutoMemoryRoot(projectRoot), 'allow');
    await evalIs(restricted, LS, getUserAutoMemoryRoot(), 'allow');
  });

  it('can keep writes project-memory-only for the dream agent', async () => {
    const pm = scopedPm({ includeUserMemory: false });
    await evalIs(pm, WRITE_FILE, projMem('project', 'a.md'), 'allow');
    await evalIs(pm, WRITE_FILE, userMem('user', 'a.md'), 'deny');
  });

  it('can keep reads and writes user-memory-only', async () => {
    const pm = scopedPm({
      includeProjectMemory: false,
      includeUserMemory: true,
      restrictReadsToMemoryPaths: true,
    });
    await evalIs(pm, WRITE_FILE, userMem('user', 'a.md'), 'allow');
    await evalIs(pm, READ_FILE, getUserAutoMemoryRoot(), 'allow');
    await evalIs(pm, WRITE_FILE, projMem('project', 'a.md'), 'deny');
    await evalIs(pm, READ_FILE, getAutoMemoryRoot(projectRoot), 'deny');
  });

  it('protects project pinned memory and aliases while leaving ordinary memory writable', async () => {
    const pinnedDir = projMem(PINNED);
    const pinnedFile = path.join(pinnedDir, 'architecture.md');
    const pinnedAlias = projMem('project', `${PINNED}-alias`);
    await fs.mkdir(pinnedDir, { recursive: true });
    await fs.writeFile(pinnedFile, 'canonical architecture');
    await fs.symlink(pinnedDir, pinnedAlias);
    const aliasFile = path.join(pinnedAlias, 'architecture.md');
    const pinnedNew = path.join(pinnedDir, 'new.md');

    const pm = projectPinnedPm();

    await evalIs(pm, WRITE_FILE, projMem('project', 'ordinary.md'), 'allow');
    await evalIs(pm, EDIT, pinnedFile, 'deny');
    await evalIs(pm, WRITE_FILE, pinnedNew, 'deny');
    await evalIs(
      pm,
      WRITE_FILE,
      projMem(PINNED.toUpperCase(), 'architecture.md'),
      'deny',
    );
    await evalIs(pm, EDIT, aliasFile, 'deny');
    await evalIs(pm, WRITE_FILE, path.join(pinnedAlias, 'new.md'), 'deny');
    await evalIs(
      pm,
      WRITE_FILE,
      projMem(`${PINNED}-notes`, 'ordinary.md'),
      'allow',
    );
    await evalIs(
      pm,
      WRITE_FILE,
      projMem('project', PINNED, 'notes.md'),
      'allow',
    );
    denyRuleIs(pm, EDIT, pinnedFile, readOnly('edit'));
    denyRuleIs(pm, EDIT, aliasFile, readOnly('edit'));
    denyRuleIs(pm, WRITE_FILE, pinnedNew, readOnly('write_file'));
  });

  it('protects user pinned memory when user memory is included', async () => {
    const userPinnedFile = userMem(PINNED, 'preferences.md');
    await fs.mkdir(path.dirname(userPinnedFile), { recursive: true });
    await fs.writeFile(userPinnedFile, 'canonical preferences');
    const pm = scopedPm({ protectPinnedMemory: true });
    await evalIs(pm, EDIT, userPinnedFile, 'deny');
    await evalIs(pm, WRITE_FILE, userMem('user', 'ordinary.md'), 'allow');
  });

  it('leaves pinned memory writable when protection is disabled', async () => {
    const pinnedFile = projMem(PINNED, 'architecture.md');
    await fs.mkdir(path.dirname(pinnedFile), { recursive: true });
    await fs.writeFile(pinnedFile, 'canonical architecture');
    const pm = scopedPm({ includeUserMemory: false });
    await evalIs(pm, EDIT, pinnedFile, 'allow');
  });

  it('protects a pinned directory symlink and its in-memory target', async () => {
    const targetDir = projMem('project', 'shared');
    const targetFile = path.join(targetDir, 'architecture.md');
    const pinnedDir = projMem(PINNED);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetFile, 'canonical architecture');
    await fs.symlink(targetDir, pinnedDir);

    const pm = projectPinnedPm();
    await evalIs(pm, EDIT, path.join(pinnedDir, 'architecture.md'), 'deny');
    await evalIs(pm, EDIT, targetFile, 'deny');
  });

  it('reports the outside-root reason for a pinned symlink target outside memory', async () => {
    const outsideDir = path.join(tempDir, 'outside-pinned-target');
    const pinnedDir = projMem(PINNED);
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideDir, 'architecture.md'),
      'external architecture',
    );
    await fs.symlink(outsideDir, pinnedDir);

    const pm = projectPinnedPm();
    const target = path.join(pinnedDir, 'architecture.md');
    await evalIs(pm, EDIT, target, 'deny');
    denyRuleIs(
      pm,
      EDIT,
      target,
      `ManagedAutoMemory(edit: only within ${getAutoMemoryRoot(projectRoot)})`,
    );
  });

  it('protects paths below a dangling top-level pinned symlink', async () => {
    const pinnedDir = projMem(PINNED);
    await fs.symlink(
      path.join(tempDir, 'missing-pinned-target'),
      pinnedDir,
      'dir',
    );

    const pm = projectPinnedPm();
    const target = path.join(pinnedDir, 'new.md');
    await evalIs(pm, WRITE_FILE, target, 'deny');
    denyRuleIs(pm, WRITE_FILE, target, readOnly('write_file'));
  });

  it('allows creating new nested topic files inside memory roots', async () => {
    const pm = scopedPm();
    await evalIs(
      pm,
      WRITE_FILE,
      projMem('project', 'new-topic', 'fact.md'),
      'allow',
    );
    await evalIs(pm, EDIT, userMem('user', 'new-topic', 'fact.md'), 'allow');
  });

  it('allows memory paths with dot-prefixed names inside memory roots', async () => {
    await evalIs(
      scopedPm(),
      WRITE_FILE,
      projMem('..topic', 'fact.md'),
      'allow',
    );
  });

  it('denies memory-root symlinks that resolve outside memory', async () => {
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'target.md');
    await fs.writeFile(outsideFile, 'secret');

    await fs.mkdir(projMem('project'), { recursive: true });
    const symlinkFile = projMem('project', 'link.md');
    const symlinkDir = projMem('project', 'linked-dir');
    await fs.symlink(outsideFile, symlinkFile);
    await fs.symlink(outsideDir, symlinkDir);

    const pm = scopedPm();
    await evalIs(pm, EDIT, symlinkFile, 'deny');
    await evalIs(pm, WRITE_FILE, path.join(symlinkDir, 'new.md'), 'deny');
  });

  it('denies dangling symlink leaves inside memory roots', async () => {
    const outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    const link = projMem('project', 'link.md');
    await fs.symlink(path.join(outsideDir, 'missing.md'), link);
    await evalIs(scopedPm(), WRITE_FILE, link, 'deny');
  });

  it('allows only read-only shell commands when shell is enabled', async () => {
    const shell = (pm: PermissionManager, command: string) =>
      pm.evaluate({ toolName: SHELL, command });
    const disabled = scopedPm();
    await expect(disabled.isToolEnabled(SHELL)).resolves.toBe(false);
    await expect(shell(disabled, 'ls')).resolves.toBe('deny');

    const enabled = scopedPm({ allowShell: true });
    await expect(enabled.isToolEnabled(SHELL)).resolves.toBe(true);
    await expect(shell(enabled, 'ls -la')).resolves.toBe('allow');
    await expect(shell(enabled, 'touch bad')).resolves.toBe('deny');
  });

  it('lets base deny rules override scoped allows', async () => {
    const pm = scopedPm(undefined, basePm(false, 'base deny', 'deny'));
    await evalIs(pm, WRITE_FILE, projMem('project', 'a.md'), 'deny');
  });

  it('can bypass base ask rules for scoped memory writes only', async () => {
    const pm = scopedPm(
      { bypassBaseAskForScopedPaths: true },
      basePm(true, undefined, 'ask'),
    );
    await evalIs(pm, WRITE_FILE, userMem('user', 'a.md'), 'allow');
    await evalIs(pm, WRITE_FILE, path.join(projectRoot, 'README.md'), 'deny');
  });

  it('does not bypass base deny rules for scoped memory writes', async () => {
    const pm = scopedPm(
      { bypassBaseAskForScopedPaths: true },
      basePm(false, 'base deny', 'deny'),
    );
    await evalIs(pm, WRITE_FILE, userMem('user', 'a.md'), 'deny');
  });

  describe('registration-gate shim delegation (#10075)', () => {
    it('isToolDisabledByCoreToolsAllowList delegates when present, defaults to false otherwise', () => {
      const gate = vi.fn().mockReturnValue(true);
      const delegated = scopedPm(undefined, {
        isToolDisabledByCoreToolsAllowList: gate,
      });
      expect(delegated.isToolDisabledByCoreToolsAllowList(EDIT)).toBe(true);
      expect(gate).toHaveBeenCalledWith(EDIT);

      expect(scopedPm().isToolDisabledByCoreToolsAllowList(EDIT)).toBe(false);

      // A base PM without the method (older shape) must not throw — the
      // scheduler's own `typeof` guard relies on this returning false.
      const legacy = scopedPm(undefined, {
        isToolEnabled: vi.fn().mockResolvedValue(true),
      });
      expect(legacy.isToolDisabledByCoreToolsAllowList(EDIT)).toBe(false);
    });

    it('getToolRegistrationStatus delegates when present, defaults to registered', async () => {
      // Use a non-scoped tool: edit/write_file/shell short-circuit as
      // scoped tools before the base delegation.
      const status = vi.fn().mockResolvedValue('disabled');
      const delegated = scopedPm(undefined, {
        getToolRegistrationStatus: status,
      });
      await expect(
        delegated.getToolRegistrationStatus(WEB_FETCH),
      ).resolves.toBe('disabled');
      expect(status).toHaveBeenCalledWith(WEB_FETCH, undefined, undefined);

      await expect(
        scopedPm().getToolRegistrationStatus(WEB_FETCH),
      ).resolves.toBe('registered');
    });

    it('isToolEnabled forwards the alias and identity channels to the base PM', async () => {
      const isToolEnabled = vi.fn().mockResolvedValue(false);
      const delegated = scopedPm(undefined, { isToolEnabled });
      const identity = { serverName: 'foo:bar', serverToolName: 'a.b' };
      await expect(
        delegated.isToolEnabled(
          'mcp__foo_bar__a_b_1aofxjh',
          ['mcp__foo:bar__a.b'],
          identity,
        ),
      ).resolves.toBe(false);
      expect(isToolEnabled).toHaveBeenCalledWith(
        'mcp__foo_bar__a_b_1aofxjh',
        ['mcp__foo:bar__a.b'],
        identity,
      );
    });

    it('gates the shell registration status on allowShell', async () => {
      await expect(scopedPm().getToolRegistrationStatus(SHELL)).resolves.toBe(
        'disabled',
      );
      await expect(
        scopedPm({ allowShell: true }).getToolRegistrationStatus(SHELL),
      ).resolves.toBe('registered');
    });
  });
});

describe('isAllowedMemoryPath with a symlinked project root', () => {
  const originalMemoryLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
  let baseDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    // Local mode anchors the memory root at `<projectRoot>/.qwen/memory`, so an
    // explicit project-root symlink puts a symlink in the root path on every
    // platform, not only where os.tmpdir() is one (macOS `/var`). The root is
    // deliberately NOT created: the allow-check must resolve the nearest
    // existing ancestor (the symlink) rather than assume the root exists.
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-symlink-'));
    const realProject = path.join(baseDir, 'realproj');
    projectRoot = path.join(baseDir, 'linkproj');
    await fs.mkdir(realProject, { recursive: true });
    await fs.symlink(realProject, projectRoot);
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    restoreEnv('QWEN_CODE_MEMORY_LOCAL', originalMemoryLocal);
    clearAutoMemoryRootCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('allows a write under a symlinked managed-memory root that does not exist yet', () => {
    // Regression: the root was path.resolve'd (symlink kept, `linkproj/...`)
    // while the candidate was realpath'd (`realproj/...`), so a legitimate
    // write was rejected. Both sides must resolve the symlink identically
    // even before the root directory exists.
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    expect(isAllowedMemoryPath(memoryFile, projectRoot)).toBe(true);
  });

  it('still denies a path outside the symlinked managed-memory root', () => {
    // The symmetric resolution must not become overly permissive: a project
    // file outside `<projectRoot>/.qwen/memory`, reached through the same
    // symlinked root, is still rejected.
    const outsideFile = path.join(projectRoot, 'notes.md');
    expect(isAllowedMemoryPath(outsideFile, projectRoot)).toBe(false);
  });
});

describe('isAllowedMemoryPath with a symlinked managed-memory suffix', () => {
  // Unlike the block above (symlink ABOVE the trusted anchor, like macOS
  // `/var`), here a repo-tracked `.qwen` INSIDE the managed suffix points out
  // of the project. Canonicalizing it would relocate the allowed root, so the
  // anchor is canonicalized but `.qwen/memory` is appended literally and the
  // write is denied.
  const originalMemoryLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
  let baseDir: string;
  let projectRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-qwenlink-'));
    projectRoot = path.join(baseDir, 'repo');
    outsideDir = path.join(baseDir, 'outside');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    // A malicious repo can ship the whole `.qwen` dir as a git-tracked
    // symlink escaping the project.
    await fs.symlink(outsideDir, path.join(projectRoot, '.qwen'));
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    restoreEnv('QWEN_CODE_MEMORY_LOCAL', originalMemoryLocal);
    clearAutoMemoryRootCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('denies a write via a `.qwen` symlink escaping the project when the target is absent', () => {
    // `.qwen -> /outside` with `/outside/memory` absent: the candidate resolves
    // to `/outside/memory/project.md`, but the allowed root keeps the literal
    // `.qwen/memory` suffix, so the escape is rejected before it creates it.
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    expect(isAllowedMemoryPath(memoryFile, projectRoot)).toBe(false);
  });

  it('denies a write via a `.qwen` symlink escaping the project when the target already exists', async () => {
    // Must stay denied once `/outside/memory` exists; realpath'ing the whole
    // root would resolve the symlink on both sides and let the write through.
    await fs.mkdir(path.join(outsideDir, 'memory'), { recursive: true });
    const memoryFile = path.join(getAutoMemoryRoot(projectRoot), 'project.md');
    expect(isAllowedMemoryPath(memoryFile, projectRoot)).toBe(false);
  });
});

describe('isAllowedMemoryPath in default (shared) memory mode', () => {
  // The symlink blocks above force QWEN_CODE_MEMORY_LOCAL=1 (project-root
  // anchor). In shared mode the anchor is getMemoryBaseDir(), a distinct branch
  // of getAutoMemoryTrustedAnchor / resolveTrustedMemoryRoot; pin both sides of
  // its trust boundary so a shared-mode regression can't hide behind them.
  const originalMemoryLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-shared-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    clearAutoMemoryRootCache();
  });

  afterEach(async () => {
    restoreEnv('QWEN_CODE_MEMORY_LOCAL', originalMemoryLocal);
    restoreEnv('QWEN_CODE_MEMORY_BASE_DIR', originalMemoryBase);
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Points the shared base dir at `base` and returns the managed root. */
  function useBaseDir(base: string): string {
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = base;
    clearAutoMemoryRootCache();
    return getAutoMemoryRoot(projectRoot);
  }

  it('allows a write under a symlinked shared base dir whose managed root is absent', async () => {
    // Route the shared base dir (this mode's anchor) through a symlink, like
    // macOS /var, and leave the managed root uncreated: the anchor must
    // canonicalize so the root and the realpath'd candidate agree.
    const realBase = path.join(tempDir, 'real-base');
    const linkBase = path.join(tempDir, 'link-base');
    await fs.mkdir(realBase, { recursive: true });
    await fs.symlink(realBase, linkBase);
    const root = useBaseDir(linkBase);
    // Sanity: shared mode puts the root under the (symlinked) base dir, not
    // `<projectRoot>/.qwen`; guards against silently falling back to local.
    expect(root.startsWith(linkBase + path.sep)).toBe(true);
    expect(
      isAllowedMemoryPath(path.join(root, 'project.md'), projectRoot),
    ).toBe(true);
  });

  it('allows a managed project alias to a sibling project directory', async () => {
    const managedRoot = useBaseDir(tempDir);
    const canonicalProjectDir = path.join(
      tempDir,
      'projects',
      'canonical-project',
    );
    await fs.mkdir(path.join(canonicalProjectDir, 'memory'), {
      recursive: true,
    });
    await fs.symlink(
      path.basename(canonicalProjectDir),
      path.dirname(managedRoot),
    );
    expect(
      isAllowedMemoryPath(
        path.join(managedRoot, 'project', 'note.md'),
        projectRoot,
      ),
    ).toBe(true);
  });

  it('denies a managed project alias that escapes the shared projects directory', async () => {
    const outside = path.join(tempDir, 'outside');
    const managedRoot = useBaseDir(tempDir);
    await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.dirname(managedRoot));
    expect(
      isAllowedMemoryPath(
        path.join(managedRoot, 'project', 'note.md'),
        projectRoot,
      ),
    ).toBe(false);
  });

  it('denies a write when a symlink below the shared suffix escapes the anchor', async () => {
    // A symlink INSIDE the managed suffix (the `memory` dir itself -> outside)
    // must NOT be followed: the anchor is canonicalized but the
    // `projects/<id>/memory` suffix is appended literally, so the write stays
    // denied though the candidate realpath-resolves into /outside.
    const realBase = path.join(tempDir, 'real-base');
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(realBase, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const managedRoot = useBaseDir(realBase);
    // Sanity: default (shared) mode — the root lives under the base dir.
    expect(managedRoot.startsWith(realBase + path.sep)).toBe(true);
    await fs.mkdir(path.dirname(managedRoot), { recursive: true });
    await fs.symlink(outside, managedRoot);
    expect(
      isAllowedMemoryPath(path.join(managedRoot, 'project.md'), projectRoot),
    ).toBe(false);
  });
});
