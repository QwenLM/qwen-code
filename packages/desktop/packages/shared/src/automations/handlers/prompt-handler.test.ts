/**
 * Tests for PromptHandler
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { WorkspaceEventBus } from '../event-bus.ts';
import { PromptHandler } from './prompt-handler.ts';
import type { AutomationsConfigProvider, PromptHandlerOptions } from './types.ts';
import type { AutomationMatcher, AutomationEvent, PendingPrompt } from '../index.ts';

// Helper to create a mock AutomationsConfigProvider
function createMockConfigProvider(matchersByEvent: Partial<Record<AutomationEvent, AutomationMatcher[]>> = {}): AutomationsConfigProvider {
  return {
    getConfig: () => ({ automations: matchersByEvent }),
    getMatchersForEvent: (event: AutomationEvent) => matchersByEvent[event] ?? [],
  };
}

// Helper to create default options
function createOptions(overrides: Partial<PromptHandlerOptions> = {}): PromptHandlerOptions {
  return {
    workspaceId: 'test-workspace',
    sessionId: 'test-session',
    ...overrides,
  };
}

describe('PromptHandler', () => {
  let bus: WorkspaceEventBus;

  beforeEach(() => {
    bus = new WorkspaceEventBus('test-workspace');
  });

  afterEach(() => {
    bus.dispose();
  });

  describe('matcher matching for app events', () => {
    it('should process prompt actions for matching LabelAdd event', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          matcher: 'bug',
          actions: [{ type: 'prompt', prompt: 'A bug label was added' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'bug',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.prompt).toBe('A bug label was added');
      expect(prompts[0]!.sessionId).toBe('test-session');

      handler.dispose();
    });

    it('should process prompt actions for PermissionModeChange', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        PermissionModeChange: [{
          matcher: 'safe',
          actions: [{ type: 'prompt', prompt: 'Mode changed to safe' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('PermissionModeChange', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        oldMode: 'ask',
        newMode: 'safe',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);

      handler.dispose();
    });

    it('should not call onPromptsReady for non-matching events', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          matcher: 'bug',
          actions: [{ type: 'prompt', prompt: 'Bug detected' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'feature',
      });

      expect(onPromptsReady).not.toHaveBeenCalled();

      handler.dispose();
    });
  });

  describe('agent events are ignored', () => {
    it('should not process prompts for PreToolUse (agent event)', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        PreToolUse: [{
          actions: [{ type: 'prompt', prompt: 'Should not fire' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('PreToolUse', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        data: { tool_name: 'Bash' },
      });

      expect(onPromptsReady).not.toHaveBeenCalled();

      handler.dispose();
    });

    it('should not process prompts for SessionStart (agent event)', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: 'Should not fire' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('SessionStart', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        data: {},
      });

      expect(onPromptsReady).not.toHaveBeenCalled();

      handler.dispose();
    });

    it('should not process prompts for PostToolUse (agent event)', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        PostToolUse: [{
          actions: [{ type: 'prompt', prompt: 'Should not fire' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('PostToolUse', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        data: {},
      });

      expect(onPromptsReady).not.toHaveBeenCalled();

      handler.dispose();
    });
  });

  describe('environment variable expansion', () => {
    it('should expand $VAR syntax in prompt text', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Label $CRAFT_LABEL was added' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'urgent',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.prompt).toContain('urgent');

      handler.dispose();
    });

    it('should expand ${VAR} syntax in prompt text', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Label ${CRAFT_LABEL} was added to ${CRAFT_WORKSPACE_ID}' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'priority',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.prompt).toContain('priority');
      expect(prompts[0]!.prompt).toContain('test-workspace');

      handler.dispose();
    });
  });

  describe('@mention parsing and deduplication', () => {
    it('should parse @mentions from prompt text', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Please @linear check for issues and @github create a PR' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.mentions).toContain('linear');
      expect(prompts[0]!.mentions).toContain('github');

      handler.dispose();
    });

    it('should deduplicate @mentions', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: '@linear do X then @linear do Y' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      const linearMentions = prompts[0]!.mentions.filter(m => m === 'linear');
      expect(linearMentions).toHaveLength(1);

      handler.dispose();
    });
  });

  describe('onPromptsReady callback', () => {
    it('should deliver multiple prompts from a single event', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [
          {
            actions: [{ type: 'prompt', prompt: 'First prompt' }],
          },
          {
            actions: [{ type: 'prompt', prompt: 'Second prompt' }],
          },
        ],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.prompt).toBe('First prompt');
      expect(prompts[1]!.prompt).toBe('Second prompt');

      handler.dispose();
    });

    it('should not call onPromptsReady if no prompt actions match', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'command', command: 'echo hello' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).not.toHaveBeenCalled();

      handler.dispose();
    });

    it('should pass labels from matcher to pending prompts', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          labels: ['auto-created', 'from-automation'],
          actions: [{ type: 'prompt', prompt: 'Do something' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.labels).toEqual(['auto-created', 'from-automation']);

      handler.dispose();
    });
  });

  describe('llmConnection passthrough', () => {
    it('should pass llmConnection from prompt action to pending prompt', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Create a source',
            llmConnection: 'my-codex',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.llmConnection).toBe('my-codex');

      handler.dispose();
    });

    it('should leave llmConnection undefined when not specified', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Create a source',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.llmConnection).toBeUndefined();

      handler.dispose();
    });
  });

  describe('model passthrough', () => {
    it('should pass model from prompt action to pending prompt', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Quick review',
            model: 'qwen3-coder-plus',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.model).toBe('qwen3-coder-plus');

      handler.dispose();
    });

    it('should leave model undefined when not specified', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{
            type: 'prompt',
            prompt: 'Quick review',
          }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.model).toBeUndefined();

      handler.dispose();
    });
  });

  describe('automationName propagation', () => {
    it('should set automationName from matcher.name when provided', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          name: 'Daily Triage',
          actions: [{ type: 'prompt', prompt: 'Review issues' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('Daily Triage');

      handler.dispose();
    });

    it('should derive automationName from @mention when matcher has no name', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: '@linear check for issues' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('linear prompt');

      handler.dispose();
    });

    it('should derive automationName from prompt text when no name or @mention', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Review the code' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).toHaveBeenCalledTimes(1);
      const prompts: PendingPrompt[] = onPromptsReady.mock.calls[0]![0];
      expect(prompts[0]!.automationName).toBe('Review the code');

      handler.dispose();
    });
  });

  describe('dispose', () => {
    it('should unsubscribe from the event bus', () => {
      const configProvider = createMockConfigProvider();
      const handler = new PromptHandler(createOptions(), configProvider);

      handler.subscribe(bus);
      expect(bus.getHandlerCount()).toBe(1);

      handler.dispose();
      expect(bus.getHandlerCount()).toBe(0);
    });

    it('should not process events after disposal', async () => {
      const onPromptsReady = jest.fn();
      const configProvider = createMockConfigProvider({
        LabelAdd: [{
          actions: [{ type: 'prompt', prompt: 'Should not fire' }],
        }],
      });

      const handler = new PromptHandler(createOptions({ onPromptsReady }), configProvider);
      handler.subscribe(bus);
      handler.dispose();

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      expect(onPromptsReady).not.toHaveBeenCalled();
    });
  });
});
