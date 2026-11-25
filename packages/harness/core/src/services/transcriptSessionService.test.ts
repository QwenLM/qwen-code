/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../config/brand.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listTranscriptSessions,
  resolveLatestTranscriptSession as resolveLatestTranscriptSessionForRead,
  resolveTranscriptSession as resolveTranscriptSessionForRead,
} from './transcriptSessionService.js';
import { createTestTranscriptWriter } from './transcript/testing/fixtures.js';
import { EntryScanner } from './transcript/scanner.js';
import { getSessionTranscriptPath } from './transcript-paths.js';
import type {
  RuntimeConfigEntry,
  TranscriptMessage,
} from '../protocol/transcript/entry.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';
import { beginResumeRead } from './transcript/resume-read-budget.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof fs>(),
}));

let tempHomeDir: string;

async function resolveTranscriptSession(...args: Parameters<typeof resolveTranscriptSessionForRead>) {
  const result = await resolveTranscriptSessionForRead(...args);
  result.resumeAttempt?.finish();
  return result;
}

async function resolveLatestTranscriptSession(...args: Parameters<typeof resolveLatestTranscriptSessionForRead>) {
  const result = await resolveLatestTranscriptSessionForRead(...args);
  result.resumeAttempt?.finish();
  return result;
}

beforeEach(async () => {
  tempHomeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'transcript-session-service-'),
  );
  vi.stubEnv('HOME', tempHomeDir);
  vi.stubEnv(ENV_CONFIG_DIR, tempHomeDir);
  _resetConfigHomeDirCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  _resetConfigHomeDirCache();
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

function makeUserMessage(
  sessionId: string,
  content: string,
  timestamp: string,
): TranscriptMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    cwd: '/workspace/demo',
    sessionId,
    userType: 'external',
    version: '1.0.0',
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
): TranscriptMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    cwd: '/workspace/demo',
    sessionId,
    userType: 'external',
    version: '1.0.0',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: randomUUID(),

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: {
        ...cloneUsage(),
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: content }],
    },
  };
}

function makeCompactBoundaryMessage(
  sessionId: string,
  timestamp: string,
): TranscriptMessage {
  return {
    type: 'system',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    cwd: '/workspace/demo',
    sessionId,
    userType: 'external',
    version: '1.0.0',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    isCompactSummary: true,
    compactMetadata: {
      trigger: 'manual',
      preTokens: 10,
      postTokens: 5,
      messagesSummarized: 1,
    },
  };
}

async function writeSession(
  projectRoot: string,
  sessionId: string,
  messages: TranscriptMessage[],
  options: {
    customTitle?: string;
    aiTitle?: string;
    summary?: string;
    lastPrompt?: string;
    directories?: string[];
    runtimeConfig?: Omit<
      RuntimeConfigEntry,
      'type' | 'sessionId' | 'timestamp'
    >;
    mtime?: Date;
  } = {},
) {
  const filePath = getSessionTranscriptPath(projectRoot, sessionId);
  const relativeTranscriptPath = path.relative(tempHomeDir, filePath);
  expect(relativeTranscriptPath).not.toBe('');
  expect(relativeTranscriptPath).not.toBe('..');
  expect(relativeTranscriptPath).not.toMatch(/^\.\.(?:[\\/]|$)/);
  expect(path.isAbsolute(relativeTranscriptPath)).toBe(false);
  const { writer } = await createTestTranscriptWriter({
    filePath,
    sessionId,
    cwd: projectRoot,
    entrypoint: 'cli',
    userType: 'external',
    version: '1.0.0',
    flushIntervalMs: 0,
  });

  const leafUuid = await writer.recordMessages(messages);
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
  if (options.runtimeConfig) {
    await writer.recordRuntimeConfig(options.runtimeConfig);
  }
  await writer.close();

  if (options.mtime) {
    await fs.utimes(filePath, options.mtime, options.mtime);
  }

  return filePath;
}

describe('transcriptSessionService', () => {
  it('fails bounded resume discovery rather than filtering over-budget candidates and changing selection', async () => {
    const projectRoot = '/workspace/bounded-catalog';
    for (const id of ['first', 'second', 'third']) {
      await writeSession(projectRoot, id, [makeUserMessage(id, 'prompt', '2026-01-01T00:00:00Z')]);
    }
    const attempt = await beginResumeRead({ limits: { maxStructureEntries: 2 } });
    try {
      await expect(listTranscriptSessions(projectRoot, undefined, {
        lightweight: true, forResume: true, resumeAttempt: attempt,
      })).rejects.toMatchObject({ reason: 'budget' });
    } finally {
      attempt.finish();
    }
    const next = await beginResumeRead();
    next.finish();
  });
  it('resumes an acknowledged empty session but excludes ordinary startup metadata', async () => {
    const projectRoot = path.join(tempHomeDir, 'empty-project');
    await fs.mkdir(projectRoot, { recursive: true });
    const sessionId = 'acknowledged-empty';
    const filePath = getSessionTranscriptPath(projectRoot, sessionId);
    const { writer, store } = await createTestTranscriptWriter({
      filePath,
      sessionId,
      cwd: projectRoot,
      entrypoint: 'acp',
      initialWorkspaceDirectories: [projectRoot],
    });
    await writer.recordWorktreeState(null);
    await writer.recordActiveLeaf(null, { explicit: true, durable: true });
    await writer.flush();
    await writer.close();
    await store.close();
    const ordinaryId = 'ordinary-startup';
    const ordinaryPath = getSessionTranscriptPath(projectRoot, ordinaryId);
    await fs.writeFile(
      ordinaryPath,
      JSON.stringify({
        type: 'worktree-state',
        sessionId: ordinaryId,
        worktreeSession: null,
      }) + '\n',
    );
    const resumed = await resolveTranscriptSession(projectRoot, sessionId);
    expect(resumed.messages).toEqual([]);
    expect(resumed.sessionInfo.id).toBe(sessionId);
    for (const lightweight of [false, true]) {
      const sessions = await listTranscriptSessions(projectRoot, undefined, {
        lightweight,
      });
      expect(sessions.map((session) => session.id)).toEqual([sessionId]);
    }
    await expect(
      resolveTranscriptSession(projectRoot, ordinaryId),
    ).rejects.toThrow();
  });

  it('lists transcript sessions and preserves title metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-a';
    await writeSession(
      projectRoot,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'first question',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(
          sessionId,
          'first answer',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      {
        customTitle: 'Custom transcript title',
        directories: ['/workspace/demo', '/workspace/lib'],
        mtime: new Date('2026-04-14T00:10:00.000Z'),
      },
    );

    const sessions = await listTranscriptSessions(projectRoot, sessionId, {
      includeFullContent: true,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      file: sessionId,
      fileName: `${sessionId}.jsonl`,
      displayName: 'Custom transcript title',
      firstUserMessage: 'first question',
      isCurrentSession: true,
      directories: ['/workspace/demo', '/workspace/lib'],
      messageCount: 2,
      lastUpdated: '2026-04-14T00:10:00.000Z',
    });
    expect(sessions[0].messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(sessions[0].fullContent).toContain('first answer');
  });

  it('projects the latest recorded git branch and transcript file size', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-metadata';
    const firstMessage = makeUserMessage(
      sessionId,
      'first question',
      '2026-04-14T00:00:00.000Z',
    );
    firstMessage.gitBranch = 'feature/old';
    const lastMessage = makeAssistantMessage(
      sessionId,
      'latest answer',
      '2026-04-14T00:00:05.000Z',
    );
    lastMessage.gitBranch = 'feature/latest';
    const filePath = await writeSession(projectRoot, sessionId, [
      firstMessage,
      lastMessage,
    ]);

    const [session] = await listTranscriptSessions(projectRoot);
    const fileStats = await fs.stat(filePath);

    expect(session.gitBranch).toBe('feature/latest');
    expect(session.fileSize).toBe(fileStats.size);
  });

  it('projects relocated cwd and active worktree state from transcript metadata', async () => {
    const projectRoot = '/workspace/demo';
    const worktreeRoot = '/workspace/demo-worktree';
    const worktreeCwd = '/workspace/demo-worktree/apps/desktop';
    const sessionId = 'session-worktree-metadata';
    const filePath = await writeSession(projectRoot, sessionId, [
      makeUserMessage(
        sessionId,
        'work in isolation',
        '2026-04-14T00:00:00.000Z',
      ),
    ]);
    const worktreeSession = {
      originalCwd: projectRoot,
      preEnterOriginalCwd: projectRoot,
      worktreePath: worktreeRoot,
      worktreeCwd,
      worktreeName: 'feature',
      worktreeBranch: 'worktree-feature',
      sessionId,
    };
    await fs.appendFile(
      filePath,
      [
        { type: 'relocated', sessionId, relocatedCwd: worktreeRoot },
        { type: 'worktree-state', sessionId, worktreeSession },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8',
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      cwd: worktreeCwd,
      gitBranch: 'worktree-feature',
      worktreeSession,
    });
  });

  it('treats persisted ai-title content as opaque metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-invalid-ai-title';
    const aiTitle =
      '<tool_call> <function=list_files> <path> .</path> </function> </tool_call>';
    await writeSession(
      projectRoot,
      sessionId,
      [
        makeUserMessage(sessionId, '看下项目结构', '2026-04-14T00:00:00.000Z'),
        makeAssistantMessage(
          sessionId,
          '项目结构如下',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      {
        aiTitle,
        lastPrompt: '看下项目结构',
      },
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      displayName: aiTitle,
      aiTitle,
      lastPrompt: '看下项目结构',
    });
  });

  it('keeps an explicit custom title ahead of opaque ai-title metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-protocol-shaped-custom-title';
    const customTitle = '<tool_call> investigation';
    await writeSession(
      projectRoot,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'Investigate protocol output',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(
          sessionId,
          'Investigation complete',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      {
        customTitle,
        aiTitle: '<tool_call> invalid generated title',
      },
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      displayName: customTitle,
      customTitle,
      aiTitle: '<tool_call> invalid generated title',
    });
  });

  it('prefers last prompt over summary for display name while preserving summary metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-last-prompt';
    await writeSession(
      projectRoot,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'initial prompt',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(
          sessionId,
          'initial answer',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      {
        summary: 'Initial summary',
        lastPrompt: 'latest direction',
        mtime: new Date('2026-04-14T00:10:00.000Z'),
      },
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      displayName: 'latest direction',
      summary: 'Initial summary',
      lastPrompt: 'latest direction',
    });
  });

  it('lists large compacted sessions from the active tail while retaining session metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-large-compact';
    const filePath = getSessionTranscriptPath(projectRoot, sessionId);
    const staleUser = makeUserMessage(
      sessionId,
      `stale-secret-${'x'.repeat(6 * 1024 * 1024)}`,
      '2026-04-14T00:00:00.000Z',
    );
    const boundary = makeCompactBoundaryMessage(
      sessionId,
      '2026-04-14T00:01:00.000Z',
    );
    boundary.logicalParentUuid = staleUser.uuid;
    const currentUser = makeUserMessage(
      sessionId,
      'current question',
      '2026-04-14T00:02:00.000Z',
    );
    currentUser.parentUuid = boundary.uuid;
    const currentAssistant = makeAssistantMessage(
      sessionId,
      'current answer',
      '2026-04-14T00:03:00.000Z',
    );
    currentAssistant.parentUuid = currentUser.uuid;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        {
          type: 'custom-title',
          sessionId,
          customTitle: 'Retained compact title',
        },
        staleUser,
        boundary,
        currentUser,
        currentAssistant,
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8',
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId, {
      includeFullContent: true,
    });

    expect(session).toMatchObject({
      id: sessionId,
      displayName: 'Retained compact title',
      customTitle: 'Retained compact title',
      firstUserMessage: 'current question',
    });
    expect(session?.fullContent).toContain('current answer');
    expect(session?.fullContent).not.toContain('stale-secret');
  });

  it('does not use internal XML user payloads as session titles', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-internal-payloads';
    await writeSession(projectRoot, sessionId, [
      makeUserMessage(
        sessionId,
        '<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>',
        '2026-04-14T00:00:00.000Z',
      ),
      makeUserMessage(
        sessionId,
        '<bash-stdout>internal command output</bash-stdout><bash-stderr></bash-stderr>',
        '2026-04-14T00:00:01.000Z',
      ),
      makeUserMessage(
        sessionId,
        'real follow-up prompt',
        '2026-04-14T00:00:02.000Z',
      ),
      makeAssistantMessage(sessionId, 'answer', '2026-04-14T00:00:03.000Z'),
    ]);

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      displayName: 'real follow-up prompt',
      firstUserMessage: 'real follow-up prompt',
      lastPrompt: 'real follow-up prompt',
    });
  });

  it('excludes command-only sessions while retaining shell-only sessions', async () => {
    const projectRoot = '/workspace/demo';
    const commandSessionId = 'session-command-only';
    const bashSessionId = 'session-bash-only';

    await writeSession(
      projectRoot,
      commandSessionId,
      [
        makeUserMessage(
          commandSessionId,
          '<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>',
          '2026-04-14T00:00:00.000Z',
        ),
      ],
      {
        aiTitle: 'Resume the conversation',
      },
    );
    await writeSession(projectRoot, bashSessionId, [
      makeUserMessage(
        bashSessionId,
        '<bash-input>pwd</bash-input>',
        '2026-04-14T00:01:00.000Z',
      ),
    ]);

    const sessions = await listTranscriptSessions(
      projectRoot,
      commandSessionId,
    );

    expect(sessions.map((session) => session.id)).toEqual([bashSessionId]);
    expect(sessions[0]).toMatchObject({
      displayName: '! pwd',
      firstUserMessage: '! pwd',
      messageCount: 1,
    });
  });

  it('uses readable command and bash-input fallbacks when no real prompt exists', async () => {
    const projectRoot = '/workspace/demo';
    const commandSessionId = 'session-command-fallback';
    const bashSessionId = 'session-bash-fallback';

    await writeSession(projectRoot, commandSessionId, [
      makeUserMessage(
        commandSessionId,
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fast</command-args>',
        '2026-04-14T00:00:00.000Z',
      ),
      makeAssistantMessage(
        commandSessionId,
        'answer',
        '2026-04-14T00:00:01.000Z',
      ),
    ]);
    await writeSession(projectRoot, bashSessionId, [
      makeUserMessage(
        bashSessionId,
        '<bash-input>pwd</bash-input>',
        '2026-04-14T00:01:00.000Z',
      ),
      makeAssistantMessage(bashSessionId, 'answer', '2026-04-14T00:01:01.000Z'),
    ]);

    const sessions = await listTranscriptSessions(projectRoot);
    const commandSession = sessions.find(
      (session) => session.id === commandSessionId,
    );
    const bashSession = sessions.find(
      (session) => session.id === bashSessionId,
    );

    expect(commandSession).toMatchObject({
      displayName: '/model fast',
      firstUserMessage: '/model fast',
      lastPrompt: undefined,
    });
    expect(bashSession).toMatchObject({
      displayName: '! pwd',
      firstUserMessage: '! pwd',
      lastPrompt: undefined,
    });
  });

  it('normalizes stale internal last-prompt metadata when listing sessions', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-stale-last-prompt';
    await writeSession(
      projectRoot,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          '<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(sessionId, 'answer', '2026-04-14T00:00:01.000Z'),
      ],
      {
        lastPrompt:
          '<command-name>/resume</command-name> <command-message>resume</command-message> <command-args></command-args>',
      },
    );

    const [session] = await listTranscriptSessions(projectRoot, sessionId);

    expect(session).toMatchObject({
      displayName: '/resume',
      firstUserMessage: '/resume',
      lastPrompt: '/resume',
    });
  });

  it('skips hidden and transcript-only user messages in session metadata', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-hidden';
    const filePath = getSessionTranscriptPath(projectRoot, sessionId);
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId,
      cwd: projectRoot,
      entrypoint: 'cli',
      userType: 'external',
      version: '1.0.0',
      flushIntervalMs: 0,
    });

    const hidden = makeUserMessage(
      sessionId,
      'hidden metadata',
      '2026-04-14T00:00:00.000Z',
    );
    hidden.isMeta = true;
    const transcriptOnly = makeUserMessage(
      sessionId,
      'transcript-only metadata',
      '2026-04-14T00:00:01.000Z',
    );
    transcriptOnly.isVisibleInTranscriptOnly = true;
    const visible = makeUserMessage(
      sessionId,
      'visible prompt',
      '2026-04-14T00:00:02.000Z',
    );
    const assistant = makeAssistantMessage(
      sessionId,
      'visible reply',
      '2026-04-14T00:00:03.000Z',
    );

    await writer.recordMessages([hidden, transcriptOnly, visible, assistant]);
    await writer.close();

    const [session] = await listTranscriptSessions(projectRoot, sessionId, {
      includeFullContent: true,
    });

    expect(session).toMatchObject({
      firstUserMessage: 'visible prompt',
      displayName: 'visible prompt',
      messageCount: 2,
    });
    expect(session?.messages).toEqual([
      { role: 'user', content: 'visible prompt' },
      { role: 'assistant', content: 'visible reply' },
    ]);
    expect(session?.fullContent).not.toContain('hidden metadata');
    expect(session?.fullContent).not.toContain('transcript-only metadata');
  });

  it('lists compacted sessions whose chain only contains a compact summary', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-compact-only';
    const compactSummary = makeUserMessage(
      sessionId,
      'Summary:\nThe user said hi.',
      '2026-04-14T00:00:01.000Z',
    );
    compactSummary.isCompactSummary = true;

    await writeSession(
      projectRoot,
      sessionId,
      [
        makeCompactBoundaryMessage(sessionId, '2026-04-14T00:00:00.000Z'),
        compactSummary,
      ],
      {
        lastPrompt: 'hi',
        mtime: new Date('2026-04-14T00:10:00.000Z'),
      },
    );

    const sessions = await listTranscriptSessions(projectRoot, 'other-session');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      displayName: 'hi',
      lastPrompt: 'hi',
      messageCount: 0,
      userMessageCount: 0,
      lastUpdated: '2026-04-14T00:10:00.000Z',
    });

    const resolved = await resolveTranscriptSession(
      projectRoot,
      sessionId,
      'other-session',
    );
    expect(resolved.messages.map((message) => message.type)).toEqual([
      'system',
      'user',
    ]);
    expect(resolved.messages[1]?.isCompactSummary).toBe(true);
  });

  it('lists legacy sessions whose parentUuid points to message.id', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'legacy-session';
    const filePath = getSessionTranscriptPath(projectRoot, sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          uuid: 'legacy-user-uuid',
          parentUuid: '',
          isSidechain: false,
          userType: 'external',
          cwd: projectRoot,
          sessionId,
          version: 'v0.1.33',
          type: 'user',
          timestamp: '2026-04-23T09:53:21.228Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'legacy prompt' }],
            id: 'legacy-user-message-id',
          },
          isMeta: false,
        }),
        JSON.stringify({
          uuid: 'legacy-assistant-uuid',
          parentUuid: 'legacy-user-message-id',
          isSidechain: false,
          userType: 'external',
          cwd: projectRoot,
          sessionId,
          version: 'v0.1.33',
          type: 'assistant',
          timestamp: '2026-04-23T09:53:21.247Z',
          message: {
            role: 'assistant',
            id: 'legacy-assistant-message-id',
            content: [{ type: 'text', text: 'legacy reply', citations: null }],
            usage: {
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
            },
          },
          isMeta: false,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const sessions = await listTranscriptSessions(projectRoot);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      firstUserMessage: 'legacy prompt',
      displayName: 'legacy prompt',
      messageCount: 2,
    });
  });

  it('resolves the most recent transcript session and returns runtime messages', async () => {
    const projectRoot = '/workspace/demo';
    await writeSession(
      projectRoot,
      'session-1',
      [
        makeUserMessage('session-1', 'older', '2026-04-14T00:00:00.000Z'),
        makeAssistantMessage(
          'session-1',
          'reply 1',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T00:01:00.000Z') },
    );
    await writeSession(
      projectRoot,
      'session-2',
      [
        makeUserMessage('session-2', 'newer', '2026-04-14T01:00:00.000Z'),
        makeAssistantMessage(
          'session-2',
          'reply 2',
          '2026-04-14T01:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T01:01:00.000Z') },
    );

    const result = await resolveLatestTranscriptSession(projectRoot);

    expect(result.messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.sessionPath).toContain('session-2.jsonl');
    expect(result.displayInfo).toContain('Session 1');
  });

  it('resolves runtime config metadata with the selected session', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = randomUUID();
    const user = makeUserMessage(sessionId, 'hi', '2026-04-14T00:00:00.000Z');
    const assistant = makeAssistantMessage(
      sessionId,
      'hello',
      '2026-04-14T00:00:05.000Z',
    );
    assistant.parentUuid = user.uuid;

    await writeSession(projectRoot, sessionId, [user, assistant], {
      runtimeConfig: {
        model: 'model-a',
        reasoningEffort: 'high',
        contextWindow: 256000,
      },
    });

    const result = await resolveTranscriptSession(projectRoot, sessionId);

    expect(result.runtimeConfig).toMatchObject({
      type: 'runtime-config',
      sessionId,
      model: 'model-a',
      reasoningEffort: 'high',
      contextWindow: 256000,
    });
  });

  it('resolves the most recent transcript session by lastUpdated rather than startTime', async () => {
    const projectRoot = '/workspace/demo';
    await writeSession(
      projectRoot,
      'session-older-start-newer-update',
      [
        makeUserMessage(
          'session-older-start-newer-update',
          'older start time',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(
          'session-older-start-newer-update',
          'reply 1',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T03:00:00.000Z') },
    );
    await writeSession(
      projectRoot,
      'session-newer-start-older-update',
      [
        makeUserMessage(
          'session-newer-start-older-update',
          'newer start time',
          '2026-04-14T01:00:00.000Z',
        ),
        makeAssistantMessage(
          'session-newer-start-older-update',
          'reply 2',
          '2026-04-14T01:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T02:00:00.000Z') },
    );

    const result = await resolveLatestTranscriptSession(projectRoot);

    expect(result.sessionInfo.id).toBe('session-older-start-newer-update');
  });

  it('throws a transcript session error for invalid identifiers', async () => {
    const projectRoot = '/workspace/demo';
    await writeSession(projectRoot, 'session-1', [
      makeUserMessage('session-1', 'hello', '2026-04-14T00:00:00.000Z'),
    ]);

    await expect(
      resolveTranscriptSession(projectRoot, '999'),
    ).rejects.toMatchObject({
      code: 'INVALID_SESSION_IDENTIFIER',
    });

    await expect(
      resolveTranscriptSession(projectRoot, 'latest'),
    ).rejects.toMatchObject({
      code: 'INVALID_SESSION_IDENTIFIER',
    });
  });

  it.each([true, false])('explicit ID bypasses enumeration and full scans (exists=%s)', async (exists) => {
    const projectRoot = '/workspace/demo';
    const id = 'direct-session';
    await writeSession(projectRoot, id, [
      makeUserMessage(id, 'direct prompt', '2026-04-14T00:00:00.000Z'),
    ]);
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('must not enumerate sessions'));
    const scan = vi.spyOn(EntryScanner.prototype, 'scan').mockRejectedValue(new Error('must not load full index'));
    try {
      if (exists) {
        const result = await resolveTranscriptSession(projectRoot, id);
        expect(result.sessionInfo.id).toBe(id);
        expect(result.sessionInfo.firstUserMessage).toBe('direct prompt');
      } else {
        await expect(resolveTranscriptSession(projectRoot, 'missing-session-id')).rejects.toMatchObject({
          code: 'INVALID_SESSION_IDENTIFIER',
        });
      }
      expect(readdir).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      scan.mockRestore();
    }
  });

  it('resolves a session whose only turn was interrupted before any assistant message', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'session-interrupted-first-turn';
    const promptText =
      '<user-pasted-image file="/uploads/a.png" /> summarize this';
    const prompt: TranscriptMessage = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-10-12T09:45:43.582Z',
      cwd: projectRoot,
      sessionId,
      userType: 'external',
      version: '1.0.0',
      origin: { kind: 'human' },
      humanInput: { text: promptText, mode: 'prompt' },
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nUser environment\n</system-reminder>',
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.test/a.png' },
          },
          { type: 'text', text: promptText },
        ],
      },
    };
    const interrupt: TranscriptMessage = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: prompt.uuid,
      isSidechain: false,
      timestamp: '2026-10-12T09:46:03.094Z',
      cwd: projectRoot,
      sessionId,
      userType: 'external',
      version: '1.0.0',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      },
    };

    await writeSession(projectRoot, sessionId, [prompt, interrupt]);

    const result = await resolveTranscriptSession(projectRoot, sessionId);

    expect(result.sessionPath).toContain(`${sessionId}.jsonl`);
    expect(result.messages.map((message) => message.type)).toEqual([
      'user',
      'user',
    ]);
  });

  it('reports the branch point from the fork leaf rather than the root message', async () => {
    const projectRoot = '/workspace/demo';
    const sessionId = 'fork-session';
    const user = makeUserMessage(
      sessionId,
      'forked question',
      '2026-04-14T00:00:00.000Z',
    );
    const assistant = makeAssistantMessage(
      sessionId,
      'forked answer',
      '2026-04-14T00:00:05.000Z',
    );
    user.forkedFrom = {
      sessionId: 'source-session',
      messageUuid: 'source-root',
    };
    assistant.parentUuid = user.uuid;
    assistant.forkedFrom = {
      sessionId: 'source-session',
      messageUuid: 'source-leaf',
    };

    await writeSession(projectRoot, sessionId, [user, assistant]);

    const sessions = await listTranscriptSessions(projectRoot);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.forkedFrom).toEqual({
      sessionId: 'source-session',
      messageUuid: 'source-leaf',
    });
  });

  it('lists transcript sessions newest-first by lastUpdated', async () => {
    const projectRoot = '/workspace/demo';
    await writeSession(
      projectRoot,
      'session-1',
      [
        makeUserMessage('session-1', 'older', '2026-04-14T00:00:00.000Z'),
        makeAssistantMessage(
          'session-1',
          'reply 1',
          '2026-04-14T00:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T00:01:00.000Z') },
    );
    await writeSession(
      projectRoot,
      'session-2',
      [
        makeUserMessage('session-2', 'newer', '2026-04-14T01:00:00.000Z'),
        makeAssistantMessage(
          'session-2',
          'reply 2',
          '2026-04-14T01:00:05.000Z',
        ),
      ],
      { mtime: new Date('2026-04-14T01:01:00.000Z') },
    );

    const sessions = await listTranscriptSessions(projectRoot);

    expect(sessions.map((session) => session.id)).toEqual([
      'session-2',
      'session-1',
    ]);
    expect(sessions.map((session) => session.index)).toEqual([1, 2]);
  });

  it('builds the lightweight picker catalog without invoking the resume scanner', async () => {
    const projectRoot = '/workspace/demo';
    const validSessionId = 'bounded-valid';
    const commandSessionId = 'bounded-command-only';
    await writeSession(
      projectRoot,
      validSessionId,
      [
        makeUserMessage(
          validSessionId,
          'catalog prompt',
          '2026-04-14T00:00:00.000Z',
        ),
        makeAssistantMessage(
          validSessionId,
          'catalog answer',
          '2026-04-14T00:00:01.000Z',
        ),
      ],
      { aiTitle: 'Catalog title' },
    );
    await writeSession(projectRoot, commandSessionId, [
      makeUserMessage(
        commandSessionId,
        '<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>',
        '2026-04-14T00:01:00.000Z',
      ),
    ]);
    const scanSpy = vi
      .spyOn(EntryScanner.prototype, 'scan')
      .mockRejectedValue(new Error('resume scanner must not run'));
    const consumeSpy = vi.spyOn(EntryScanner.prototype, 'consume').mockRejectedValue(new Error('bounded resume must not run for listing'));

    try {
      const sessions = await listTranscriptSessions(projectRoot, undefined, {
        lightweight: true,
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: validSessionId,
        displayName: 'Catalog title',
        firstUserMessage: 'catalog prompt',
        messageCount: 0,
        userMessageCount: 0,
        isMetadataOnly: true,
      });
      expect(scanSpy).not.toHaveBeenCalled();
      expect(consumeSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it('bounds concurrent transcript scans while listing many sessions', async () => {
    const projectRoot = '/workspace/demo';
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const sessionId = `bounded-session-${index}`;
        return writeSession(projectRoot, sessionId, [
          makeUserMessage(
            sessionId,
            `question ${index}`,
            '2026-04-14T00:00:00.000Z',
          ),
          makeAssistantMessage(
            sessionId,
            `answer ${index}`,
            '2026-04-14T00:00:01.000Z',
          ),
        ]);
      }),
    );
    const originalScan = EntryScanner.prototype.scan;
    let activeScans = 0;
    let maximumActiveScans = 0;
    const scanSpy = vi
      .spyOn(EntryScanner.prototype, 'scan')
      .mockImplementation(async function (
        this: EntryScanner,
        filePath,
        profile,
      ) {
        activeScans++;
        maximumActiveScans = Math.max(maximumActiveScans, activeScans);
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          return await originalScan.call(this, filePath, profile);
        } finally {
          activeScans--;
        }
      });

    try {
      await expect(listTranscriptSessions(projectRoot)).resolves.toHaveLength(
        12,
      );
      expect(maximumActiveScans).toBe(8);
    } finally {
      scanSpy.mockRestore();
    }
  });
});
