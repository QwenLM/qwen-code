/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnvironmentMemoryPaths } from './memoryDiscovery.js';
import { CONFIG_DIR, normalizePath } from './paths.js';
import { runLogger } from './runLogger.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const operations = ['realpath', 'readdir', 'readFile'] as const;
type RuleReadOperation = (typeof operations)[number];

function rejectRuleAccess(
  operation: RuleReadOperation,
  targetPath: string,
  error: NodeJS.ErrnoException,
): void {
  const original = fs[operation];
  vi.spyOn(fs, operation).mockImplementation((...args: unknown[]) => {
    if (normalizePath(String(args[0])) === normalizePath(targetPath)) {
      return Promise.reject(error);
    }
    return Reflect.apply(original, fs, args);
  });
}

describe('规则访问失败时的发现降级', () => {
  let projectDir: string;
  let contextFile: string;
  let rulesDir: string;
  let ruleFile: string;

  beforeEach(async () => {
    projectDir = normalizePath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rule-access-test-')),
    );
    rulesDir = path.join(projectDir, CONFIG_DIR, 'rules');
    contextFile = normalizePath(path.join(projectDir, 'AGENTS.md'));
    ruleFile = normalizePath(path.join(rulesDir, 'style.md'));
    await fs.mkdir(path.join(projectDir, '.git'));
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(contextFile, '# 项目说明');
    await fs.writeFile(ruleFile, '# 规则正文不应进入诊断日志');
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  describe.each(operations)('%s', (operation) => {
    it.each(['EPERM', 'EACCES'])(
      '%s 不阻断项目说明发现，并记录权限降级诊断',
      async (code) => {
        const targetPath = operation === 'readFile' ? ruleFile : rulesDir;
        rejectRuleAccess(
          operation,
          targetPath,
          Object.assign(new Error(), { code }),
        );

        await expect(
          getEnvironmentMemoryPaths([projectDir], ['AGENTS.md']),
        ).resolves.toEqual({ project: [contextFile], local: [] });
        expect(runLogger.warn).toHaveBeenCalledWith(expect.any(String), {
          operation,
          code,
          path: targetPath,
        });
      },
    );

    it('其他 I/O 错误保留原异常，不伪装成权限降级', async () => {
      const targetPath = operation === 'readFile' ? ruleFile : rulesDir;
      const error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
      rejectRuleAccess(operation, targetPath, error);

      await expect(
        getEnvironmentMemoryPaths([projectDir], ['AGENTS.md']),
      ).rejects.toBe(error);
      expect(runLogger.warn).not.toHaveBeenCalled();
    });
  });

  it.each(['ENOENT', 'ENOTDIR'])(
    '%s 仍静默跳过，不产生权限告警',
    async (code) => {
      rejectRuleAccess(
        'realpath',
        rulesDir,
        Object.assign(new Error(), { code }),
      );

      await expect(
        getEnvironmentMemoryPaths([projectDir], ['AGENTS.md']),
      ).resolves.toEqual({ project: [contextFile], local: [] });
      expect(runLogger.warn).not.toHaveBeenCalled();
    },
  );

  it('不可读的规则子目录不影响同级可读规则', async () => {
    const blockedDir = normalizePath(path.join(rulesDir, 'blocked'));
    await fs.mkdir(blockedDir);
    await fs.writeFile(path.join(blockedDir, 'hidden.md'), '# 不可读规则');
    rejectRuleAccess(
      'readdir',
      blockedDir,
      Object.assign(new Error(), { code: 'EPERM' }),
    );

    const result = await getEnvironmentMemoryPaths([projectDir], ['AGENTS.md']);

    expect(result).toEqual({
      project: [contextFile, ruleFile].sort(),
      local: [],
    });
    expect(runLogger.warn).toHaveBeenCalledWith(expect.any(String), {
      operation: 'readdir',
      code: 'EPERM',
      path: blockedDir,
    });
  });
});
