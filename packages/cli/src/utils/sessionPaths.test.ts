/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { createMockCommandContext } from '../test-utils/mockCommandContext.js';
import {
  collectSessionPathInfo,
  formatSessionPathInfo,
} from './sessionPaths.js';
import type { CommandContext } from '../ui/commands/types.js';

describe('sessionPaths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-paths-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(tmpDir, 'runtime'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects current session paths and latest matching OpenAI log', async () => {
    const sessionId = '2a25a035-da35-4722-850e-b8aa074bd244';
    const planFilePath = path.join(tmpDir, 'plans', `${sessionId}.md`);
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, '# Plan\n', 'utf-8');
    const openAILogDir = path.join(tmpDir, 'openai-logs');
    await fs.mkdir(openAILogDir, { recursive: true });
    await fs.writeFile(
      path.join(openAILogDir, 'openai-2026-01-01T00-00-00-000Z-old.json'),
      JSON.stringify({ context: { sessionId } }),
      'utf-8',
    );
    const latestOpenAILog = path.join(
      openAILogDir,
      'openai-2026-01-02T00-00-00-000Z-new.json',
    );
    await fs.writeFile(
      latestOpenAILog,
      JSON.stringify({ context: { sessionId } }),
      'utf-8',
    );

    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi
            .fn()
            .mockReturnValue(`/tmp/chats/${sessionId}.jsonl`),
          getDebugMode: vi.fn().mockReturnValue(true),
          getPlanFilePath: vi.fn().mockReturnValue(planFilePath),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain(`Session ID: ${sessionId}`);
    expect(text).toContain(`Transcript: /tmp/chats/${sessionId}.jsonl`);
    expect(text).toContain(`Debug log: ${Storage.getDebugLogPath(sessionId)}`);
    expect(text).toContain(`Plan file: ${planFilePath}`);
    expect(text).toContain(`Directory: ${openAILogDir}`);
    expect(text).toContain(`Latest for session: ${latestOpenAILog}`);
  });

  it('matches OpenAI logs by promptId when sessionId is absent', async () => {
    const sessionId = '2a25a035-da35-4722-850e-b8aa074bd244';
    const openAILogDir = path.join(tmpDir, 'openai-logs');
    await fs.mkdir(openAILogDir, { recursive: true });
    const latestOpenAILog = path.join(
      openAILogDir,
      'openai-2026-01-02T00-00-00-000Z-new.json',
    );
    await fs.writeFile(
      latestOpenAILog,
      JSON.stringify({ context: { promptId: sessionId } }),
      'utf-8',
    );

    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi.fn().mockReturnValue(''),
          getDebugMode: vi.fn().mockReturnValue(false),
          getPlanFilePath: vi.fn().mockReturnValue(''),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain(`Latest for session: ${latestOpenAILog}`);
  });

  it('formats session path sections with indentation and separators', () => {
    const text = formatSessionPathInfo({
      sections: [
        {
          title: 'Session files',
          entries: [
            { label: 'Session ID', value: 'session-id' },
            { label: 'Transcript', value: '/tmp/session.jsonl' },
          ],
        },
        {
          title: 'OpenAI logs',
          entries: [{ label: 'Directory', value: '/tmp/openai-logs' }],
        },
      ],
    });

    expect(text).toBe(
      [
        'Session files:',
        '  Session ID: session-id',
        '  Transcript: /tmp/session.jsonl',
        '',
        'OpenAI logs:',
        '  Directory: /tmp/openai-logs',
      ].join('\n'),
    );
  });

  it('limits OpenAI log JSON scans to recent files', async () => {
    const sessionId = '2a25a035-da35-4722-850e-b8aa074bd244';
    const openAILogDir = path.join(tmpDir, 'openai-logs');
    await fs.mkdir(openAILogDir, { recursive: true });
    for (let i = 0; i <= 100; i++) {
      await fs.writeFile(
        path.join(
          openAILogDir,
          `openai-2026-01-01T00-00-00-000Z-${String(i).padStart(3, '0')}.json`,
        ),
        JSON.stringify({
          context: i === 0 ? { sessionId } : { sessionId: 'other-session' },
        }),
        'utf-8',
      );
    }
    const readFileSpy = vi.spyOn(fs, 'readFile');

    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi.fn().mockReturnValue(''),
          getDebugMode: vi.fn().mockReturnValue(false),
          getPlanFilePath: vi.fn().mockReturnValue(''),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain('Latest for session: none yet');
    expect(readFileSpy).toHaveBeenCalledTimes(100);
  });

  it('keeps session output when the OpenAI log directory is unreadable', async () => {
    const sessionId = '2a25a035-da35-4722-850e-b8aa074bd244';
    const openAILogDir = path.join(tmpDir, 'openai-logs');
    vi.spyOn(fs, 'readdir').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );

    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi.fn().mockReturnValue(`/tmp/${sessionId}.jsonl`),
          getDebugMode: vi.fn().mockReturnValue(false),
          getPlanFilePath: vi.fn().mockReturnValue(''),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain(`Session ID: ${sessionId}`);
    expect(text).toContain(`Transcript: /tmp/${sessionId}.jsonl`);
    expect(text).toContain(`Directory: ${openAILogDir}`);
    expect(text).toContain('Latest for session: none yet');
  });

  it('keeps session output when the OpenAI log directory is missing', async () => {
    const sessionId = '2a25a035-da35-4722-850e-b8aa074bd244';
    const openAILogDir = path.join(tmpDir, 'missing-openai-logs');
    const readdirSpy = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );

    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi.fn().mockReturnValue(`/tmp/${sessionId}.jsonl`),
          getDebugMode: vi.fn().mockReturnValue(false),
          getPlanFilePath: vi.fn().mockReturnValue(''),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(readdirSpy).toHaveBeenCalledOnce();
    expect(text).toContain(`Session ID: ${sessionId}`);
    expect(text).toContain(`Directory: ${openAILogDir}`);
    expect(text).toContain('Latest for session: none yet');
  });

  it('handles an unknown session id without derived path lookups', async () => {
    const openAILogDir = path.join(tmpDir, 'openai-logs');
    const readdirSpy = vi.spyOn(fs, 'readdir');
    const accessSpy = vi.spyOn(fs, 'access');

    const context = createMockCommandContext({
      session: {
        stats: {
          sessionId: undefined,
        },
      },
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(''),
          getTranscriptPath: vi.fn().mockReturnValue('/tmp/unknown.jsonl'),
          getDebugMode: vi.fn().mockReturnValue(true),
          getPlanFilePath: vi.fn().mockReturnValue(''),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: true,
            openAILoggingDir: openAILogDir,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain('Session ID: unknown');
    expect(text).toContain('Transcript: /tmp/unknown.jsonl');
    expect(text).toContain(`Directory: ${openAILogDir}`);
    expect(text).toContain('Latest for session: none yet');
    expect(text).not.toContain('Debug log:');
    expect(text).not.toContain('Plan file:');
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(accessSpy).not.toHaveBeenCalled();
  });

  it('hides disabled or absent log sections and missing plan files', async () => {
    const sessionId = 'session-id';
    const context = createMockCommandContext({
      services: {
        config: {
          getSessionId: vi.fn().mockReturnValue(sessionId),
          getTranscriptPath: vi.fn().mockReturnValue(`/tmp/${sessionId}.jsonl`),
          getDebugMode: vi.fn().mockReturnValue(false),
          getPlanFilePath: vi
            .fn()
            .mockReturnValue(path.join(tmpDir, 'missing-plan.md')),
          getWorkingDir: vi.fn().mockReturnValue(tmpDir),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            enableOpenAILogging: false,
          }),
        },
      },
    } as unknown as CommandContext);

    const text = formatSessionPathInfo(await collectSessionPathInfo(context));

    expect(text).toContain(`Session ID: ${sessionId}`);
    expect(text).toContain(`Transcript: /tmp/${sessionId}.jsonl`);
    expect(text).not.toContain('Debug log:');
    expect(text).not.toContain('Plan file:');
    expect(text).not.toContain('OpenAI logs:');
  });
});
