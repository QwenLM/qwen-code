/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import {
  readSessionTitleSidecar,
  sessionTitleSidecarPath,
  writeSessionTitleSidecar,
} from './session-title-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('ChatRecordingService - list title sidecar', () => {
  let root: string;
  let projectDir: string;
  let service: ChatRecordingService;
  let sidecarPath: string;

  function makeConfig(overrides: Record<string, unknown> = {}): Config {
    return {
      getSessionId: () => SESSION_ID,
      getProjectRoot: () => root,
      getCliVersion: () => '1.0.0',
      getModel: () => 'test-model',
      getAuthType: () => undefined,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getFastModel: () => undefined,
      isInteractive: () => false,
      getDebugMode: () => false,
      getResumedSessionData: () => undefined,
      storage: {
        getProjectDir: () => projectDir,
        getProjectTempDir: () => path.join(root, '.qwen', 'tmp'),
      },
      ...overrides,
    } as unknown as Config;
  }

  const newService = (config = makeConfig()) =>
    new ChatRecordingService(
      config,
      undefined,
      /* writerLeaseRequired */ false,
    );

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-recording-title-'));
    projectDir = path.join(root, '.qwen', 'projects', 'test-project');
    mkdirSync(path.join(projectDir, 'chats'), { recursive: true });
    sidecarPath = sessionTitleSidecarPath(
      path.join(projectDir, 'chats'),
      SESSION_ID,
    );
    service = newService();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists the first prompt as the list label', () => {
    service.recordUserMessage([{ text: '  处理 CI 报错与复验  ' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '处理 CI 报错与复验',
      source: 'prompt',
    });
  });

  it('lets a rename replace the prompt label', async () => {
    service.recordUserMessage([{ text: '处理 CI 报错与复验' }]);
    await service.recordCustomTitle('CI 验证与复验', 'manual');

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('does not let a later prompt overwrite an explicit title', async () => {
    await service.recordCustomTitle('CI 验证与复验', 'manual');
    service.recordUserMessage([{ text: '继续看 CI' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('prefers the prompt display text over the wire text', () => {
    service.recordUserMessage([{ text: 'wire-only text' }], undefined, {
      displayText: '列表展示文本',
      hookContext: '',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '列表展示文本',
      source: 'prompt',
    });
  });

  it('does not invent a label from a text-less first prompt', () => {
    service.recordUserMessage([
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
    ]);

    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
  });

  it('truncates by code point with an ellipsis like the list reader', () => {
    service.recordUserMessage([{ text: 'a'.repeat(201) }]);

    expect(readSessionTitleSidecar(sidecarPath)?.displayName).toBe(
      `${'a'.repeat(200)}...`,
    );
  });

  it('seeds the prompt label when a session is resumed', () => {
    const prompt = '恢复后的首条 prompt';
    const resumed: ChatRecord = {
      uuid: 'resumed-user',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: prompt }] },
      systemPayload: { displayText: prompt },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [resumed] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: prompt,
      source: 'prompt',
    });
  });

  it('seeds an explicit title when a session is resumed', () => {
    const title: ChatRecord = {
      uuid: 'resumed-title',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'system',
      subtype: 'custom_title',
      cwd: root,
      version: '1.0.0',
      systemPayload: { customTitle: '恢复的自定义标题', titleSource: 'manual' },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [title] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '恢复的自定义标题',
      source: 'manual',
    });
  });

  it('does not replace a persisted prompt label with a later prompt', () => {
    service.recordUserMessage([{ text: '首条 prompt' }]);
    service.recordUserMessage([{ text: '第二条 prompt' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '首条 prompt',
      source: 'prompt',
    });
  });

  it('lets a later text prompt label a session whose first prompt was image-only', () => {
    service.recordUserMessage([
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
    ]);
    service.recordUserMessage([{ text: '第二轮的文本 prompt' }]);

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '第二轮的文本 prompt',
      source: 'prompt',
    });
  });

  it('seeds the first prompt of a long resumed session, not the sliding window head', () => {
    const messages: ChatRecord[] = Array.from({ length: 25 }, (_, index) => ({
      uuid: `resumed-${index}`,
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: `prompt ${index + 1}` }] },
      systemPayload: { displayText: `prompt ${index + 1}` },
    }));
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: 'prompt 1',
      source: 'prompt',
    });
  });

  it('seeds a resume prompt from its message text when no display text exists', () => {
    const prompt = '只有 message parts 的 prompt';
    const resumed: ChatRecord = {
      uuid: 'resumed-plain',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: prompt }] },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [resumed] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: prompt,
      source: 'prompt',
    });
  });

  it('keeps an astral prompt intact through truncation and validation', () => {
    service.recordUserMessage([{ text: '😀'.repeat(300) }]);

    const stored = readSessionTitleSidecar(sidecarPath);
    expect(Array.from(stored!.displayName)).toHaveLength(203);
    expect(stored!.displayName.endsWith('...')).toBe(true);
    expect(stored!.displayName.includes('\uFFFD')).toBe(false);
  });

  it('treats an explicitly empty projection as no label for that turn', () => {
    service.recordUserMessage([{ text: 'wire-only text' }], undefined, {
      displayText: '',
      hookContext: '',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();

    service.recordUserMessage([{ text: '后续的文本 prompt' }], undefined, {
      displayText: '后续的文本 prompt',
      hookContext: '',
    });
    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '后续的文本 prompt',
      source: 'prompt',
    });
  });

  it('writes the same label a resume seed derives for a Mod prompt', () => {
    const prompt = '检查这段代码';
    service.recordUserMessage([{ text: 'wire text' }], undefined, {
      displayText: prompt,
      hookContext: '',
      mod: 'lint',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: prompt,
      source: 'prompt',
    });

    rmSync(sidecarPath, { force: true });
    const resumed: ChatRecord = {
      uuid: 'resumed-mod',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      provenance: 'mod_prompt',
      message: { role: 'user', parts: [{ text: 'wire text' }] },
      systemPayload: { displayText: prompt, hookContext: '', mod: 'lint' },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [resumed] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: prompt,
      source: 'prompt',
    });
  });

  it('keeps an explicit sidecar name across a headless resume', () => {
    writeSessionTitleSidecar(sidecarPath, '手动名字', 'manual');
    const resumed: ChatRecord = {
      uuid: 'resumed-prompt-only',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: '首条 prompt' }] },
      systemPayload: { displayText: '首条 prompt', hookContext: '' },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [resumed] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '手动名字',
      source: 'manual',
    });
  });

  it('seeds an explicit title when the projected restore runs', () => {
    new ChatRecordingService(makeConfig(), undefined, false, {
      lastCompletedUuid: 'tail',
      turnParentUuids: [null],
      customTitle: '投影标题',
      titleSource: 'manual',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '投影标题',
      source: 'manual',
    });
  });

  it('does not label a resumed session from its first post-resume prompt', () => {
    const recorder = new ChatRecordingService(makeConfig(), undefined, false, {
      lastCompletedUuid: 'tail',
      turnParentUuids: [null],
    });

    recorder.recordUserMessage([{ text: '继续看 CI' }], undefined, {
      displayText: '继续看 CI',
      hookContext: '',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();
  });

  it('lets a later prompt label a resumed session whose first prompt had no text', () => {
    const imageOnly: ChatRecord = {
      uuid: 'resumed-image',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
      },
    };
    newService(
      makeConfig({
        getResumedSessionData: () => ({
          conversation: { messages: [imageOnly] },
          filePath: path.join(projectDir, 'chats', `${SESSION_ID}.jsonl`),
          lastCompletedUuid: null,
        }),
      }),
    );
    expect(readSessionTitleSidecar(sidecarPath)).toBeUndefined();

    service.recordUserMessage([{ text: '恢复后的文本 prompt' }], undefined, {
      displayText: '恢复后的文本 prompt',
      hookContext: '',
    });

    expect(readSessionTitleSidecar(sidecarPath)).toMatchObject({
      displayName: '恢复后的文本 prompt',
      source: 'prompt',
    });
  });
});
