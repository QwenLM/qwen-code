/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { PreToolUseHookOutput } from '../hooks/types.js';
import { SkillCallLifecycle } from './skillCallLifecycle.js';
import { businessInfoContext } from '../utils/sessionIdContext.js';

function fixture() {
  const events: Array<{
    event: string;
    context: unknown;
    interrupted?: unknown;
    aborted?: boolean;
  }> = [];
  const config = {
    getSkillManager: () => ({
      getSkill: (name: string) => ({
        name,
        source: 'project',
        location: `/skills/${name}/SKILL.md`,
      }),
    }),
    getHookSystem: () => ({
      firePreToolUseEvent: async () => ({
        finalOutput: new PreToolUseHookOutput({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { skill: 'second' },
          },
        }),
      }),
      firePostToolUseEvent: async (...args: unknown[]) => {
        events.push({ event: 'post', context: args[9] });
        return {};
      },
      firePostToolUseFailureEvent: async (...args: unknown[]) => {
        events.push({
          event: 'failure',
          context: args[9],
          interrupted: args[10],
          aborted: (args[7] as AbortSignal)?.aborted,
        });
        return {};
      },
    }),
  } as unknown as Config;
  return { config, events };
}

describe(
  'SkillCallLifecycle',
  () => {
    it('preserves file marketplace features through direct Skill activation', async () => {
      const { config } = fixture();
      let features: unknown;
      Object.assign(
        config,
        {
          getSkillManager: () => ({
            getSkill: () => ({
              name: 'owner:review',
              source: 'plugin',
              plugin: {
                marketSourceId: 'file-market',
                orgId: 'file-org',
                itemKind: 'plugin',
                marketItemId: 'file-id',
                displayName: 'File plugin',
                version: 'file-version',
              },
            }),
          }),
          getHookSystem: () => ({
            firePostToolUseEvent: async (...args: unknown[]) => {
              features = (args[11] as { extensionFeatures: unknown }).extensionFeatures;
            },
          }),
        },
      );
      const lifecycle = new SkillCallLifecycle(
        config,
        { skill: 'owner:review' },
        'selected_skills',
      );

      await lifecycle.succeed('body');

      expect(features).toMatchObject({
        marketSourceId: 'file-market',
        marketOrgId: 'file-org',
        extensionKind: 'plugin',
        extensionId: 'file-id',
        extensionVersion: 'file-version',
      });
    });

    it(
      'keeps synthetic selection facts across a manager reload after PreToolUse',
      async () => {
        const { config } = fixture();
        let source = 'project';
        let features:
          | import('../extensions/extension-features.js').ExtensionFeatures
          | undefined;
        let execution:
          | import('../extensions/extension-features.js').ExtensionExecutionFields
          | undefined;
        const hooks = config.getHookSystem()!;
        Object.assign(
          config,
          {
            getSessionId: () => 's',
            getSkillManager: () => ({
              getSkill: (name: string) => ({
                name,
                source,
                resourceLocation: {
                  base: 'project_config',
                  relativePath: `skills/${name}/SKILL.md`,
                  softlink: false,
                },
              }),
            }),
            getHookSystem: () => ({
              ...hooks,
              firePostToolUseEvent: async (...args: unknown[]) => {
                execution = (args[11] as { extensionExecution: typeof execution })
                  .extensionExecution;
                features = (args[11] as { extensionFeatures: typeof features })
                  .extensionFeatures;
              },
            }),
          }
        );
        const call = new SkillCallLifecycle(
          config,
          { skill: 'first' },
          'selected_skills',
        );
        await call.pre();
        source = 'plugin';
        await call.succeed('ok');
        expect(features).toMatchObject({
          skillSource: 'project',
          resourceRelativePath: 'skills/second/SKILL.md',
        });
        expect(execution?.name).toBe('second');
      }
    );
    it(
      'retains known fork cancellation in the frozen features',
      async () => {
        const { config } = fixture();
        const controller = new AbortController();
        controller.abort();
        let features:
          | import('../extensions/extension-features.js').ExtensionFeatures
          | undefined;
        let execution:
          | import('../extensions/extension-features.js').ExtensionExecutionFields
          | undefined;
        Object.assign(
          config,
          {
            getSessionId: () => 's',
            getHookSystem: () => ({
              firePostToolUseFailureEvent: async (...args: unknown[]) => {
                execution = (args[12] as { extensionExecution: typeof execution })
                  .extensionExecution;
                features = (args[12] as { extensionFeatures: typeof features })
                  .extensionFeatures;
              },
            }),
          }
        );
        const call = new SkillCallLifecycle(
          config,
          { skill: 'first' },
          'slash_command',
          { fork: true, signal: controller.signal },
        );
        await call.succeed('late');
        expect(features).toMatchObject({
          success: false,
          contentLength: '',
        });
        expect(execution?.status).toBe('cancelled');
      }
    );
    it.each(['succeed', 'fail'] as const)(
      'freezes the effective synthetic Skill without invented scheduler timing on %s',
      async (method) => {
        const { config } = fixture();
        Object.assign(
          config,
          {
            getSessionId: () => 's',
          }
        );
        let features:
          | import('../extensions/extension-features.js').ExtensionFeatures
          | undefined;
        let execution:
          | import('../extensions/extension-features.js').ExtensionExecutionFields
          | undefined;
        const hooks = config.getHookSystem()!;
        Object.assign(
          config,
          {
            getHookSystem: () => ({
              ...hooks,
              firePostToolUseEvent: async (...args: unknown[]) => {
                execution = (args[11] as { extensionExecution: typeof execution })
                  .extensionExecution;
                features = (args[11] as { extensionFeatures: typeof features })
                  .extensionFeatures;
              },
              firePostToolUseFailureEvent: async (...args: unknown[]) => {
                execution = (args[12] as { extensionExecution: typeof execution })
                  .extensionExecution;
                features = (args[12] as { extensionFeatures: typeof features })
                  .extensionFeatures;
              },
            }),
          }
        );
        const call = new SkillCallLifecycle(
          config,
          { skill: 'first' },
          'selected_skills',
        );
        await call.pre();
        await call[method](
          method === 'fail' ? new Error('original failure') : 'abc',
        );
        expect(features).toMatchObject({
          activationSource: 'selected_skills',
          skillSource: 'project',
          success: method === 'succeed',
        });
        expect(Object.keys(features!)).toHaveLength(38);
        expect(execution).toMatchObject({
          name: 'second',
          status: method === 'succeed' ? 'success' : 'error',
        });
        expect(execution).not.toHaveProperty('durationMs');
        expect(features).not.toHaveProperty('skillName');
        expect(Object.isFrozen(features)).toBe(true);
      },
    );
    describe(
      'runtime hook businessId',
      () => {
        it.each(['succeed', 'fail'] as const)(
          'retains the construction snapshot on %s across contexts',
          async (method) => {
            const { config } = fixture();
            const events: unknown[][] = [];
            Object.assign(
              config,
              {
                getHookSystem: () => ({
                  firePostToolUseEvent: async (...args: unknown[]) => {
                    events.push(args);
                  },
                  firePostToolUseFailureEvent: async (...args: unknown[]) => {
                    events.push(args);
                  },
                }),
              }
            );
            const source = { id: 'B1' };
            const calls = businessInfoContext.run(
              source as never,
              () => [
                new SkillCallLifecycle(
                  config,
                  { skill: 'first' },
                  'selected_skills'
                ),
                new SkillCallLifecycle(
                  config,
                  { skill: 'first' },
                  'agent_preload',
                  {
                    businessId: 'explicit',
                  }
                ),
              ]
            );
            source.id = 'mutated';
            await businessInfoContext.run(
              { id: 'B2' } as never,
              async () => {
                for (const call of calls) {
                  await call[method](method === 'fail' ? new Error('broken') : {});
                  await call[method]({});
                }
              }
            );
            expect(
              events.map((args) => args[method === 'succeed' ? 11 : 12]),
            ).toMatchObject([
              { businessId: 'B1', extensionFeatures: { toolCallId: calls[0].id } },
              {
                businessId: 'explicit',
                extensionFeatures: { toolCallId: calls[1].id },
              },
            ]);
          },
        );

        it(
          'keeps a missing construction source undefined at completion',
          async () => {
            const { config } = fixture();
            let attribution: unknown;
            Object.assign(
              config,
              {
                getHookSystem: () => ({
                  firePostToolUseEvent: async (...args: unknown[]) => {
                    attribution = args[11];
                  },
                }),
              }
            );
            const call = new SkillCallLifecycle(
              config,
              { skill: 'first' },
              'selected_skills',
            );
            await businessInfoContext.run(
              { id: 'later' } as never,
              () =>
                call.succeed({}),
            );
            expect(attribution).toMatchObject({
              businessId: undefined,
              extensionFeatures: { toolCallId: call.id },
            });
          }
        );
      }
    );

    it(
      'reports the effective skill and completes one successful direct call once',
      async () => {
        const { config, events } = fixture();
        const call = new SkillCallLifecycle(
          config,
          { skill: 'first' },
          'slash_command',
        );
        await call.pre();
        call.markInjected();
        await call.succeed({ success: true });
        await call.succeed({ success: true });
        expect(events).toEqual([
          {
            event: 'post',
            context: expect.objectContaining({
              requested_skill_name: 'first',
              skill_name: 'second',
              skill_activated: true,
            }),
          },
        ]);
      }
    );

    it(
      'keeps the cancellation exception confined to fork calls',
      async () => {
        const { config, events } = fixture();
        const controller = new AbortController();
        const call = new SkillCallLifecycle(
          config,
          { skill: 'fork' },
          'slash_command',
          { signal: controller.signal, fork: true },
        );
        call.markInjected();
        controller.abort();
        await call.fail(new Error('cancelled'));
        expect(events[0]).toMatchObject({
          event: 'failure',
          interrupted: true,
          aborted: false,
          context: { skill_activated: true, failure_stage: 'execution' },
        });
      }
    );
  }
);
