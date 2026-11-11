/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));

import {
  _resetPromptPolicyForTesting,
  getPromptPolicySnapshot,
  parsePromptPolicyValue,
  PROMPT_POLICY_FEATURE_GATE,
  registerPromptPolicyFeature,
} from './promptPolicy.js';

describe('prompt_policy', () => {
  beforeEach(() => {
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    _resetPromptPolicyForTesting();
  });

  it('parses equivalent object and JSON payloads', () => {
    const payload = {
      bundleByModel: { ultimate: 'full' },
      sectionGates: {
        'communication.turn_updates': 'enable',
        'behavior.verified_vs_assumed': 'enable',
        'behavior.act_dont_rederive': 'disable',
        'behavior.delivering_work': 'enable',
        'behavior.overcorrection': 'enable',
        'behavior.tool_argument_json': 'enable',
        'behavior.autonomy': 'enable',
      },
    };
    expect(parsePromptPolicyValue(payload)).toEqual(
      parsePromptPolicyValue(JSON.stringify(payload)),
    );
  });

  it('rejects invalid bundle modes and accepts arbitrary model keys', () => {
    expect(
      parsePromptPolicyValue({ bundleByModel: { ultimate: 'invalid' } }),
    ).toBeUndefined();
    expect(
      parsePromptPolicyValue({ bundleByModel: { ultimate: 'inherit' } }),
    ).toBeUndefined();
    expect(
      parsePromptPolicyValue({
        sectionGates: { 'behavior.delivering_work': 'inherit' },
      }),
    ).toBeUndefined();
    expect(
      parsePromptPolicyValue({
        bundleByModel: { unknown: 'lean' },
        sectionGates: { unknown: 'enable' },
      }),
    ).toEqual({ bundleByModel: { unknown: 'lean' }, sectionGates: {} });
  });

  it('reads only own model properties without prototype pollution', () => {
    const inherited = Object.create({ ultimate: 'lean' }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(inherited, '__proto__', {
      value: 'lean',
      enumerable: true,
    });
    const parsed = parsePromptPolicyValue({ bundleByModel: inherited });
    expect(parsed!.bundleByModel['ultimate']).toBeUndefined();
    expect(parsed!.bundleByModel['__proto__']).toBe('lean');
    expect(Object.getPrototypeOf(parsed!.bundleByModel)).toBe(Object.prototype);
  });

  it('fully replaces last-known-good and preserves it on invalid updates', () => {
    registerPromptPolicyFeature();
    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      PROMPT_POLICY_FEATURE_GATE,
      expect.any(Function),
    );
    const onChange = mocks.subscribeConfigValue.mock.calls[0][1];
    onChange({
      bundleByModel: { ultimate: 'lean' },
      sectionGates: { 'behavior.delivering_work': 'enable' },
    });
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(getPromptPolicySnapshot()).toMatchObject({
      bundleByModel: { ultimate: 'lean' },
      sectionGates: { 'behavior.delivering_work': 'enable' },
    });

    onChange({});
    expect(getPromptPolicySnapshot()).toEqual({
      bundleByModel: {},
      sectionGates: {},
    });

    onChange({ bundleByModel: { ultimate: 'bad' } });
    expect(getPromptPolicySnapshot()).toEqual({
      bundleByModel: {},
      sectionGates: {},
    });
  });

  it('clears the previous identity policy on explicit removal', () => {
    registerPromptPolicyFeature();
    const onChange = mocks.subscribeConfigValue.mock.calls[0][1];
    onChange({ sectionGates: { 'behavior.act_dont_rederive': 'enable' } });
    expect(getPromptPolicySnapshot().sectionGates['behavior.act_dont_rederive']).toBe('enable');
    onChange(undefined);
    expect(getPromptPolicySnapshot()).toEqual({ bundleByModel: {}, sectionGates: {} });
  });

  it('reuses one deeply frozen snapshot while the gate value is unchanged', () => {
    mocks.getConfigValue.mockReturnValue({
      bundleByModel: { ultimate: 'full' },
    });
    const first = getPromptPolicySnapshot();
    const second = getPromptPolicySnapshot();
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bundleByModel)).toBe(true);
    expect(Object.isFrozen(first.sectionGates)).toBe(true);
  });

  it('parses and freezes explicit model behavior and false flags', () => {
    const payload = {
      behaviorByModel: { custom: { mitigations: true, modernDefaults: false } },
      behaviorFlags: { autonomyEnabled: false, brief: true },
    };
    const parsed = parsePromptPolicyValue(payload)!;
    expect(parsed).toEqual({ bundleByModel: {}, sectionGates: {}, ...payload });
    expect(parsed).toEqual(parsePromptPolicyValue(JSON.stringify(payload)));
    expect(Object.isFrozen(parsed.behaviorByModel)).toBe(true);
    expect(Object.isFrozen(parsed.behaviorByModel?.['custom'])).toBe(true);
    expect(Object.isFrozen(parsed.behaviorFlags)).toBe(true);
    payload.behaviorByModel.custom.mitigations = false;
    expect(parsed.behaviorByModel?.['custom']?.mitigations).toBe(true);
  });

  it.each([
    { behaviorByModel: [] },
    { behaviorByModel: { custom: 'invalid' } },
    { behaviorByModel: { custom: { mitigations: 'true' } } },
    { behaviorFlags: { autonomyEnabled: 'false' } },
    { behaviorFlags: null },
  ])('rejects invalid behavior policy %j', (value) => {
    expect(parsePromptPolicyValue(value)).toBeUndefined();
  });

  it('keeps model profile keys as own data properties', () => {
    const parsed = parsePromptPolicyValue(
      JSON.parse('{"behaviorByModel":{"__proto__":{"mitigations":true}}}'),
    )!;
    expect(Object.hasOwn(parsed.behaviorByModel!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed.behaviorByModel)).toBe(
      Object.prototype,
    );
    expect(parsed.behaviorByModel?.['__proto__']?.mitigations).toBe(true);
  });

  it('preserves the last valid behavior snapshot after a malformed update', () => {
    mocks.getConfigValue.mockReturnValue({
      behaviorByModel: { custom: { mitigations: true } },
    });
    const valid = getPromptPolicySnapshot();
    mocks.getConfigValue.mockReturnValue({
      behaviorFlags: { brief: 'true' },
    });
    expect(getPromptPolicySnapshot()).toBe(valid);
    mocks.getConfigValue.mockReturnValue({});
    expect(getPromptPolicySnapshot().behaviorByModel).toBeUndefined();
  });
});
