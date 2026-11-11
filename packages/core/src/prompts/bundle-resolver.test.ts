/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveLocalPromptMode,
  resolvePromptPolicy,
} from './bundle-resolver.js';

const emptyPolicy = Object.freeze({
  bundleByModel: Object.freeze({}),
  sectionGates: Object.freeze({}),
});

describe('prompt bundle resolver', () => {
  it('parses the local three-state environment contract', () => {
    expect(resolveLocalPromptMode(undefined)).toBeUndefined();
    expect(resolveLocalPromptMode(' TRUE ')).toBe('lean');
    expect(resolveLocalPromptMode('1')).toBe('lean');
    expect(resolveLocalPromptMode('false')).toBe('full');
    expect(resolveLocalPromptMode('0')).toBe('full');
    expect(resolveLocalPromptMode('invalid')).toBeUndefined();
  });

  it('defaults all models to Full until Lean is explicitly enabled', () => {
    for (const effectiveModel of [
      'ultimate',
      'alibaba/qwen3.8-max',
      'custom',
    ]) {
      expect(
        resolvePromptPolicy({
          effectiveModel,
          localMode: undefined,
          policy: emptyPolicy,
        }).bundle,
      ).toBe('full');
    }
  });

  it('lets the local override enable Lean for any model key', () => {
    for (const effectiveModel of ['qwen3.8-max', 'ULTIMATE', 'custom']) {
      expect(
        resolvePromptPolicy({
          effectiveModel,
          localMode: 'lean',
          policy: emptyPolicy,
        }).bundle,
      ).toBe('lean');
    }
  });

  it('lets the remote policy explicitly enable or disable Lean for any model', () => {
    expect(
      resolvePromptPolicy({
        effectiveModel: 'custom',
        localMode: undefined,
        policy: {
          bundleByModel: { custom: 'lean' },
          sectionGates: {},
        },
      }).bundle,
    ).toBe('lean');
    expect(
      resolvePromptPolicy({
        effectiveModel: 'custom',
        localMode: undefined,
        policy: {
          bundleByModel: { custom: 'full' },
          sectionGates: {},
        },
      }).bundle,
    ).toBe('full');
  });

  it('gives an explicit local override precedence over the remote policy', () => {
    expect(
      resolvePromptPolicy({
        effectiveModel: 'ultimate',
        localMode: 'lean',
        policy: {
          bundleByModel: { ultimate: 'full' },
          sectionGates: {},
        },
      }).bundle,
    ).toBe('lean');
    expect(
      resolvePromptPolicy({
        effectiveModel: 'ultimate',
        localMode: 'full',
        policy: {
          bundleByModel: { ultimate: 'lean' },
          sectionGates: {},
        },
      }).bundle,
    ).toBe('full');
  });

  it.each(['ultimate', 'custom'])(
    'lets QCS enable optional behavior sections for %s',
    (effectiveModel) => {
      const resolved = resolvePromptPolicy({
        effectiveModel,
        localMode: undefined,
        policy: {
          bundleByModel: {},
          sectionGates: {
            'communication.turn_updates': 'enable',
            'behavior.verified_vs_assumed': 'enable',
            'behavior.act_dont_rederive': 'enable',
            'behavior.delivering_work': 'enable',
            'behavior.overcorrection': 'enable',
            'behavior.tool_argument_json': 'enable',
            'behavior.autonomy': 'enable',
          },
        },
      });

      expect(resolved.enabledSectionGates).toEqual([
        'communication.turn_updates',
        'behavior.verified_vs_assumed',
        'behavior.act_dont_rederive',
        'behavior.delivering_work',
        'behavior.overcorrection',
        'behavior.tool_argument_json',
        'behavior.autonomy',
      ]);
    },
  );

  it('keeps behavior gates disabled when QCS has no policy', () => {
    const resolved = resolvePromptPolicy({
      effectiveModel: 'ultimate',
      localMode: undefined,
      policy: emptyPolicy,
    });

    expect(resolved.enabledSectionGates).toEqual([]);
  });

  it('keeps an explicitly disabled behavior section off', () => {
    const resolved = resolvePromptPolicy({
      effectiveModel: 'ultimate',
      localMode: undefined,
      policy: {
        bundleByModel: {},
        sectionGates: {
          'behavior.act_dont_rederive': 'disable',
        },
      },
    });

    expect(resolved.enabledSectionGates).toEqual([]);
  });
});
