/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getActiveSkillWatcherCount, SkillManager } from './skill-manager.js';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';

// Real files and the real chokidar implementation: watcher sharing is module
// state, so it is asserted against the native subscription count instead of
// mocked chokidar calls.
describe('SkillManager watcher sharing', () => {
  let qwenHome: string;
  let projectRoot: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(qwenHome, { recursive: true, force: true });
    await fsp.rm(projectRoot, { recursive: true, force: true });
  });

  it('opens one native watcher per directory and keeps it until the last manager stops', async () => {
    qwenHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-share-home-'));
    projectRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-share-project-'),
    );
    vi.stubEnv('QWEN_HOME', qwenHome);
    await fsp.mkdir(path.join(projectRoot, '.qwen', 'skills'), {
      recursive: true,
    });
    const config: Config = makeFakeConfig({});
    vi.spyOn(config, 'getProjectRoot').mockReturnValue(projectRoot);

    const first = new SkillManager(config);
    const second = new SkillManager(config);
    try {
      await first.startWatching();
      // The project directory plus the user Skills directory `startWatching`
      // creates.
      const afterFirst = getActiveSkillWatcherCount();
      expect(afterFirst).toBe(2);

      await second.startWatching();
      expect(getActiveSkillWatcherCount()).toBe(afterFirst);

      first.stopWatching();
      expect(getActiveSkillWatcherCount()).toBe(afterFirst);

      second.stopWatching();
      expect(getActiveSkillWatcherCount()).toBe(0);
    } finally {
      first.stopWatching();
      second.stopWatching();
    }
  });
});
