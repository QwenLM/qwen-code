/**
 * Tests for AutomationSystem facade
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationSystem, type SessionMetadataSnapshot } from './automation-system.ts';
import { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE } from './constants.ts';

describe('AutomationSystem', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'automation-system-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create an AutomationSystem without automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.isDisposed()).toBe(false);
      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    it('should load automations.json if present', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const config = system.getConfig();
      expect(config?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should handle invalid automations.json gracefully', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), 'invalid json');

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    it('should reject semantically invalid conditions at load time', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', after: '25:99' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });
  });

  describe('reloadConfig', () => {
    it('should reload automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      // Create automations.json
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true);
      expect(result.automationCount).toBe(1);
      expect(system.getConfig()?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should return errors for invalid config', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Invalid JSON structure (actions must have at least one action)
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test', actions: 'not-an-array' }, // Invalid: actions should be an array
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      await system.dispose();
    });

    it('should return errors for semantically invalid conditions', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', before: '99:00' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid time value'))).toBe(true);

      await system.dispose();
    });

    it('should ignore unknown event types with warning', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Unknown events are filtered out with a warning, not an error
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          UnknownEvent: [
            { matcher: 'test', actions: [{ type: 'prompt', prompt: 'echo test' }] },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true); // Unknown events are ignored, not errors
      expect(result.automationCount).toBe(0); // No valid actions

      await system.dispose();
    });
  });

  describe('getMatchersForEvent', () => {
    it('should return matchers for configured events', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test1', actions: [{ type: 'prompt', prompt: 'echo 1' }] },
            { matcher: 'test2', actions: [{ type: 'prompt', prompt: 'echo 2' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toHaveLength(2);
      expect(matchers[0]?.matcher).toBe('test1');

      await system.dispose();
    });

    it('should return empty array for unconfigured events', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toEqual([]);

      await system.dispose();
    });
  });

  describe('updateSessionMetadata', () => {
    it('should emit PermissionModeChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
      });

      expect(events).toContain('PermissionModeChange');
      expect(emitSpy).toHaveBeenCalledWith('PermissionModeChange', expect.objectContaining({
        sessionId: 'session-1',
        oldMode: '',
        newMode: 'execute',
      }));

      await system.dispose();
    });

    it('should emit LabelAdd event for new labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      expect(events).toContain('LabelAdd');
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-1',
      }));
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit LabelRemove event for removed labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Set initial state
      system.setInitialSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1'], // label-2 removed
      });

      expect(events).toContain('LabelRemove');
      expect(emitSpy).toHaveBeenCalledWith('LabelRemove', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit FlagChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        isFlagged: true,
      });

      expect(events).toContain('FlagChange');
      expect(emitSpy).toHaveBeenCalledWith('FlagChange', expect.objectContaining({
        isFlagged: true,
      }));

      await system.dispose();
    });

    it('should emit SessionStatusChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        sessionStatus: 'todo',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        sessionStatus: 'done',
      });

      expect(events).toContain('SessionStatusChange');
      expect(emitSpy).toHaveBeenCalledWith('SessionStatusChange', expect.objectContaining({
        oldState: 'todo',
        newState: 'done',
      }));

      await system.dispose();
    });

    it('should not emit events when metadata unchanged', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      expect(events).toEqual([]);
      expect(emitSpy).not.toHaveBeenCalled();

      await system.dispose();
    });

    it('should update stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
        labels: ['label-1'],
      });

      const stored = system.getSessionMetadata('session-1');
      expect(stored?.permissionMode).toBe('execute');
      expect(stored?.labels).toEqual(['label-1']);

      await system.dispose();
    });
  });

  describe('removeSessionMetadata', () => {
    it('should remove stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
      });

      expect(system.getSessionMetadata('session-1')).toBeDefined();

      system.removeSessionMetadata('session-1');

      expect(system.getSessionMetadata('session-1')).toBeUndefined();

      await system.dispose();
    });
  });

  describe('emitLabelConfigChange', () => {
    it('should emit LabelConfigChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      await system.emitLabelConfigChange();

      expect(emitSpy).toHaveBeenCalledWith('LabelConfigChange', expect.objectContaining({
        workspaceId: 'test-workspace',
      }));

      await system.dispose();
    });
  });

  describe('executeAgentEvent', () => {
    it('should match agent events when matcher and conditions pass', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PreToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(1);
      await system.dispose();
    });

    it('should not match agent events when conditions fail', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PostToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(0);
      await system.dispose();
    });
  });

  describe('buildSdkHooks', () => {
    it('should return empty object (command execution removed)', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            { matcher: 'Bash', actions: [{ type: 'prompt', prompt: 'check this' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const result = system.buildSdkHooks();
      expect(result).toEqual({});

      await system.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', { permissionMode: 'explore' });

      await system.dispose();

      expect(system.isDisposed()).toBe(true);
      expect(system.eventBus.isDisposed()).toBe(true);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
    });

    it('should be idempotent', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.dispose();
      await system.dispose(); // Should not throw
      expect(system.isDisposed()).toBe(true);
    });
  });
});
