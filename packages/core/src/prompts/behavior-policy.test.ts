/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePromptPolicyValue } from '../config-service/features/promptPolicy.js';
import {
  readPromptBehaviorOverrides,
  type PromptBehaviorOverrides,
} from './behavior-policy.js';
import { resolvePromptPolicy } from './bundle-resolver.js';
import { selectCommunicationVariant } from './sections/communication.js';
import { SystemPromptAssembler } from './system-prompt-assembler.js';
import {
  ALL_PROMPT_SURFACES,
  type PromptAssemblyContext,
  type PromptBundle,
} from './types.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/native-behavior-2.1.270.json', import.meta.url),
    'utf8',
  ),
) as {
  texts: Record<string, string>;
  cases: Array<{
    name: string;
    effectiveModel: string;
    bundle: PromptBundle;
    policy: unknown;
    overrides: PromptBehaviorOverrides;
    expected: {
      communication: string;
      autonomy: boolean;
      deliveringWork: boolean;
    };
  }>;
};

// Expected text and decisions were captured from the extracted native functions,
// with model metadata and feature lookups supplied by each fixture's inputs.
describe('prompt behavior native 2.1.270 parity', () => {
  it.each(fixture.cases)('$name', async (sample) => {
    const policy = parsePromptPolicyValue(sample.policy);
    expect(policy).toBeDefined();
    const resolved = resolvePromptPolicy({
      effectiveModel: sample.effectiveModel,
      localMode: sample.bundle,
      policy: policy!,
      behaviorOverrides: sample.overrides,
    });
    expect(resolved.enabledSectionGates.includes('behavior.autonomy')).toBe(
      sample.expected.autonomy,
    );
    expect(
      resolved.enabledSectionGates.includes('behavior.delivering_work'),
    ).toBe(sample.expected.deliveringWork);

    for (const surface of ALL_PROMPT_SURFACES) {
      const context: PromptAssemblyContext = {
        source: 'default',
        ...resolved,
        surface,
        renderInputs: {
          usingTools: { cacheVariant: 'empty', compute: () => null },
          hostCapabilities: [],
        },
      };
      const communication =
        await selectCommunicationVariant(context).render(context);
      expect(communication?.trim()).toBe(
        fixture.texts[sample.expected.communication],
      );
      const prompt = (
        await new SystemPromptAssembler({
          sessionId: `parity:${sample.name}:${surface}`,
        }).build(context)
      ).join('\n\n');
      expect(prompt.includes(fixture.texts['autonomy']!)).toBe(
        sample.expected.autonomy,
      );
      expect(prompt.includes(fixture.texts['delivering_work']!)).toBe(
        sample.expected.deliveringWork,
      );
      if (sample.expected.deliveringWork && sample.expected.autonomy) {
        expect(prompt.indexOf('# Delivering work')).toBeLessThan(
          prompt.indexOf('You are operating autonomously'),
        );
      }
    }
  });

  it('preserves absent and explicit false environment overrides', () => {
    expect(readPromptBehaviorOverrides({})).toEqual({
      turnUpdates: undefined,
      outcomeFirst: undefined,
      autonomy: undefined,
      actDontRederive: undefined,
      deliveringWork: undefined,
    });
    expect(
      readPromptBehaviorOverrides({
        QWEN_TURN_UPDATES: 'false',
        QWEN_OUTCOME_FIRST: '1',
        QWEN_AUTONOMY: 'invalid',
        QWEN_ACT_DONT_REDERIVE: 'false',
        QWEN_DELIVERING_WORK: '0',
        QWEN_FRONTEND_GUIDANCE: 'true',
      }),
    ).toEqual({
      turnUpdates: false,
      outcomeFirst: true,
      autonomy: undefined,
      actDontRederive: false,
      deliveringWork: false,
      frontendGuidance: true,
    });
  });

  it('does not reuse another communication subvariant from the session cache', async () => {
    const assembler = new SystemPromptAssembler({
      sessionId: 'communication-variant-change',
    });
    for (const name of [
      'modern-defaults-full',
      'model-turn-disabled-modern-full',
      'model-turn-disabled-modern-mitigated-full',
      'model-turn-disabled-modern-mitigated-brief-full',
      'modern-defaults-full',
      'mitigations-full',
      'mitigated-brief-full',
      'unconfigured-lean',
      'model-outcome-first-full',
      'mitigations-full',
    ]) {
      const sample = fixture.cases.find((entry) => entry.name === name)!;
      const resolved = resolvePromptPolicy({
        effectiveModel: sample.effectiveModel,
        localMode: sample.bundle,
        policy: parsePromptPolicyValue(sample.policy)!,
        behaviorOverrides: sample.overrides,
      });
      const prompt = (
        await assembler.build({
          source: 'default',
          ...resolved,
          surface: 'headless',
          renderInputs: {
            usingTools: { cacheVariant: 'empty', compute: () => null },
            hostCapabilities: [],
          },
        })
      ).join('\n\n');
      expect(prompt).toContain(fixture.texts[sample.expected.communication]);
      expect(prompt.includes('Everything the user needs from this turn')).toBe(
        sample.expected.communication === 'outcome_first_final',
      );
    }
  });
});

describe.each(['full', 'lean'] as const)(
  'act_dont_rederive environment override with %s prompts',
  (bundle) => {
    it.each([
      ['true', 'disable', true],
      ['1', 'disable', true],
      ['false', 'enable', false],
      ['0', 'enable', false],
      [undefined, 'enable', true],
      [undefined, 'disable', false],
      [undefined, undefined, false],
      ['invalid', 'enable', true],
      ['invalid', undefined, false],
    ] as const)(
      'renders the section for env=%s and gate=%s: %s',
      async (env, gate, enabled) => {
        const resolved = resolvePromptPolicy({
          effectiveModel: 'custom',
          localMode: bundle,
          policy: {
            bundleByModel: {},
            sectionGates:
              gate === undefined ? {} : { 'behavior.act_dont_rederive': gate },
          },
          behaviorOverrides: readPromptBehaviorOverrides({
            QWEN_ACT_DONT_REDERIVE: env,
          }),
        });
        const prompt = (
          await new SystemPromptAssembler({
            sessionId: `act-dont-rederive:${bundle}:${env}:${gate}`,
          }).build({
            source: 'default',
            ...resolved,
            surface: 'headless',
            renderInputs: {
              usingTools: { cacheVariant: 'empty', compute: () => null },
              hostCapabilities: [],
            },
          })
        ).join('\n\n');
        expect(prompt.includes('When you have enough information to act, act.'))
          .toBe(enabled);
      },
    );
  },
);
