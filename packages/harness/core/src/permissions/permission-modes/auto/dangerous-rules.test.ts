/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRules } from '../../manager/decision/index.js';
import {
  createDangerousRuleStash,
  filterDangerousAllowRules,
  isDangerousAgentPermission,
  isDangerousClassifierPermission,
  isDangerousShellPermission,
  restoreDangerousAllowRules,
  stripDangerousAllowRules,
  type DangerousRuleStash,
} from './dangerous-rules.js';

function rules(allow: Record<string, string[]>): PermissionRules {
  return { allow, deny: {}, ask: {} };
}

/** One session's stash, exactly as its `AutoClassifier` would hold one. */
let stash: DangerousRuleStash;

beforeEach(() => {
  stash = createDangerousRuleStash();
});

describe('isDangerousShellPermission', () => {
  it('treats a shell grant with no content as dangerous', () => {
    // Bare `Bash` allows every command, which is Yolo by another name.
    expect(isDangerousShellPermission('Bash', undefined)).toBe(true);
    expect(isDangerousShellPermission('Bash', '')).toBe(true);
    expect(isDangerousShellPermission('Bash', '*')).toBe(true);
  });

  it('treats an interpreter prefix as dangerous', () => {
    expect(isDangerousShellPermission('Bash', 'python:*')).toBe(true);
    expect(isDangerousShellPermission('Bash', 'node:*')).toBe(true);
  });

  it('leaves an ordinary command grant alone', () => {
    expect(isDangerousShellPermission('Bash', 'git status')).toBe(false);
    expect(isDangerousShellPermission('Bash', 'npm test')).toBe(false);
  });

  it('says nothing about other tools', () => {
    expect(isDangerousShellPermission('Read', undefined)).toBe(false);
  });
});

describe('isDangerousAgentPermission', () => {
  it('treats any agent grant as dangerous, content or not', () => {
    // A subagent approved up front is a prompt the classifier never reads.
    expect(isDangerousAgentPermission('Agent', undefined)).toBe(true);
    expect(isDangerousAgentPermission('Agent', 'Explore')).toBe(true);
  });

  it('says nothing about other tools', () => {
    expect(isDangerousAgentPermission('Read', undefined)).toBe(false);
  });
});

describe('isDangerousClassifierPermission', () => {
  it('covers shell, powershell and agent together', () => {
    expect(isDangerousClassifierPermission('Bash', 'python:*')).toBe(true);
    expect(isDangerousClassifierPermission('PowerShell', '*')).toBe(true);
    expect(isDangerousClassifierPermission('Agent', undefined)).toBe(true);
    expect(isDangerousClassifierPermission('Read', '//repo/**')).toBe(false);
  });
});

describe('filterDangerousAllowRules', () => {
  it('keeps the original set when every grant is narrow', () => {
    const input = rules({ userSettings: ['Read', 'Bash(git status)'] });
    expect(filterDangerousAllowRules(input)).toBe(input);
    expect(filterDangerousAllowRules(rules({}))).toEqual(rules({}));
  });

  it('filters dangerous grants from every source without changing the input', () => {
    const allow = {
      policySettings: ['Bash'],
      userSettings: ['Bash(*)', 'Read'],
      projectSettings: ['Bash(python:*)'],
      localSettings: ['PowerShell(*)'],
      cliArg: ['Agent'],
      session: ['Agent(general-purpose)', 'Bash(npm test)'],
    };
    for (const grants of Object.values(allow)) Object.freeze(grants);
    const input = Object.freeze(rules(Object.freeze(allow)));
    const result = filterDangerousAllowRules(input);

    expect(result.allow).toEqual({
      policySettings: [],
      userSettings: ['Read'],
      projectSettings: [],
      localSettings: [],
      cliArg: [],
      session: ['Bash(npm test)'],
    });
    expect(input.allow).toBe(allow);
    expect(input.allow.session).toEqual([
      'Agent(general-purpose)',
      'Bash(npm test)',
    ]);
    expect(filterDangerousAllowRules(result)).toBe(result);
  });

  it('never filters deny or ask rules and does not change the entry-time stash', () => {
    const original = rules({ userSettings: ['Bash(node:*)'] });
    const stripped = stripDangerousAllowRules(stash, original);
    const input = {
      ...stripped,
      allow: { session: ['Bash', 'Read'] },
      deny: { session: ['Bash(python:*)'] },
      ask: { session: ['Agent'] },
    };
    const result = filterDangerousAllowRules(input);

    expect(result.deny).toBe(input.deny);
    expect(result.ask).toBe(input.ask);
    expect(restoreDangerousAllowRules(stash, result).allow).toEqual({
      session: ['Read'],
      userSettings: ['Bash(node:*)'],
    });
  });
});

describe('stripDangerousAllowRules', () => {
  it('returns the set unchanged when nothing is dangerous', () => {
    const input = rules({ userSettings: ['Read', 'Bash(git status)'] });

    expect(stripDangerousAllowRules(stash, input)).toBe(input);
  });

  it('removes only the dangerous rules, keeping the rest of the source', () => {
    const result = stripDangerousAllowRules(
      stash,
      rules({ userSettings: ['Read', 'Bash(python:*)', 'Bash(git status)'] }),
    );

    expect(result.allow.userSettings).toEqual(['Read', 'Bash(git status)']);
  });

  it('strips across every source', () => {
    const result = stripDangerousAllowRules(
      stash,
      rules({ userSettings: ['Agent'], projectSettings: ['Bash'] }),
    );

    expect(result.allow.userSettings).toEqual([]);
    expect(result.allow.projectSettings).toEqual([]);
  });

  it('does not touch deny or ask', () => {
    const input: PermissionRules = {
      allow: { userSettings: ['Bash'] },
      deny: { userSettings: ['WebFetch'] },
      ask: { userSettings: ['Edit'] },
    };

    const result = stripDangerousAllowRules(stash, input);

    expect(result.deny).toEqual(input.deny);
    expect(result.ask).toEqual(input.ask);
  });
});

describe('restoreDangerousAllowRules', () => {
  it('puts back exactly what was stripped', () => {
    const original = rules({
      userSettings: ['Read', 'Bash(python:*)'],
      projectSettings: ['Agent'],
    });

    const stripped = stripDangerousAllowRules(stash, original);
    const restored = restoreDangerousAllowRules(stash, stripped);

    expect(restored.allow.userSettings?.sort()).toEqual(
      ['Read', 'Bash(python:*)'].sort(),
    );
    expect(restored.allow.projectSettings).toEqual(['Agent']);
  });

  it('is a no-op when nothing was stripped', () => {
    const input = rules({ userSettings: ['Read'] });
    stripDangerousAllowRules(stash, input);

    expect(restoreDangerousAllowRules(stash, input)).toBe(input);
  });

  it('does not duplicate rules when called twice', () => {
    const stripped = stripDangerousAllowRules(
      stash,
      rules({ userSettings: ['Bash'] }),
    );

    const once = restoreDangerousAllowRules(stash, stripped);
    const twice = restoreDangerousAllowRules(stash, once);

    expect(twice.allow.userSettings).toEqual(['Bash']);
  });

  it('keeps rules added while Auto was active', () => {
    const stripped = stripDangerousAllowRules(
      stash,
      rules({ userSettings: ['Bash(python:*)'] }),
    );

    // The user allows something else while Auto is on, then leaves Auto.
    const withNew = {
      ...stripped,
      allow: { ...stripped.allow, userSettings: ['Read'] },
    };
    const restored = restoreDangerousAllowRules(stash, withNew);

    expect(restored.allow.userSettings?.sort()).toEqual(
      ['Read', 'Bash(python:*)'].sort(),
    );
  });

  it('does not re-add a rule the user wrote again by hand', () => {
    const stripped = stripDangerousAllowRules(
      stash,
      rules({ userSettings: ['Agent'] }),
    );

    const rewritten = {
      ...stripped,
      allow: { ...stripped.allow, userSettings: ['Agent'] },
    };
    const restored = restoreDangerousAllowRules(stash, rewritten);

    expect(restored.allow.userSettings).toEqual(['Agent']);
  });
});

describe('per-session stash isolation', () => {
  it('does not hand one session the rules another session stashed', () => {
    // Two sessions in one process — the SDK daemon, or ACP beside a worker.
    // Both enter Auto, then both leave.
    const sessionA = createDangerousRuleStash();
    const sessionB = createDangerousRuleStash();
    const aRules = rules({ userSettings: ['Bash(python:*)'] });
    const bRules = rules({ userSettings: ['Bash(node:*)'] });

    const aStripped = stripDangerousAllowRules(sessionA, aRules);
    const bStripped = stripDangerousAllowRules(sessionB, bRules);
    expect(aStripped.allow.userSettings).toEqual([]);
    expect(bStripped.allow.userSettings).toEqual([]);

    const aRestored = restoreDangerousAllowRules(sessionA, aStripped);
    const bRestored = restoreDangerousAllowRules(sessionB, bStripped);

    // Each gets its own back. A shared slot used to give B's rules to whoever
    // restored second, granting a session something it was never allowed.
    expect(aRestored.allow.userSettings).toEqual(['Bash(python:*)']);
    expect(bRestored.allow.userSettings).toEqual(['Bash(node:*)']);
  });
});
