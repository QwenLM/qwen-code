/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import { QwenLogger } from './qwen-logger.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../core/contentGenerator.js';

// Mock dependencies
vi.mock('../../utils/user_id.js', () => ({
  getInstallationId: vi.fn(() => 'test-installation-id'),
}));

vi.mock('../../utils/safeJsonStringify.js', () => ({
  safeJsonStringify: vi.fn((obj) => JSON.stringify(obj)),
}));

// Mock https module
vi.mock('https', () => ({
  request: vi.fn(),
}));

const makeFakeConfig = (overrides: Partial<Config> = {}): Config => {
  const defaults = {
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getSessionId: () => 'test-session-id',
    getCliVersion: () => '1.0.0',
    getProxy: () => undefined,
    getContentGeneratorConfig: () => ({ authType: 'test-auth' }),
    getAuthType: () => AuthType.QWEN_OAUTH,
    getMcpServers: () => ({}),
    getModel: () => 'test-model',
    getEmbeddingModel: () => 'test-embedding',
    getSandbox: () => false,
    getCoreTools: () => [],
    getApprovalMode: () => 'auto',
    getTelemetryEnabled: () => true,
    getTelemetryLogPromptsEnabled: () => false,
    getFileFilteringRespectGitIgnore: () => true,
    getOutputFormat: () => 'text',
    ...overrides,
  };
  return defaults as Config;
};

describe('QwenLogger', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    mockConfig = makeFakeConfig();
    // Clear singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  describe('getInstance', () => {
    it('returns undefined when usage statistics are disabled', () => {
      const config = makeFakeConfig({ getUsageStatisticsEnabled: () => false });
      const logger = QwenLogger.getInstance(config);
      expect(logger).toBeUndefined();
    });

    it('returns undefined when usage statistics are enabled (telemetry disabled)', () => {
      const logger = QwenLogger.getInstance(mockConfig);
      expect(logger).toBeUndefined();
    });
  });

  // Other tests removed as functionality is disabled
});
