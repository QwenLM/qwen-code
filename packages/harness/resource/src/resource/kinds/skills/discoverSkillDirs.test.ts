/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCheckedSkillDirs,
  discoverSkillDirsForPaths,
} from './discoverSkillDirs.js';

let tmpDir: string;

beforeEach(async () => {
  clearCheckedSkillDirs();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-discovery-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('discoverSkillDirsForPaths', () => {
  it('discovers configured and legacy skill dirs deepest first', async () => {
    const filePath = path.join(tmpDir, 'packages', 'app', 'src', 'index.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '');
    await fs.mkdir(path.join(tmpDir, 'packages', '.qwen', 'skills'), {
      recursive: true,
    });
    await fs.mkdir(path.join(tmpDir, 'packages', 'app', '.agents', 'skills'), {
      recursive: true,
    });

    const dirs = await discoverSkillDirsForPaths([filePath], tmpDir, {
      loadFromAgentsDirectory: true,
    });

    expect(dirs).toEqual([
      path.join(tmpDir, 'packages', 'app', '.agents', 'skills'),
      path.join(tmpDir, 'packages', '.qwen', 'skills'),
    ]);
  });

  it('uses the injected ignore callback', async () => {
    const filePath = path.join(tmpDir, 'packages', 'app', 'src', 'index.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '');
    await fs.mkdir(path.join(tmpDir, 'packages', 'app', '.qwen', 'skills'), {
      recursive: true,
    });

    const dirs = await discoverSkillDirsForPaths([filePath], tmpDir, {
      isPathIgnored: () => true,
    });

    expect(dirs).toEqual([]);
  });
});
