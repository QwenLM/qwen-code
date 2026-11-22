/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillManager } from '@qwen-code/qwen-code-core/skills/skill-manager.js';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';
import { getServeAppLifecycle } from './serve-app-lifecycle.js';

const { watch, routeDeps } = vi.hoisted(() => ({
  watch: vi.fn(),
  routeDeps: { current: undefined as unknown },
}));
vi.mock('chokidar', () => ({ watch }));
vi.mock('./workspace-service/index.js', () => ({
  createDaemonWorkspaceService: vi.fn(() => ({})),
}));
vi.mock('./routes/workspace-skills.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./routes/workspace-skills.js')>();
  return {
    ...actual,
    registerWorkspaceSkillsRoutes: (
      ...args: Parameters<typeof actual.registerWorkspaceSkillsRoutes>
    ) => {
      routeDeps.current = args[1];
      actual.registerWorkspaceSkillsRoutes(...args);
    },
  };
});

class Watcher extends EventEmitter {
  close = vi.fn(async () => {
    this.removeAllListeners();
  });
}

describe('PR 16262 Critical reproduction', () => {
  let root: string;
  let workspace: string;
  let home: string;
  let now: number;
  let providers: Array<ReturnType<typeof createWorkspaceSkillsStatusProvider>>;
  let watchers: Map<string, Watcher>;
  let closeApp: (() => Promise<unknown>) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-review-repro-'));
    workspace = path.join(root, 'workspace');
    home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    vi.stubEnv('QWEN_HOME', home);
    vi.stubEnv('QWEN_CODE_SAFE_MODE', '0');
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    providers = [];
    watchers = new Map();
    watch.mockImplementation((directory: string) => {
      const watcher = new Watcher();
      watchers.set(directory, watcher);
      return watcher;
    });
  });

  afterEach(async () => {
    await closeApp?.();
    closeApp = undefined;
    await Promise.all(providers.map((provider) => provider.dispose?.()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    watch.mockReset();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeSkill(name: string, cwd = workspace) {
    const directory = path.join(cwd, '.qwen', 'skills', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\nInstructions\n`,
    );
    return directory;
  }

  function create() {
    const provider = createWorkspaceSkillsStatusProvider({
      autoDiscover: true,
    });
    providers.push(provider);
    return provider;
  }

  it('R1-1 discovers an unrelated valid addition despite a persistent malformed manifest', async () => {
    await writeSkill('retained');
    const provider = create();
    await provider(workspace);
    const malformed = await writeSkill('broken');
    await fs.writeFile(
      path.join(malformed, 'SKILL.md'),
      '---\nname: broken\n---\nMissing description\n',
    );
    await writeSkill('valid-addition');
    for (let window = 0; window < 4; window++) {
      now += 1000;
      await provider(workspace);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await expect(provider.snapshot(workspace)).rejects.toThrow(
      'could not be completely discovered',
    );
    expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
      'valid-addition',
    );
  });

  it('R1-2 bounds outstanding discovery after repeated scheduling timeouts', async () => {
    await writeSkill('retained');
    const provider = create();
    await provider(workspace);
    const original = SkillManager.prototype.listSkills;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scans = 0;
    vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementation(
      async function (this: SkillManager, options) {
        const cold = this.getCachedSkills() === null;
        const result = await original.call(this, options);
        if (cold) {
          scans++;
          await gate;
        }
        return result;
      },
    );
    try {
      for (let window = 0; window < 4; window++) {
        now += 6000;
        await provider(workspace);
        await new Promise((resolve) => setTimeout(resolve, 5100));
      }
      expect(scans).toBe(2);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 30000);

  it.each(['untrusted-read', 'trust-drain'] as const)(
    'R1-3 releases trusted subscriptions on %s while preserving shared watchers',
    async (transition) => {
      await writeSkill('project');
      await fs.mkdir(path.join(home, 'skills'));
      const other = path.join(root, 'other');
      await fs.mkdir(other);
      const { createServeApp } = await import('./server.js');
      const app = createServeApp(
        { hostname: '127.0.0.1', port: 4170, mode: 'http-bridge' },
        undefined,
        {
          boundWorkspace: workspace,
          bridge: {
            isChannelLive: vi.fn(() => false),
            queryWorkspaceStatus: vi.fn(),
            invokeWorkspaceCommand: vi.fn(),
            refreshExtensionsForAllSessions: vi.fn(async () => ({
              refreshed: 0,
              failed: 0,
            })),
            publishWorkspaceEvent: vi.fn(),
            shutdown: vi.fn(async () => {}),
          },
        } as never,
      );
      closeApp = () => getServeAppLifecycle(app).close();
      const deps = routeDeps.current as {
        getSkillsConfigStatus: (
          cwd: string,
          trusted: boolean,
        ) => Promise<unknown>;
      };
      await deps.getSkillsConfigStatus(workspace, true);
      await deps.getSkillsConfigStatus(other, true);
      const projectWatcher = watchers.get(
        path.join(workspace, '.qwen', 'skills'),
      )!;
      const sharedWatcher = watchers.get(path.join(home, 'skills'))!;
      expect(projectWatcher).toBeDefined();
      if (transition === 'untrusted-read') {
        await deps.getSkillsConfigStatus(workspace, false);
      } else {
        const invalidate = app.locals['invalidateSkillsConfigStatus'] as (
          cwd: string,
        ) => void;
        invalidate(workspace);
      }
      expect(projectWatcher.close).toHaveBeenCalledOnce();
      expect(sharedWatcher.close).not.toHaveBeenCalled();
      const scanned = vi.spyOn(SkillManager.prototype, 'listSkills');
      projectWatcher.emit('all', 'add', 'project/SKILL.md');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(scanned).not.toHaveBeenCalled();
    },
    30000,
  );
});
