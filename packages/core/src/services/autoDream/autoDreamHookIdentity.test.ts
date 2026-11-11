/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import { Storage } from '../../config/storage.js';
import { runForkedAgent } from '../../core/forkedAgent.js';
import {
  HookAggregator,
  type AggregatedHookResult,
} from '../../hooks/hookAggregator.js';
import { HookEventHandler } from '../../hooks/hookEventHandler.js';
import type { HookPlanner } from '../../hooks/hookPlanner.js';
import { HookRunner } from '../../hooks/hookRunner.js';
import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import {
  ConfigSource,
  HookEventName,
  HookType,
  type HookInput,
  type RuntimeHookConfig,
} from '../../hooks/types.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { getAgentContext } from '../../utils/agentContext.js';
import {
  CoreEvent,
  coreEvents,
  type HookEndPayload,
  type HookStartPayload,
} from '../../utils/events.js';
import { getTranscriptProjectDir } from '../transcript-paths.js';
import { executeAutoDream, initAutoDream } from './autoDreamService.js';

vi.mock('../../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

describe('AutoDream hook identity', () => {
  let tempDir: string;
  let config: Config;
  let handler: HookEventHandler;
  let starts: HookStartPayload[];
  let ends: HookEndPayload[];
  let action: ReturnType<typeof vi.fn>;
  let unsubscribe: Array<() => void>;

  beforeEach(async () => {
    vi.mocked(runForkedAgent).mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-dream-identity-'));
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(tempDir);
    const projectRoot = path.join(tempDir, 'project');
    const transcriptDir = getTranscriptProjectDir(projectRoot);
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, 'previous-session.jsonl'),
      '{}\n',
    );

    config = {
      isAutoMemoryEnabled: () => true,
      isAutoMemoryUserScopeEnabled: () => false,
      isAutoMemoryProjectScopeEnabled: () => true,
      isSdkMemoryRequestActive: () => false,
      isInteractive: () => true,
      isTrustedFolder: () => true,
      isAllHooksDisabled: () => false,
      canRunAsyncRewakeHooks: () => false,
      getDreamSettings: () => ({ enabled: true, minSessions: 1 }),
      getSessionId: () => 'foreground-session',
      getProjectRoot: () => projectRoot,
      getSessionArtifactProjectRoot: () => projectRoot,
      getWorkingDir: () => projectRoot,
      getActiveSessionTranscriptPath: () =>
        path.join(transcriptDir, 'foreground-session.jsonl'),
      getPermissionMode: () => 'default',
      getModel: () => 'dream-model',
      getWorkspaceContext: () => ({ getDirectories: () => [projectRoot] }),
      storage: { getProjectMemoryTempDir: () => path.join(tempDir, 'memory') },
    } as unknown as Config;
    const registry = new ToolRegistry(config);
    config.getToolRegistry = () => registry;

    action = vi.fn(async (_input: HookInput) => ({
      hookSpecificOutput: {
        hookEventName: HookEventName.PostToolUse,
        additionalContext: 'hook still executed',
      },
    }));
    const hook: RuntimeHookConfig = {
      type: HookType.Runtime,
      name: 'visible-hook',
      source: ConfigSource.User,
      action,
    };
    const planner = {
      createExecutionPlan: (eventName: HookEventName) => ({
        eventName,
        hookConfigs: [hook],
        asyncHookConfigs: [],
        sequential: false,
      }),
    } as unknown as HookPlanner;
    handler = new HookEventHandler(
      { config, promptId: 'foreground-turn' } as AgentLoopContext,
      planner,
      new HookRunner(config),
      new HookAggregator(),
    );
    starts = [];
    ends = [];
    unsubscribe = [
      coreEvents.onSessionEvent(
        CoreEvent.HookStart,
        'foreground-session',
        (e) => starts.push(e),
      ),
      coreEvents.onSessionEvent(CoreEvent.HookEnd, 'foreground-session', (e) =>
        ends.push(e),
      ),
    ];
    initAutoDream(config);
  });

  afterEach(async () => {
    unsubscribe.forEach((off) => off());
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    'executes and tags hooks across async boundaries without leaking identity (fork fails: %s)',
    async (failFork) => {
      const identities: Array<ReturnType<typeof getAgentContext>> = [];
      let hookResult: AggregatedHookResult | undefined;
      vi.mocked(runForkedAgent).mockImplementation(async () => {
        identities.push(getAgentContext());
        await new Promise<void>((resolve) => setImmediate(resolve));
        identities.push(getAgentContext());
        hookResult = await handler.firePostToolUseEvent(
          'Read',
          { file_path: path.join(tempDir, 'memory', 'topic.md') },
          { content: 'memory' },
          'dream-call',
        );
        if (failFork) throw new Error('model failed');
        return {
          messages: [],
          textContent: '',
          totalUsage: cloneUsage(),
        };
      });

      await executeAutoDream(config, {
        prompt: 'hi',
        response: 'hello',
        messages: [],
      });

      expect(runForkedAgent).toHaveBeenCalledOnce();
      expect(hookResult?.success).toBe(true);
      expect(hookResult?.finalOutput?.getAdditionalContext()).toBe(
        'hook still executed',
      );
      expect(identities).toEqual([
        expect.objectContaining({
          agentId: expect.any(String),
          agentType: 'auto_dream',
        }),
        identities[0],
      ]);
      expect(action).toHaveBeenCalledOnce();
      expect(action.mock.calls[0][0]).toMatchObject({
        agent_id: identities[0]?.agentId,
        agent_type: 'auto_dream',
        tool_use_id: 'dream-call',
      });
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ agentId: identities[0]?.agentId });
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        agentId: identities[0]?.agentId,
        success: true,
      });
      expect(getAgentContext()).toBeUndefined();

      await handler.firePostToolUseEvent('Read', {}, {}, 'foreground-call');
      expect(action).toHaveBeenCalledTimes(2);
      expect(starts[1].agentId).toBeUndefined();
      expect(ends[1].agentId).toBeUndefined();
    },
  );
});
