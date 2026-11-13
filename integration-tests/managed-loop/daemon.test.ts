/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { readSessionTranscriptSnapshot } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import { spawnDaemon, type SpawnedDaemon } from '../cli/_daemon-harness.js';
import { HOSTED_CLI, waitUntil } from '../helpers/hosted-harness-process.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { debugLog, loopEnv, mode, saveEvidence } from './evidence.js';

let root: string;
let daemon: SpawnedDaemon | undefined;
let model: FakeOpenAIServer | undefined;
let passed = false;
let transcriptEvidence: unknown;
let ownerEvidence: unknown;

afterEach(async () => {
  try {
    await saveEvidence('daemon-acp', {
      status: passed ? 'pass' : 'fail',
      stdout: daemon?.stdoutBuf.value,
      stderr: daemon?.stderrBuf.value,
      requests: model?.requests,
      transcript: transcriptEvidence,
      owner: ownerEvidence,
      debug: root ? await debugLog(path.join(root, 'runtime')) : '',
    });
  } finally {
    try {
      await daemon?.dispose();
    } finally {
      await model?.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});

it(`ordinary daemon runs a Managed ACP tool turn (${mode})`, async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-loop-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const runtimeDir = path.join(root, 'runtime');
  await Promise.all([home, workspace].map((dir) => mkdir(dir)));
  const sentinel = `MANAGED_LOOP_READ_${randomUUID()}`;
  const file = path.join(workspace, 'probe.txt');
  await writeFile(file, sentinel);
  await writeFile(path.join(root, 'system.json'), '{}');
  await writeFile(
    path.join(home, 'trustedFolders.json'),
    JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
  );
  await writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({
      security: {
        auth: { selectedType: 'openai' },
        folderTrust: { enabled: true },
      },
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
      general: { enableAutoUpdate: false },
      ui: { enableFollowupSuggestions: false },
      telemetry: { enabled: false },
      model: { skipNextSpeakerCheck: true },
    }),
  );
  let called = false;
  model = await startFakeOpenAIServer(({ body }) => {
    if (body['stream'] !== true) return { content: 'fixture' };
    if (!called) {
      called = true;
      return {
        toolCalls: [
          fakeToolCall('read_file', { file_path: file }, 'managed-read'),
        ],
      };
    }
    return { content: 'MANAGED_ACP_DONE' };
  });
  daemon = await spawnDaemon({
    cliBin: HOSTED_CLI,
    workspaceCwd: workspace,
    bootTimeoutMs: 60_000,
    extraArgs: ['--experimental-paired-engines', '--no-web'],
    env: {
      ...loopEnv,
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: home,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CLI_ENTRY: HOSTED_CLI,
      QWEN_SANDBOX: 'false',
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
      QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(home, 'trustedFolders.json'),
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_CODE_MODELS_DEV_REFRESH: 'off',
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_BASE_URL: model.baseUrl,
      OPENAI_MODEL: 'fixture-model',
      QWEN_MODEL: 'fixture-model',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      NODE_OPTIONS: '',
    },
  });
  const session = await daemon.client.createOrAttachSession({
    workspaceCwd: workspace,
    sessionScope: 'thread',
    approvalMode: 'yolo',
  });
  const transcript = new SessionService(workspace, {
    runtimeBaseDir: runtimeDir,
  }).getSessionTranscriptPath(session.sessionId);
  const snapshot = await readSessionTranscriptSnapshot(
    transcript,
    session.sessionId,
    false,
  );
  ownerEvidence = snapshot?.executionEngine;
  expect(snapshot?.executionEngine).toMatchObject({
    status: 'verified',
    engine: 'managed',
  });
  const result = await daemon.client.prompt(
    session.sessionId,
    {
      prompt: [{ type: 'text', text: 'Read probe.txt and report completion.' }],
    },
    AbortSignal.timeout(60_000),
    session.clientId,
  );
  expect(result.stopReason).toBe('end_turn');
  const requests = model.requests.filter(({ body }) => body['stream'] === true);
  expect(requests).toHaveLength(2);
  const messages = requests[1].body['messages'] as Array<{
    role: string;
    content: unknown;
    tool_call_id?: string;
  }>;
  expect(messages).toContainEqual(
    expect.objectContaining({
      role: 'tool',
      tool_call_id: 'managed-read',
      content: expect.stringContaining(sentinel),
    }),
  );
  transcriptEvidence = await daemon.client.getSessionTranscriptPage(
    session.sessionId,
    { clientId: session.clientId },
  );
  expect(JSON.stringify(transcriptEvidence)).toContain('MANAGED_ACP_DONE');
  await waitUntil(async () => {
    const log = await debugLog(runtimeDir);
    return (
      log.includes('[ACP] model round on the shared agent loop') &&
      log.includes('[ACP] tool batch on the shared agent loop')
    );
  });
  passed = true;
});
