/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanStateManager } from '../plan/planStateManager.js';
import { PermissionModes, type PermissionMode } from '../permissions/manager/decision/index.js';
import type { TestPermissionManager } from '../test-utils/config.js';
import { WORKFLOW_TOOL_NAME } from '../tools/tool-names.js';
import {
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../utils/imageReader.js';
import type { Config } from '../config/config.js';
import type { ImagePrepareRequest } from '../hooks/imagePrepare.js';
import type { ModelImageBlock } from '../provider/modelStreamRequest.js';
const prepareImage = vi.fn<(block: ModelImageBlock, options?: { signal?: AbortSignal }) => Promise<ModelImageBlock>>();
function imageConfig(enabled = true): Config {
  return {
    getModelProviderManager: () => ({ getMainModel: async () => ({ source: 'qwen-provider', key: 'test' }) }),
    getHookSystem: () => ({
      fireImagePrepareEvent: async (input: ImagePrepareRequest, signal?: AbortSignal) => Promise.all(input.images.map(async block => {
        if (!enabled) return block;
        const result = await prepareImage(block, { signal });
        signal?.throwIfAborted();
        if (input.failureMode === 'throw' && result.source.type !== 'url') throw new Error('image upload did not return a URL');
        return result;
      })),
    }),
  } as unknown as Config;
}
import type { QueuedCommand } from './types.js';
import { McpLazyToolsDeltaAttachment } from './models/mcp-attachments.js';
import { PlanModeAttachment } from './models/plan-attachments.js';
import {
  createAttachmentContext,
  getAttachmentMessages,
} from './get-attachments.js';

vi.mock('../utils/imageReader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/imageReader.js')>();
  return {
    ...actual,
    maybeResizeAndDownsampleImageBuffer: vi.fn(),
  };
});


afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** A permission module that only reports its mode — enough for the generators. */
function permissionInMode(mode: PermissionMode): TestPermissionManager {
  return {
    getPermissionMode: () => mode,
  } as unknown as TestPermissionManager;
}

describe('getAttachmentMessages', () => {
  it('reads MCP resources alongside files while preserving attachment order', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-mention-parallel-'));
    try {
      const filename = path.join(tempDir, 'notes.txt');
      writeFileSync(filename, 'file content');
      const ctx = createAttachmentContext(tempDir);
      let fileReadWhenResourceStarted: boolean | undefined;
      const messages = await getAttachmentMessages(
        '@notes.txt @docs:doc://schema',
        ctx,
        [],
        null,
        { skipSkillDiscovery: true },
        {
          mcpResources: {
            findResource: () => ({
              serverName: 'docs',
              uri: 'doc://schema',
              name: 'Schema',
              discoveredAt: Date.now(),
            }),
            canUseServer: () => true,
            readResource: async () => {
              fileReadWhenResourceStarted = ctx.readFileState.has(filename);
              return { contents: [{ uri: 'doc://schema', text: 'schema' }] };
            },
          },
        },
      );

      expect(fileReadWhenResourceStarted).toBe(false);
      expect(ctx.readFileState.has(filename)).toBe(true);
      expect(messages.slice(0, 2).map((message) => message.attachment)).toEqual([
        expect.objectContaining({ type: 'file', content: 'file content' }),
        expect.objectContaining({ type: 'mcp_resource', uri: 'doc://schema' }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects the auto-mode reminder on a human turn in auto mode', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-auto-reminder-'));
    try {
      const ctx = createAttachmentContext(tempDir);
      ctx.permission = permissionInMode(PermissionModes.Auto);
      const planStateManager = {
        get isActive() {
          return false;
        },
        consumeReentryFlag: () => false,
        consumeExitAttachmentFlag: () => false,
        incrementTurnsSincePlanExit: () => {},
        shouldSendVerifyReminder: () => false,
      } as unknown as PlanStateManager;

      const inAuto = await getAttachmentMessages(
        'do the thing',
        ctx,
        [],
        [],
        { isMainThread: true },
        { plansDir: tempDir, sessionId: 'session-1' },
        planStateManager,
      );

      expect(inAuto).toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: { type: 'auto_mode', reminderType: 'full' },
        }),
      );

      const defaultCtx = createAttachmentContext(tempDir);
      defaultCtx.permission = permissionInMode(PermissionModes.Default);
      const inDefault = await getAttachmentMessages(
        'do the thing',
        defaultCtx,
        [],
        [],
        { isMainThread: true },
        { plansDir: tempDir, sessionId: 'session-2' },
        planStateManager,
      );

      expect(
        inDefault.some(
          (m) =>
            m.type === 'attachment' && m.attachment.type === 'auto_mode',
        ),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows callers to mark an attachment context as subagent-owned', () => {
    const ctx = createAttachmentContext('/workspace', 'fork-agent-1', {
      isMainAgent: false,
    });

    expect(ctx).toMatchObject({
      cwd: '/workspace',
      agentId: 'fork-agent-1',
      isMainAgent: false,
    });
  });

  it('uses plan state, not permission mode, for inter-turn plan reminders', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-plan-interturn-'));
    try {
      const planFilePath = path.join(tempDir, 'session-plan.md');
      const ctx = createAttachmentContext(tempDir);
      ctx.currentPlanFilePath = planFilePath;
      ctx.planModeJustEntered = true;

      const planStateManager = {
        get isActive() {
          return true;
        },
      } as unknown as PlanStateManager;

      const messages = await getAttachmentMessages(
        null,
        ctx,
        [],
        [],
        { isMainThread: true },
        {
          plansDir: tempDir,
          sessionId: 'session-1',
        },
        planStateManager,
      );

      expect(messages).toEqual([
        expect.objectContaining({
          type: 'attachment',
          attachment: {
            type: 'plan_mode',
            reminderType: 'full',
            isActive: true,
            isSubAgent: false,
            planFilePath,
            planExists: false,
          },
        }),
      ]);
      expect(ctx.planModeJustEntered).toBe(false);
      expect(ctx.interTurnSparseEmittedThisTurn).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects a workflow reminder for a local-TUI ultracode keyword', async () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'test-workflow-reminder-'),
    );
    try {
      const ctx = createAttachmentContext(tempDir);

      const messages = await getAttachmentMessages(
        'Please ultracode this repository audit.',
        ctx,
        [],
        [],
        { isMainThread: true, isTuiPrompt: true },
        {
          toolRegistry: {
            hasToolEnabled: (name: string) => name === WORKFLOW_TOOL_NAME,
          },
        },
      );

      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: { type: 'workflow_keyword_request' },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses pre-expansion input for workflow keyword reminders', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-workflow-reminder-'));
    try {
      const ctx = createAttachmentContext(tempDir);

      const messages = await getAttachmentMessages(
        'Run ultracode with the expanded deep-research workflow.',
        ctx,
        [],
        [],
        {
          isMainThread: true,
          isTuiPrompt: true,
          preExpansionInput: '/deep-research',
        },
        {
          toolRegistry: {
            hasToolEnabled: (name: string) => name === WORKFLOW_TOOL_NAME,
          },
        },
      );

      expect(messages).not.toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: { type: 'workflow_keyword_request' },
          }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not infer the ultracode keyword from non-TUI transport text', async () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'test-workflow-reminder-'),
    );
    try {
      const messages = await getAttachmentMessages(
        'ultracode audit this repository',
        createAttachmentContext(tempDir),
        [],
        [],
        { isMainThread: true, isTuiPrompt: false },
        {
          toolRegistry: {
            hasToolEnabled: (name: string) => name === WORKFLOW_TOOL_NAME,
          },
        },
      );

      expect(
        messages.some(
          (message) =>
            message.type === 'attachment' &&
            message.attachment.type === 'workflow_keyword_request',
        ),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('suppresses only the one-turn keyword reminder, not session guidance', async () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'test-ultracode-session-'),
    );
    try {
      const messages = await getAttachmentMessages(
        'ultracode audit this repository',
        createAttachmentContext(tempDir),
        [],
        [],
        {
          isMainThread: true,
          isTuiPrompt: true,
          suppressWorkflowKeyword: true,
          ultracodeActive: true,
          ultracodeRegularUserPrompt: true,
        },
        {
          toolRegistry: {
            hasToolEnabled: (name: string) => name === WORKFLOW_TOOL_NAME,
          },
        },
      );

      expect(
        messages.some(
          (message) =>
            message.type === 'attachment' &&
            message.attachment.type === 'workflow_keyword_request',
        ),
      ).toBe(false);
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'attachment',
          attachment: { type: 'ultra_effort_enter', reminderType: 'full' },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not inject UltraCode session reminders on internal input', async () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'test-ultracode-internal-'),
    );
    try {
      const messages = await getAttachmentMessages(
        '<task-notification>done</task-notification>',
        createAttachmentContext(tempDir),
        [],
        [],
        {
          ultracodeActive: true,
          ultracodeRegularUserPrompt: false,
        },
      );

      expect(
        messages.some(
          (message) =>
            message.type === 'attachment' &&
            (message.attachment.type === 'ultra_effort_enter' ||
              message.attachment.type === 'ultra_effort_exit'),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('deferred post-compact re-announcements', () => {
  function queuedCatalog(toolNames: string[]) {
    return new McpLazyToolsDeltaAttachment({
      type: 'mcp_lazy_tools_delta',
      content: 'catalog',
      isInitial: true,
      addedNames: toolNames,
      removedNames: [],
    });
  }

  function lazyContext(toolNames: () => string[]) {
    return {
      mcpClientManager: {
        getConnectedServerInstructions: () => [],
        getLazyMcpServerSnapshot: () => [
          { serverName: 'files', toolNames: toolNames() },
        ],
      },
    };
  }

  function lazyReminders(
    messages: Awaited<ReturnType<typeof getAttachmentMessages>>,
  ) {
    return messages.filter(
      (m) =>
        m.type === 'attachment' && m.attachment.type === 'mcp_lazy_tools_delta',
    );
  }

  it('drains on the next human turn when the tool continuation never ran', async () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    ctx.announcedLazyMcpTools.add('mcp__files__read');
    const catalog = queuedCatalog(['mcp__files__read']);
    ctx.pendingPostCompactDeltaAttachments = [catalog];
    const external = lazyContext(() => ['mcp__files__read']);

    const first = await getAttachmentMessages(
      'hello',
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      external,
    );
    expect(lazyReminders(first).map((m) => m.attachment)).toEqual([catalog]);
    expect(ctx.pendingPostCompactDeltaAttachments).toBeNull();

    const second = await getAttachmentMessages(
      'hello again',
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      external,
    );
    expect(lazyReminders(second)).toEqual([]);
  });

  it('drains once on the tool continuation pass', async () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    const catalog = queuedCatalog(['mcp__files__read']);
    ctx.pendingPostCompactDeltaAttachments = [catalog];

    const continuation = await getAttachmentMessages(null, ctx, [], null, {
      skipSkillDiscovery: true,
    });
    expect(lazyReminders(continuation).map((m) => m.attachment)).toEqual([
      catalog,
    ]);

    const next = await getAttachmentMessages(null, ctx, [], null, {
      skipSkillDiscovery: true,
    });
    expect(lazyReminders(next)).toEqual([]);
  });

  it('puts the queued baseline ahead of fresh deltas', async () => {
    const ctx = createAttachmentContext('/workspace', 'session');
    ctx.announcedLazyMcpTools.add('mcp__files__read');
    const catalog = queuedCatalog(['mcp__files__read']);
    ctx.pendingPostCompactDeltaAttachments = [catalog];

    const messages = await getAttachmentMessages(
      'hello',
      ctx,
      [],
      null,
      { skipSkillDiscovery: true },
      lazyContext(() => ['mcp__files__read', 'mcp__files__write']),
    );

    expect(lazyReminders(messages).map((m) => m.attachment)).toEqual([
      catalog,
      expect.objectContaining({
        isInitial: false,
        addedNames: ['mcp__files__write'],
      }),
    ]);
  });

  it('lets the human-turn plan generator replace a queued plan_mode reminder', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-deferred-plan-'));
    try {
      const ctx = createAttachmentContext(tempDir, 'session');
      ctx.pendingPostCompactDeltaAttachments = [
        new PlanModeAttachment({
          type: 'plan_mode',
          reminderType: 'full',
          isActive: true,
          planFilePath: '',
          planExists: false,
        }),
      ];
      const planStateManager = {
        get isActive() {
          return true;
        },
        getPlanFilePath: () => path.join(tempDir, 'plan.md'),
        consumeReentryFlag: () => false,
        consumeExitAttachmentFlag: () => false,
        incrementTurnsSincePlanExit: () => {},
        shouldSendVerifyReminder: () => false,
      } as unknown as PlanStateManager;

      const messages = await getAttachmentMessages(
        'keep planning',
        ctx,
        [],
        null,
        { skipSkillDiscovery: true },
        { plansDir: tempDir, sessionId: 'session' },
        planStateManager,
      );

      const planReminders = messages.filter(
        (m) => m.type === 'attachment' && m.attachment.type === 'plan_mode',
      );
      expect(planReminders).toHaveLength(1);
      expect(planReminders[0]?.attachment).toMatchObject({
        planFilePath: path.join(tempDir, 'plan.md'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('queued command pasted images', () => {
  const rawBase64 = Buffer.from('raw pasted png bytes').toString('base64');
  const resizedBytes = Buffer.from('resized png bytes');

  function queuedImageCommand(): QueuedCommand {
    return {
      prompt: '这是什么图',
      commandMode: 'prompt',
      pastedContents: {
        0: {
          id: 0,
          type: 'image',
          content: rawBase64,
          mediaType: 'image/png',
          filename: 'clipboard.png',
        },
      },
    };
  }

  async function collectQueuedAttachment(
    command: QueuedCommand,
    withImageHook?: boolean,
    signal?: AbortSignal,
  ) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-queued-image-'));
    try {
      const messages = await getAttachmentMessages(
        null,
        createAttachmentContext(tempDir),
        [command],
        [],
        {
          isMainThread: true,
          imagePreparation: { config: imageConfig(withImageHook ?? true) },
          ...(signal ? { signal } : {}),
        },
      );
      const queued = messages.find(
        (msg) => msg.attachment.type === 'queued_command',
      );
      expect(queued).toBeDefined();
      return queued!.attachment as { type: 'queued_command'; prompt: unknown };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('carries a host-relayed user decision onto the queued attachment', async () => {
    const decided = await collectQueuedAttachment({
      prompt: 'The user approved: rm build',
      commandMode: 'prompt',
      isMeta: true,
      isUserDecision: true,
    });
    const plain = await collectQueuedAttachment({
      prompt: 'Continue.',
      commandMode: 'prompt',
      isMeta: true,
    });
    expect(decided).toMatchObject({ isMeta: true, isUserDecision: true });
    expect(plain).not.toHaveProperty('isUserDecision');
  });

  it('resizes and uploads a mid-turn queued image instead of inlining base64', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockResolvedValue({
      type: 'image',
      source: { type: 'url', url: 'https://images.example.test/uploaded.png' },
    });

    const attachment = await collectQueuedAttachment(queuedImageCommand());

    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledOnce();
    expect(prepareImage).toHaveBeenCalledOnce();
    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://images.example.test/uploaded.png' },
      },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });

  it('keeps the image inline when uploads are disabled for custom providers', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });

    const attachment = await collectQueuedAttachment(
      queuedImageCommand(),
      false,
    );

    expect(prepareImage).not.toHaveBeenCalled();
    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: resizedBytes.toString('base64'),
        },
      },
    ]);
  });

  it('degrades an unprocessable queued image to a text note', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockRejectedValue(
      new ImageResizeError('unsupported image payload'),
    );

    const attachment = await collectQueuedAttachment(queuedImageCommand());

    expect(prepareImage).not.toHaveBeenCalled();
    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'text',
        text: '[Image #0 could not be processed: unsupported image payload]',
      },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });

  it('waits for queued image upload beyond the optional attachment timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://images.example.test/slow-upload.png',
                },
              }),
            15_000,
          );
        }),
    );

    let settled = false;
    const collecting = collectQueuedAttachment(queuedImageCommand()).then(
      (attachment) => {
        settled = true;
        return attachment;
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    const attachment = await collecting;
    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://images.example.test/slow-upload.png',
        },
      },
    ]);
  });

  it('preserves queued text when overall image processing times out', async () => {
    vi.useFakeTimers();
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockImplementation(
      (block, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(block), {
            once: true,
          });
        }),
    );

    const collecting = collectQueuedAttachment(queuedImageCommand());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const attachment = await collecting;

    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'text',
        text: expect.stringContaining('[Image #0 could not be processed:'),
      },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });

  it('propagates parent cancellation instead of consuming it as image degradation', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    vi.mocked(prepareImage).mockImplementation(
      (block, options) =>
        new Promise((resolve) => {
          markUploadStarted();
          options?.signal?.addEventListener('abort', () => resolve(block), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();

    const collecting = collectQueuedAttachment(
      queuedImageCommand(),
      undefined,
      controller.signal,
    );
    await uploadStarted;
    controller.abort(new Error('cancel queued image processing'));

    await expect(collecting).rejects.toThrow('cancel queued image processing');
  });

  it('degrades an internal-provider upload fallback instead of emitting base64', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockImplementation(async (block) => block);

    const attachment = await collectQueuedAttachment(queuedImageCommand());

    expect(prepareImage).toHaveBeenCalledOnce();
    expect(attachment.prompt).toEqual([
      { type: 'text', text: '这是什么图' },
      {
        type: 'text',
        text: '[Image #0 could not be processed: image upload did not return a URL]',
      },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });

  it('isolates a deferred-image read failure from other queued images', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-missing-image-'));
    try {
      vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
        buffer: resizedBytes,
        mediaType: 'png',
      });
      vi.mocked(prepareImage).mockResolvedValue({
        type: 'image',
        source: { type: 'url', url: 'https://images.example.test/valid.png' },
      });
      const command = queuedImageCommand();
      command.pastedContents = {
        0: {
          id: 0,
          type: 'image',
          content: '',
          mediaType: 'image/png',
          sourcePath: path.join(tempDir, 'missing.png'),
          preparationId: 'missing-image-preparation',
        },
        1: {
          id: 1,
          type: 'image',
          content: rawBase64,
          mediaType: 'image/png',
          filename: 'valid.png',
        },
      };

      const attachment = await collectQueuedAttachment(command);

      expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledOnce();
      expect(prepareImage).toHaveBeenCalledOnce();
      expect(attachment.prompt).toEqual([
        { type: 'text', text: '这是什么图' },
        {
          type: 'text',
          text: expect.stringContaining(
            '[Image #0 could not be processed: Unable to read pasted image',
          ),
        },
        {
          type: 'image',
          source: { type: 'url', url: 'https://images.example.test/valid.png' },
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('queued command SDK images', () => {
  const rawBase64 = Buffer.from('raw SDK png bytes').toString('base64');
  const resizedBytes = Buffer.from('resized SDK png bytes');

  function queuedSdkImageCommand(): QueuedCommand {
    return {
      prompt: [
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: rawBase64,
          },
        },
        { type: 'text', text: '分析这张图片' },
      ],
      commandMode: 'prompt',
      origin: { kind: 'bridge' },
    };
  }

  async function collectQueuedAttachment(
    command: QueuedCommand,
    withImageHook?: boolean,
  ) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'test-queued-sdk-image-'));
    try {
      const messages = await getAttachmentMessages(
        null,
        createAttachmentContext(tempDir),
        [command],
        [],
        {
          isMainThread: true,
          imagePreparation: { config: imageConfig(withImageHook ?? true) },
        },
      );
      const queued = messages.find(
        (msg) => msg.attachment.type === 'queued_command',
      );
      expect(queued).toBeDefined();
      return queued!.attachment as { type: 'queued_command'; prompt: unknown };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('resizes and uploads an inline SDK image queued during an active turn', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockResolvedValue({
      type: 'image',
      source: { type: 'url', url: 'https://images.example.test/sdk.png' },
    });

    const attachment = await collectQueuedAttachment(queuedSdkImageCommand());

    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledOnce();
    expect(prepareImage).toHaveBeenCalledOnce();
    expect(attachment.prompt).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'https://images.example.test/sdk.png' },
      },
      { type: 'text', text: '分析这张图片' },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });

  it('keeps a resized SDK image inline for Custom Providers', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });

    const attachment = await collectQueuedAttachment(
      queuedSdkImageCommand(),
      false,
    );

    expect(prepareImage).not.toHaveBeenCalled();
    expect(attachment.prompt).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: resizedBytes.toString('base64'),
        },
      },
      { type: 'text', text: '分析这张图片' },
    ]);
  });

  it('replaces an SDK image when the internal upload falls back to base64', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: resizedBytes,
      mediaType: 'png',
    });
    vi.mocked(prepareImage).mockImplementation(async (block) => block);

    const attachment = await collectQueuedAttachment(queuedSdkImageCommand());

    expect(attachment.prompt).toEqual([
      {
        type: 'text',
        text: '[Image #1 could not be processed: image upload did not return a URL]',
      },
      { type: 'text', text: '分析这张图片' },
    ]);
    expect(JSON.stringify(attachment.prompt)).not.toContain(rawBase64);
  });
});
