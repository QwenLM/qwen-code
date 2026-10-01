/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSkillHooks,
  unregisterSkillHooks,
} from './registerSkillHooks.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import { HookEventName, HookType } from './types.js';
import type { CommandHookConfig, HookConfig } from './types.js';
import type { SkillConfig } from '../skills/types.js';

type SkillHooks = NonNullable<SkillConfig['hooks']>;

const command = (command: string): CommandHookConfig => ({
  type: HookType.Command,
  command,
});

/** A single PreToolUse definition running `hooks` for tools matching `matcher`. */
const preToolUse = (matcher: string, ...hooks: HookConfig[]): SkillHooks => ({
  [HookEventName.PreToolUse]: [{ matcher, hooks }],
});

describe('registerSkillHooks', () => {
  let sessionHooksManager: SessionHooksManager;
  const sessionId = 'test-session';
  const skillRoot = '/path/to/skill';

  beforeEach(() => {
    sessionHooksManager = new SessionHooksManager();
  });

  /** The user skill `test-skill`, rooted at `skillRoot`, with `hooks`. */
  const testSkill = (hooks: SkillHooks): SkillConfig => ({
    name: 'test-skill',
    description: 'Test skill',
    level: 'user',
    filePath: '/path/to/skill/SKILL.md',
    skillRoot,
    body: 'Test body',
    hooks,
  });
  const register = (skill: SkillConfig) =>
    registerSkillHooks(sessionHooksManager, sessionId, skill);
  const preToolUseHooks = () =>
    sessionHooksManager.getHooksForEvent(sessionId, HookEventName.PreToolUse);

  it('should return 0 when skill has no hooks', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      body: 'Test body',
    };

    const count = register(skill);
    expect(count).toBe(0);
  });

  it('should register a single command hook', () => {
    const count = register(
      testSkill(preToolUse('Bash', command('echo "checking command"'))),
    );
    expect(count).toBe(1);
    expect(sessionHooksManager.hasSessionHooks(sessionId)).toBe(true);
  });

  it('should register multiple hooks for different events', () => {
    const skill = testSkill({
      ...preToolUse('Bash', command('echo "pre-tool-use"')),
      [HookEventName.PostToolUse]: [
        { matcher: 'Write', hooks: [command('echo "post-tool-use"')] },
      ],
    });

    const count = register(skill);
    expect(count).toBe(2);
  });

  it('should register HTTP hooks', () => {
    const skill = testSkill(
      preToolUse('Bash', {
        type: HookType.Http,
        url: 'https://example.com/hook',
        headers: {
          Authorization: 'Bearer token',
        },
      }),
    );

    const count = register(skill);
    expect(count).toBe(1);
  });

  it('should register hooks with matcher pattern', () => {
    const count = register(
      testSkill(preToolUse('^(Write|Edit)$', command('echo "file operation"'))),
    );
    expect(count).toBe(1);

    const hooks = preToolUseHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].matcher).toBe('^(Write|Edit)$');
  });

  it('matches every tool when a hook entry omits matcher', () => {
    const count = register(
      testSkill({
        [HookEventName.PreToolUse]: [{ hooks: [command('echo "every tool"')] }],
      }),
    );
    expect(count).toBe(1);

    for (const tool of ['write_file', 'run_shell_command']) {
      expect(
        sessionHooksManager.getMatchingHooks(
          sessionId,
          HookEventName.PreToolUse,
          tool,
        ),
      ).toHaveLength(1);
    }
  });

  it('should register multiple hooks for same event and matcher', () => {
    const skill = testSkill(
      preToolUse(
        'Bash',
        command('echo "first check"'),
        command('echo "second check"'),
      ),
    );

    const count = register(skill);
    expect(count).toBe(2);
  });

  it('should register hooks with skillRoot for environment variable', () => {
    const count = register(
      testSkill(preToolUse('Bash', command('echo $QWEN_SKILL_ROOT'))),
    );
    expect(count).toBe(1);

    const hooks = preToolUseHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].skillRoot).toBe(skillRoot);
  });

  it('should not duplicate hooks when the same skill registers again (skill reload)', () => {
    // Skill unload (/unskill, eviction sync) never unregisters session hooks,
    // so a reload must not push duplicate entries — otherwise the hook fires
    // once per unload/reload cycle.
    const skill = testSkill(
      preToolUse('Bash', command('echo "checking command"')),
    );

    expect(register(skill)).toBe(1);
    expect(register(skill)).toBe(0);

    expect(preToolUseHooks()).toHaveLength(1);
  });

  it('still registers a same-command hook from a different skill', () => {
    const makeSkill = (name: string, root: string): SkillConfig => ({
      ...testSkill(preToolUse('Bash', command('echo "checking command"'))),
      name,
      filePath: `${root}/SKILL.md`,
      skillRoot: root,
    });

    expect(register(makeSkill('skill-a', '/path/to/a'))).toBe(1);
    expect(register(makeSkill('skill-b', '/path/to/b'))).toBe(1);

    expect(preToolUseHooks()).toHaveLength(2);
  });

  it('registers same-command hooks that differ only in timeout (R1-1)', () => {
    const skill = testSkill(
      preToolUse(
        'Bash',
        { ...command('echo hi'), timeout: 10 },
        { ...command('echo hi'), timeout: 30 },
      ),
    );

    expect(register(skill)).toBe(2);
  });

  it('registers same-URL http hooks that differ only in headers (R1-1)', () => {
    const skill = testSkill(
      preToolUse(
        'Bash',
        {
          type: HookType.Http,
          url: 'http://gw.local/hook',
          headers: { Authorization: 'Bearer a' },
        },
        {
          type: HookType.Http,
          url: 'http://gw.local/hook',
          headers: { Authorization: 'Bearer b' },
        },
      ),
    );

    expect(register(skill)).toBe(2);
  });
});

describe('registerSkillHooks — the trust gate travels with the entry', () => {
  const hooks = preToolUse('Bash', command('./x.sh'));

  it("marks a project skill's hooks trust-gated, so the handler re-checks folder trust at fire time", () => {
    const manager = new SessionHooksManager();
    registerSkillHooks(manager, 's1', {
      name: 'repo-skill',
      description: 'repo',
      level: 'project',
      filePath: '/repo/.qwen/skills/repo-skill/SKILL.md',
      skillRoot: '/repo/.qwen/skills/repo-skill',
      body: '',
      hooks,
    });
    const [entry] = manager.getHooksForEvent('s1', HookEventName.PreToolUse);
    expect(entry.trustGated).toBe(true);
  });

  it("leaves a user skill's hooks ungated — they are not repository-controlled", () => {
    const manager = new SessionHooksManager();
    registerSkillHooks(manager, 's1', {
      name: 'home-skill',
      description: 'home',
      level: 'user',
      filePath: '/home/u/.qwen/skills/home-skill/SKILL.md',
      skillRoot: '/home/u/.qwen/skills/home-skill',
      body: '',
      hooks,
    });
    const [entry] = manager.getHooksForEvent('s1', HookEventName.PreToolUse);
    expect(entry.trustGated).toBeUndefined();
  });

  describe('unregisterSkillHooks', () => {
    const skillWithRoot = (name: string, root?: string): SkillConfig => ({
      name,
      description: name,
      level: 'user',
      filePath: `/skills/${name}/SKILL.md`,
      ...(root ? { skillRoot: root } : {}),
      body: '',
      hooks: preToolUse('Bash', command(`echo ${name}`)),
    });
    const preToolUseRoots = (manager: SessionHooksManager) =>
      manager
        .getHooksForEvent('s1', HookEventName.PreToolUse)
        .map((entry) => entry.skillRoot);

    it('removes only the hooks the skill registered', () => {
      const manager = new SessionHooksManager();
      const skillA = skillWithRoot('a', '/skills/a');
      const skillB = skillWithRoot('b', '/skills/b');
      registerSkillHooks(manager, 's1', skillA);
      registerSkillHooks(manager, 's1', skillB);

      expect(unregisterSkillHooks(manager, 's1', skillA)).toBe(1);
      expect(preToolUseRoots(manager)).toEqual(['/skills/b']);
      expect(registerSkillHooks(manager, 's1', skillA)).toBe(1);
    });

    it('removes every hook the skill registered across events', () => {
      const manager = new SessionHooksManager();
      const twoEvents: SkillConfig = {
        ...skillWithRoot('a', '/skills/a'),
        hooks: {
          ...preToolUse('Bash', command('echo a')),
          [HookEventName.PostToolUse]: [
            { matcher: 'Write', hooks: [command('echo a2')] },
          ],
        },
      };
      registerSkillHooks(manager, 's1', twoEvents);
      registerSkillHooks(manager, 's1', skillWithRoot('b', '/skills/b'));

      expect(unregisterSkillHooks(manager, 's1', twoEvents)).toBe(2);
      expect(preToolUseRoots(manager)).toEqual(['/skills/b']);
      expect(manager.getHooksForEvent('s1', HookEventName.PostToolUse)).toEqual(
        [],
      );
    });

    it('removes hooks by root even when the config no longer lists them', () => {
      const manager = new SessionHooksManager();
      const skillA = skillWithRoot('a', '/skills/a');
      registerSkillHooks(manager, 's1', skillA);

      expect(
        unregisterSkillHooks(manager, 's1', { ...skillA, hooks: undefined }),
      ).toBe(1);
      expect(manager.getHooksForEvent('s1', HookEventName.PreToolUse)).toEqual(
        [],
      );
    });

    it('removes nothing for a skill without a root directory', () => {
      const manager = new SessionHooksManager();
      const rootless = skillWithRoot('rootless');
      registerSkillHooks(manager, 's1', rootless);

      expect(unregisterSkillHooks(manager, 's1', rootless)).toBe(0);
      expect(
        manager.getHooksForEvent('s1', HookEventName.PreToolUse),
      ).toHaveLength(1);
    });
  });
});
