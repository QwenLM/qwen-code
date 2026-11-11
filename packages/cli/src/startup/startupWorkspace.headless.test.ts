/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { ENV_CONFIG_DIR } from '@qwen-code/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  _resetConfigHomeDirCache,
  getSessionTranscriptPath,
  type SessionResumeData,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import { resolveHeadlessResume } from '../headless/sessionResume.js';
import { resolveStartupWorkspace } from './startupWorkspace.js';

let directory: string;
let workspaceRoot: string;
let sessionId: string;
const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
  Object.getOwnPropertyDescriptor(stream, 'isTTY'),
);

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'startup-headless-resume-'));
  workspaceRoot = path.join(directory, 'workspace');
  await fs.mkdir(workspaceRoot);
  vi.stubEnv(ENV_CONFIG_DIR, path.join(directory, 'config'));
  vi.stubEnv('CI', 'false');
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  }
  _resetConfigHomeDirCache();
  sessionId = randomUUID();
  const transcriptPath = getSessionTranscriptPath(workspaceRoot, sessionId);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(
    transcriptPath,
    JSON.stringify({
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-10-01T00:00:00Z',
      cwd: workspaceRoot,
      sessionId,
      userType: 'external',
      version: '1.0.0',
      message: { role: 'user', content: 'resume this conversation' },
    }) + '\n',
  );
});

afterEach(async () => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
  vi.unstubAllEnvs();
  _resetConfigHomeDirCache();
  await fs.rm(directory, { recursive: true, force: true });
});

// Mode detection has its own unit tests; keep one real read per resume entry.
it.each(['resume', 'continue'] as const)(
  '%s releases workspace discovery before the headless session reads history',
  async (mode) => {
    const argv = {
      print: true,
      ...(mode === 'resume' ? { resume: sessionId } : { continue: true }),
    } as CliArgs;
    const workspace = await resolveStartupWorkspace(argv, workspaceRoot);
    let resumed: SessionResumeData | undefined;
    try {
      expect(workspace.resourceRoot).toBe(workspaceRoot);
      expect(workspace.resumeSelection).toBeUndefined();
      resumed = await resolveHeadlessResume({
        cliArgs: argv,
        workspaceRoot: workspace.resourceRoot,
      });
      expect(resumed?.sessionId).toBe(sessionId);
      expect(resumed?.messages).toHaveLength(1);
      expect(resumed?.transcriptReadState?.snapshot).toBeDefined();
    } finally {
      if (workspace.resumeSelection?.status === 'fulfilled')
        workspace.resumeSelection.value.resumeAttempt?.finish();
      resumed?.resumeAttempt?.finish();
    }
  },
);

it('keeps the exact startup selection for interactive resume', async () => {
  const workspace = await resolveStartupWorkspace(
    { resume: sessionId },
    workspaceRoot,
  );
  try {
    expect(workspace.resumeSelection?.status).toBe('fulfilled');
    if (workspace.resumeSelection?.status === 'fulfilled') {
      expect(workspace.resumeSelection.value.sessionInfo.id).toBe(sessionId);
      expect(workspace.resumeSelection.value.messages).toHaveLength(1);
    }
  } finally {
    if (workspace.resumeSelection?.status === 'fulfilled')
      workspace.resumeSelection.value.resumeAttempt?.finish();
  }
});
