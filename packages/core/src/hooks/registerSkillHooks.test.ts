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

  it('should preserve sequential and supported hook fields when registering', () => {
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
            sequential: true,
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "checking command"',
                name: 'command-hook',
                description: 'Command hook description',
                env: {
                  EXISTING: '1',
                },
                async: true,
                shell: 'bash',
                timeout: 5,
                statusMessage: 'Running command hook',
              },
            ],
          },
        ],
        [HookEventName.PostToolUse]: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: HookType.Http,
                url: 'https://example.com/hook',
                if: "tool_name == 'Write'",
                name: 'http-hook',
                description: 'HTTP hook description',
                headers: {
                  Authorization: 'Bearer token',
                },
                allowedEnvVars: ['API_KEY'],
                timeout: 10,
                statusMessage: 'Running HTTP hook',
                once: true,
              },
            ],
          },
        ],
      },
    };

    const count = registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(count).toBe(2);

    const preToolHooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PreToolUse,
    );
    expect(preToolHooks).toHaveLength(1);
    expect(preToolHooks[0].sequential).toBe(true);
    expect(preToolHooks[0].skillRoot).toBe(skillRoot);
    expect(preToolHooks[0].config.type).toBe(HookType.Command);
    if (preToolHooks[0].config.type === HookType.Command) {
      expect(preToolHooks[0].config.name).toBe('command-hook');
      expect(preToolHooks[0].config.description).toBe(
        'Command hook description',
      );
      expect(preToolHooks[0].config.env).toEqual({
        EXISTING: '1',
        QWEN_SKILL_ROOT: skillRoot,
      });
      expect(preToolHooks[0].config.async).toBe(true);
      expect(preToolHooks[0].config.shell).toBe('bash');
      expect(preToolHooks[0].config.timeout).toBe(5);
      expect(preToolHooks[0].config.statusMessage).toBe('Running command hook');
    }

    const postToolHooks = sessionHooksManager.getHooksForEvent(
      sessionId,
      HookEventName.PostToolUse,
    );
    expect(postToolHooks).toHaveLength(1);
    expect(postToolHooks[0].config.type).toBe(HookType.Http);
    if (postToolHooks[0].config.type === HookType.Http) {
      expect(postToolHooks[0].config.if).toBe("tool_name == 'Write'");
      expect(postToolHooks[0].config.name).toBe('http-hook');
      expect(postToolHooks[0].config.description).toBe('HTTP hook description');
      expect(postToolHooks[0].config.headers).toEqual({
        Authorization: 'Bearer token',
      });
      expect(postToolHooks[0].config.allowedEnvVars).toEqual(['API_KEY']);
      expect(postToolHooks[0].config.timeout).toBe(10);
      expect(postToolHooks[0].config.statusMessage).toBe('Running HTTP hook');
      expect(postToolHooks[0].config.once).toBe(true);
    }
  });
});
