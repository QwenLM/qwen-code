/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { PermissionManager } from './permission-manager.js';

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: () => ({
      ...actual.getShellConfiguration(),
      shell: 'bash',
    }),
  };
});

function makeManager(
  deny: string[] = [],
  ask: string[] = [],
  allow: string[] = ['Bash(*)'],
) {
  const manager = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
}

describe.each(['run_shell_command', 'monitor'])(
  '%s compound redirect cwd',
  (toolName) => {
    describe.each(['deny', 'ask'] as const)(
      '%s restrictions',
      (restriction) => {
        const restricted = (target: string) => {
          const rule = `Bash(git>${target} push *)`;
          return {
            rule,
            manager: makeManager(
              restriction === 'deny' ? [rule] : [],
              restriction === 'ask' ? [rule] : [],
            ),
          };
        };

        it.each([
          'git >./protected push "$BRANCH"',
          'git >./protected push $BRANCH',
          'git >./protected push origin "$BRANCH"',
        ])(
          'keeps an expanded argument from hiding a redirect: %s',
          async (command) => {
            const { manager } = restricted('protected');
            const ctx = { toolName, command };
            expect(manager.hasRelevantRules(ctx)).toBe(true);
            expect(
              await evaluatePermissionRules(manager, 'allow', ctx),
            ).toEqual({
              finalPermission: 'ask',
              pmForcedAsk: true,
            });
            expect(manager.hasMatchingAskRule(ctx)).toBe(true);
            expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
          },
        );

        it.each([
          'cd /tmp',
          'pushd /tmp',
          'popd',
          '"cd" /tmp',
          '! cd /tmp',
          'DIR=/tmp cd /tmp',
          'cd "$DIR"',
          '>log cd "$DIR"',
        ])('requires review after %s without guessing cwd', async (prefix) => {
          const { manager } = restricted('/tmp/protected');
          const ctx = {
            toolName,
            command: `${prefix} && git >protected push origin main`,
          };
          expect(manager.hasRelevantRules(ctx)).toBe(true);
          expect(await evaluatePermissionRules(manager, 'allow', ctx)).toEqual({
            finalPermission: 'ask',
            pmForcedAsk: true,
          });
          expect(manager.hasMatchingAskRule(ctx)).toBe(true);
          expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
        });

        it('does not claim an initial-cwd restriction matched after cd', async () => {
          const { manager } = restricted('/project/protected');
          const ctx = {
            toolName,
            command: 'cd /tmp && git >protected push origin main',
          };
          expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
            finalPermission: 'ask',
            pmForcedAsk: true,
          });
          expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
        });

        it.each([
          'cd /tmp && git >/tmp/protected push origin main',
          'git >/tmp/protected push origin main && cd /tmp',
        ])('preserves a cwd-independent match: %s', async (command) => {
          const { manager, rule } = restricted('/tmp/protected');
          const ctx = { toolName, command };
          expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
            finalPermission: restriction,
            pmForcedAsk: restriction === 'ask',
          });
          expect(manager.findMatchingDenyRule(ctx)).toBe(
            restriction === 'deny' ? rule : undefined,
          );
        });

        it.each([
          'git >protected push origin main',
          'echo cd && git >protected push origin main',
          'echo "$X" cd && git >protected push origin main',
          'echo "$X" pushd && git >protected push origin main',
          'echo "$X" popd && git >protected push origin main',
          'git status && git >protected push origin main',
          'cd /tmp && git >/safe push origin main',
          'cd /tmp && echo >protected hello',
        ])(
          'keeps a known unrelated invocation allowed: %s',
          async (command) => {
            const { manager } = restricted('/tmp/protected');
            const ctx = { toolName, command };
            expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
              finalPermission: 'allow',
              pmForcedAsk: false,
            });
            expect(manager.hasMatchingAskRule(ctx)).toBe(false);
            expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
          },
        );

        it('keeps the known cwd for a redirect before cd', async () => {
          const { manager, rule } = restricted('/project/protected');
          const ctx = {
            toolName,
            command: 'git >protected push origin main && cd /tmp',
          };
          expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
            finalPermission: restriction,
            pmForcedAsk: restriction === 'ask',
          });
          expect(manager.findMatchingDenyRule(ctx)).toBe(
            restriction === 'deny' ? rule : undefined,
          );
        });
      },
    );

    it('does not force review without a restrictive redirect rule', async () => {
      expect(
        await evaluatePermissionRules(makeManager(), 'ask', {
          toolName,
          command: 'cd /tmp && git >protected push origin main',
        }),
      ).toEqual({ finalPermission: 'allow', pmForcedAsk: false });
    });

    it('keeps an unresolved restriction relevant without an allow rule', async () => {
      const manager = makeManager(['Bash(git>/tmp/protected push *)'], [], []);
      const ctx = {
        toolName,
        command: 'cd /tmp && git >protected push "$BRANCH"',
      };
      expect(manager.hasRelevantRules(ctx)).toBe(true);
      expect(await evaluatePermissionRules(manager, 'allow', ctx)).toEqual({
        finalPermission: 'ask',
        pmForcedAsk: true,
      });
      expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
    });

    it('honors a definite deny even when another redirect rule is uncertain', async () => {
      const manager = makeManager([
        'Bash(git>/tmp/protected push *)',
        'Bash(git push *)',
      ]);
      const ctx = {
        toolName,
        command: 'cd /tmp && git >protected push origin main',
      };
      expect(await manager.evaluate(ctx)).toBe('deny');
      expect(manager.findMatchingDenyRule(ctx)).toBe('Bash(git push *)');
    });

    it('preserves a direct relative redirect restriction', async () => {
      const rule = 'Bash(git>protected push *)';
      const manager = makeManager([rule]);
      const ctx = {
        toolName,
        command: 'cd /tmp && git >protected push origin main',
      };
      expect(await manager.evaluate(ctx)).toBe('deny');
      expect(manager.findMatchingDenyRule(ctx)).toBe(rule);
    });

    it('does not anchor a leading wildcard rule for an absolute target', async () => {
      const manager = makeManager(['Bash(git>*/protected push *)']);
      const ctx = {
        toolName,
        command: 'cd /tmp && git >/safe push origin main',
      };
      expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
        finalPermission: 'allow',
        pmForcedAsk: false,
      });
      expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
    });

    it('uses the full-command tracker for virtual operations after cd', async () => {
      const ctx = {
        toolName,
        command: 'cd /tmp && git >protected push origin main',
      };
      const destination = makeManager(['Write(//tmp/protected)']);
      expect(await destination.evaluate(ctx)).toBe('deny');
      expect(destination.findMatchingDenyRule(ctx)).toBe(
        'Write(//tmp/protected)',
      );
      const initial = makeManager(['Write(//project/protected)']);
      expect(await initial.evaluate(ctx)).toBe('allow');
      expect(initial.findMatchingDenyRule(ctx)).toBeUndefined();
    });
  },
);
