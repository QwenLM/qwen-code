/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerSkillHooks } from './registerSkillHooks.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import { HookEventName, HookType } from './types.js';
import type { SkillConfig } from '../skills/types.js';

describe('registerSkillHooks', () => {
  let sessionHooksManager: SessionHooksManager;
  const sessionId = 'test-session';
  const skillRoot = '/path/to/skill';

  beforeEach(() => {
    sessionHooksManager = new SessionHooksManager();
  });

  it('should return 0 when skill has no hooks', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      body: 'Test body',
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(0);
  });

  it('should register a single command hook', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "checking command"',
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(1);
    expect(sessionHooksManager.hasSessionHooks(sessionId)).toBe(true);
  });

  it('should register multiple hooks for different events', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "pre-tool-use"',
              },
            ],
          },
        ],
        [HookEventName.PostToolUse]: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "post-tool-use"',
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(2);
  });

  it('should register HTTP hooks', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Http,
                url: 'https://example.com/hook',
                headers: {
                  Authorization: 'Bearer token',
                },
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(1);
  });

  it('should register hooks with matcher pattern', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: '^(Write|Edit)$',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "file operation"',
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(1);

    const hooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PreToolUse,
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0].matcher).toBe('^(Write|Edit)$');
  });

  it('should register multiple hooks for same event and matcher', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "first check"',
              },
              {
                type: HookType.Command,
                command: 'echo "second check"',
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(2);
  });

  it('should register hooks with skillRoot for environment variable', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo $QWEN_SKILL_ROOT',
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(1);

    const hooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PreToolUse,
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0].skillRoot).toBe(skillRoot);
  });

  it('should not duplicate hooks when the same skill registers again (skill reload)', () => {
    // Skill unload (/unskill, eviction sync) never unregisters session hooks,
    // so a reload must not push duplicate entries — otherwise the hook fires
    // once per unload/reload cycle.
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "checking command"',
              },
            ],
          },
        ],
      },
    };

    expect(registerSkillHooks(sessionHooksManager, sessionId, skill)).toBe(1);
    expect(registerSkillHooks(sessionHooksManager, sessionId, skill)).toBe(0);

    const hooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PreToolUse,
    );
    expect(hooks).toHaveLength(1);
  });

  it('still registers a same-command hook from a different skill', () => {
    const makeSkill = (name: string, root: string): SkillConfig => ({
      name,
      description: 'Test skill',
      level: 'user',
      filePath: `${root}/SKILL.md`,
      skillRoot: root,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "checking command"',
              },
            ],
          },
        ],
      },
    });

    expect(
      registerSkillHooks(
        sessionHooksManager,
        sessionId,
        makeSkill('skill-a', '/path/to/a'),
      ),
    ).toBe(1);
    expect(
      registerSkillHooks(
        sessionHooksManager,
        sessionId,
        makeSkill('skill-b', '/path/to/b'),
      ),
    ).toBe(1);

    const hooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PreToolUse,
    );
    expect(hooks).toHaveLength(2);
  });

  it('registers same-command hooks that differ only in timeout (R1-1)', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo hi',
                timeout: 10,
              },
              {
                type: HookType.Command,
                command: 'echo hi',
                timeout: 30,
              },
            ],
          },
        ],
      },
    };

    expect(registerSkillHooks(sessionHooksManager, sessionId, skill)).toBe(2);
  });

  it('registers same-URL http hooks that differ only in headers (R1-1)', () => {
    const skill: SkillConfig = {
      name: 'test-skill',
      description: 'Test skill',
      level: 'user',
      filePath: '/path/to/skill/SKILL.md',
      skillRoot,
      body: 'Test body',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
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
            ],
          },
        ],
      },
    };

    expect(registerSkillHooks(sessionHooksManager, sessionId, skill)).toBe(2);
  });
});
