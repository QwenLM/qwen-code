/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseSdkSkillEvolutionConfig,
  resolveSdkSkillEvolutionEnablement,
  parseSdkEvolutionConfig,
} from './sdkSkillEvolution.js';

describe('sdk skill evolution configuration', () => {
  it('reads skill evolution beneath the evolution namespace', () => {
    expect(parseSdkEvolutionConfig({
      skill: {
        requester: 'sdk',
        mode: 'native',
        generation: { turnComplete: { reviewThreshold: 7 } },
      },
    })).toEqual({
      skill: {
        requester: 'sdk',
        mode: 'native',
        generation: { turnComplete: { reviewThreshold: 7 } },
      },
    });
    expect(() => parseSdkEvolutionConfig('invalid')).toThrow(
      /evolution must be an object/,
    );
  });

  it('parses custom generation options and defaults generation on', () => {
    const config = parseSdkSkillEvolutionConfig({
      requester: 'sdk',
      mode: 'custom',
      generation: {
        maxSuggestions: 4,
      },
    });
    expect(config).toEqual({
      requester: 'sdk',
      mode: 'custom',
      generation: {
        enabled: true,
        maxSuggestions: 4,
        prompt: undefined,
        turnComplete: undefined,
      },
    });
    expect(resolveSdkSkillEvolutionEnablement(config!)).toEqual({
      generationEnabled: true,
      turnCompleteEnabled: true,
    });
  });

  it('rejects SDK-provided roots because roots are derived from loaded skills', () => {
    expect(() => parseSdkSkillEvolutionConfig({
      requester: 'sdk',
      mode: 'custom',
      generation: {
        roots: [{ id: 'x', path: '/tmp/x', access: 'read' }],
      },
    })).toThrow(/does not accept roots/);
  });

  it('rejects invalid gate timeout and disabled generation gate', () => {
    expect(() => parseSdkSkillEvolutionConfig({
      requester: 'sdk', mode: 'custom', generation: {
        enabled: false,
        turnComplete: { enabled: true },
      },
    })).toThrow(/cannot be enabled/);
    expect(() => parseSdkSkillEvolutionConfig({
      requester: 'sdk', mode: 'custom', generation: {
        turnComplete: { timeoutMs: 0 },
      },
    })).toThrow(/timeoutMs/);
    expect(() => parseSdkSkillEvolutionConfig({
      requester: 'sdk', mode: 'custom', generation: {
        turnComplete: { shouldReviewCallbackId: 1 },
      },
    })).toThrow(/shouldReviewCallbackId/);
  });

  it.each([0, 11, 1.5])(
    'rejects review threshold %s outside the integer range 1 to 10',
    (reviewThreshold) => {
      expect(() => parseSdkSkillEvolutionConfig({
        requester: 'sdk',
        mode: 'native',
        generation: { turnComplete: { reviewThreshold } },
      })).toThrow(/reviewThreshold.*between 1 and 10/);
    },
  );
});
