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
});
