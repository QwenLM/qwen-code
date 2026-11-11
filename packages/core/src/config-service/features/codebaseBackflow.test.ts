/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnabledGateValue } from './gateParseUtils.js';

const mocks = vi.hoisted(() => ({
  getFeatureGateValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getFeatureGateValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: mocks.runLogger,
}));

describe('config-service/features/codebaseBackflow', () => {
  let feature: typeof import('./codebaseBackflow.js');
  let valueListener: ((value: unknown) => void) | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getFeatureGateValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    valueListener = undefined;
    mocks.subscribeConfigValue.mockImplementation(
      (_key: string, listener: (value: unknown) => void) => {
        valueListener = listener;
        return () => {};
      },
    );
    vi.unstubAllEnvs();
    feature = await import('./codebaseBackflow.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats null as an invalid enabled override', () => {
    expect(parseEnabledGateValue(null)).toBeUndefined();
  });

  it('registers a default-off QCS gate', () => {
    feature.registerCodebaseBackflowFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      'codebase_backflow',
      expect.any(Function),
    );
    expect(feature.isCodebaseBackflowEnabled()).toBe(false);
  });

  it('reads and normalizes the QCS object configuration', () => {
    mocks.getFeatureGateValue.mockReturnValue({
      enabled: true,
      allowed_org_ids: [' org-1 ', 'org-1', 'org-2'],
    });

    expect(feature.getCodebaseBackflowConfig()).toEqual({
      enabled: true,
      allowedOrgIds: ['org-1', 'org-2'],
    });
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('external-org')).toBe(
      false,
    );
  });

  it('rejects legacy boolean and incomplete QCS values', () => {
    mocks.getFeatureGateValue.mockReturnValueOnce(true);
    expect(feature.isCodebaseBackflowEnabled()).toBe(false);

    mocks.getFeatureGateValue.mockReturnValueOnce({ enabled: true });
    expect(feature.isCodebaseBackflowEnabled()).toBe(false);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(false);
  });

  it('applies JSON QCS updates received through onChange', () => {
    feature.registerCodebaseBackflowFeature();
    const registration = { onChange: valueListener! };

    registration.onChange(
      '{"enabled":true,"allowed_org_ids":["org-1"]}',
    );
    mocks.getFeatureGateValue.mockReturnValue(undefined);

    expect(feature.isCodebaseBackflowEnabled()).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);
  });

  it('lets the environment override enabled without bypassing the org list', () => {
    mocks.getFeatureGateValue.mockReturnValue({
      enabled: true,
      allowed_org_ids: ['org-1'],
    });
    vi.stubEnv(feature.CODEBASE_BACKFLOW_FEATURE_ENV, '0');
    expect(feature.isCodebaseBackflowEnabled()).toBe(false);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);

    mocks.getFeatureGateValue.mockReturnValue({
      enabled: false,
      allowed_org_ids: ['org-1'],
    });
    vi.stubEnv(feature.CODEBASE_BACKFLOW_FEATURE_ENV, '1');
    expect(feature.isCodebaseBackflowEnabled()).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('external-org')).toBe(
      false,
    );
  });

  it('fails closed for organizations when env enables without QCS config', () => {
    mocks.getFeatureGateValue.mockReturnValue(undefined);
    vi.stubEnv(feature.CODEBASE_BACKFLOW_FEATURE_ENV, '1');

    expect(feature.isCodebaseBackflowEnabled()).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(false);
  });

  it('notifies enabled when env forces on a QCS-disabled config', () => {
    feature.registerCodebaseBackflowFeature();
    const registration = { onChange: valueListener! };
    const listener = vi.fn();
    feature.subscribeCodebaseBackflowEnabled(listener);
    vi.stubEnv(feature.CODEBASE_BACKFLOW_FEATURE_ENV, '1');

    registration.onChange({
      enabled: false,
      allowed_org_ids: ['org-1'],
    });

    expect(listener).toHaveBeenCalledWith(true);
    expect(feature.isCodebaseBackflowEnabled()).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);
  });

  it('keeps the last valid QCS value when an update is invalid', () => {
    feature.registerCodebaseBackflowFeature();
    const registration = { onChange: valueListener! };

    registration.onChange({
      enabled: true,
      allowed_org_ids: ['org-1'],
    });
    registration.onChange('not-json');
    mocks.getFeatureGateValue.mockReturnValue(undefined);

    expect(feature.isCodebaseBackflowEnabled()).toBe(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(true);
    expect(mocks.runLogger.warn).toHaveBeenCalled();
  });

  it('notifies subscribers for config changes and replays enabled state', async () => {
    feature.registerCodebaseBackflowFeature();
    const registration = { onChange: valueListener! };
    const firstListener = vi.fn();
    const unsubscribe = feature.subscribeCodebaseBackflowEnabled(firstListener);

    registration.onChange({
      enabled: true,
      allowed_org_ids: ['org-1'],
    });

    expect(firstListener).toHaveBeenCalledWith(true);

    const replayedListener = vi.fn();
    feature.subscribeCodebaseBackflowEnabled(replayedListener);
    await vi.waitFor(() => expect(replayedListener).toHaveBeenCalledWith(true));

    unsubscribe();
    registration.onChange({
      enabled: true,
      allowed_org_ids: ['org-2'],
    });
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(replayedListener).toHaveBeenLastCalledWith(true);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-1')).toBe(false);
    expect(feature.isCodebaseBackflowOrganizationAllowed('org-2')).toBe(true);
  });
});
