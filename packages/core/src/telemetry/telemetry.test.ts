/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeTelemetry, shutdownTelemetry } from './sdk.js';
import { Config } from '../config/config.js';
import { NodeSDK } from '@opentelemetry/sdk-node';

vi.mock('@opentelemetry/sdk-node');
vi.mock('../config/config.js');

describe('telemetry', () => {
  let mockConfig: Config;
  let mockNodeSdk: NodeSDK;

  beforeEach(() => {
    vi.resetAllMocks();

    mockConfig = new Config({
      sessionId: 'test-session-id',
      model: 'test-model',
      targetDir: '/test/dir',
      debugMode: false,
      cwd: '/test/dir',
    });
    // Forced disabled in implementation
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://localhost:4317',
    );
    vi.spyOn(mockConfig, 'getSessionId').mockReturnValue('test-session-id');
    mockNodeSdk = {
      start: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as NodeSDK;
    vi.mocked(NodeSDK).mockImplementation(() => mockNodeSdk);
  });

  afterEach(async () => {
    await shutdownTelemetry(mockConfig);
  });

  it('should NOT initialize the telemetry service (disabled)', () => {
    initializeTelemetry(mockConfig);
    expect(NodeSDK).not.toHaveBeenCalled();
    expect(mockNodeSdk.start).not.toHaveBeenCalled();
  });

  it('shutdown should be safe to call when not initialized', async () => {
    await shutdownTelemetry(mockConfig);
    expect(mockNodeSdk.shutdown).not.toHaveBeenCalled();
  });
});
