/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '../utils/paths.js';
import { discoverSkillDirsForPaths } from './discoverSkillDirs.js';

vi.mock('../utils/gitignore.js', () => ({
  isPathGitignored: vi.fn().mockResolvedValue(false),
}));

describe('discoverSkillDirsForPaths', () => {
  let testRootDir: string;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'discover-skill-dirs-test-'),
    );
  });

  afterEach(async () => {
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it(`should discover ${CONFIG_DIR}/skills/ in intermediate directories`, async () => {
    // Create: testRoot/packages/frontend/${CONFIG_DIR}/skills/
    const skillsDir = path.join(
      testRootDir,
      'packages',
      'frontend',
      CONFIG_DIR,
      'skills',
    );
    await fs.mkdir(skillsDir, { recursive: true });

    // Simulate accessing: testRoot/packages/frontend/src/App.tsx
    const filePath = path.join(
      testRootDir,
      'packages',
      'frontend',
      'src',
      'App.tsx',
    );

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);

    expect(result).toContain(skillsDir);
  });

  it('should not discover .agents/skills/ in intermediate directories', async () => {
    const agentSkillsDir = path.join(
      testRootDir,
      'packages',
      'backend',
      '.agents',
      'skills',
    );
    await fs.mkdir(agentSkillsDir, { recursive: true });

    const filePath = path.join(
      testRootDir,
      'packages',
      'backend',
      'src',
      'index.ts',
    );

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);

    expect(result).not.toContain(agentSkillsDir);
  });

  it('discovers .agents/skills in intermediate directories when enabled', async () => {
    const agentSkillsDir = path.join(
      testRootDir,
      'packages',
      'backend',
      '.agents',
      'skills',
    );
    await fs.mkdir(agentSkillsDir, { recursive: true });
    const filePath = path.join(
      testRootDir,
      'packages',
      'backend',
      'src',
      'index.ts',
    );

    const result = await discoverSkillDirsForPaths(
      [filePath],
      testRootDir,
      { loadFromAgentsDirectory: true },
    );

    expect(result).toContain(agentSkillsDir);
  });

  it('deduplicates configured and legacy directories that resolve to the same path', async () => {
    const packageDir = path.join(testRootDir, 'packages', 'backend');
    const agentSkillsDir = path.join(packageDir, '.agents', 'skills');
    await fs.mkdir(agentSkillsDir, { recursive: true });
    await fs.symlink(
      path.join(packageDir, '.agents'),
      path.join(packageDir, CONFIG_DIR),
      'dir',
    );

    const result = await discoverSkillDirsForPaths(
      [path.join(packageDir, 'src', 'index.ts')],
      testRootDir,
      { loadFromAgentsDirectory: true },
    );

    expect(result).toHaveLength(1);
  });

  it('should NOT discover skills in cwd itself (only intermediate dirs)', async () => {
    // Skills in the root `${CONFIG_DIR}/skills/` are already loaded as project skills
    const rootSkillsDir = path.join(testRootDir, CONFIG_DIR, 'skills');
    await fs.mkdir(rootSkillsDir, { recursive: true });

    // File is directly in cwd — no intermediate directories to walk
    const filePath = path.join(testRootDir, 'file.ts');

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);

    expect(result).not.toContain(rootSkillsDir);
  });

  it('should return deepest directories first', async () => {
    // Create two skill directories at different depths
    const deepSkillsDir = path.join(
      testRootDir,
      'packages',
      'frontend',
      'src',
      CONFIG_DIR,
      'skills',
    );
    const shallowSkillsDir = path.join(
      testRootDir,
      'packages',
      'frontend',
      CONFIG_DIR,
      'skills',
    );
    await fs.mkdir(deepSkillsDir, { recursive: true });
    await fs.mkdir(shallowSkillsDir, { recursive: true });

    const filePath = path.join(
      testRootDir,
      'packages',
      'frontend',
      'src',
      'components',
      'Button.tsx',
    );

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);

    expect(result.length).toBeGreaterThanOrEqual(2);
    // Deepest should come first
    const deepIdx = result.indexOf(deepSkillsDir);
    const shallowIdx = result.indexOf(shallowSkillsDir);
    expect(deepIdx).toBeLessThan(shallowIdx);
  });

  it('should not re-discover already checked directories', async () => {
    const skillsDir = path.join(
      testRootDir,
      'packages',
      'lib',
      CONFIG_DIR,
      'skills',
    );
    await fs.mkdir(skillsDir, { recursive: true });

    const filePath = path.join(
      testRootDir,
      'packages',
      'lib',
      'src',
      'index.ts',
    );

    const options = { checkedDirs: new Set<string>() };
    // First call discovers it
    const result1 = await discoverSkillDirsForPaths([filePath], testRootDir, options);
    expect(result1).toContain(skillsDir);

    // Second call should return empty (already checked)
    const result2 = await discoverSkillDirsForPaths([filePath], testRootDir, options);
    expect(result2).toHaveLength(0);
  });

  it('should handle non-existent intermediate directories gracefully', async () => {
    // No skill directories exist anywhere
    const filePath = path.join(
      testRootDir,
      'packages',
      'app',
      'src',
      'main.ts',
    );

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);
    expect(result).toHaveLength(0);
  });

  it('should skip gitignored skill directories', async () => {
    const { isPathGitignored } = await import('../utils/gitignore.js');
    const mockIsPathGitignored = vi.mocked(isPathGitignored);
    mockIsPathGitignored.mockResolvedValue(true);

    const skillsDir = path.join(
      testRootDir,
      'node_modules',
      'some-pkg',
      CONFIG_DIR,
      'skills',
    );
    await fs.mkdir(skillsDir, { recursive: true });

    const filePath = path.join(
      testRootDir,
      'node_modules',
      'some-pkg',
      'src',
      'index.ts',
    );

    const result = await discoverSkillDirsForPaths([filePath], testRootDir);
    expect(result).not.toContain(skillsDir);
  });

  it('should handle multiple file paths', async () => {
    const frontendSkillsDir = path.join(
      testRootDir,
      'packages',
      'frontend',
      CONFIG_DIR,
      'skills',
    );
    const backendSkillsDir = path.join(
      testRootDir,
      'packages',
      'backend',
      CONFIG_DIR,
      'skills',
    );
    await fs.mkdir(frontendSkillsDir, { recursive: true });
    await fs.mkdir(backendSkillsDir, { recursive: true });

    const filePaths = [
      path.join(testRootDir, 'packages', 'frontend', 'src', 'App.tsx'),
      path.join(testRootDir, 'packages', 'backend', 'src', 'server.ts'),
    ];

    const result = await discoverSkillDirsForPaths(filePaths, testRootDir);

    expect(result).toContain(frontendSkillsDir);
    expect(result).toContain(backendSkillsDir);
  });
});
