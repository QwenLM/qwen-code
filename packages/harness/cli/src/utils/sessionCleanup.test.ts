/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TranscriptStore,
  modelMessageToAssistantPayload,
  type Config,
  type UserMessage,
  type AssistantMessage,
  getSessionTranscriptPath,
  getSubagentTranscriptDir,
  getTranscriptProjectDir,
  TOOL_OUTPUTS_DIR,
  runLogger,
  _resetConfigHomeDirCache,
} from '@qwen-code/core';
import { mergeSettings, type Settings } from '../config/settings.js';

const transcriptDeletionMocks = vi.hoisted(() => ({
  releaseOwnership: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  releasePersistedWorktreeSessionOwnership:
    transcriptDeletionMocks.releaseOwnership,
}));

import {
  cleanupExpiredSessions,
  cleanupToolOutputFiles,
} from './sessionCleanup.js';
import { cleanupDiagnosticLogs } from './diagnosticLogCleanup.js';

describe('cleanupExpiredSessions', () => {
  let tempHomeDir: string;
  let tempProjectDir: string;

  beforeEach(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-home-'));
    tempProjectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'session-project-'),
    );
    vi.stubEnv('HOME', tempHomeDir);
    vi.stubEnv(ENV_CONFIG_DIR, path.join(tempHomeDir, '.qwen'));
    _resetConfigHomeDirCache();
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
    vi.spyOn(runLogger, 'error').mockImplementation(() => {});
    transcriptDeletionMocks.releaseOwnership.mockReset();
    transcriptDeletionMocks.releaseOwnership.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    vi.restoreAllMocks();
    await fs.rm(tempHomeDir, { recursive: true, force: true });
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  function createConfig(
    overrides: Partial<Config> = {},
    currentSessionId = 'current-session',
    projectRoot = '/workspace/demo',
  ): Config {
    const transcriptStore = new TranscriptStore();
    return {
      storage: {
        getProjectTempDir: () => tempProjectDir,
      },
      getSessionId: () => currentSessionId,
      getProjectRoot: () => projectRoot,
      getSessionArtifactProjectRoot: () => projectRoot,
      getTranscriptStore: () => transcriptStore,
      getDebugMode: () => false,
      initialize: async () => undefined,
      ...overrides,
    } as unknown as Config;
  }

  function makeUserMessage(
    sessionId: string,
    content: string,
    timestamp: string,
  ): UserMessage {
    return {
      type: 'user',
      uuid: `${sessionId}-user-${timestamp}`,
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
      uuid: `${sessionId}-assistant-${timestamp}`,
      timestamp,
      sessionId,
      message: modelMessageToAssistantPayload({
        messageId: `${sessionId}-assistant-message`,

        model: 'test-model',
        stopReason: 'end_turn',

        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        blocks: [{ type: 'text', text: content }],
      }),
    };
  }

  async function writeTranscriptSession(options: {
    projectRoot?: string;
    sessionId: string;
    firstUser: string;
    assistant: string;
    timestamp: string;
    mtime: Date;
  }) {
    const projectRoot = options.projectRoot ?? '/workspace/demo';
    const sessionPath = getSessionTranscriptPath(
      projectRoot,
      options.sessionId,
    );
    const writer = await new TranscriptStore().acquireSessionWriter({
      filePath: sessionPath,
      sessionId: options.sessionId,
      cwd: projectRoot,
      entrypoint: 'cli',
      userType: 'external',
      version: '1.0.0',
    });

    await writer.recordMessages([
      makeUserMessage(options.sessionId, options.firstUser, options.timestamp),
      makeAssistantMessage(
        options.sessionId,
        options.assistant,
        new Date(new Date(options.timestamp).getTime() + 1000).toISOString(),
      ),
    ]);
    await writer.close();
    await fs.utimes(sessionPath, options.mtime, options.mtime);
    return sessionPath;
  }

  async function writeArtifacts(sessionId: string) {
    const logsDir = path.join(tempProjectDir, 'logs');
    const outputsDir = path.join(tempProjectDir, TOOL_OUTPUTS_DIR);
    const topLevelDir = path.join(tempProjectDir, sessionId);
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.mkdir(path.join(outputsDir, `session-${sessionId}`), {
      recursive: true,
    });
    await fs.mkdir(topLevelDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, `session-${sessionId}.jsonl`),
      'log content',
    );
    await fs.writeFile(
      path.join(outputsDir, `session-${sessionId}`, 'output.txt'),
      'tool output',
    );
  }

  async function writeSubagentArtifacts(
    parentSessionId: string,
    subagentSessionIds: string[],
  ) {
    const subagentDir = getSubagentTranscriptDir(
      '/workspace/demo',
      parentSessionId,
    );
    const logsDir = path.join(tempProjectDir, 'logs');
    await fs.mkdir(subagentDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    for (const sessionId of subagentSessionIds) {
      await fs.writeFile(
        path.join(subagentDir, `agent-${sessionId}.jsonl`),
        '{}',
      );
      await fs.writeFile(
        path.join(logsDir, `session-${sessionId}.jsonl`),
        '{}',
      );
      await fs.mkdir(
        path.join(tempProjectDir, TOOL_OUTPUTS_DIR, `session-${sessionId}`),
        {
          recursive: true,
        },
      );
    }
  }

  it.each([
    {
      name: 'no retention settings',
      retention: undefined,
      shouldDelete: false,
    },
    {
      name: 'only maxAge configured',
      retention: { maxAge: '30d' },
      shouldDelete: false,
    },
    {
      name: 'explicitly disabled',
      retention: { enabled: false },
      shouldDelete: false,
    },
    {
      name: 'explicitly enabled',
      retention: { enabled: true },
      shouldDelete: true,
    },
  ])('requires opt-in with $name', async ({ retention, shouldDelete }) => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const sessionPath = await writeTranscriptSession({
      sessionId: 'old-session',
      firstUser: 'old question',
      assistant: 'old answer',
      timestamp: oldDate.toISOString(),
      mtime: oldDate,
    });
    const settings = mergeSettings(
      retention ? { general: { sessionRetention: retention } } : {},
      {},
      true,
    );

    const result = await cleanupExpiredSessions(createConfig(), settings);

    expect(existsSync(sessionPath)).toBe(!shouldDelete);
    expect(result.disabled).toBe(!shouldDelete);
    expect(result.deleted).toBe(shouldDelete ? 1 : 0);
    expect(result.failed).toBe(0);
  });

  it('resumes a 45-day-old conversation with its artifacts after diagnostic cleanup', async () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const sessionPath = await writeTranscriptSession({
      sessionId: 'old-session',
      firstUser: 'old question',
      assistant: 'old answer',
      timestamp: oldDate.toISOString(),
      mtime: oldDate,
    });
    await writeArtifacts('old-session');
    await writeSubagentArtifacts('old-session', ['old-agent']);
    const outputPath = path.join(
      tempProjectDir,
      TOOL_OUTPUTS_DIR,
      'session-old-session',
      'output.txt',
    );
    const outputsDir = path.dirname(outputPath);
    for (const filePath of [outputPath, outputsDir]) {
      await fs.utimes(filePath, oldDate, oldDate);
    }
    const logsRoot = path.join(tempProjectDir, 'diagnostics');
    const runDir = path.join(logsRoot, 'runs', 'old-run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'qwen.log'), 'diagnostic log');
    await fs.utimes(runDir, oldDate, oldDate);
    const settings = mergeSettings({}, {}, true);
    const results = await Promise.all([
      cleanupExpiredSessions(createConfig(), settings),
      cleanupToolOutputFiles(settings, false, tempProjectDir),
      cleanupDiagnosticLogs({ logsRoot, currentRunId: 'current-run' }),
    ]);
    expect(results.every((result) => result.failed === 0)).toBe(true);

    expect(existsSync(runDir)).toBe(false);
    expect(await fs.readFile(outputPath, 'utf8')).toBe('tool output');
    expect(
      existsSync(getSubagentTranscriptDir('/workspace/demo', 'old-session')),
    ).toBe(true);
    const store = new TranscriptStore();
    const resumed = await store
      .repository()
      .resolveSession(sessionPath, { sessionId: 'old-session' });
    expect(resumed?.messages).toHaveLength(2);
    expect(resumed?.messages[0]).toMatchObject({
      message: { content: 'old question' },
    });
    const writer = await store.acquireSessionWriter({
      filePath: sessionPath,
      sessionId: 'old-session',
      cwd: '/workspace/demo',
      entrypoint: 'cli',
      userType: 'external',
      version: '1.0.0',
    });
    await writer.recordMessages([
      makeUserMessage('old-session', 'continue', new Date().toISOString()),
    ]);
    await writer.close();
    const continued = await store
      .repository()
      .resolveSession(sessionPath, { sessionId: 'old-session' });
    expect(continued?.messages).toHaveLength(3);
    expect(continued?.messages.at(-1)).toMatchObject({
      message: { content: 'continue' },
    });
    await store.close();
  });

  it('returns early when cleanup is disabled', async () => {
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: false } },
    };

    const result = await cleanupExpiredSessions(config, settings);

    expect(result).toEqual({
      disabled: true,
      scanned: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('returns no-op when transcript project directory does not exist', async () => {
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };

    const result = await cleanupExpiredSessions(config, settings);

    expect(result).toEqual({
      disabled: false,
      scanned: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('scans the stable artifact root while a worktree is the runtime root', async () => {
    const artifactProjectRoot = '/workspace/original-project';
    const runtimeWorktreeRoot =
      '/workspace/original-project/.qwen/worktrees/feature';
    const config = createConfig({
      getProjectRoot: () => runtimeWorktreeRoot,
      getSessionArtifactProjectRoot: () => artifactProjectRoot,
    });
    const sessionPath = await writeTranscriptSession({
      projectRoot: artifactProjectRoot,
      sessionId: 'expired-worktree-session',
      firstUser: 'old question',
      assistant: 'old answer',
      timestamp: '2025-01-01T00:00:00.000Z',
      mtime: new Date('2025-01-01T00:00:00.000Z'),
    });

    const result = await cleanupExpiredSessions(config, {
      general: { sessionRetention: { enabled: true, maxAge: '1d' } },
    });

    expect(result.deleted).toBe(1);
    await expect(fs.stat(sessionPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deletes expired transcript sessions and related artifacts', async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };

    const currentPath = await writeTranscriptSession({
      sessionId: 'current-session',
      firstUser: 'current message',
      assistant: 'current reply',
      timestamp: now.toISOString(),
      mtime: now,
    });
    const oldPath = await writeTranscriptSession({
      sessionId: 'old-session',
      firstUser: 'old message',
      assistant: 'old reply',
      timestamp: oldDate.toISOString(),
      mtime: oldDate,
    });
    const recentPath = await writeTranscriptSession({
      sessionId: 'recent-session',
      firstUser: 'recent message',
      assistant: 'recent reply',
      timestamp: recentDate.toISOString(),
      mtime: recentDate,
    });

    await writeArtifacts('old-session');
    await writeArtifacts('recent-session');
    await writeSubagentArtifacts('old-session', [
      'old-subagent-1',
      'old-subagent-2',
    ]);

    const result = await cleanupExpiredSessions(config, settings);

    expect(result).toEqual({
      disabled: false,
      scanned: 3,
      deleted: 1,
      skipped: 2,
      failed: 0,
    });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(recentPath)).toBe(true);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-old-session.jsonl'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(tempProjectDir, TOOL_OUTPUTS_DIR, 'session-old-session'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-old-subagent-1.jsonl'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(tempProjectDir, TOOL_OUTPUTS_DIR, 'session-old-subagent-1'),
      ),
    ).toBe(false);
    expect(
      existsSync(getSubagentTranscriptDir('/workspace/demo', 'old-session')),
    ).toBe(false);
  });

  it('preserves unindexable transcript files that are not expired', async () => {
    const projectRoot = '/workspace/demo';
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    await writeTranscriptSession({
      sessionId: 'valid-session',
      firstUser: 'valid message',
      assistant: 'valid reply',
      timestamp: recentDate.toISOString(),
      mtime: recentDate,
    });

    const corruptedPath = path.join(
      getTranscriptProjectDir(projectRoot),
      'corrupted-session.jsonl',
    );
    await fs.mkdir(path.dirname(corruptedPath), { recursive: true });
    await fs.writeFile(corruptedPath, '{"type":"user"');
    await fs.utimes(corruptedPath, recentDate, recentDate);
    await writeArtifacts('corrupted-session');
    await writeSubagentArtifacts('corrupted-session', ['corrupted-subagent']);

    const result = await cleanupExpiredSessions(config, settings);

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(existsSync(corruptedPath)).toBe(true);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-corrupted-session.jsonl'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          tempProjectDir,
          TOOL_OUTPUTS_DIR,
          'session-corrupted-session',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-corrupted-subagent.jsonl'),
      ),
    ).toBe(true);
    expect(
      existsSync(getSubagentTranscriptDir(projectRoot, 'corrupted-session')),
    ).toBe(true);
  });

  it('deletes expired unindexable transcript files by file mtime', async () => {
    const projectRoot = '/workspace/demo';
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };

    const corruptedPath = path.join(
      getTranscriptProjectDir(projectRoot),
      'corrupted-session.jsonl',
    );
    await fs.mkdir(path.dirname(corruptedPath), { recursive: true });
    await fs.writeFile(corruptedPath, '{"type":"user"');
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await fs.utimes(corruptedPath, oldDate, oldDate);
    await writeArtifacts('corrupted-session');
    await writeSubagentArtifacts('corrupted-session', ['corrupted-subagent']);

    const result = await cleanupExpiredSessions(config, settings);

    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(existsSync(corruptedPath)).toBe(false);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-corrupted-session.jsonl'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          tempProjectDir,
          TOOL_OUTPUTS_DIR,
          'session-corrupted-session',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-corrupted-subagent.jsonl'),
      ),
    ).toBe(false);
    expect(
      existsSync(getSubagentTranscriptDir(projectRoot, 'corrupted-session')),
    ).toBe(false);
  });

  it('preserves an expired transcript and reports failure when associated artifacts cannot be deleted', async () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };
    const transcriptPath = await writeTranscriptSession({
      sessionId: 'retry-session',
      firstUser: 'retry message',
      assistant: 'retry reply',
      timestamp: oldDate.toISOString(),
      mtime: oldDate,
    });
    const blockedLogPath = path.join(
      tempProjectDir,
      'logs',
      'session-retry-session.jsonl',
    );
    await fs.mkdir(blockedLogPath, { recursive: true });

    const failedResult = await cleanupExpiredSessions(config, settings);

    expect(failedResult).toEqual({
      disabled: false,
      scanned: 1,
      deleted: 0,
      skipped: 0,
      failed: 1,
    });
    expect(existsSync(transcriptPath)).toBe(true);

    await fs.rm(blockedLogPath, { recursive: true, force: true });
    const retryResult = await cleanupExpiredSessions(config, settings);

    expect(retryResult).toEqual({
      disabled: false,
      scanned: 1,
      deleted: 1,
      skipped: 0,
      failed: 0,
    });
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it('preserves transcript artifacts when Worktree ownership cannot be settled', async () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxAge: '30d' } },
    };
    const transcriptPath = await writeTranscriptSession({
      sessionId: 'owner-retry-session',
      firstUser: 'retry message',
      assistant: 'retry reply',
      timestamp: oldDate.toISOString(),
      mtime: oldDate,
    });
    await writeArtifacts('owner-retry-session');
    await fs.appendFile(
      transcriptPath,
      JSON.stringify({
        type: 'worktree-state',
        sessionId: 'owner-retry-session',
        worktreeSession: {
          sessionId: 'owner-retry-session',
          originalCwd: '/workspace/demo',
          worktreePath: '/workspace/demo/.qwen/worktrees/retry',
          worktreeName: 'retry',
          lifecycle: 'owner',
        },
      }) + '\n',
    );
    await fs.utimes(transcriptPath, oldDate, oldDate);
    transcriptDeletionMocks.releaseOwnership.mockRejectedValue(
      new Error('owner unavailable'),
    );

    const result = await cleanupExpiredSessions(config, settings);

    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    expect(existsSync(transcriptPath)).toBe(true);
    expect(
      existsSync(
        path.join(tempProjectDir, 'logs', 'session-owner-retry-session.jsonl'),
      ),
    ).toBe(true);
  });

  it('does not scan transcript files when only maxCount is configured', async () => {
    const config = createConfig();
    const settings: Settings = {
      general: { sessionRetention: { enabled: true, maxCount: 2 } },
    };

    const oldestPath = await writeTranscriptSession({
      sessionId: 'oldest-session',
      firstUser: 'oldest message',
      assistant: 'oldest reply',
      timestamp: '2026-04-10T10:00:00.000Z',
      mtime: new Date('2026-04-10T10:00:00.000Z'),
    });
    const newestPath = await writeTranscriptSession({
      sessionId: 'newest-session',
      firstUser: 'newest message',
      assistant: 'newest reply',
      timestamp: '2026-04-13T10:00:00.000Z',
      mtime: new Date('2026-04-13T10:00:00.000Z'),
    });
    const currentPath = await writeTranscriptSession({
      sessionId: 'current-session',
      firstUser: 'current message',
      assistant: 'current reply',
      timestamp: '2026-04-14T10:00:00.000Z',
      mtime: new Date('2026-04-14T10:00:00.000Z'),
    });

    const result = await cleanupExpiredSessions(config, settings);

    expect(result).toEqual({
      disabled: false,
      scanned: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    });
    expect(existsSync(oldestPath)).toBe(true);
    expect(existsSync(newestPath)).toBe(true);
    expect(existsSync(currentPath)).toBe(true);
  });

  it('disables cleanup when retention config is invalid', async () => {
    const config = createConfig();
    const settings: Settings = {
      general: {
        sessionRetention: {
          enabled: true,
          maxAge: '0d',
        },
      },
    };

    const result = await cleanupExpiredSessions(config, settings);

    expect(result.disabled).toBe(true);
    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Session cleanup disabled: Error: Invalid retention period',
      ),
    );
  });
});
