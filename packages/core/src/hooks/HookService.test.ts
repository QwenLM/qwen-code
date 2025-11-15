import { describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import type { HooksSettings } from './HooksSettings.js';
import { HookService } from './HookService.js';
import type { HookPayload } from './HookManager.js';

// Create a basic mock config object
const baseMockConfig = {
  getTargetDir: () => '/tmp/test-project',
  getProjectRoot: () => '/tmp/test-project',
  getHooksSettings: () => 
    // Default empty settings for basic functionality
     ({} as HooksSettings)
  ,
  storage: {
    getProjectTempDir: () => '/tmp/test-temp',
  },
  getSessionId: () => 'test-session-123',
};

// Cast to Config type using unknown to bypass strict type checking
const mockConfig = baseMockConfig as unknown as Config;

describe('HookService', () => {
  let hookService: HookService;

  beforeEach(() => {
    hookService = new HookService(mockConfig);
  });

  it('should initialize and execute hooks', async () => {
    const testPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'original',
    };

    // Execute a hook that doesn't exist - should return original payload
    const result = await hookService.executeHooks(
      'input.received',
      testPayload,
    );

    expect(result).toEqual(testPayload);
  });

  it('should properly handle disabled hooks', async () => {
    const settings: HooksSettings = {
      enabled: false, // Hooks disabled globally
      hooks: [],
    };

    // Create a properly typed config object
    const disabledConfig: Config = {
      ...mockConfig,
      getHooksSettings: () => settings,
    } as unknown as Config;

    const hookServiceWithDisabledHooks = new HookService(disabledConfig);

    const testPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'original',
    };

    const result = await hookServiceWithDisabledHooks.executeHooks(
      'input.received',
      testPayload,
    );

    // Should return original payload when hooks are disabled
    expect(result).toEqual(testPayload);
  });

  it('should register custom hooks', () => {
    const mockHandler = async (_payload: HookPayload) => _payload;
    const hookId = hookService.registerHook(
      'input.received' as unknown as HookType, // Using unknown to avoid enum mismatch
      mockHandler,
      5, // Priority
    );

    expect(hookId).toBeDefined();
  });
});
