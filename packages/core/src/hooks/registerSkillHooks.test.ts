/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerSkillHooks,
  removeReviewActiveMarker,
} from './registerSkillHooks.js';
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

describe('registerSkillHooks /review session marker', () => {
  let sessionHooksManager: SessionHooksManager;
  const sessionId = 'test-session';
  let cwdBefore: string;
  let tmpProjectDir: string;
  const markerRel = join('.qwen', 'tmp', 'qwen-review-active');

  beforeEach(() => {
    sessionHooksManager = new SessionHooksManager();
    cwdBefore = process.cwd();
    tmpProjectDir = mkdtempSync(join(tmpdir(), 'qwen-review-marker-'));
    process.chdir(tmpProjectDir);
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  it('writes the /review session marker when the review skill is registered', () => {
    // Closes the pre-fetch-pr window: guard.sh checks for the marker (in
    // addition to qwen-review-pr-*-fetch.json) so a model that runs
    // `git checkout FETCH_HEAD` BEFORE fetch-pr still gets denied.
    const skill: SkillConfig = {
      name: 'review',
      description: 'Code review skill',
      level: 'bundled',
      filePath: '/path/to/review/SKILL.md',
      body: 'Review prose',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'run_shell_command',
            hooks: [
              {
                type: HookType.Command,
                command: 'bash guard.sh',
              },
            ],
          },
        ],
      },
    };
    expect(existsSync(markerRel)).toBe(false);
    registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(existsSync(markerRel)).toBe(true);
  });

  it('does not write the marker for non-review skills', () => {
    // Skill-specific guard: only the bundled /review skill writes the
    // marker. A future "deploy" skill registering its own PreToolUse
    // hook must not be flagged as a /review session.
    const skill: SkillConfig = {
      name: 'deploy',
      description: 'Deploy skill',
      level: 'user',
      filePath: '/path/to/deploy/SKILL.md',
      body: 'Deploy prose',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              { type: HookType.Command, command: 'echo deploy-guard' },
            ],
          },
        ],
      },
    };
    registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(existsSync(markerRel)).toBe(false);
  });

  it('removeReviewActiveMarker removes the marker idempotently', () => {
    const skill: SkillConfig = {
      name: 'review',
      description: 'Code review skill',
      level: 'bundled',
      filePath: '/path/to/review/SKILL.md',
      body: 'Review prose',
      hooks: {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'run_shell_command',
            hooks: [
              { type: HookType.Command, command: 'bash guard.sh' },
            ],
          },
        ],
      },
    };
    registerSkillHooks(sessionHooksManager, sessionId, skill);
    expect(existsSync(markerRel)).toBe(true);
    expect(removeReviewActiveMarker()).toBe(true);
    expect(existsSync(markerRel)).toBe(false);
    // Idempotent: removing again returns false (already gone) but
    // does not throw — `qwen review cleanup` calls this defensively.
    expect(removeReviewActiveMarker()).toBe(false);
  });
});
