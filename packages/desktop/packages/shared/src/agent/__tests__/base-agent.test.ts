/**
 * Tests for BaseAgent abstract class
 *
 * Uses TestAgent (concrete implementation) to verify BaseAgent functionality.
 * Tests model/thinking configuration, permission mode, source management,
 * and lifecycle management.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { AbortReason } from '../backend/types.ts';
import {
  TestAgent,
  createMockBackendConfig,
  createMockSource,
  collectEvents,
} from './test-utils.ts';

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    agent = new TestAgent(createMockBackendConfig());
  });

  describe('Model Configuration', () => {
    it('should initialize with config model', () => {
      expect(agent.getModel()).toBe('test-model');
    });

    it('should allow setting model', () => {
      agent.setModel('new-model');
      expect(agent.getModel()).toBe('new-model');
    });
  });

  describe('Thinking Level Configuration', () => {
    it('should initialize with config thinking level', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('should allow setting thinking level', () => {
      agent.setThinkingLevel('max');
      expect(agent.getThinkingLevel()).toBe('max');
    });

  });

  describe('Permission Mode', () => {
    it('should have a permission mode', () => {
      const mode = agent.getPermissionMode();
      expect(['allow-all', 'safe', 'ask', 'auto-edit']).toContain(mode);
    });

    it('should allow setting permission mode', () => {
      agent.setPermissionMode('safe');
      expect(agent.getPermissionMode()).toBe('safe');
    });

    it('should notify on permission mode change', () => {
      let notifiedMode = '';
      agent.onPermissionModeChange = (mode) => { notifiedMode = mode; };

      agent.setPermissionMode('allow-all');
      expect(notifiedMode).toBe('allow-all');
    });

    it('should cycle permission modes', () => {
      const initialMode = agent.getPermissionMode();
      const newMode = agent.cyclePermissionMode();
      expect(newMode).not.toBe(initialMode);
    });

    it('should report safe mode correctly', () => {
      agent.setPermissionMode('safe');
      expect(agent.isInSafeMode()).toBe(true);

      agent.setPermissionMode('ask');
      expect(agent.isInSafeMode()).toBe(false);
    });
  });

  describe('Workspace & Session', () => {
    it('should return workspace from config', () => {
      const workspace = agent.getWorkspace();
      expect(workspace.id).toBe('test-workspace-id');
    });

    it('should allow setting workspace', () => {
      agent.setWorkspace({
        id: 'new-workspace',
        name: 'New Workspace',
        slug: 'path',
        rootPath: '/new/path',
        createdAt: Date.now(),
      });
      expect(agent.getWorkspace().id).toBe('new-workspace');
    });

    it('should have session ID', () => {
      expect(agent.getSessionId()).toBeTruthy();
    });

    it('should allow setting session ID', () => {
      agent.setSessionId('new-session-id');
      expect(agent.getSessionId()).toBe('new-session-id');
    });
  });

  describe('Source Management', () => {
    it('should start with no active sources', () => {
      expect(agent.getActiveSourceSlugs()).toEqual([]);
    });

    it('should track source servers', async () => {
      await agent.setSourceServers(
        { 'source-1': { type: 'http', url: 'http://test' } },
        { 'source-2': {} },
        ['source-1', 'source-2']
      );

      expect(agent.getActiveSourceSlugs()).toContain('source-1');
      expect(agent.getActiveSourceSlugs()).toContain('source-2');
    });

    it('should check if source is active', async () => {
      await agent.setSourceServers(
        { 'active-source': { type: 'http', url: 'http://test' } },
        {},
        ['active-source']
      );

      expect(agent.isSourceServerActive('active-source')).toBe(true);
      expect(agent.isSourceServerActive('inactive-source')).toBe(false);
    });

    it('should track all sources', () => {
      const sources = [
        createMockSource({ slug: 'source-1' }),
        createMockSource({ slug: 'source-2' }),
      ];

      agent.setAllSources(sources);
      expect(agent.getAllSources()).toHaveLength(2);
    });

    it('should allow marking source as unseen', () => {
      // This should not throw
      agent.markSourceUnseen('some-source');
    });

    it('should track temporary clarifications', () => {
      agent.setTemporaryClarifications('Test clarification');
      // Clarifications are internal state - verify via PromptBuilder if needed
    });
  });

  describe('Manager Accessors', () => {
    it('should provide access to SourceManager', () => {
      const manager = agent.getSourceManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PermissionManager', () => {
      const manager = agent.getPermissionManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PromptBuilder', () => {
      const builder = agent.getPromptBuilder();
      expect(builder).toBeTruthy();
    });
  });

  describe('Lifecycle', () => {
    it('should track processing state', () => {
      expect(agent.isProcessing()).toBe(false);
    });

    it('should emit complete event from chat', async () => {
      const events = await collectEvents(agent.chat('test message'));
      expect(events.some(e => e.type === 'complete')).toBe(true);
    });

    it('should track chat calls', async () => {
      await collectEvents(agent.chat('test message'));
      expect(agent.chatCalls).toHaveLength(1);
      expect(agent.chatCalls[0]?.message).toBe('test message');
    });

    it('should track abort calls', async () => {
      await agent.abort('test reason');
      expect(agent.abortCalls).toHaveLength(1);
      expect(agent.abortCalls[0]?.reason).toBe('test reason');
    });

    it('should delegate handoff interrupts to forceAbort by default', () => {
      agent.interruptForHandoff(AbortReason.AuthRequest);
      expect(agent.forceAbortCalls).toHaveLength(1);
      expect(agent.forceAbortCalls[0]?.reason).toBe(AbortReason.AuthRequest);
    });

    it('should track respondToPermission calls', () => {
      agent.respondToPermission('req-1', true, false);
      expect(agent.respondToPermissionCalls).toHaveLength(1);
      expect(agent.respondToPermissionCalls[0]).toEqual({
        requestId: 'req-1',
        allowed: true,
        alwaysAllow: false,
      });
    });

    it('should cleanup on destroy', () => {
      // Should not throw
      agent.destroy();
    });

    it('should cleanup on dispose (alias)', () => {
      // Should not throw
      agent.dispose();
    });
  });

  describe('Callbacks', () => {
    it('should support debug callback', () => {
      let message = '';
      agent.onDebug = (msg) => { message = msg; };

      // Trigger a debug message by setting thinking level
      agent.setThinkingLevel('off');
      expect(message).toContain('Thinking level');
    });

    it('should support permission mode change callback', () => {
      let mode = '';
      agent.onPermissionModeChange = (m) => { mode = m; };

      agent.setPermissionMode('allow-all');
      expect(mode).toBe('allow-all');
    });
  });

  describe('Config Watcher', () => {
    it('should not start config watcher when skipConfigWatcher is true', () => {
      // Simulates the SessionManager scenario: isHeadless=false but server owns the watcher
      const managedAgent = new TestAgent(createMockBackendConfig({
        isHeadless: false,
        skipConfigWatcher: true,
      }));
      // configWatcherManager should remain null — the guard in startConfigWatcher() returns early
      expect(managedAgent.getConfigWatcherManager()).toBeNull();
      managedAgent.destroy();
    });

    it('should not start config watcher when isHeadless is true (existing behavior)', () => {
      // Simulates temp/headless agents — existing isHeadless guard still works
      const headlessAgent = new TestAgent(createMockBackendConfig({
        isHeadless: true,
      }));
      expect(headlessAgent.getConfigWatcherManager()).toBeNull();
      headlessAgent.destroy();
    });
  });
});
