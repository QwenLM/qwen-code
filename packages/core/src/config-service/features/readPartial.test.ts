/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConfigValue: vi.fn() }));
vi.mock('../index.js', () => mocks);
import { resolveReadPartialGate } from './readPartial.js';

const rule = { enabled: true };
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const decide = (eligible = true) => resolveReadPartialGate(eligible);

describe('Read PARTIAL feature gate', () => {
  it('enables with only a boolean QCS switch', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue(rule);
    expect(decide()).toEqual({ enabled: true, source: 'qcs' });
  });
  it.each(['0', '1'])('lets explicit env %s override QCS, including unsupported surfaces', (env) => {
    vi.stubEnv('OPEN_READ_PARTIAL', env);
    mocks.getConfigValue.mockReturnValue({ ...rule, enabled: env === '0' });
    expect(decide(false)).toEqual({ enabled: env === '1', source: 'env' });
    expect(mocks.getConfigValue).not.toHaveBeenCalled();
  });
  it('rejects QCS on unsupported surfaces', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue(rule);
    expect(decide(false)).toMatchObject({ enabled: false, source: 'ineligible' });
  });
  it.each([undefined, null, true, [], {}, { enable: true }, { enabled: 'true' }, { enabled: 1 }])('fails closed for invalid value %j', (value) => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue(value);
    expect(decide().enabled).toBe(false);
  });
  it('accepts JSON QCS values and explicit shutdown', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue(JSON.stringify({ enabled: true }));
    expect(decide()).toEqual({ enabled: true, source: 'qcs' });
    mocks.getConfigValue.mockReturnValue(JSON.stringify({ enabled: false }));
    expect(decide()).toEqual({ enabled: false, source: 'qcs' });
  });
  it('does not retain an enabled snapshot after shutdown or deletion', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue(rule);
    expect(decide().enabled).toBe(true);
    mocks.getConfigValue.mockReturnValue({ enabled: false });
    expect(decide()).toEqual({ enabled: false, source: 'qcs' });
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(decide()).toMatchObject({ enabled: false, source: 'missing' });
  });
  it('ignores legacy experiment metadata instead of requiring it', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockReturnValue({ ...rule, cohort: 'enabled', revision: 'old', expires_at: '2020-01-01T00:00:00Z' });
    expect(decide()).toEqual({ enabled: true, source: 'qcs' });
  });
  it('fails closed for invalid explicit env values rather than silently using an enabling rule', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', 'true');
    mocks.getConfigValue.mockReturnValue(rule);
    expect(decide()).toEqual({ enabled: false, source: 'invalid_env' });
  });
  it('does not throw when the QCS cache is unavailable', () => {
    vi.stubEnv('OPEN_READ_PARTIAL', undefined);
    mocks.getConfigValue.mockImplementation(() => { throw new Error('private'); });
    expect(decide()).toMatchObject({ enabled: false, source: 'unavailable' });
  });
});
