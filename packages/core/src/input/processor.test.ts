/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HookSystemMessageAttachment } from '../attachments/models/hook-attachments.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  emptySnapshotSource,
} from '../test-utils/listed-model.js';
import type { HookCoordinatorAdapter } from '../core/hook-coordinator-types.js';
import type {
  AttachmentToolUseContext,
  SkillListingAttachment,
} from '../attachments/types.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { McpLazyToolsDeltaAttachment } from '../attachments/models/mcp-attachments.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { UserMessage } from '../protocol/transcript/message.js';
import { processUserInput } from './processor.js';
import { executeUserInput } from './executor.js';
import type { ProcessInputFullContext } from './processor.js';
import { createJpegBuffer } from '../test-utils/index.js';
import { DefaultHookCoordinator } from '../hooks/coordinators.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import { coreEvents } from '../utils/events.js';

function makeHookCoordinator(
  fireBefore: HookCoordinatorAdapter['fireBefore'] = vi.fn(async () => null),
): HookCoordinatorAdapter {
  return {
    fireBefore,
    fireAfter: vi.fn(async () => null),
    drainPendingAsyncContext: vi.fn(() => undefined),
    fireStopFailure: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function makeContext(options?: {
  hookCoordinator?: HookCoordinatorAdapter;
  tempDir?: string;
  persistSessionTitle?: (title: string) => Promise<void>;
}): ProcessInputFullContext {
  const tempDir = options?.tempDir ?? tmpdir();
  const attachmentCtx = {
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    sentSkillNames: new Map<string, Set<string>>(),
    announcedLazyMcpTools: new Set<string>(),
    announcedMcpInstructionServers: new Set<string>(),
    announcedAgentTypes: new Set<string>(),
    readFileState: new Map<string, unknown>(),
  } as unknown as AttachmentToolUseContext;

  const config = {
    getHookSystem: () => undefined,
    storage: {
      getProjectTempDir: () => tempDir,
      getPlansDir: () => tempDir,
    },
    getPermissionMode: () => 'acceptEdits',
    persistSessionTitle: options?.persistSessionTitle,
    getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
    getToolRegistry: () => ({ hasToolEnabled: () => false }),
    isWorkflowsEnabled: () => false,
    isTasksEnabled: () => false,
    getTaskStore: () => undefined,
    getModelProviderManager: emptySnapshotSource.getModelProviderManager,
    getSkillListingMaxDescChars: () => 80,
    getSkillListingBudgetFraction: () => 0.1,
    getSkillVisibilityOverrides: () => undefined,
    getWorkflowKeywordTriggerEnabled: () => true,
    isUltracodeActive: () => false,
    getModel: () => 'test-model',
    getModelRequestIdentity: () => 'input-account',
    getCustomProviderRegistry: () => ({
      isCustomProviderModel: () => false,
    }),
    isConfiguredCustomProviderModelKey: () => false,
    planStateManager: undefined,
  } as unknown as Config;

  return {
    attachmentCtx,
    config,
    hookCoordinator: options?.hookCoordinator ?? makeHookCoordinator(),
    sessionId: 'session-1',
    cwd: tempDir,
    messages: [],
  };
}

describe('processUserInput', () => {
  it.each(['tui', 'sdk', 'remote'])(
    'prepares %s images before UserPromptSubmit and message creation',
    async (surface) => {
      const events: string[] = [];
      const fireBefore = vi.fn(async () => { events.push('UserPromptSubmit'); return null; });
      const context = makeContext({ hookCoordinator: makeHookCoordinator(fireBefore) });
      const url = 'https://images.example/prepared.png';
      Object.assign(context.config, {
        getModelProviderManager: () => ({ getMainModel: async () => ({ source: 'qwen-provider', key: 'main' }) }),
        getHookSystem: () => ({
          fireImagePrepareEvent: async () => {
            events.push('ImagePrepare');
            expect(context.messages).toEqual([]);
            expect(fireBefore).not.toHaveBeenCalled();
            return [{ type: 'image', source: { type: 'url', url } }];
          },
        }),
      });
      const data = (await createJpegBuffer(32, 32)).toString('base64');
      const result = await processUserInput({
        input: surface === 'tui' ? 'describe [Image #1]' : [
          { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data } },
          { type: 'text', text: 'describe' },
        ],
        ...(surface === 'tui' ? { pastedContents: { 1: { id: 1, type: 'image' as const, content: data, mediaType: 'image/jpeg', filename: 'paste.jpg' } } } : {}),
        commandMode: 'prompt', skipAttachments: true, uuid: 'image-user', promptId: 'image-prompt',
        querySource: surface === 'remote' ? 'sdk' : surface, bridgeOrigin: surface === 'remote',
      }, context);
      expect(events).toEqual(['ImagePrepare', 'UserPromptSubmit']);
      expect(result.shouldQuery).toBe(true);
      expect(JSON.stringify(result.messages)).toContain(url);
      expect(JSON.stringify(result.messages)).not.toContain(data);
      expect(fireBefore.mock.calls[0]).toContainEqual([url]);
    },
  );
  it('cancels a waiting UserPromptSubmit hook with the input turn', async () => {
    const controller = new AbortController();
    let releaseHook!: () => void;
    let started!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    const hookSystem = {
      fireUserPromptSubmitEvent: vi.fn(
        (_prompt: string, signal?: AbortSignal) =>
          new Promise<null>((resolve) => {
            releaseHook = () => resolve(null);
            signal?.addEventListener(
              'abort',
              () => {
                cancelled = true;
                resolve(null);
              },
              { once: true },
            );
            started();
          }),
      ),
    } as unknown as HookSystem;
    const context = makeContext({
      hookCoordinator: new DefaultHookCoordinator(hookSystem),
    });
    context.signal = controller.signal;
    const pending = processUserInput(
      {
        input: 'preview hooks',
        commandMode: 'prompt',
        promptId: 'cancel-hook',
      },
      context,
    );
    try {
      await hookStarted;
      controller.abort();
      expect(cancelled).toBe(true);
      await pending;
    } finally {
      releaseHook();
      await pending;
    }
  });

  it('cancels MCP reads when the active input turn is cancelled', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-mention-abort-'));
    try {
      const context = makeContext({ tempDir });
      context.attachmentCtx = createAttachmentContext(tempDir);
      const controller = new AbortController();
      context.signal = controller.signal;
      const error = new Error('input cancelled');
      context.externalContext = {
        mcpResources: {
          findResource: () => ({
            name: 'Schema',
            uri: 'doc://schema',
            serverName: 'docs',
            discoveredAt: 0,
          }),
          canUseServer: () => true,
          readResource: async (_server, _uri, signal) => {
            controller.abort(error);
            signal.throwIfAborted();
            return { contents: [] };
          },
        },
      };
      await expect(
        processUserInput(
          { input: '@docs:doc://schema', commandMode: 'prompt' },
          context,
        ),
      ).rejects.toBe(error);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(['tui', 'sdk', 'acp'] as const)(
    'keeps the original %s prompt separate from exact file and MCP attachments',
    async (querySource) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'test-mention-input-'));
      try {
        writeFileSync(path.join(tempDir, 'DataHelper.java'), 'not referenced');
        writeFileSync(
          path.join(tempDir, 'UserData.java'),
          'not referenced either',
        );
        writeFileSync(path.join(tempDir, 'README'), 'exact local file');
        const context = makeContext({ tempDir });
        context.attachmentCtx = createAttachmentContext(tempDir);
        const resource = {
          name: 'Schema',
          uri: 'doc://schema?rev=1',
          serverName: 'docs',
        };
        const readResource = vi.fn(async () => ({
          contents: [{ uri: 'doc://schema?rev=1', text: 'schema text' }],
        }));
        context.externalContext = {
          mcpResources: {
            findResource: (id) =>
              id === 'docs:doc://schema?rev=1' ? resource : undefined,
            canUseServer: () => true,
            readResource,
          },
        };
        const prompt =
          '使用 @Data @Builder @Service；参考 @README @docs:doc://schema?rev=1';
        const result = await processUserInput(
          { input: prompt, commandMode: 'prompt', querySource },
          context,
        );
        expect(result.shouldQuery).toBe(true);
        expect(result.messages[0]).toMatchObject({
          type: 'user',
          message: { content: prompt },
        });
        const attachments = result.messages
          .filter((m) => m.type === 'attachment')
          .map((m) => m.attachment);
        expect(attachments.filter((a) => a.type === 'file')).toEqual([
          expect.objectContaining({ content: 'exact local file' }),
        ]);
        expect(attachments.filter((a) => a.type === 'mcp_resource')).toEqual([
          expect.objectContaining({
            server: 'docs',
            uri: 'doc://schema?rev=1',
          }),
        ]);
        expect(readResource).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('does not trigger memory discovery for unresolved annotations', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-mention-memory-'));
    try {
      const context = makeContext({ tempDir });
      context.attachmentCtx = createAttachmentContext(tempDir);
      const discoverContext = vi.fn(async () => '');
      context.externalContext = {
        memoryContextManager: {
          getGlobalMemory: () => '',
          getPluginMemory: () => '',
          getEnvironmentMemory: () => '',
          getLocalMemory: () => '',
          getLoadedPaths: () => new Set<string>(),
          discoverContext,
        },
      };
      await processUserInput(
        { input: '使用 @Data @Service', commandMode: 'prompt' },
        context,
      );
      expect(discoverContext).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeSelectedSkillContext() {
    const context = makeContext();
    const activateSkill = vi.fn();
    const selectedSkill = {
      name: 'review',
      description: 'Review changes',
      location: '/workspace/.qwen/skills/review/SKILL.md',
      skillRoot: '/workspace/.qwen/skills/review',
      body: 'Review $ARGUMENTS',
      disableModelInvocation: true,
      allowedTools: ['Read'],
    };
    Object.assign(context.config as unknown as Record<string, unknown>, {
      isSkillsSupportEnabled: () => true,
      isSkillShellExecutionDisabled: () => false,
      getSessionId: () => 'session-1',
      getSkillManager: () => ({
        isAdminEnabled: () => true,
        getSkill: (name: string) =>
          name.toLowerCase() === 'review' ? selectedSkill : null,
        getModelVisibleSkills: () => [],
        getUsageScore: () => 0,
        getSkillVisibilityOverride: () => undefined,
        activateSkill,
        recordUsage: vi.fn(async () => {}),
      }),
      getToolRegistry: () => ({
        hasToolEnabled: () => false,
        getFunctionDeclarations: () => [],
      }),
    });
    return { context, activateSkill };
  }

  it('activates structured selections inside the accepted text-input route', async () => {
    const { context, activateSkill } = makeSelectedSkillContext();

    const result = await processUserInput(
      {
        input: '/workspace/file.ts',
        commandMode: 'prompt',
        skipSlashCommands: true,
        selectedSkills: [{ name: 'review', arguments: '--strict' }],
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(result.allowedTools).toEqual(['Read']);
    expect(result.skillActivations).toEqual([
      expect.objectContaining({
        skillName: 'review',
        activationSource: 'selected_skills',
      }),
    ]);
    expect(result.messages).toHaveLength(3);
    expect(JSON.stringify(result.messages[0])).toContain('/review');
    expect(JSON.stringify(result.messages[1])).toContain('Review --strict');
    expect(JSON.stringify(result.messages[2])).toContain('/workspace/file.ts');
    expect(activateSkill).toHaveBeenCalledTimes(1);
  });

  it('rejects selected skills when a slash command handles the owning input', async () => {
    const { context, activateSkill } = makeSelectedSkillContext();
    context.onSlashCommand = vi.fn(async () => ({
      messages: [],
      shouldQuery: false,
      resultText: 'done',
    }));

    await expect(
      processUserInput(
        {
          input: '/compact',
          commandMode: 'prompt',
          selectedSkills: [{ name: 'review' }],
        },
        context,
      ),
    ).rejects.toThrow('cannot be combined with a handled slash command');
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it('does not activate selections when image preprocessing rejects the input', async () => {
    const { context, activateSkill } = makeSelectedSkillContext();

    const result = await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'not-valid-image-data',
            },
          },
        ],
        commandMode: 'prompt',
        selectedSkills: [{ name: 'review' }],
      },
      context,
    );

    expect(result.shouldQuery).toBe(false);
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'claude-opus-4-6', workflows: true, descriptions: 5 },
    { model: 'claude-opus-4-7', workflows: true, descriptions: 4 },
    { model: 'qwen-max', workflows: true, descriptions: 4 },
    { model: 'claude-opus-4-7', workflows: false, descriptions: 4 },
  ])(
    'budgets initial Skill discovery for $model (workflows=$workflows)',
    async ({ model, workflows, descriptions }) => {
      const context = makeContext();
      context.isInitialTurn = true;
      context.attachmentCtx = createAttachmentContext(
        context.cwd,
        context.sessionId,
      );
      const skills = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
        name,
        description: 'x'.repeat(1490),
        location: `/workspace/${name}/SKILL.md`,
        skillRoot: '/workspace',
        body: '',
      }));
      Object.assign(context.config, {
        isWorkflowsEnabled: () => workflows,
        getModel: () => model,
        getEffectiveContextWindow: () => 200_000,
        getSkillListingMaxDescChars: () => 1536,
        getSkillListingBudgetFraction: () => 0.01,
        getSkillManager: () => ({
          isAdminEnabled: () => true,
          getModelVisibleSkills: () => skills,
          getUsageScore: () => 0,
          getSkillVisibilityOverride: () => undefined,
        }),
        getToolRegistry: () => ({
          hasToolEnabled: () => true,
          getFunctionDeclarations: () => [{ name: 'Skill' }],
        }),
      });

      const result = await processUserInput(
        {
          input: 'Show the available skills.',
          commandMode: 'prompt',
          querySource: 'tui',
        },
        context,
      );
      const [listing] = result.messages
        .filter((message) => message.type === 'attachment')
        .map((message) => message.attachment)
        .filter(
          (attachment) => attachment.type === 'skill_listing',
        ) as unknown as SkillListingAttachment[];
      expect(listing?.names).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(
        listing?.content.split('\n').filter((line) => line.includes(': ')),
      ).toHaveLength(descriptions);
    },
  );

  it('re-sends the Skill listing after a hook blocks the prompt', async () => {
    const fireBefore = vi
      .fn()
      .mockResolvedValueOnce({ blocked: true })
      .mockResolvedValue(null);
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });
    context.attachmentCtx = createAttachmentContext(
      context.cwd,
      context.sessionId,
    );
    const skills = [
      {
        name: 'review',
        description: 'Review a change',
        location: '/workspace/review/SKILL.md',
        skillRoot: '/workspace',
        body: '',
      },
    ];
    Object.assign(context.config, {
      getEffectiveContextWindow: () => 200_000,
      getSkillManager: () => ({
        isAdminEnabled: () => true,
        getModelVisibleSkills: () => skills,
        getUsageScore: () => 0,
        getSkillVisibilityOverride: () => undefined,
      }),
      getToolRegistry: () => ({
        hasToolEnabled: () => true,
        getFunctionDeclarations: () => [{ name: 'Skill' }],
      }),
    });
    const skillListing = (
      messages: Awaited<ReturnType<typeof processUserInput>>['messages'],
    ) =>
      messages.find(
        (message) =>
          message.type === 'attachment' &&
          message.attachment.type === 'skill_listing',
      );

    const blocked = await processUserInput(
      { input: 'hello', commandMode: 'prompt', promptId: 'prompt-1' },
      context,
    );
    expect(blocked.shouldQuery).toBe(false);

    const accepted = await processUserInput(
      { input: 'hello', commandMode: 'prompt', promptId: 'prompt-2' },
      context,
    );
    expect(skillListing(accepted.messages)).toMatchObject({
      attachment: { names: ['review'] },
    });
  });

  it('injects UltraCode reminders only for regular primary-session prompts', async () => {
    const makeUltracodeContext = () => {
      const context = makeContext();
      Object.assign(context.config as unknown as Record<string, unknown>, {
        isUltracodeActive: () => true,
      });
      return context;
    };

    const regularResult = await processUserInput(
      {
        input: 'review this change',
        commandMode: 'prompt',
      },
      makeUltracodeContext(),
    );
    expect(
      regularResult.messages.some(
        (message) =>
          message.type === 'attachment' &&
          message.attachment.type === 'ultra_effort_enter',
      ),
    ).toBe(true);

    const metaResult = await processUserInput(
      {
        input: 'internal continuation',
        commandMode: 'prompt',
        isMeta: true,
      },
      makeUltracodeContext(),
    );
    expect(
      metaResult.messages.some(
        (message) =>
          message.type === 'attachment' &&
          (message.attachment.type === 'ultra_effort_enter' ||
            message.attachment.type === 'ultra_effort_exit'),
      ),
    ).toBe(false);

    const taskNotificationResult = await processUserInput(
      {
        input: 'task completed',
        commandMode: 'task-notification',
      },
      makeUltracodeContext(),
    );
    expect(
      taskNotificationResult.messages.some(
        (message) =>
          message.type === 'attachment' &&
          (message.attachment.type === 'ultra_effort_enter' ||
            message.attachment.type === 'ultra_effort_exit'),
      ),
    ).toBe(false);
  });

  it('places task reminders after the current user message', async () => {
    const context = makeContext();
    Object.assign(context.config as unknown as Record<string, unknown>, {
      getToolRegistry: () => ({
        hasToolEnabled: (name: string) => name === 'TaskUpdate',
      }),
      isTasksEnabled: () => true,
      getTaskStore: () => ({
        listTasks: vi.fn().mockResolvedValue([
          {
            id: '1',
            subject: 'Pending work',
            description: 'Continue the work',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ]),
      }),
    });
    context.messages = Array.from({ length: 10 }, (_, index) => ({
      type: 'assistant' as const,
      uuid: `assistant-${index}`,
      timestamp: '2026-08-03T00:00:00.000Z',
      message: {
        id: `message-${index}`,
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'test-model',
        content: [{ type: 'text' as const, text: `turn ${index}` }],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        container: null,
        context_management: null,
      },
    }));

    const result = await processUserInput(
      {
        input: 'continue',
        commandMode: 'prompt',
        uuid: 'current-user',
        promptId: 'current-prompt',
      },
      context,
    );

    const reminderIndex = result.messages.findIndex(
      (message) =>
        message.type === 'attachment' &&
        message.attachment.type === 'task_reminder',
    );
    const userIndex = result.messages.findIndex(
      (message) => message.type === 'user' && message.uuid === 'current-user',
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(reminderIndex).toBe(userIndex + 1);
  });

  it('stamps prompt metadata and routes before-hook context into attachments', async () => {
    const persistSessionTitle = vi.fn(async () => {});
    const fireBefore = vi.fn(async () => ({
      sessionTitle: 'Hook title',
      stdoutForModel: 'stdout context',
      additionalContext: 'additional context',
    }));
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
      persistSessionTitle,
    });

    const result = await processUserInput(
      {
        input: 'hello',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(fireBefore).toHaveBeenCalledWith(
      'prompt-1',
      'hello',
      undefined,
      undefined,
    );
    expect(persistSessionTitle).toHaveBeenCalledWith('Hook title');

    const userMessage = result.messages.find((msg) => msg.type === 'user');
    expect(userMessage?.uuid).toBe('user-1');
    expect(userMessage?.promptId).toBe('prompt-1');
    expect(userMessage?.permissionMode).toBe('acceptEdits');
    expect(context.attachmentCtx.pendingHookOutputs).toEqual([
      {
        hookEventName: 'UserPromptSubmit',
        output: 'stdout context',
        sourceType: 'stdout',
      },
      {
        hookEventName: 'UserPromptSubmit',
        output: 'additional context',
        sourceType: 'additionalContext',
      },
    ]);
  });

  it('passes multi-block prompts to before hooks without system reminders', async () => {
    const fireBefore = vi.fn(async () => null);
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });

    const result = await processUserInput(
      {
        input: [
          { type: 'text', text: '用户真实问题' },
          {
            type: 'text',
            text: '<system-reminder>qwen internal</system-reminder>',
          },
          { type: 'text', text: '继续说明' },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(fireBefore).toHaveBeenCalledWith(
      'prompt-1',
      '用户真实问题\n继续说明',
      undefined,
      undefined,
    );

    const userMessage = result.messages.find((msg) => msg.type === 'user');
    expect(userMessage?.message.content).toEqual([
      { type: 'text', text: '用户真实问题' },
      {
        type: 'text',
        text: '<system-reminder>qwen internal</system-reminder>',
      },
      { type: 'text', text: '继续说明' },
    ]);
  });

  it('passes resolved image URLs to before hooks for local TUI prompts', async () => {
    const fireBefore = vi.fn(async () => null);
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });

    const result = await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/uploaded-image.png',
            },
          },
          { type: 'text', text: '看看这张图' },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-with-image',
        promptId: 'prompt-with-image',
        requestSetId: 'request-set-with-image',
        querySource: 'tui',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(fireBefore).toHaveBeenCalledWith(
      'prompt-with-image',
      '看看这张图',
      ['https://example.com/uploaded-image.png'],
      'request-set-with-image',
    );
  });

  it('omits image data from image_urls when upload is not used', async () => {
    const fireBefore = vi.fn(async () => null);
    const inlineImage =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });
    Object.assign(context.config as unknown as Record<string, unknown>, {
      getCustomProviderRegistry: () => ({
        isCustomProviderModel: () => true,
      }),
    });

    await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: inlineImage,
            },
          },
          {
            type: 'image',
            source: {
              type: 'url',
              url: `data:image/png;base64,${inlineImage}`,
            },
          },
          { type: 'text', text: '自定义 Provider 模型图片' },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'custom-provider-user-with-image',
        promptId: 'custom-provider-prompt-with-image',
        querySource: 'tui',
      },
      context,
    );

    expect(fireBefore).toHaveBeenCalledWith(
      'custom-provider-prompt-with-image',
      '自定义 Provider 模型图片',
      undefined,
      undefined,
    );
  });

  it.each([
    { surface: 'SDK', querySource: 'sdk', bridgeOrigin: false, id: 'sdk' },
    { surface: 'ACP', querySource: 'acp', bridgeOrigin: false, id: 'acp' },
    {
      surface: 'remote bridge',
      querySource: 'sdk',
      bridgeOrigin: true,
      id: 'remote',
    },
  ])(
    'passes image URLs to before hooks for $surface prompts',
    async ({ querySource, bridgeOrigin, id }) => {
      const fireBefore = vi.fn(async () => null);
      const context = makeContext({
        hookCoordinator: makeHookCoordinator(fireBefore),
      });
      const imageUrl = `https://example.com/${id}-image.png`;
      const prompt = `${id} image prompt`;
      const promptId = `${id}-prompt-with-image`;

      await processUserInput(
        {
          input: [
            {
              type: 'image',
              source: { type: 'url', url: imageUrl },
            },
            { type: 'text', text: prompt },
          ],
          commandMode: 'prompt',
          skipAttachments: true,
          uuid: `${id}-user-with-image`,
          promptId,
          querySource,
          bridgeOrigin,
          requestSetId: `${id}-request-set`,
        },
        context,
      );

      expect(fireBefore).toHaveBeenCalledWith(
        promptId,
        prompt,
        [imageUrl],
        `${id}-request-set`,
      );
    },
  );

  it('fires before hooks for image-only prompts with an empty prompt string', async () => {
    const fireBefore = vi.fn(async () => null);
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });

    await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/image-only.png',
            },
          },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'image-only-user',
        promptId: 'image-only-prompt',
        querySource: 'sdk',
      },
      context,
    );

    expect(fireBefore).toHaveBeenCalledWith(
      'image-only-prompt',
      '',
      ['https://example.com/image-only.png'],
      undefined,
    );
  });

  it('fires before hooks for image-only prompts without an HTTP URL', async () => {
    const fireBefore = vi.fn(async () => null);
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(fireBefore),
    });
    // Upload failures and custom providers both reach the hook boundary as
    // unresolved base64 images. Keep this test deterministic by bypassing the
    // provider upload path while exercising that shared representation.
    Object.assign(context.config as unknown as Record<string, unknown>, {
      getCustomProviderRegistry: () => ({
        isCustomProviderModel: () => true,
      }),
    });

    const result = await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            },
          },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'image-only-upload-fallback-user',
        promptId: 'image-only-upload-fallback-prompt',
        querySource: 'sdk',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(fireBefore).toHaveBeenCalledWith(
      'image-only-upload-fallback-prompt',
      '',
      undefined,
      undefined,
    );
  });

  it('blocks query execution before the user message enters history', async () => {
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(
        vi.fn(async () => ({ blocked: true })),
      ),
    });

    const result = await processUserInput(
      {
        input: 'blocked prompt',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.messages.some((msg) => msg.type === 'user')).toBe(false);
    expect(result.messages[0]).toMatchObject({
      type: 'system',
      subtype: 'error',
      level: 'error',
    });
  });

  it('reports a before-hook stop with its stopReason instead of an empty turn', async () => {
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(
        vi.fn(async () => ({ stopped: true, stopReason: 'BLOCKED-BY-HOOK' })),
      ),
    });

    const result = await processUserInput(
      {
        input: 'blocked prompt',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.hookStop).toEqual({ stopReason: 'BLOCKED-BY-HOOK' });
    const stopMessage = result.messages.find(
      (msg): msg is UserMessage => msg.type === 'user' && msg.isMeta === true,
    );
    expect(stopMessage?.message.content).toBe(
      'Operation stopped by hook: BLOCKED-BY-HOOK',
    );
  });

  it('keeps a before-hook stop distinguishable when no stopReason was given', async () => {
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(
        vi.fn(async () => ({ stopped: true })),
      ),
    });

    const result = await processUserInput(
      {
        input: 'blocked prompt',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.hookStop).toEqual({});
  });

  it('includes before-hook pending attachments in processed messages', async () => {
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(
        vi.fn(async () => ({
          pendingAttachments: [
            new HookSystemMessageAttachment({
              type: 'hook_system_message' as const,
              content: 'ready',
              hookName: 'setup',
              toolUseID: '',
              hookEvent: 'UserPromptSubmit',
            }),
          ],
        })),
      ),
    });

    const result = await processUserInput(
      {
        input: 'hello',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'attachment',
          attachment: expect.objectContaining({
            type: 'hook_system_message',
            content: 'ready',
            hookName: 'setup',
          }),
        }),
      ]),
    );
    expect(context.attachmentCtx.pendingHookAttachments).toEqual([]);
  });

  it('inlines referenced pasted images and drops orphaned images', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-input-test-'));
    try {
      const result = await processUserInput(
        {
          input: 'look at [Image #1]',
          commandMode: 'prompt',
          skipAttachments: true,
          uuid: 'user-1',
          promptId: 'prompt-1',
          pastedContents: {
            1: {
              id: 1,
              type: 'image',
              content:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              mediaType: 'image/png',
              filename: 'pixel.png',
            },
            2: {
              id: 2,
              type: 'image',
              content:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              mediaType: 'image/png',
              filename: 'orphan.png',
            },
          },
        },
        makeContext({ tempDir }),
      );

      const userMessage = result.messages.find((msg) => msg.type === 'user');
      expect(Array.isArray(userMessage?.message.content)).toBe(true);
      const blocks = userMessage?.message.content;
      expect(
        Array.isArray(blocks) ? blocks.filter((b) => b.type === 'image') : [],
      ).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops before querying when a direct image block is truncated', async () => {
    const completeJpeg = await createJpegBuffer(10, 10);
    const truncatedJpeg = completeJpeg.subarray(0, completeJpeg.length - 2);

    const result = await processUserInput(
      {
        input: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/jpeg',
              data: truncatedJpeg.toString('base64'),
            },
          },
          { type: 'text', text: 'inspect this image' },
        ],
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      makeContext(),
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.resultIsError).toBe(true);
    expect(result.terminalReason).toBe('image_processing_failed');
    expect(result.errorCode).toBe('IMAGE_PROCESSING_FAILED');
    expect(result.resultText).toContain('could not be decoded completely');
    expect(result.messages).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'error',
      }),
    ]);
  });

  it('stops before querying when a referenced pasted image is truncated', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-input-test-'));
    try {
      const completeJpeg = await createJpegBuffer(10, 10);
      const truncatedJpeg = completeJpeg.subarray(0, completeJpeg.length - 2);

      const result = await processUserInput(
        {
          input: 'inspect [Image #1]',
          commandMode: 'prompt',
          skipAttachments: true,
          uuid: 'user-1',
          promptId: 'prompt-1',
          pastedContents: {
            1: {
              id: 1,
              type: 'image',
              content: truncatedJpeg.toString('base64'),
              mediaType: 'image/jpeg',
              filename: 'truncated.jpg',
            },
          },
        },
        makeContext({ tempDir }),
      );

      expect(result.shouldQuery).toBe(false);
      expect(result.resultIsError).toBe(true);
      expect(result.terminalReason).toBe('image_processing_failed');
      expect(result.errorCode).toBe('IMAGE_PROCESSING_FAILED');
      expect(result.resultText).toContain('could not be decoded completely');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('submits an unreadable pasted path as plain text instead of failing the turn', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-input-test-'));
    const emitFeedbackSpy = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    try {
      const missingPath = path.join(tempDir, 'unreachable-share', 'image.png');
      const result = await processUserInput(
        {
          input: 'what about this one [Image #1]',
          commandMode: 'prompt',
          skipAttachments: true,
          uuid: 'user-1',
          promptId: 'prompt-1',
          pastedContents: {
            1: {
              id: 1,
              type: 'image',
              content: '',
              sourcePath: missingPath,
              filename: 'image.png',
            },
          },
        },
        makeContext({ tempDir }),
      );

      expect(result.shouldQuery).toBe(true);
      expect(result.resultIsError).toBeUndefined();
      const userMessage = result.messages.find((msg) => msg.type === 'user');
      expect(userMessage?.message.content).toBe(
        `what about this one ${missingPath}`,
      );
      expect(emitFeedbackSpy).toHaveBeenCalledWith(
        'warning',
        `No readable image found, kept as plain text: ${missingPath}`,
        undefined,
        { omitFromTranscript: true },
      );
    } finally {
      emitFeedbackSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('routes bash mode through the injected handler without querying', async () => {
    const onBashCommand = vi.fn(async () => ({
      messages: [],
      shouldQuery: false,
    }));
    const context = {
      ...makeContext(),
      onBashCommand,
    };

    const result = await processUserInput(
      {
        input: 'pwd',
        commandMode: 'bash',
        skipAttachments: true,
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result).toEqual({ messages: [], shouldQuery: false });
    expect(onBashCommand).toHaveBeenCalledWith('pwd', []);
    expect(context.hookCoordinator.fireBefore).not.toHaveBeenCalled();
  });

  it('collects bash attachments after the handler confirms a model query', async () => {
    const order: string[] = [];
    let lazyModeLocked = false;
    const context = makeContext();
    context.attachmentCtx = createAttachmentContext(
      context.cwd,
      context.sessionId,
    );
    context.externalContext = {
      mcpClientManager: {
        getConnectedServerInstructions: () => [],
        getLazyMcpServerSnapshot: () => {
          order.push('attachments');
          expect(lazyModeLocked).toBe(true);
          return [
            {
              serverName: 'files',
              toolNames: ['mcp__files__read'],
            },
          ];
        },
      },
    };
    context.onBashCommand = vi.fn(async (_input, attachments) => {
      order.push('bash');
      expect(attachments).toEqual([]);
      lazyModeLocked = true;
      return {
        messages: [createUserMessage('bash completed', { isMeta: true })],
        shouldQuery: true,
      };
    });

    const result = await processUserInput(
      {
        input: 'pwd',
        commandMode: 'bash',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(order).toEqual(['bash', 'attachments']);
    expect(
      result.messages.some(
        (message) =>
          message.type === 'attachment' &&
          message.attachment.type === 'mcp_lazy_tools_delta' &&
          String(message.attachment['content']).includes('mcp__files__read'),
      ),
    ).toBe(true);
  });

  it('does not collect bash attachments when no model query follows', async () => {
    const getConnectedServerInstructions = vi.fn(() => []);
    const getLazyMcpServerSnapshot = vi.fn(() => null);
    const context = makeContext();
    context.attachmentCtx = createAttachmentContext(
      context.cwd,
      context.sessionId,
    );
    context.externalContext = {
      mcpClientManager: {
        getConnectedServerInstructions,
        getLazyMcpServerSnapshot,
      },
    };
    context.onBashCommand = vi.fn(async () => ({
      messages: [],
      shouldQuery: false,
    }));

    const result = await processUserInput(
      {
        input: 'sleep 30',
        commandMode: 'bash',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(false);
    expect(getConnectedServerInstructions).not.toHaveBeenCalled();
    expect(getLazyMcpServerSnapshot).not.toHaveBeenCalled();
  });

  describe('lazy MCP reminder after an input is not accepted', () => {
    interface LazyHarness {
      context: ProcessInputFullContext;
      blockNextPrompt: () => void;
    }

    function makeLazyHarness(
      getSnapshot: () => Array<{ serverName: string; toolNames: string[] }>,
    ): LazyHarness {
      let block = false;
      const fireBefore = vi.fn(async () => {
        if (!block) return null;
        block = false;
        return { blocked: true };
      });
      const context = makeContext({
        hookCoordinator: makeHookCoordinator(fireBefore),
      });
      Object.assign(context.config, { isSkillsSupportEnabled: () => false });
      context.attachmentCtx = createAttachmentContext(
        context.cwd,
        context.sessionId,
      );
      context.externalContext = {
        mcpClientManager: {
          getConnectedServerInstructions: () => [],
          getLazyMcpServerSnapshot: getSnapshot,
        },
      };
      return {
        context,
        blockNextPrompt: () => {
          block = true;
        },
      };
    }

    function findLazyReminder(
      messages: Awaited<ReturnType<typeof processUserInput>>['messages'],
    ) {
      for (const message of messages) {
        if (
          message.type === 'attachment' &&
          message.attachment.type === 'mcp_lazy_tools_delta'
        ) {
          return message.attachment;
        }
      }
      return undefined;
    }

    let promptCounter = 0;
    async function send(
      context: ProcessInputFullContext,
      selectedSkills?: Array<{ name: string }>,
    ) {
      promptCounter += 1;
      return processUserInput(
        {
          input: 'hello',
          commandMode: 'prompt',
          promptId: `prompt-${promptCounter}`,
          selectedSkills,
        },
        context,
      );
    }

    const rejections: Array<[string, (harness: LazyHarness) => Promise<void>]> =
      [
        [
          'a hook blocks the prompt',
          async ({ context, blockNextPrompt }) => {
            blockNextPrompt();
            const result = await send(context);
            expect(result.shouldQuery).toBe(false);
            expect(findLazyReminder(result.messages)).toBeUndefined();
          },
        ],
        [
          'selected skill activation throws',
          async ({ context }) => {
            await expect(send(context, [{ name: 'review' }])).rejects.toThrow(
              'Skills are disabled for this session.',
            );
          },
        ],
      ];

    describe.each(rejections)('when %s', (_label, rejectPrompt) => {
      it('re-sends the full catalog on the next accepted prompt', async () => {
        const harness = makeLazyHarness(() => [
          { serverName: 'files', toolNames: ['mcp__files__read'] },
        ]);

        await rejectPrompt(harness);
        expect(harness.context.attachmentCtx.announcedLazyMcpTools.size).toBe(
          0,
        );

        const accepted = await send(harness.context);
        expect(accepted.shouldQuery).toBe(true);
        expect(findLazyReminder(accepted.messages)).toMatchObject({
          isInitial: true,
          addedNames: ['mcp__files__read'],
        });
      });

      it('keeps a deferred post-compact catalog for the next accepted prompt', async () => {
        const harness = makeLazyHarness(() => [
          { serverName: 'files', toolNames: ['mcp__files__read'] },
        ]);
        const ctx = harness.context.attachmentCtx;
        ctx.announcedLazyMcpTools.add('mcp__files__read');
        const catalog = new McpLazyToolsDeltaAttachment({
          type: 'mcp_lazy_tools_delta',
          content: 'catalog',
          isInitial: true,
          addedNames: ['mcp__files__read'],
          removedNames: [],
        });
        ctx.pendingPostCompactDeltaAttachments = [catalog];

        await rejectPrompt(harness);
        expect(ctx.pendingPostCompactDeltaAttachments).toEqual([catalog]);

        const accepted = await send(harness.context);
        expect(findLazyReminder(accepted.messages)).toMatchObject({
          content: 'catalog',
          isInitial: true,
        });
        expect(ctx.pendingPostCompactDeltaAttachments).toBeNull();
      });

      it('re-sends the delta on the next accepted prompt', async () => {
        // Enough existing tools that the delta is shorter than the full catalog.
        const initialTools = Array.from(
          { length: 30 },
          (_, i) => `mcp__files__tool_${String(i).padStart(2, '0')}`,
        );
        let toolNames = initialTools;
        const harness = makeLazyHarness(() => [
          { serverName: 'files', toolNames },
        ]);

        const first = await send(harness.context);
        expect(findLazyReminder(first.messages)).toMatchObject({
          isInitial: true,
        });

        toolNames = [...initialTools, 'mcp__files__write'];
        await rejectPrompt(harness);
        expect(
          [...harness.context.attachmentCtx.announcedLazyMcpTools].sort(),
        ).toEqual(initialTools);

        const accepted = await send(harness.context);
        expect(findLazyReminder(accepted.messages)).toMatchObject({
          isInitial: false,
          addedNames: ['mcp__files__write'],
          removedNames: [],
        });
      });
    });
  });

  it('falls back to a text prompt when the slash handler returns false', async () => {
    const onSlashCommand = vi.fn(async (): Promise<false> => false);
    const context = {
      ...makeContext(),
      onSlashCommand,
    };

    const result = await processUserInput(
      {
        input: '/unknown should be model text',
        commandMode: 'prompt',
        skipAttachments: true,
        uuid: 'user-1',
        promptId: 'prompt-1',
      },
      context,
    );

    expect(result.shouldQuery).toBe(true);
    expect(onSlashCommand).toHaveBeenCalledWith(
      '/unknown should be model text',
      [],
      [],
      [],
    );
    const userMessage = result.messages.find((msg) => msg.type === 'user');
    expect(userMessage).toMatchObject({
      uuid: 'user-1',
      promptId: 'prompt-1',
    });
    expect(userMessage?.message.content).toBe('/unknown should be model text');
  });

  it('collects attachments when an absolute-path prompt falls through slash routing', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-path-attachment-'));
    try {
      const discoverContext = vi.fn(async () => '');
      const context = makeContext({ tempDir });
      context.attachmentCtx = createAttachmentContext(tempDir);
      writeFileSync(path.join(tempDir, 'README.md'), 'readme');
      context.externalContext = {
        memoryContextManager: {
          getGlobalMemory: () => '',
          getPluginMemory: () => '',
          getEnvironmentMemory: () => '',
          getLocalMemory: () => '',
          getLoadedPaths: () => new Set<string>(),
          discoverContext,
        },
      };

      const result = await processUserInput(
        {
          input: '/Users/me/project 检查一下 @README.md',
          commandMode: 'prompt',
          promptId: 'prompt-path-attachment',
        },
        {
          ...context,
          onSlashCommand: vi.fn(async (): Promise<false> => false),
        },
      );

      expect(result.shouldQuery).toBe(true);
      expect(discoverContext).toHaveBeenCalledWith(
        path.join(tempDir, 'README.md'),
        [tempDir],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects post-slash plan attachments when a slash command enters plan mode and submits a prompt', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-plan-slash-test-'));
    try {
      const context = makeContext({ tempDir });
      let isPlanActive = false;
      const planStateManager = {
        get isActive() {
          return isPlanActive;
        },
        getPlanFilePath: vi.fn(() => path.join(tempDir, 'session-plan.md')),
        consumeReentryFlag: vi.fn(() => false),
        consumeExitAttachmentFlag: vi.fn(() => false),
        get interviewPhaseEnabled() {
          return false;
        },
        get phase4Variant() {
          return 'control';
        },
      };
      (
        context.config as unknown as { planStateManager: unknown }
      ).planStateManager = planStateManager;
      context.externalContext = {
        plansDir: tempDir,
        sessionId: 'session-1',
      };

      const onSlashCommand = vi.fn(async () => {
        isPlanActive = true;
        return {
          messages: [
            createUserMessage('implement auth', {
              uuid: 'user-1',
              origin: { kind: 'human' },
              permissionMode: 'acceptEdits',
            }),
          ],
          shouldQuery: true,
        };
      });

      const result = await processUserInput(
        {
          input: '/plan implement auth',
          commandMode: 'prompt',
          uuid: 'user-1',
          promptId: 'prompt-1',
        },
        {
          ...context,
          onSlashCommand,
        },
      );

      expect(result.shouldQuery).toBe(true);
      expect(result.messages[0]).toMatchObject({
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
      });
      expect(result.messages[1]).toMatchObject({
        type: 'attachment',
        attachment: {
          type: 'plan_mode',
          reminderType: 'full',
          isActive: true,
          planFilePath: path.join(tempDir, 'session-plan.md'),
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the explicit expanded prompt for post-slash attachment discovery', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-slash-attachment-'));
    try {
      const discoverContext = vi.fn(async () => '');
      const context = makeContext({ tempDir });
      context.attachmentCtx = createAttachmentContext(tempDir);
      writeFileSync(path.join(tempDir, 'README.md'), 'readme');
      context.externalContext = {
        memoryContextManager: {
          getGlobalMemory: () => '',
          getPluginMemory: () => '',
          getEnvironmentMemory: () => '',
          getLocalMemory: () => '',
          getLoadedPaths: () => new Set<string>(),
          discoverContext,
        },
      };

      const result = await processUserInput(
        {
          input: '/inspect-readme',
          commandMode: 'prompt',
          uuid: 'user-attachment',
          promptId: 'prompt-attachment',
        },
        {
          ...context,
          onSlashCommand: vi.fn(async () => ({
            messages: [
              createUserMessage(
                '<command-message>inspect-readme</command-message>\n<command-name>/inspect-readme</command-name>',
              ),
              createUserMessage('Inspect @README.md before answering.', {
                isMeta: true,
              }),
            ],
            shouldQuery: true,
            attachmentInput: 'Inspect @README.md before answering.',
          })),
        },
      );

      expect(result.shouldQuery).toBe(true);
      expect(discoverContext).toHaveBeenCalledWith(
        path.join(tempDir, 'README.md'),
        [tempDir],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows bridge-origin slash commands only after a command-aware safety decision', async () => {
    const onSlashCommand = vi.fn(async () => ({
      messages: [],
      shouldQuery: false,
      resultText: 'safe command ran',
    }));
    const onBridgeSlashCommand = vi.fn(async () => ({ allow: true as const }));
    const context = {
      ...makeContext(),
      onSlashCommand,
      onBridgeSlashCommand,
    };

    const result = await processUserInput(
      {
        input: '/safe',
        commandMode: 'prompt',
        skipSlashCommands: true,
        bridgeOrigin: true,
      },
      context,
    );

    expect(onBridgeSlashCommand).toHaveBeenCalledWith('/safe');
    expect(onSlashCommand).toHaveBeenCalled();
    expect(result).toMatchObject({
      shouldQuery: false,
      resultText: 'safe command ran',
    });
  });

  it('blocks known unsafe bridge-origin slash commands with direct output', async () => {
    const onSlashCommand = vi.fn();
    const context = {
      ...makeContext(),
      onSlashCommand,
      onBridgeSlashCommand: vi.fn(async () => ({
        allow: false as const,
        message: "/config isn't available over Remote Control.",
      })),
    };

    const result = await processUserInput(
      {
        input: '/config',
        commandMode: 'prompt',
        skipSlashCommands: true,
        bridgeOrigin: true,
        uuid: 'bridge-user',
      },
      context,
    );

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(result.shouldQuery).toBe(false);
    expect(result.resultText).toBe(
      "/config isn't available over Remote Control.",
    );
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user', uuid: 'bridge-user' }),
        expect.objectContaining({
          type: 'system',
          content: "/config isn't available over Remote Control.",
        }),
      ]),
    );
  });

  it('keeps unknown bridge-origin slash input as plain text', async () => {
    const onSlashCommand = vi.fn();
    const context = {
      ...makeContext(),
      onSlashCommand,
      onBridgeSlashCommand: vi.fn(async () => null),
    };

    const result = await processUserInput(
      {
        input: '/shrug',
        commandMode: 'prompt',
        skipSlashCommands: true,
        bridgeOrigin: true,
      },
      context,
    );

    const userMessage = result.messages.find((msg) => msg.type === 'user');
    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(result.shouldQuery).toBe(true);
    expect(userMessage?.message.content).toBe('/shrug');
  });
});

describe('executeUserInput', () => {
  it('returns processed messages and passes them to onQuery', async () => {
    const context = makeContext();
    const onQuery = vi.fn(async () => {});

    const result = await executeUserInput(
      [
        {
          prompt: 'hello',
          commandMode: 'prompt',
          uuid: 'user-1',
        },
      ],
      {
        ...context,
        promptId: 'prompt-1',
        querySource: 'internal',
        onQuery,
      },
    );

    expect(result.shouldQuery).toBe(true);
    expect(result.messages.some((msg) => msg.type === 'user')).toBe(true);
    expect(onQuery).toHaveBeenCalledWith(result.messages, undefined);
  });

  it('propagates a before-hook stop instead of reporting an empty query', async () => {
    const context = makeContext({
      hookCoordinator: makeHookCoordinator(
        vi.fn(async () => ({ stopped: true, stopReason: 'BLOCKED-BY-HOOK' })),
      ),
    });
    const onQuery = vi.fn(async () => {});

    const result = await executeUserInput(
      [
        {
          prompt: 'blocked prompt',
          commandMode: 'prompt',
          uuid: 'user-1',
        },
      ],
      {
        ...context,
        promptId: 'prompt-1',
        querySource: 'internal',
        onQuery,
      },
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.hookStop).toEqual({ stopReason: 'BLOCKED-BY-HOOK' });
    expect(onQuery).not.toHaveBeenCalled();
  });

  it('overrides default human origin for non-human queued commands', async () => {
    const context = makeContext();
    const onQuery = vi.fn(async () => {});

    const result = await executeUserInput(
      [
        {
          prompt: '<task-notification>done</task-notification>',
          commandMode: 'task-notification',
          uuid: 'task-1',
        },
        {
          prompt: 'bridge prompt',
          commandMode: 'prompt',
          uuid: 'bridge-1',
          origin: { kind: 'bridge', sessionId: 'bridge-session' },
        },
      ],
      {
        ...context,
        promptId: 'prompt-1',
        querySource: 'internal',
        onQuery,
      },
    );

    const userMessages = result.messages.filter((msg) => msg.type === 'user');
    expect(userMessages[0]?.origin).toEqual({ kind: 'task-notification' });
    expect(userMessages[1]?.origin).toEqual({
      kind: 'bridge',
      sessionId: 'bridge-session',
    });
  });

  it('returns first-command slash metadata and direct output', async () => {
    const context = makeContext();
    const onQuery = vi.fn(async () => {});
    const onNextInput = vi.fn();
    const enqueueNextInput = vi.fn();

    const result = await executeUserInput(
      [
        {
          prompt: '/model opus',
          commandMode: 'prompt',
          uuid: 'user-1',
        },
      ],
      {
        ...context,
        promptId: 'prompt-1',
        onQuery,
        onNextInput,
        enqueueNextInput,
        onSlashCommand: vi.fn(async () => ({
          messages: [],
          shouldQuery: false,
          model: 'opus',
          effort: 'high',
          resultText: 'Using opus',
          nextInput: 'continue',
          submitNextInput: true,
        })),
      },
    );

    expect(result).toMatchObject({
      messages: [],
      shouldQuery: false,
      model: 'opus',
      effort: 'high',
      resultText: 'Using opus',
      nextInput: 'continue',
      submitNextInput: true,
    });
    expect(onQuery).not.toHaveBeenCalled();
    expect(onNextInput).not.toHaveBeenCalled();
    expect(enqueueNextInput).toHaveBeenCalledWith('continue');
  });
});
