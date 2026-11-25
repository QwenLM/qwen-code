/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../skills/dynamicSkillDiscovery.js', () => ({
  discoverAndRegisterDynamicSkills: vi.fn().mockResolvedValue(false),
}));

import { discoverJitContext } from './jit-context.js';
import { discoverAndRegisterDynamicSkills } from '../skills/dynamicSkillDiscovery.js';
import type { Config } from '../config/config.js';
import type { MemoryContextManager } from '../context/memoryContextManager.js';

describe('jit-context', () => {
  describe('discoverJitContext', () => {
    let mockConfig: Config;
    let mockMemoryContextManager: MemoryContextManager;

    beforeEach(() => {
      vi.clearAllMocks();
      mockMemoryContextManager = {
        discoverContext: vi.fn().mockResolvedValue(''),
      } as unknown as MemoryContextManager;

      mockConfig = {
        getMemoryContextManager: vi
          .fn()
          .mockReturnValue(mockMemoryContextManager),
        getWorkspaceContext: vi.fn().mockReturnValue({
          getDirectories: vi.fn().mockReturnValue(['/app']),
        }),
        getTargetDir: vi.fn().mockReturnValue('/app'),
        getWorktreeSettings: vi.fn().mockReturnValue(undefined),
        getSkillManager: vi.fn().mockReturnValue({
          hasDynamicSkillDir: vi.fn().mockReturnValue(false),
          addDynamicSkills: vi.fn(),
          activateConditionalSkillsForPaths: vi.fn().mockReturnValue([]),
        }),
        isTrustedFolder: vi.fn().mockReturnValue(true),
        isAgentSourceAllowed: vi.fn().mockReturnValue(true),
        shouldLoadSkillsFromAgentsDirectory: vi.fn().mockReturnValue(true),
        notifySkillsChanged: vi.fn(),
      } as unknown as Config;
    });

    it('should return early when memoryContextManager is undefined', async () => {
      vi.mocked(mockConfig.getMemoryContextManager).mockReturnValue(undefined);

      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(mockMemoryContextManager.discoverContext).not.toHaveBeenCalled();
    });

    it('should call memoryContextManager.discoverContext with correct args', async () => {
      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(mockMemoryContextManager.discoverContext).toHaveBeenCalledWith(
        '/app/src/file.ts',
        ['/app'],
        undefined,
      );
    });

    it('should pass all workspace directories as trusted roots', async () => {
      vi.mocked(mockConfig.getWorkspaceContext).mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/app', '/lib']),
      } as unknown as ReturnType<Config['getWorkspaceContext']>);

      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(mockMemoryContextManager.discoverContext).toHaveBeenCalledWith(
        '/app/src/file.ts',
        ['/app', '/lib'],
        undefined,
      );
    });

    it('passes runtime inputs to dynamic skill discovery', async () => {
      await discoverJitContext(mockConfig, '/app/src/file.ts');

      const skillManager = mockConfig.getSkillManager();
      expect(discoverAndRegisterDynamicSkills).toHaveBeenCalledWith({
        accessedPaths: ['/app/src/file.ts'],
        cwd: '/app',
        loadFromAgentsDirectory: true,
        skillManager,
      });
    });

    it('activates and publishes newly discovered skills to runtime consumers', async () => {
      vi.mocked(discoverAndRegisterDynamicSkills).mockResolvedValueOnce(true);

      await discoverJitContext(mockConfig, '/app/src/file.ts');

      const skillManager = mockConfig.getSkillManager();
      expect(
        skillManager.activateConditionalSkillsForPaths,
      ).toHaveBeenCalledWith(['src/file.ts']);
      expect(mockConfig.notifySkillsChanged).toHaveBeenCalledOnce();
      expect(
        vi.mocked(skillManager.activateConditionalSkillsForPaths).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(mockConfig.notifySkillsChanged).mock.invocationCallOrder[0],
      );
    });

    it('does not publish a skill change when JIT discovery adds nothing', async () => {
      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(mockConfig.notifySkillsChanged).not.toHaveBeenCalled();
    });

    it('does not discover project skills in an untrusted workspace', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);

      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(discoverAndRegisterDynamicSkills).not.toHaveBeenCalled();
    });

    it('does not discover project skills when the project source is excluded', async () => {
      vi.mocked(mockConfig.isAgentSourceAllowed).mockReturnValue(false);

      await discoverJitContext(mockConfig, '/app/src/file.ts');

      expect(discoverAndRegisterDynamicSkills).not.toHaveBeenCalled();
      expect(mockConfig.isAgentSourceAllowed).toHaveBeenCalledWith('project');
    });

    it('should not throw when discoverContext throws', async () => {
      vi.mocked(mockMemoryContextManager.discoverContext).mockRejectedValue(
        new Error('Permission denied'),
      );

      await expect(
        discoverJitContext(mockConfig, '/app/src/file.ts'),
      ).resolves.toBeUndefined();
    });

    it('should not throw when dynamic skill discovery throws', async () => {
      vi.mocked(discoverAndRegisterDynamicSkills).mockRejectedValueOnce(
        new Error('Permission denied'),
      );

      await expect(
        discoverJitContext(mockConfig, '/app/src/file.ts'),
      ).resolves.toBeUndefined();
    });
  });
});
