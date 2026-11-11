/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeI18nService,
  resetI18nService,
} from '../../../core/src/i18n/index.js';
import {
  type AssistantMessage,
  cloneUsage,
  CompressionStatus,
  type Config,
  CoreToolCallStatus,
  GLOB_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  type SystemMessage,
  TranscriptStore,
  TranscriptRepository,
  beginResumeRead,
  WRITE_FILE_DISPLAY_NAME,
  getSessionTranscriptPath,
  _resetConfigHomeDirCache,
  type UserMessage,
  type Message as RuntimeMessage,
} from '@qwen-code/core';
import {
  SessionSelector,
  convertMessagesToHistoryFormats,
  convertMessagesToIdentifiedHistoryFormats,
  extractFirstUserMessage,
  formatRelativeTime,
} from './sessionUtils.js';

let tempHomeDir: string;
let projectRoot: string;
let config: Config;

beforeEach(async () => {
  initializeI18nService();
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-utils-'));
  projectRoot = path.join(tempHomeDir, 'workspace');
  await fs.mkdir(projectRoot, { recursive: true });
  vi.stubEnv('HOME', tempHomeDir);
  vi.stubEnv(ENV_CONFIG_DIR, path.join(tempHomeDir, '.qwen'));
  _resetConfigHomeDirCache();
  config = {
    getProjectRoot: () => projectRoot,
    getSessionArtifactProjectRoot: () => projectRoot,
    getSessionId: () => 'current-session-id',
  } as Partial<Config> as Config;
});

afterEach(async () => {
  resetI18nService();
  vi.unstubAllEnvs();
  _resetConfigHomeDirCache();
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

function makeUserMessage(
  sessionId: string,
  content: string,
  timestamp: string,
): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp,
    sessionId,
    message: {
      role: 'user',
      content,
    },
  };
}

function makeAssistantMessage(
  sessionId: string,
  content: string,
  timestamp: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp,
    sessionId,
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: { ...cloneUsage(), input_tokens: 1, output_tokens: 2 },
      content: [{ type: 'text', text: content }],
    },
  };
}

async function writeTranscriptSession(
  sessionId: string,
  options: {
    userText: string;
    assistantText: string;
    userTimestamp: string;
    assistantTimestamp: string;
    customTitle?: string;
    aiTitle?: string;
    summary?: string;
    lastPrompt?: string;
    directories?: string[];
    mtime?: Date;
  },
) {
  const filePath = getSessionTranscriptPath(projectRoot, sessionId);
  const writer = await new TranscriptStore().acquireSessionWriter({
    filePath,
    sessionId,
    cwd: projectRoot,
    entrypoint: 'cli',
    version: '1.0.0',
  });

  const leafUuid = await writer.recordMessages([
    makeUserMessage(sessionId, options.userText, options.userTimestamp),
    makeAssistantMessage(
      sessionId,
      options.assistantText,
      options.assistantTimestamp,
    ),
  ]);

  if (options.customTitle) {
    await writer.recordCustomTitle(options.customTitle);
  }
  if (options.aiTitle) {
    await writer.recordAiTitle(options.aiTitle);
  }
  if (options.summary && leafUuid) {
    await writer.recordSummary(leafUuid, options.summary);
  }
  if (options.lastPrompt) {
    await writer.recordLastPrompt(options.lastPrompt);
  }
  if (options.directories) {
    await writer.recordWorkspaceDirectories(options.directories);
  }

  await writer.close();

  if (options.mtime) {
    await fs.utimes(filePath, options.mtime, options.mtime);
  }
}

describe('SessionSelector', () => {
  it('discovers sessions from the stable artifact root while running in a worktree', async () => {
    const worktreeCwd = path.join(tempHomeDir, 'worktree');
    await fs.mkdir(worktreeCwd, { recursive: true });
    await writeTranscriptSession('session-artifact-root', {
      userText: 'Artifact root session',
      assistantText: 'Artifact root reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
    });
    config = {
      getProjectRoot: () => worktreeCwd,
      getSessionArtifactProjectRoot: () => projectRoot,
      getSessionId: () => 'current-session-id',
    } as Partial<Config> as Config;

    const sessions = await new SessionSelector(config).listSessions();

    expect(sessions.map((session) => session.id)).toEqual([
      'session-artifact-root',
    ]);
  });

  it('lists transcript sessions', async () => {
    await writeTranscriptSession('session-1', {
      userText: 'First session',
      assistantText: 'First reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
      mtime: new Date('2026-04-14T10:01:00.000Z'),
    });
    await writeTranscriptSession('session-2', {
      userText: 'Second session',
      assistantText: 'Second reply',
      userTimestamp: '2026-04-14T11:00:00.000Z',
      assistantTimestamp: '2026-04-14T11:00:05.000Z',
      customTitle: 'Custom title',
      directories: [projectRoot, path.join(projectRoot, 'pkg')],
      mtime: new Date('2026-04-14T11:01:00.000Z'),
    });

    const selector = new SessionSelector(config);
    const sessions = await selector.listSessions({ includeFullContent: true });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: 'session-2',
      displayName: 'Custom title',
      firstUserMessage: 'Second session',
      directories: [projectRoot, path.join(projectRoot, 'pkg')],
      index: 1,
    });
    expect(sessions[1]).toMatchObject({
      id: 'session-1',
      displayName: 'First session',
      firstUserMessage: 'First session',
      index: 2,
    });
    expect(sessions[0]?.messages).toEqual([
      { role: 'user', content: 'Second session' },
      { role: 'assistant', content: 'Second reply' },
    ]);
  });

  it('lists current and all session scopes for the picker', async () => {
    await writeTranscriptSession('session-1', {
      userText: 'Scoped session',
      assistantText: 'Scoped reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
      mtime: new Date('2026-04-14T10:01:00.000Z'),
    });

    const selector = new SessionSelector(config);
    const scopes = await selector.listSessionScopes();

    expect(scopes.current.map((session) => session.id)).toEqual(['session-1']);
    expect(scopes.all.map((session) => session.id)).toEqual(['session-1']);
    expect(scopes.current[0]).not.toBe(scopes.all[0]);
    expect(scopes.current[0]).toMatchObject({
      displayName: 'Scoped session',
      messageCount: 0,
      isMetadataOnly: true,
    });

    const resolved = await selector.resolveSelectedSession(scopes.current[0]!);
    expect(resolved.sessionInfo).toMatchObject({
      displayName: 'Scoped session',
      messageCount: 2,
      isMetadataOnly: false,
    });
    expect(resolved.messages).toHaveLength(2);
    resolved.resumeAttempt?.finish();
  });

  it('surfaces last prompt as display name before summary fallback', async () => {
    await writeTranscriptSession('session-preview', {
      userText: 'Initial session question',
      assistantText: 'Initial reply',
      userTimestamp: '2026-04-14T11:00:00.000Z',
      assistantTimestamp: '2026-04-14T11:00:05.000Z',
      summary: 'Summary title',
      lastPrompt: 'Latest active task',
      mtime: new Date('2026-04-14T11:01:00.000Z'),
    });

    const selector = new SessionSelector(config);
    const [session] = await selector.listSessions();

    expect(session).toMatchObject({
      displayName: 'Latest active task',
      summary: 'Summary title',
      lastPrompt: 'Latest active task',
    });
  });

  it('finds transcript sessions by uuid and index', async () => {
    await writeTranscriptSession('session-a', {
      userText: 'Older session',
      assistantText: 'Older reply',
      userTimestamp: '2026-04-14T09:00:00.000Z',
      assistantTimestamp: '2026-04-14T09:00:05.000Z',
      mtime: new Date('2026-04-14T09:01:00.000Z'),
    });
    await writeTranscriptSession('session-b', {
      userText: 'Newer session',
      assistantText: 'Newer reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
      mtime: new Date('2026-04-14T10:01:00.000Z'),
    });

    const selector = new SessionSelector(config);

    const byUuid = await selector.findSession('session-b');
    expect(byUuid.id).toBe('session-b');

    const byIndex = await selector.findSession('1');
    expect(byIndex.id).toBe('session-b');
  });

  it('resolves the most recent transcript session and a specific transcript session', async () => {
    await writeTranscriptSession('session-1', {
      userText: 'Older session',
      assistantText: 'Older reply',
      userTimestamp: '2026-04-14T09:00:00.000Z',
      assistantTimestamp: '2026-04-14T09:00:05.000Z',
      mtime: new Date('2026-04-14T09:01:00.000Z'),
    });
    await writeTranscriptSession('session-2', {
      userText: 'Latest session',
      assistantText: 'Latest reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
      mtime: new Date('2026-04-14T10:01:00.000Z'),
    });

    const selector = new SessionSelector(config);

    const legacyResolve = vi.spyOn(
      TranscriptRepository.prototype,
      'resolveSession',
    );
    const latest = await selector.resolveLatestSession();
    expect(legacyResolve).not.toHaveBeenCalled();
    legacyResolve.mockRestore();
    expect(latest.sessionInfo.id).toBe('session-2');
    expect(latest.displayInfo).toContain('Latest session');
    expect(latest.messages?.map((message) => message.type)).toEqual([
      'user',
      'assistant',
    ]);

    latest.resumeAttempt?.finish();
    const exact = await selector.resolveSession('session-1');
    exact.resumeAttempt?.finish();
    expect(exact.sessionInfo.id).toBe('session-1');
  });

  it('cancels a queued selected-session read and leaves the next resume usable', async () => {
    await writeTranscriptSession('queued-session', {
      userText: 'Queued history',
      assistantText: 'Reply',
      userTimestamp: '2026-04-14T10:00:00.000Z',
      assistantTimestamp: '2026-04-14T10:00:05.000Z',
    });
    const selector = new SessionSelector(config);
    const {
      current: [session],
    } = await selector.listSessionScopes();
    const blocker = await beginResumeRead();
    const controller = new AbortController();
    let enteredQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      enteredQueue = resolve;
    });
    const addListener = controller.signal.addEventListener.bind(
      controller.signal,
    );
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation(
      (...args) => {
        addListener(...args);
        if (args[0] === 'abort') enteredQueue();
      },
    );
    const pending = selector.resolveSelectedSession(
      session!,
      controller.signal,
    );
    const rejected = pending.catch(() => undefined);
    try {
      await queued;
      controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
    } finally {
      blocker.finish();
      await rejected;
    }
    const next = await selector.resolveSelectedSession(session!);
    try {
      expect(next.messages).toHaveLength(2);
      next.resumeAttempt?.check();
    } finally {
      next.resumeAttempt?.finish();
    }
  });

  it('throws transcript-backed session errors', async () => {
    const selector = new SessionSelector(config);

    await expect(selector.resolveLatestSession()).rejects.toMatchObject({
      code: 'NO_SESSIONS_FOUND',
    });

    await writeTranscriptSession('session-1', {
      userText: 'Only session',
      assistantText: 'Only reply',
      userTimestamp: '2026-04-14T09:00:00.000Z',
      assistantTimestamp: '2026-04-14T09:00:05.000Z',
      mtime: new Date('2026-04-14T09:01:00.000Z'),
    });

    await expect(selector.resolveSession('missing')).rejects.toMatchObject({
      code: 'INVALID_SESSION_IDENTIFIER',
      message: expect.stringContaining('Invalid session identifier "missing"'),
    });

    await expect(selector.resolveSession('latest')).rejects.toMatchObject({
      code: 'INVALID_SESSION_IDENTIFIER',
      message: expect.stringContaining('Invalid session identifier "latest"'),
    });
  });
});

describe('extractFirstUserMessage', () => {
  it('prefers the first non-command user message', () => {
    const messages = [
      makeUserMessage(
        'session-1',
        '/resume latest',
        '2026-04-14T10:00:00.000Z',
      ),
      makeUserMessage('session-1', 'Hello world', '2026-04-14T10:01:00.000Z'),
    ];

    expect(extractFirstUserMessage(messages)).toBe('Hello world');
  });

  it('skips hidden, transcript-only, compact-summary, and tool-result messages', () => {
    const toolResultMessage: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-14T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
      sourceToolAssistantUUID: 'assistant-1',
    };

    expect(
      extractFirstUserMessage([
        {
          ...makeUserMessage(
            'session-1',
            'hidden prompt',
            '2026-04-14T09:59:00.000Z',
          ),
          isMeta: true,
        },
        {
          ...makeUserMessage(
            'session-1',
            'transcript only',
            '2026-04-14T09:59:30.000Z',
          ),
          isVisibleInTranscriptOnly: true,
        },
        {
          ...makeUserMessage(
            'session-1',
            'summary text',
            '2026-04-14T09:59:45.000Z',
          ),
          isCompactSummary: true,
        },
        toolResultMessage,
        makeUserMessage(
          'session-1',
          'Visible prompt',
          '2026-04-14T10:01:00.000Z',
        ),
      ]),
    ).toBe('Visible prompt');
  });

  it('treats mixed tool-result and text messages as meaningful prompts', () => {
    const mixedMessage: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-14T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'ok',
            is_error: false,
          },
          {
            type: 'text',
            text: 'Visible prompt',
          },
        ],
      },
      sourceToolAssistantUUID: 'assistant-1',
    };

    expect(extractFirstUserMessage([mixedMessage])).toBe('Visible prompt');
  });

  it('falls back to slash commands or empty conversation', () => {
    expect(
      extractFirstUserMessage([
        makeUserMessage('session-1', '/help', '2026-04-14T10:00:00.000Z'),
      ]),
    ).toBe('/help');

    expect(extractFirstUserMessage([])).toBe('Empty conversation');
  });
});

describe('formatRelativeTime', () => {
  it('formats long and short relative times', () => {
    vi.useFakeTimers();
    const now = new Date('2026-04-14T12:00:00.000Z');
    vi.setSystemTime(now);

    expect(formatRelativeTime('2026-04-14T11:55:00.000Z')).toBe(
      '5 minutes ago',
    );
    expect(formatRelativeTime('2026-04-14T10:00:00.000Z')).toBe('2 hours ago');
    expect(formatRelativeTime('2026-04-13T12:00:00.000Z')).toBe('1 day ago');
    expect(formatRelativeTime('2026-04-14T12:00:00.000Z')).toBe('Just now');
    expect(formatRelativeTime('2026-04-14T11:55:00.000Z', 'short')).toBe('5m');
    expect(formatRelativeTime('2026-04-14T11:59:45.000Z', 'short')).toBe('15s');
    expect(
      formatRelativeTime('2026-04-14T10:00:00.000Z', 'long', 'zh-CN'),
    ).toBe('2小时前');
    expect(
      formatRelativeTime('2026-04-14T10:00:00.000Z', 'short', 'zh-CN'),
    ).toBe('2小时');

    vi.useRealTimers();
  });
});

describe('convertMessagesToHistoryFormats', () => {
  function makeApiErrorAssistant(
    uuid = 'synthetic-api-error',
  ): AssistantMessage {
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Session blocked',
      type: 'provider_error',
    });
    return {
      type: 'assistant',
      uuid,
      timestamp: '2026-07-20T07:47:05.675Z',
      message: {
        id: `${uuid}-message`,
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,

        model: '<synthetic>',
        stop_reason: null,

        content: [
          {
            type: 'text',
            text: `Qoder API error: REQUESTED_RANGE_NOT_SATISFIABLE - ${body}`,
          },
        ],
      },
      isApiErrorMessage: true,
      error: 'unknown',
    };
  }

  function makeToolUseAssistant(
    toolUses: Array<{
      id: string;
      name: string;
      input: unknown;
    }>,
  ): AssistantMessage {
    return {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: '2026-04-14T10:00:00.000Z',
      message: {
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,

        model: 'test-model',
        stop_reason: 'tool_use',

        usage: { ...cloneUsage(), input_tokens: 1, output_tokens: 2 },
        content: toolUses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        })),
      },
    };
  }

  it('derives stable transcript identities from message UUIDs', () => {
    const first = makeToolUseAssistant([
      { id: 'tool-a', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
    first.uuid = 'assistant-a';
    const second = makeToolUseAssistant([
      { id: 'tool-b', name: 'Read', input: { file_path: 'b.ts' } },
    ]);
    second.uuid = 'assistant-b';

    const initial = convertMessagesToIdentifiedHistoryFormats([first]);
    const appended = convertMessagesToIdentifiedHistoryFormats([first, second]);

    expect(initial.uiHistory.map((item) => item.renderKey)).toEqual([
      'assistant-a:0',
    ]);
    expect(appended.uiHistory.map((item) => item.renderKey)).toEqual([
      'assistant-a:0',
      'assistant-b:0',
    ]);
  });

  it('restores the background marker for legacy Bash tool input', () => {
    const message = makeToolUseAssistant([
      {
        id: 'tool-background',
        name: 'Bash',
        input: {
          command: 'npm test',
          description: 'Run tests',
          is_background: true,
        },
      },
    ]);

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    const toolGroup = uiHistory.find((item) => item.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup?.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup.tools[0]).toEqual(
      expect.objectContaining({
        name: 'Bash',
        description: 'Run tests [background]',
      }),
    );
  });

  it('renders an orphaned synthetic API error as a formatted error', () => {
    const { uiHistory } = convertMessagesToHistoryFormats([
      makeApiErrorAssistant(),
    ]);

    expect(uiHistory).toHaveLength(1);
    expect(uiHistory[0]).toEqual(expect.objectContaining({ type: 'error' }));
    expect(uiHistory[0]).not.toEqual(
      expect.objectContaining({ type: 'gemini' }),
    );
    const errorItem = uiHistory[0];
    if (errorItem?.type !== 'error') throw new Error('Expected error item');
    expect(errorItem.text).not.toContain('Qoder API error:');
    expect(errorItem).not.toHaveProperty('excludedFromContext');
  });

  it('restores the prepared Custom Provider authentication message', () => {
    const synthetic = makeApiErrorAssistant();
    synthetic.displayErrorCode = 100401;
    synthetic.errorFallbackMessage =
      'Authentication to the custom model service failed. Please check its credentials.';
    const restored = JSON.parse(JSON.stringify(synthetic)) as AssistantMessage;
    const { uiHistory } = convertMessagesToHistoryFormats([restored]);
    expect(uiHistory).toEqual([
      expect.objectContaining({
        type: 'error',
        text: synthetic.errorFallbackMessage,
      }),
    ]);
  });

  it.each([
    { code: '401', status: 401, providerSource: 'custom-provider', expected: 'credentials' },
    {
      code: 'invalid_api_key',
      status: undefined,
      providerSource: 'custom-provider',
      expected: 'credentials',
    },
    { code: undefined, status: 401, providerSource: 'custom-provider', expected: 'credentials' },
    { code: '403', status: 403, providerSource: 'custom-provider', expected: 'permissions' },
    { code: '401', status: 401, providerSource: 'qoder', expected: 'sign in again' },
  ])(
    'restores original auth code $code (provider=$providerSource)',
    ({ code, status, providerSource, expected }) => {
      const synthetic = makeApiErrorAssistant();
      synthetic.displayErrorCode = code;
      synthetic.errorFallbackMessage = 'private provider diagnostic';
      synthetic.modelError = { kind: 'auth', status, providerSource };
      const restored = JSON.parse(
        JSON.stringify(synthetic),
      ) as AssistantMessage;
      const { uiHistory } = convertMessagesToHistoryFormats([restored]);
      expect(uiHistory).toHaveLength(1);
      expect(uiHistory[0]).toEqual(
        expect.objectContaining({
          type: 'error',
          text: expect.stringContaining(expected),
        }),
      );
      expect(restored.displayErrorCode).toBe(code);
    },
  );

  it('uses persisted display metadata without relying on adjacent messages', () => {
    const synthetic = makeApiErrorAssistant();
    synthetic.displayErrorCode = 'missing.dynamic.error.code';
    synthetic.errorFallbackMessage = 'Persisted user-facing fallback';

    const { uiHistory } = convertMessagesToIdentifiedHistoryFormats([
      synthetic,
    ]);

    expect(uiHistory).toHaveLength(1);
    expect(uiHistory[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        renderKey: 'synthetic-api-error:0',
      }),
    );
    const errorItem = uiHistory[0];
    if (errorItem?.type !== 'error') throw new Error('Expected error item');
    expect(errorItem.text).toBe('Persisted user-facing fallback');
  });

  it.each([
    { providerSource: 'qoder', kind: 'quota_exhausted', expected: 'Billing Group' },
    { providerSource: 'custom-provider', kind: 'auth', expected: 'permissions' },
    { providerSource: 'qwen-subscription', kind: 'auth', expected: 'permissions' },
    { providerSource: undefined, kind: 'quota_exhausted', expected: 'provider usage and limits' },
  ] as const)(
    'restores HTTP 403/code 122 using the recorded provider (provider=$providerSource)',
    ({ providerSource, kind, expected }) => {
      const synthetic = makeApiErrorAssistant();
      synthetic.displayErrorCode = '122';
      // Older records can still contain the boolean. Rendering uses only the source.
      const legacyMetadata = providerSource === undefined ? { isCustomProvider: false } : {};
      synthetic.modelError = { ...legacyMetadata, kind, status: 403, providerSource };
      const restored = JSON.parse(JSON.stringify(synthetic)) as AssistantMessage;

      expect(convertMessagesToHistoryFormats([restored]).uiHistory).toEqual([
        expect.objectContaining({
          type: 'error',
          text: expect.stringContaining(expected),
        }),
      ]);
    },
  );

  it('renders persisted Provider failures using the original code and safe UI fallback', () => {
    const synthetic = makeApiErrorAssistant();
    synthetic.message.content = [
      { type: 'text', text: 'private provider diagnostic' },
    ];
    synthetic.modelError = { kind: 'invalid_request' };
    synthetic.displayErrorCode = '140';
    synthetic.errorFallbackMessage = 'private provider diagnostic';
    const { uiHistory } = convertMessagesToHistoryFormats([synthetic]);
    expect(uiHistory).toEqual([
      expect.objectContaining({
        type: 'error',
        text: 'The model service rejected this request. Please check the request and try again.',
      }),
    ]);
  });

  it('restores the existing message-based quota classification', () => {
    const synthetic = makeApiErrorAssistant();
    synthetic.message.content = [
      { type: 'text', text: 'User quota exhausted' },
    ];
    synthetic.modelError = { kind: 'quota_exhausted', providerSource: 'qoder' };
    synthetic.displayErrorCode = 'insufficient_quota';
    const { uiHistory } = convertMessagesToHistoryFormats([synthetic]);
    expect(uiHistory).toEqual([
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('check your quota'),
      }),
    ]);
  });

  it.each([
    {
      code: 'insufficient_quota',
      modelError: { kind: 'quota_exhausted' as const, status: 429, providerSource: 'qoder' },
      expected:
        'The usage limit has been reached. Please check your quota and try again later.',
    },
    {
      code: 'rate_limit_error',
      modelError: { kind: 'rate_limited' as const, status: 429, providerSource: 'qoder' },
      expected:
        'The usage limit has been reached. Please check your quota and try again later.',
    },
    {
      code: undefined,
      modelError: { kind: 'server' as const, status: 503 },
      expected:
        'The model service is temporarily unavailable. Please try again later.',
    },
    {
      code: 'network_failure',
      modelError: {
        kind: 'network' as const,
        causeCodes: ['network_failure', 'ETIMEDOUT'],
      },
      expected: 'The model service did not respond in time. Please try again.',
    },
    {
      code: 'empty_assistant_completion',
      modelError: {
        kind: 'unknown' as const,
        emptyCompletionReason: 'reasoning_only' as const,
      },
      expected:
        'The model finished its reasoning but returned no answer or tool call. Please try again or switch models.',
    },
    {
      code: 'network_failure',
      modelError: {
        kind: 'network' as const,
        causeCodes: ['network_failure', 'UND_ERR_SOCKET'],
      },
      expected:
        'The connection to the model service was interrupted. Please try again.',
    },
  ])(
    'preserves specialized resumed Provider text for $code',
    ({ code, modelError, expected }) => {
      const synthetic = makeApiErrorAssistant();
      synthetic.modelError = modelError;
      synthetic.displayErrorCode = code;
      synthetic.errorFallbackMessage = 'private provider diagnostic';
      const { uiHistory } = convertMessagesToHistoryFormats([synthetic]);
      expect(uiHistory).toEqual([
        expect.objectContaining({ type: 'error', text: expected }),
      ]);
    },
  );

  it('renders a resumed content-filter replacement as an error', () => {
    const replacement = makeApiErrorAssistant('content-filtered-message');
    replacement.isApiErrorMessage = false;
    replacement.isContentFilteredMessage = true;
    replacement.displayErrorCode = 'missing.dynamic.error.code';
    replacement.errorFallbackMessage = 'Content-filtered fallback';
    replacement.message = {
      ...replacement.message,
      content: [{ type: 'text', text: 'Previously rendered dynamic text' }],
    };

    const { uiHistory } = convertMessagesToHistoryFormats([replacement]);

    expect(uiHistory).toEqual([
      {
        type: 'error',
        text: 'Content-filtered fallback',
        excludedFromContext: true,
      },
    ]);
  });

  it('normalizes malformed tool input when rendering resumed tool calls', () => {
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: 'toolu_missing', name: 'Read', input: undefined },
        { id: 'toolu_null', name: 'Read', input: null },
        { id: 'toolu_string', name: 'Read', input: '{"file_path":"a.ts"}' },
        { id: 'toolu_array', name: 'Read', input: ['file_path', 'a.ts'] },
      ]),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup?.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup.tools).toHaveLength(4);
    expect(toolGroup.tools.map((tool) => tool.args)).toEqual([{}, {}, {}, {}]);
    expect(toolGroup.tools.map((tool) => tool.description)).toEqual([
      '',
      '',
      '',
      '',
    ]);
  });

  function makeToolResultUser(
    results: Array<{
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }>,
    toolUseResult: unknown,
  ): UserMessage {
    return {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-14T10:00:01.000Z',
      message: {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        })),
      },
      toolUseResult,
    };
  }

  it('restores tool result displays from persisted toolUseResult on single tool call', () => {
    const toolId = 'toolu_single';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Bash', input: { command: 'ls' } },
      ]),
      makeToolResultUser(
        [
          {
            tool_use_id: toolId,
            content: 'file1.ts\nfile2.ts',
            is_error: false,
          },
        ],
        { stdout: 'file1.ts\nfile2.ts', stderr: '', interrupted: false },
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    expect(toolGroup!.type).toBe('tool_group');
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools).toHaveLength(1);
    expect(toolGroup!.tools[0].resultDisplay).toBe('file1.ts\nfile2.ts');
    expect(toolGroup!.tools[0].status).toBe(CoreToolCallStatus.Success);
  });

  it('restores the refusal unknown payload without exposing model-only guidance', () => {
    const toolId = 'toolu_refusal_unknown';
    const unknownDisplay = {
      summary: 'Tool execution status unknown',
      payload:
        'The model response ended in refusal before the tool result could be confirmed.',
    };
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Bash', input: { command: 'deploy' } },
      ]),
      makeToolResultUser(
        [
          {
            tool_use_id: toolId,
            content: 'model-only recovery guidance',
            is_error: true,
          },
        ],
        unknownDisplay,
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((item) => item.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup?.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup.tools[0]).toMatchObject({
      callId: toolId,
      status: CoreToolCallStatus.Error,
      resultDisplay: unknownDisplay,
    });
    expect(JSON.stringify(toolGroup)).not.toContain(
      'model-only recovery guidance',
    );
  });

  it('does not restore ToolResult returnDisplay from persisted toolUseResult', () => {
    const toolId = 'toolu_read_structured';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Read', input: { file_path: 'src/app.ts' } },
      ]),
      makeToolResultUser(
        [
          {
            tool_use_id: toolId,
            content: 'file content for the model',
            is_error: false,
          },
        ],
        {
          llmContent: 'file content for the model',
          returnDisplay: 'Read 42 lines',
        },
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools[0].status).toBe(CoreToolCallStatus.Success);
    expect(toolGroup!.tools[0].resultDisplay).toBeUndefined();
  });

  it('restores structured toolUseResult without stored display output', () => {
    const toolId = 'toolu_write_structured';
    const fileDiff = {
      fileDiff: '--- a/app.ts\n+++ b/app.ts\n@@\n+export const x = 1;\n',
      fileName: 'app.ts',
      filePath: '/tmp/src/app.ts',
      originalContent: null,
      newContent: 'export const x = 1;\n',
    };
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        {
          id: toolId,
          name: 'Write',
          input: { file_path: 'src/app.ts', content: 'export const x = 1;\n' },
        },
      ]),
      makeToolResultUser(
        [
          {
            tool_use_id: toolId,
            content: 'File created successfully at: /tmp/src/app.ts',
            is_error: false,
          },
        ],
        fileDiff,
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools[0].status).toBe(CoreToolCallStatus.Success);
    expect(toolGroup!.tools[0].resultDisplay).toEqual(fileDiff);
  });

  it('reconstructs display names and descriptions for resumed compact tools', () => {
    const writeToolId = 'toolu_write';
    const globToolId = 'toolu_glob';
    const grepToolId = 'toolu_grep';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        {
          id: writeToolId,
          name: 'Write',
          input: {
            file_path: 'src/app.ts',
            content: 'export const answer = 42;\n',
          },
        },
        {
          id: globToolId,
          name: 'Glob',
          input: { pattern: '**/*.ts', path: 'src' },
        },
        {
          id: grepToolId,
          name: 'Grep',
          input: { pattern: 'answer', path: 'src', glob: '*.ts' },
        },
      ]),
      makeToolResultUser(
        [
          {
            tool_use_id: writeToolId,
            content: 'File created successfully at: /tmp/src/app.ts',
            is_error: false,
          },
          {
            tool_use_id: globToolId,
            content: 'src/app.ts',
            is_error: false,
          },
          {
            tool_use_id: grepToolId,
            content: 'src/app.ts:1:export const answer = 42;',
            is_error: false,
          },
        ],
        [
          {
            fileDiff:
              '--- a/app.ts\n+++ b/app.ts\n@@\n+export const answer = 42;\n',
            fileName: 'app.ts',
            filePath: '/tmp/src/app.ts',
            originalContent: null,
            newContent: 'export const answer = 42;\n',
          },
          'Found 1 matching file(s)',
          {
            mode: 'content',
            numFiles: 0,
            filenames: [],
            content: 'src/app.ts:1:export const answer = 42;',
            numLines: 1,
            matches: [
              {
                filePath: 'src/app.ts',
                absolutePath: '/tmp/src/app.ts',
                lineNumber: 1,
                line: 'export const answer = 42;',
              },
            ],
          },
        ],
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup?.type !== 'tool_group') throw new Error('unreachable');

    expect(toolGroup.tools).toHaveLength(3);
    expect(toolGroup.tools[0]).toEqual(
      expect.objectContaining({
        name: WRITE_FILE_DISPLAY_NAME,
        description: 'src/app.ts',
      }),
    );
    expect(toolGroup.tools[1]).toEqual(
      expect.objectContaining({
        name: GLOB_DISPLAY_NAME,
        description: "'**/*.ts' within src",
      }),
    );
    expect(toolGroup.tools[2]).toEqual(
      expect.objectContaining({
        name: GREP_DISPLAY_NAME,
        description: "'answer' in *.ts within src",
      }),
    );
  });

  it('restores tool result displays for multiple parallel tool calls', () => {
    const id1 = 'toolu_a';
    const id2 = 'toolu_b';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: id1, name: 'Read', input: { file_path: 'a.ts' } },
        { id: id2, name: 'Read', input: { file_path: 'b.ts' } },
      ]),
      makeToolResultUser(
        [
          { tool_use_id: id1, content: 'content-a', is_error: false },
          { tool_use_id: id2, content: 'content-b', is_error: true },
        ],
        ['display-a', 'display-b'],
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools).toHaveLength(2);
    expect(toolGroup!.tools[0].resultDisplay).toBeUndefined();
    expect(toolGroup!.tools[0].status).toBe(CoreToolCallStatus.Success);
    expect(toolGroup!.tools[1].resultDisplay).toBe('content-b');
    expect(toolGroup!.tools[1].status).toBe(CoreToolCallStatus.Error);
  });

  it('keeps sparse parallel tool result displays aligned by position', () => {
    const id1 = 'toolu_sparse_a';
    const id2 = 'toolu_sparse_b';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: id1, name: 'Read', input: { file_path: 'a.ts' } },
        { id: id2, name: 'Read', input: { file_path: 'b.ts' } },
      ]),
      makeToolResultUser(
        [
          { tool_use_id: id1, content: 'content-a', is_error: false },
          { tool_use_id: id2, content: 'content-b', is_error: false },
        ],
        [undefined, 'display-b'],
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup?.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup.tools).toHaveLength(2);
    expect(toolGroup.tools[0].resultDisplay).toBeUndefined();
    expect(toolGroup.tools[1].resultDisplay).toBeUndefined();
  });

  it('handles missing toolUseResult gracefully', () => {
    const toolId = 'toolu_no_result';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Bash', input: { command: 'echo hi' } },
      ]),
      // User message with tool_result but no toolUseResult field
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-14T10:00:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolId,
              content: 'hi',
              is_error: false,
            },
          ],
        },
      } satisfies UserMessage,
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools[0].resultDisplay).toBeUndefined();
  });

  it('uses tool_result content for errors without structured toolUseResult', () => {
    const toolId = 'toolu_error_content';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Read', input: { file_path: 'missing.ts' } },
      ]),
      makeToolResultUser(
        [{ tool_use_id: toolId, content: 'File not found.', is_error: true }],
        undefined,
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const toolGroup = uiHistory.find((h) => h.type === 'tool_group');

    expect(toolGroup).toBeDefined();
    if (toolGroup!.type !== 'tool_group') throw new Error('unreachable');
    expect(toolGroup!.tools[0].status).toBe(CoreToolCallStatus.Error);
    expect(toolGroup!.tools[0].resultDisplay).toBe('File not found.');
  });

  it('does not emit user items for tool_result messages', () => {
    const toolId = 'toolu_skip';
    const messages: RuntimeMessage[] = [
      makeToolUseAssistant([
        { id: toolId, name: 'Read', input: { file_path: 'x.ts' } },
      ]),
      makeToolResultUser(
        [{ tool_use_id: toolId, content: 'content', is_error: false }],
        'display-content',
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    const userItems = uiHistory.filter((h) => h.type === 'user');
    expect(userItems).toHaveLength(0);
  });

  it('hides meta and transcript-only messages from default history rendering', () => {
    const messages = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:00.000Z',
        message: {
          role: 'user',
          content: 'meta payload',
        },
        isMeta: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:01.000Z',
        message: {
          role: 'user',
          content: 'transcript-only payload',
        },
        isVisibleInTranscriptOnly: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:02.000Z',
        message: {
          role: 'user',
          content: 'visible payload',
        },
      },
    ] as RuntimeMessage[];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    expect(uiHistory).toEqual([{ type: 'user', text: 'visible payload' }]);
  });

  it('hides meta local command output user messages from default history rendering', () => {
    const messages: RuntimeMessage[] = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:00.000Z',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Model set to ultimate\n    (persisted)</local-command-stdout>',
        },
        isMeta: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:01.000Z',
        message: {
          role: 'user',
          content: 'visible payload',
        },
      },
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    expect(uiHistory).toEqual([{ type: 'user', text: 'visible payload' }]);
  });

  it('hides meta bash transcript user messages from default history rendering', () => {
    const messages: RuntimeMessage[] = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:00.000Z',
        message: {
          role: 'user',
          content: '<bash-input>pwd</bash-input>',
        },
        isMeta: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:01.000Z',
        message: {
          role: 'user',
          content:
            '<bash-stdout>/tmp/project</bash-stdout><bash-stderr></bash-stderr>',
        },
        isMeta: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:02.000Z',
        message: {
          role: 'user',
          content: 'visible payload',
        },
      },
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    expect(uiHistory).toEqual([{ type: 'user', text: 'visible payload' }]);
  });

  it('hides meta image-only user messages from default history rendering', () => {
    const messages: RuntimeMessage[] = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
        isMeta: true,
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:01.000Z',
        message: {
          role: 'user',
          content: 'visible payload',
        },
      },
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    expect(uiHistory).toEqual([{ type: 'user', text: 'visible payload' }]);
  });

  it('renders restored user text blocks back into UI history', () => {
    const messages: RuntimeMessage[] = [
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: '2026-04-18T05:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hihi',
            },
          ],
        },
      } satisfies UserMessage,
      makeAssistantMessage(
        'legacy-session',
        'hihi! 有什么可以帮你的吗？',
        '2026-04-18T05:00:01.000Z',
      ),
    ];

    const { uiHistory } = convertMessagesToHistoryFormats(messages);
    expect(uiHistory).toEqual([
      { type: 'user', text: 'hihi' },
      { type: 'gemini', text: 'hihi! 有什么可以帮你的吗？' },
    ]);
  });

  it('renders local_command system messages back as user-typed slash commands', () => {
    const message: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      subtype: 'local_command',
      level: 'info',
      content:
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([{ type: 'user', text: '/compact' }]);
  });

  it('renders command XML user messages back as user-typed slash commands', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      message: {
        role: 'user',
        content:
          '<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>',
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([{ type: 'user', text: '/status' }]);
  });

  it('renders user input after session-start hook context on resume', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-05-14T06:00:41.419Z',
      message: {
        role: 'user',
        content:
          '<hook_context>[安全会话] 会话已启动，所有操作将被审计记录\n[安全策略] 禁止执行涉及生产环境数据库的写操作</hook_context>\n\n用write工具创建一个文件test.txt，写入 123456789876543210.',
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([
      {
        type: 'user',
        text: '用write工具创建一个文件test.txt，写入 123456789876543210.',
      },
    ]);
  });

  it('preserves multiline user input formatting after resume', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-05-14T07:04:12.957Z',
      message: {
        role: 'user',
        content:
          '依次调用内置工具\n内置工具\n\n   - Read - 读取文件内容\n   - Write - 创建/覆盖文件\n   - Edit - 编辑文件内容',
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);

    expect(uiHistory).toEqual([
      {
        type: 'user',
        text: '依次调用内置工具\n内置工具\n\n   - Read - 读取文件内容\n   - Write - 创建/覆盖文件\n   - Edit - 编辑文件内容',
      },
    ]);
  });

  it('renders stream interruption user markers as resume cancellation info', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: INTERRUPT_MESSAGE }],
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([{ type: 'info', text: 'Request cancelled.' }]);
  });

  it('does not render tool-use interruption markers as standalone resume items', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }],
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([]);
  });

  it('does not render unknown internal XML user messages as raw text', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      message: {
        role: 'user',
        content: '<internal-metadata>hidden</internal-metadata>',
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([]);
  });

  it('preserves command args when rendering local_command back', () => {
    const message: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      subtype: 'local_command',
      level: 'info',
      content:
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>efficient</command-args>',
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([{ type: 'user', text: '/model efficient' }]);
  });

  it('strips the local-command-stdout wrapper from local_command_output', () => {
    const message: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      subtype: 'local_command_output',
      level: 'info',
      content:
        '<local-command-stdout>Compacted (ctrl+o…)</local-command-stdout>',
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([{ type: 'info', text: 'Compacted (ctrl+o…)' }]);
  });

  it('skips transcript-only system metadata without display content', () => {
    const message = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      subtype: 'turn_duration',
      durationMs: 338002,
      messageCount: 163,
    } as unknown as SystemMessage;

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([]);
  });

  it('skips unknown top-level transcript events and continues converting later messages', () => {
    const unknownMessage = {
      type: 'external_event',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      payload: { event: 'metadata-only' },
    } as unknown as RuntimeMessage;
    const userMessage: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:01.000Z',
      message: {
        role: 'user',
        content: 'continue after unknown event',
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([
      unknownMessage,
      userMessage,
    ]);
    expect(uiHistory).toEqual([
      { type: 'user', text: 'continue after unknown event' },
    ]);
  });

  it('renders compact_boundary as a structured compression item, not raw text', () => {
    const message: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-04-18T05:00:00.000Z',
      subtype: 'compact_boundary',
      level: 'info',
      content: 'Conversation compacted',
      isCompactSummary: true,
      compactMetadata: {
        trigger: 'manual',
        preTokens: 70884,
        postTokens: 1082,
        messagesSummarized: 165,
      },
    };

    const { uiHistory } = convertMessagesToHistoryFormats([message]);
    expect(uiHistory).toEqual([
      {
        type: 'compression',
        compression: {
          isPending: false,
          originalTokenCount: 70884,
          newTokenCount: 1082,
          compressionStatus: CompressionStatus.COMPRESSED,
          trigger: 'manual',
        },
      },
    ]);
  });
});

describe('MCP original names after resume', () => {
  it.each(['mcp__demo__u_611aec98eddc', 'mcp_call'])(
    'renders %s from the persisted identity without an MCP connection',
    (name) => {
      const assistant = makeAssistantMessage(
        'session',
        '',
        new Date().toISOString(),
      );
      assistant.message = {
        ...assistant.message,
        content: [
          {
            type: 'tool_use',
            id: 'mcp-call',
            mcpInfo: { serverName: '转换服务', toolName: '文档格式转换_查询' },
            name,
            input:
              name === 'mcp_call'
                ? {
                    toolName: 'mcp__demo__u_611aec98eddc',
                    arguments: { id: 'demo-001' },
                  }
                : { id: 'demo-001' },
          },
        ],
      };
      expect(assistant).not.toHaveProperty('mcpToolIdentities');
      expect(assistant.message.content[0]).toHaveProperty('mcpInfo');
      const { uiHistory } = convertMessagesToHistoryFormats(
        JSON.parse(JSON.stringify([assistant])),
      );
      expect(uiHistory).toContainEqual(
        expect.objectContaining({
          type: 'tool_group',
          tools: [
            expect.objectContaining({
              callId: 'mcp-call',
              name: '文档格式转换_查询 (转换服务 MCP Server)',
              description: expect.stringContaining('demo-001'),
            }),
          ],
        }),
      );
    },
  );
});
