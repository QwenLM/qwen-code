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

const { watch, stderr } = vi.hoisted(() => ({
  watch: vi.fn(),
  stderr: vi.fn(),
}));
vi.mock('chokidar', () => ({ watch }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));
vi.mock('../utils/stdioHelpers.js', () => ({ writeStderrLine: stderr }));

class Watcher extends EventEmitter {
  close = vi.fn(async () => {
    this.removeAllListeners();
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('configuration catalog automatic discovery', () => {
  let root: string;
  let workspace: string;
  let home: string;
  let now: number;
  let providers: Array<ReturnType<typeof createWorkspaceSkillsStatusProvider>>;
  let watchers: Map<string, Watcher>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-catalog-discovery-'));
    workspace = path.join(root, 'workspace');
    home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.mkdir(path.join(home, 'skills'));
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
    await Promise.all(providers.map((provider) => provider.dispose?.()));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    watch.mockReset();
    stderr.mockReset();
    await fs.rm(root, { recursive: true, force: true });
  });

  function create(
    options: Parameters<typeof createWorkspaceSkillsStatusProvider>[0] = {},
  ) {
    const provider = createWorkspaceSkillsStatusProvider({
      autoDiscover: true,
      ...options,
    });
    providers.push(provider);
    return provider;
  }

  async function writeSkill(name: string, description = name, cwd = workspace) {
    const directory = path.join(cwd, '.qwen', 'skills', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`,
    );
    return directory;
  }

  it('refreshes from filesystem events without a GET and coalesces events during a scan', async () => {
    await writeSkill('existing');
    const provider = create();
    await provider(workspace);
    const gate = deferred();
    const scanned = deferred();
    const original = SkillManager.prototype.listSkills;
    let scans = 0;
    vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementation(
      async function (this: SkillManager, options) {
        const cold = this.getCachedSkills() === null;
        const result = await original.call(this, options);
        if (cold && ++scans === 1) {
          scanned.resolve();
          await gate.promise;
        }
        return result;
      },
    );
    const watcher = watchers.get(path.join(workspace, '.qwen', 'skills'))!;
    await writeSkill('first');
    watcher.emit('all', 'add', 'first/SKILL.md');
    await scanned.promise;
    await writeSkill('second');
    watcher.emit('all', 'add', 'second/SKILL.md');
    gate.resolve();
    await vi.waitFor(() => expect(scans).toBe(2));
    await vi.waitFor(async () =>
      expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
        'second',
      ),
    );
    await provider(workspace);
    expect(scans).toBe(2);
  });

  it('reconciles missing directories over successive windows and applies settings on warm reads', async () => {
    const provider = create();
    const original = SkillManager.prototype.listSkills;
    let scans = 0;
    vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementation(function (
      this: SkillManager,
      options,
    ) {
      if (this.getCachedSkills() === null) scans++;
      return original.call(this, options);
    });
    await provider(workspace);
    const directory = await writeSkill('external', 'first');
    now += 999;
    expect((await provider(workspace)).skills.map((s) => s.name)).not.toContain(
      'external',
    );
    expect(scans).toBe(1);
    now += 1;
    await vi.waitFor(async () =>
      expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
        'external',
      ),
    );
    expect(scans).toBe(2);
    await fs.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabled: ['external'] } }),
    );
    expect(
      (await provider(workspace)).skills.find((s) => s.name === 'external')
        ?.status,
    ).toBe('disabled');
    await writeSkill('external', 'edited');
    now += 1000;
    await vi.waitFor(async () =>
      expect(
        (await provider(workspace)).skills.find((s) => s.name === 'external')
          ?.description,
      ).toBe('edited'),
    );
    await fs.rm(directory, { recursive: true });
    now += 1000;
    await vi.waitFor(async () =>
      expect(
        (await provider(workspace)).skills.map((s) => s.name),
      ).not.toContain('external'),
    );
  });

  it('shares subscriptions across workspaces and releases only the removed workspace', async () => {
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await writeSkill('one');
    await writeSkill('two', 'two', other);
    const provider = create();
    await Promise.all([provider(workspace), provider(other)]);
    const userDirectory = path.join(home, 'skills');
    expect(
      watch.mock.calls.filter(([dir]) => dir === userDirectory),
    ).toHaveLength(1);
    expect((await provider(other)).skills.map((s) => s.name)).not.toContain(
      'one',
    );
    const shared = watchers.get(userDirectory)!;
    const own = watchers.get(path.join(workspace, '.qwen', 'skills'))!;
    provider.invalidate?.(workspace);
    expect(own.close).toHaveBeenCalledOnce();
    expect(shared.close).not.toHaveBeenCalled();
    await provider.dispose?.();
    expect(shared.close).toHaveBeenCalledOnce();
    expect((await provider(workspace)).initialized).toBe(false);
  });

  it('keeps safe and inert untrusted catalogs inside their trust policy across cycles', async () => {
    await writeSkill('project');
    await fs.writeFile(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({ skills: { disabled: ['project'] } }),
    );
    const provider = create({
      workspaceTrusted: false,
      includeUntrustedSkills: true,
    });
    expect(
      (await provider(workspace)).skills.find((s) => s.name === 'project')
        ?.status,
    ).toBe('ok');
    await writeSkill('later');
    now += 1000;
    await vi.waitFor(async () =>
      expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
        'later',
      ),
    );
    expect(watch).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(workspace, '.agents')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    vi.stubEnv('QWEN_CODE_SAFE_MODE', '1');
    expect(
      (await provider(workspace)).skills.every((s) => s.level === 'bundled'),
    ).toBe(true);
    now += 1000;
    expect(
      (await provider(workspace)).skills.every((s) => s.level === 'bundled'),
    ).toBe(true);
    expect(watch).not.toHaveBeenCalled();
  });

  it('drops trusted subscriptions immediately on entering safe mode', async () => {
    await writeSkill('project');
    const provider = create();
    await provider(workspace);
    const priorWatchers = [...watchers.values()];
    vi.stubEnv('QWEN_CODE_SAFE_MODE', '1');
    expect(
      (await provider(workspace)).skills.every((s) => s.level === 'bundled'),
    ).toBe(true);
    for (const watcher of priorWatchers)
      expect(watcher.close).toHaveBeenCalledOnce();
  });

  it('does not start watchers for snapshots or non-config fallback callers', async () => {
    await writeSkill('project');
    const provider = create();
    expect(
      (await provider.snapshot(workspace)).skills.map((s) => s.name),
    ).toContain('project');
    const fallback = create({ autoDiscover: false });
    await fallback(workspace);
    now += 10_000;
    await fallback(workspace);
    expect(watch).not.toHaveBeenCalled();
  });

  it.each(['invalidate', 'dispose'] as const)(
    'fences a cold scan during %s',
    async (operation) => {
      await writeSkill('old');
      const gate = deferred();
      const scanned = deferred();
      const original = SkillManager.prototype.listSkills;
      vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementationOnce(
        async function (this: SkillManager, options) {
          const result = await original.call(this, options);
          scanned.resolve();
          await gate.promise;
          return result;
        },
      );
      const provider = create();
      const oldRead = provider(workspace);
      await scanned.promise;
      if (operation === 'dispose') await provider.dispose?.();
      else provider.invalidate?.(workspace);
      gate.resolve();
      await oldRead;
      expect(watch).not.toHaveBeenCalled();
      if (operation === 'invalidate') {
        await writeSkill('new');
        expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
          'new',
        );
      } else {
        expect((await provider(workspace)).initialized).toBe(false);
      }
    },
  );

  it('shares a slow background scan without delaying concurrent readers', async () => {
    await writeSkill('retained');
    const provider = create();
    await provider(workspace);
    const gate = deferred();
    const scanned = deferred();
    const original = SkillManager.prototype.listSkills;
    let scans = 0;
    vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementation(
      async function (this: SkillManager, options) {
        if (this.getCachedSkills() === null) {
          scans++;
          scanned.resolve();
          await gate.promise;
        }
        return original.call(this, options);
      },
    );
    now += 1000;
    await provider(workspace);
    await scanned.promise;
    now += 1000;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => provider(workspace)),
    );
    expect(scans).toBe(1);
    expect(
      results.every((result) =>
        result.skills.some((s) => s.name === 'retained'),
      ),
    ).toBe(true);
    gate.resolve();
  });

  it.each(['late-success', 'newer-success', 'invalidate'] as const)(
    'releases a timed-out slot and fences %s',
    async (scenario) => {
      await writeSkill('initial');
      const provider = create();
      await provider(workspace);
      const gate = deferred();
      const scanned = deferred();
      const original = SkillManager.prototype.listSkills;
      let scans = 0;
      vi.spyOn(SkillManager.prototype, 'listSkills').mockImplementation(
        async function (this: SkillManager, options) {
          const cold = this.getCachedSkills() === null;
          const result = await original.call(this, options);
          if (cold && ++scans === 1) {
            scanned.resolve();
            await gate.promise;
          }
          return result;
        },
      );
      await writeSkill('slow');
      now += 1000;
      await provider(workspace);
      await scanned.promise;
      // The timer is already running on real time; switching timers would lose it.
      await new Promise((resolve) => setTimeout(resolve, 5100));
      if (scenario !== 'late-success') {
        await fs.rm(path.join(workspace, '.qwen', 'skills', 'slow'), {
          recursive: true,
        });
        await writeSkill('newer');
        if (scenario === 'invalidate') provider.invalidate?.(workspace);
        now += 6000;
        await vi.waitFor(async () =>
          expect(
            (await provider(workspace)).skills.map((s) => s.name),
          ).toContain('newer'),
        );
      }
      gate.resolve();
      if (scenario === 'late-success') {
        await vi.waitFor(async () =>
          expect(
            (await provider(workspace)).skills.map((s) => s.name),
          ).toContain('slow'),
        );
      } else {
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          (await provider(workspace)).skills.map((s) => s.name),
        ).not.toContain('slow');
      }
    },
    15000,
  );

  it('retains a complete catalog after an unreadable directory and retries after recovery', async () => {
    await writeSkill('retained');
    const provider = create();
    await provider(workspace);
    const original = fs.readdir;
    const failing = vi.spyOn(fs, 'readdir').mockImplementation((...args) => {
      if (String(args[0]) === path.join(workspace, '.qwen', 'skills')) {
        return Promise.reject(
          Object.assign(new Error('unreadable'), { code: 'EACCES' }),
        );
      }
      return original(...args);
    });
    now += 1000;
    await provider(workspace);
    await vi.waitFor(() =>
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('unreadable'),
      ),
    );
    expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
      'retained',
    );
    failing.mockRestore();
    await writeSkill('recovered');
    now += 1000;
    await vi.waitFor(async () =>
      expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
        'recovered',
      ),
    );
  });

  it('rejects a partially discovered catalog and publishes a later complete scan', async () => {
    const directory = await writeSkill('retained');
    const provider = create();
    await provider(workspace);
    await fs.rm(directory, { recursive: true });
    await writeSkill('replacement');
    const failedDiscovery = vi
      .spyOn(SkillManager.prototype, 'hasDiscoveryReadErrors')
      .mockReturnValue(true);
    now += 1000;
    await provider(workspace);
    await vi.waitFor(() => expect(failedDiscovery).toHaveBeenCalled());
    const retained = (await provider(workspace)).skills.map((s) => s.name);
    expect(retained).toContain('retained');
    expect(retained).not.toContain('replacement');
    failedDiscovery.mockRestore();
    now += 1000;
    await vi.waitFor(async () => {
      const refreshed = (await provider(workspace)).skills.map((s) => s.name);
      expect(refreshed).toContain('replacement');
      expect(refreshed).not.toContain('retained');
    });
  });

  it('recovers from asynchronous watcher failure using read reconciliation', async () => {
    await writeSkill('initial');
    const provider = create();
    await provider(workspace);
    const watcher = watchers.get(path.join(workspace, '.qwen', 'skills'))!;
    watcher.emit('error', new Error('watch unavailable'));
    expect(watcher.close).toHaveBeenCalledOnce();
    for (let read = 0; read < 3; read++) await provider(workspace);
    const projectWatches = () =>
      watch.mock.calls.filter(
        ([dir]) => dir === path.join(workspace, '.qwen', 'skills'),
      ).length;
    expect(projectWatches()).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    await writeSkill('recovered');
    now += 1000;
    await vi.waitFor(async () =>
      expect((await provider(workspace)).skills.map((s) => s.name)).toContain(
        'recovered',
      ),
    );
    expect(projectWatches()).toBe(1);
    now += 30_000;
    await provider(workspace);
    expect(projectWatches()).toBe(2);
  });
});
