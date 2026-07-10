/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanPackageBuildArtifacts } from '../clean-package-build-artifacts.js';

describe('clean package build artifacts', () => {
  it('removes workspace outputs without deleting dependencies', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'clean-build-artifacts-'));

    try {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ workspaces: ['packages/*'] }),
      );
      mkdirSync(join(tempDir, 'packages', 'core', 'dist'), {
        recursive: true,
      });
      mkdirSync(join(tempDir, 'packages', 'core', 'node_modules', 'dep'), {
        recursive: true,
      });
      writeFileSync(join(tempDir, 'packages', 'core', 'package.json'), '{}');
      writeFileSync(join(tempDir, 'packages', 'core', 'dist', 'index.js'), '');
      writeFileSync(
        join(tempDir, 'packages', 'core', 'tsconfig.tsbuildinfo'),
        '',
      );

      cleanPackageBuildArtifacts({ root: tempDir });

      expect(existsSync(join(tempDir, 'packages', 'core', 'dist'))).toBe(false);
      expect(
        existsSync(join(tempDir, 'packages', 'core', 'tsconfig.tsbuildinfo')),
      ).toBe(false);
      expect(
        existsSync(join(tempDir, 'packages', 'core', 'node_modules', 'dep')),
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
