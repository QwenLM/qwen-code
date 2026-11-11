/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserResource } from './userResource.js';
import { UserSkillProvider } from '../kinds/skills/providers/userSkillProvider.js';
import { UserAgentProvider } from '../kinds/agents/providers/userAgentProvider.js';
import { OutputStyleProvider } from '../kinds/outputStyles/providers/outputStyleProvider.js';
import { ResourceWatchBridge } from '../watch/resourceWatchBridge.js';

const roots: string[] = [];
async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'user-resource-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function skill(home: string, name: string, description: string) {
  const dir = join(home, '.qwen', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody`,
  );
}

async function markdown(
  home: string,
  domain: string,
  name: string,
  body: string,
) {
  const dir = join(home, '.qwen', domain);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${name}\n---\n${body}`,
  );
  return file;
}

describe('UserResource', () => {
  it('loads each user domain once and exposes per-domain candidate views', async () => {
    const home = await createRoot();
    await skill(home, 'shared', 'User skill');
    await markdown(home, 'agents', 'shared', 'User agent');
    await markdown(home, 'output-styles', 'shared', 'User style');
    const skills = vi.spyOn(UserSkillProvider.prototype, 'load');
    const agents = vi.spyOn(UserAgentProvider.prototype, 'load');
    const styles = vi.spyOn(OutputStyleProvider.prototype, 'load');

    const user = new UserResource({ homeDir: home });
    const view = user.skills;
    await Promise.all([user.initialize(), view.ready]);

    expect(skills).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
    expect(
      styles.mock.contexts.filter(
        (provider) =>
          provider instanceof OutputStyleProvider &&
          provider.source === 'userSettings',
      ),
    ).toHaveLength(1);
    expect(view.getAllDiscoveredSkills().map((item) => item.name)).toEqual([
      'shared',
    ]);
    expect(
      user.agents.getAllDiscoveredAgents().map((item) => item.name),
    ).toEqual(['shared']);
    expect(
      user.outputStyles.getAllDiscoveredOutputStyles().map((item) => item.name),
    ).toEqual(['shared']);
    await user.dispose();
  });

  it('loads one process-fixed user Skill view with compatibility candidates', async () => {
    const home = await createRoot();
    await skill(home, 'same', 'User skill');
    const compatibility = join(home, '.agents', 'skills');
    await mkdir(join(compatibility, 'same'), { recursive: true });
    await mkdir(join(compatibility, 'compat-only'), { recursive: true });
    await writeFile(
      join(compatibility, 'same', 'SKILL.md'),
      '---\ndescription: Compatibility skill\n---\nBody',
    );
    await writeFile(
      join(compatibility, 'compat-only', 'SKILL.md'),
      '---\ndescription: Compatibility only\n---\nBody',
    );

    const user = new UserResource({
      homeDir: home,
      loadFromAgentsDirectory: true,
    });
    const loads = vi.spyOn(UserSkillProvider.prototype, 'load');
    const view = user.skills;
    await view.ready;
    expect(loads).toHaveBeenCalledTimes(1);
    expect(
      view
        .getAllDiscoveredSkills()
        .map((item) => item.description),
    ).toEqual(['Compatibility skill', 'Compatibility only', 'User skill']);
    expect(user.skills).toBe(view);
    await user.dispose();
  });

  it('activates user compatibility once and filters it per session', async () => {
    const home = await createRoot();
    await skill(home, 'standard', 'Standard skill');
    const compatibility = join(home, '.agents', 'skills', 'legacy');
    await mkdir(compatibility, { recursive: true });
    await writeFile(
      join(compatibility, 'SKILL.md'),
      '---\ndescription: Legacy skill\n---\nBody',
    );
    const loads = vi.spyOn(UserSkillProvider.prototype, 'load');
    const setTargets = vi.spyOn(ResourceWatchBridge.prototype, 'setTargets');
    const user = new UserResource({
      homeDir: home,
      loadFromAgentsDirectory: false,
    });
    try {
      const disabled = user.getSkills({ loadFromAgentsDirectory: false });
      await disabled.ready;
      expect(
        disabled.getAllDiscoveredSkills().map((item) => item.name),
      ).toEqual(['standard']);

      const enabled = user.getSkills({ loadFromAgentsDirectory: true });
      await enabled.ready;
      expect(loads.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(enabled.getAllDiscoveredSkills().map((item) => item.name)).toEqual(
        ['legacy', 'standard'],
      );
      expect(
        disabled.getAllDiscoveredSkills().map((item) => item.name),
      ).toEqual(['standard']);

      const anotherEnabled = user.getSkills({ loadFromAgentsDirectory: true });
      await anotherEnabled.ready;
      expect(setTargets).toHaveBeenCalledTimes(1);
      const disabledChanged = vi.fn();
      const enabledChanged = vi.fn();
      disabled.onDidChange(disabledChanged);
      enabled.onDidChange(enabledChanged);
      await user.reloadSkills();
      expect(
        disabledChanged.mock.calls[0]?.[1].discoveredSkills.map(
          (item: { name: string }) => item.name,
        ),
      ).toEqual(['standard']);
      expect(
        enabledChanged.mock.calls[0]?.[1].discoveredSkills.map(
          (item: { name: string }) => item.name,
        ),
      ).toEqual(['legacy', 'standard']);
    } finally {
      await user.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a regular skill visible when compatibility points to the same file',
    async () => {
      const home = await createRoot();
      await skill(home, 'standard', 'Standard skill');
      const compatibility = join(home, '.agents', 'skills');
      await mkdir(compatibility, { recursive: true });
      await symlink(
        join(home, '.qwen', 'skills', 'standard'),
        join(compatibility, 'alias'),
        'dir',
      );
      const user = new UserResource({
        homeDir: home,
        loadFromAgentsDirectory: true,
      });
      try {
        const disabled = user.getSkills({ loadFromAgentsDirectory: false });
        await disabled.ready;
        expect(
          disabled.getAllDiscoveredSkills().map((item) => item.name),
        ).toEqual(['standard']);
      } finally {
        await user.dispose();
      }
    },
  );

  it('waits for a pre-activation read before publishing compatibility skills', async () => {
    const home = await createRoot();
    const compatibility = join(home, '.agents', 'skills', 'legacy');
    await mkdir(compatibility, { recursive: true });
    await writeFile(join(compatibility, 'SKILL.md'), '---\ndescription: Legacy skill\n---\nBody');
    const user = new UserResource({ homeDir: home });
    let releaseRead: () => void = () => undefined;
    try {
      await user.skills.ready;
      let readStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { readStarted = resolve; });
      const held = new Promise<void>((resolve) => { releaseRead = resolve; });
      const originalLoad = UserSkillProvider.prototype.load;
      vi.spyOn(UserSkillProvider.prototype, 'load').mockImplementationOnce(async function (this: UserSkillProvider) {
        const oldSnapshot = await originalLoad.call(this);
        readStarted();
        await held;
        return oldSnapshot;
      });
      const staleReload = user.reloadSkills({ notify: false });
      await started;
      const enabled = user.getSkills({ loadFromAgentsDirectory: true });
      releaseRead();
      await Promise.all([staleReload, enabled.ready]);
      expect(enabled.getAllDiscoveredSkills().map((item) => item.name)).toEqual(['legacy']);
    } finally {
      releaseRead();
      await user.dispose();
    }
  });

  it('resolves compatibility skills from home when the config root is overridden', async () => {
    const home = await createRoot();
    const configRoot = join(await createRoot(), 'custom-config');
    const compatibility = join(home, '.agents', 'skills', 'home-skill');
    await mkdir(compatibility, { recursive: true });
    await writeFile(join(compatibility, 'SKILL.md'), '---\ndescription: Home skill\n---\nBody');
    const user = new UserResource({
      homeDir: home,
      globalConfigDirOverride: configRoot,
      loadFromAgentsDirectory: true,
    });
    try {
      await user.skills.ready;
      expect(user.skills.getAllDiscoveredSkills().map((item) => item.name)).toEqual(['home-skill']);
    } finally {
      await user.dispose();
    }
  });

  it('keeps the shared Skill view when one subscriber leaves', async () => {
    const home = await createRoot();
    await skill(home, 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    const first = user.skills;
    const second = user.skills;
    expect(second).toBe(first);
    await first.ready;
    const departed = vi.fn();
    const active = vi.fn();
    first.onDidChange(departed)();
    second.onDidChange(active);
    await user.reloadSkills();
    expect(departed).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledOnce();
    expect(user.skills).toBe(first);
    await user.dispose();
  });

  it('notifies skill subscribers with file events and candidate snapshots', async () => {
    const home = await createRoot();
    await skill(home, 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    const view = user.skills;
    await Promise.all([user.initialize(), view.ready, view.watcherReady]);
    const changed = vi.fn();
    view.onDidChange(changed);

    await skill(home, 'shared', 'After');
    // The store watcher re-reads before notifying the view.
    await vi.waitFor(
      () =>
        expect(
          view.getAllDiscoveredSkills().map((item) => item.description),
        ).toEqual(['After']),
      { timeout: 9000, interval: 100 },
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    // Native signals can also invalidate a missing commands target anchored
    // at the same parent. The batch must include the changed Skill, but need
    // not contain exactly one target-level event.
    expect(changed.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          source: 'user',
          operation: 'change',
        }),
      ]),
    );
    expect(typeof changed.mock.calls[0][0][0]?.path).toBe('string');
    expect(changed.mock.calls[0][1]).toMatchObject({
      discoveredSkills: expect.any(Array),
    });
    await user.dispose();
  });

  it('isolates candidate snapshots between subscribers to the same user Skill view', async () => {
    const home = await createRoot();
    await skill(home, 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    const view = user.skills;
    try {
      await view.ready;
      view.onDidChange((_events, snapshot) => {
        snapshot.discoveredSkills[0].description = 'Subscriber mutation';
      });
      const otherSubscriber = vi.fn();
      view.onDidChange(otherSubscriber);
      await user.reloadSkills();
      expect(otherSubscriber).toHaveBeenCalledExactlyOnceWith(
        undefined,
        expect.objectContaining({
          discoveredSkills: [
            expect.objectContaining({ description: 'Before' }),
          ],
        }),
      );
      expect(view.getAllDiscoveredSkills()[0].description).toBe('Before');
    } finally {
      await user.dispose();
    }
  });

  it('re-reads user skills on explicit reload and suppresses notifications when requested', async () => {
    const home = await createRoot();
    await skill(home, 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    const view = user.skills;
    await Promise.all([user.initialize(), view.ready]);
    const changed = vi.fn();
    view.onDidChange(changed);

    await skill(home, 'shared', 'Reloaded');
    await user.reloadSkills({ notify: false });
    expect(
      view.getAllDiscoveredSkills().map((item) => item.description),
    ).toEqual(['Reloaded']);
    expect(changed).not.toHaveBeenCalled();

    await skill(home, 'shared', 'Notified');
    await user.reloadSkills();
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ discoveredSkills: expect.any(Array) }),
    );
    await user.dispose();
  });

  it('reloads user agents and output styles and keeps the last snapshot on failure', async () => {
    const home = await createRoot();
    await markdown(home, 'agents', 'shared', 'Before');
    await markdown(home, 'output-styles', 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    await user.initialize();
    await markdown(home, 'agents', 'shared', 'After');
    await markdown(home, 'output-styles', 'shared', 'After');
    await user.reloadAgents();
    await user.reloadOutputStyles();
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('After');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
      'After',
    );
    const failure = vi
      .spyOn(UserAgentProvider.prototype, 'load')
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(user.reloadAgents()).rejects.toThrow('read failed');
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('After');
    failure.mockRestore();
    await user.dispose();
  });

  it('rejects user Agent and OutputStyle reload after disposal', async () => {
    const home = await createRoot();
    await markdown(home, 'agents', 'shared', 'Before');
    await markdown(home, 'output-styles', 'shared', 'Before');
    const user = new UserResource({ homeDir: home });
    await user.initialize();
    let finishAgentRead!: (value: Awaited<ReturnType<UserAgentProvider['load']>>) => void;
    let finishStyleRead!: (value: Awaited<ReturnType<OutputStyleProvider['load']>>) => void;
    vi.spyOn(UserAgentProvider.prototype, 'load').mockImplementationOnce(
      () => new Promise((resolve) => { finishAgentRead = resolve; }),
    );
    vi.spyOn(OutputStyleProvider.prototype, 'load').mockImplementationOnce(
      () => new Promise((resolve) => { finishStyleRead = resolve; }),
    );
    const agentReload = user.reloadAgents();
    const styleReload = user.reloadOutputStyles();
    const disposal = user.dispose();
    finishAgentRead({ source: 'user', agents: [], loadErrors: [] });
    finishStyleRead({ outputStyles: [], loadErrors: [] });
    await expect(agentReload).rejects.toThrow('disposed');
    await expect(styleReload).rejects.toThrow('disposed');
    await disposal;
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('Before');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('Before');
    await expect(user.reloadAgents()).rejects.toThrow('disposed');
    await expect(user.reloadOutputStyles()).rejects.toThrow('disposed');
  });

  it('copies returned candidates so consumers cannot mutate shared snapshots', async () => {
    const home = await createRoot();
    await markdown(home, 'agents', 'shared', 'Body');
    const user = new UserResource({ homeDir: home });
    await user.initialize();
    const returned = user.agents.getAllDiscoveredAgents()[0];
    returned.prompt = 'mutated';
    returned.metadata.source = 'project';
    expect(user.agents.getAllDiscoveredAgents()[0]).toMatchObject({
      prompt: 'Body',
      metadata: { source: 'user' },
    });
    await user.dispose();
  });

  it('binds one user root and rejects mismatching options', async () => {
    const home = await createRoot();
    const other = await createRoot();
    const user = new UserResource({ homeDir: home });
    try {
      expect(user.hasSamePaths({ homeDir: home })).toBe(true);
      expect(
        user.hasSamePaths({
          homeDir: home,
          globalConfigDirOverride: join(home, '.qwen', 'nested', '..'),
          userAgentSkillsDirOverride: join(home, '.agents', 'skills'),
        }),
      ).toBe(true);
      expect(user.hasSamePaths({ homeDir: other })).toBe(false);
    } finally {
      await user.dispose();
    }
  });
});
