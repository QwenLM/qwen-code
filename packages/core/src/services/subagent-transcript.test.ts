/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSessionTranscriptPath } from './transcript-paths.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type {
  AssistantMessage,
  SystemMessage,
  UserMessage,
} from '../protocol/transcript/message.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import {
  createSubagentTranscriptRecorder,
  getSubagentMetadataPath,
  getSubagentTranscriptPath,
  readSubagentTranscript,
  writeSubagentMetadata,
} from './subagent-transcript.js';
import { TranscriptStore } from './transcript/store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const tempDirs: string[] = [];

afterEach(async () => {
  setConfigHomeDirOverride(undefined);
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('writeSubagentMetadata', () => {
  it('publishes agent metadata only after the sidecar is durable', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-metadata-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);

    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const agentId = 'worker-1';
    const publishCommittedEntries = vi.fn(
      async (transcriptPath: string, entries: readonly unknown[]) => {
        const metadataPath = getSubagentMetadataPath(
          projectRoot,
          sessionId,
          agentId,
        );
        expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual({
          agentType: 'researcher',
          toolUseId: 'tool-1',
        });
        expect(transcriptPath).toBe(
          getSubagentTranscriptPath(projectRoot, sessionId, agentId),
        );
        expect(entries).toEqual([
          {
            type: 'agent_metadata',
            agentType: 'researcher',
            toolUseId: 'tool-1',
          },
        ]);
      },
    );
    const config = {
      getProjectRoot: () => projectRoot,
      getSessionArtifactProjectRoot: () => projectRoot,
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => sessionId,
      getTranscriptStore: () => ({ publishCommittedEntries }),
    } as unknown as Config;

    await writeSubagentMetadata(config, agentId, {
      agentType: 'researcher',
      toolUseId: 'tool-1',
    });

    expect(publishCommittedEntries).toHaveBeenCalledOnce();
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename failed'));
    {
      await expect(writeSubagentMetadata(config, agentId, {
        agentType: 'researcher', toolUseId: 'tool-1',
        gitBranchObservation: { branch: 'later', cwd: projectRoot, observedAt: '2026-10-26T00:00:00Z' },
      })).rejects.toThrow('rename failed');
      const metadataPath = getSubagentMetadataPath(projectRoot, sessionId, agentId);
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual({ agentType: 'researcher', toolUseId: 'tool-1' });
      expect((await fs.readdir(path.dirname(metadataPath))).some((name) => name.endsWith('.tmp'))).toBe(false);
      expect(publishCommittedEntries).toHaveBeenCalledOnce();
    }

  });
});

describe('createSubagentTranscriptRecorder', () => {
  it('stamps sidechain messages with the child worktree cwd and branch', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-worktree-transcript-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const worktreeCwd = '/workspace/project/.qwen/worktrees/worker';
    const sessionId = '550e8400-e29b-41d4-a716-446655440010';
    const agentId = 'worker-worktree';
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const config = {
      getProjectRoot: () => projectRoot,
      getSessionArtifactProjectRoot: () => projectRoot,
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => sessionId,
      getTargetDir: () => projectRoot,
      getTranscriptStore: () => store,
    } as unknown as Config;
    const recorder = await createSubagentTranscriptRecorder(
      config,
      agentId,
      'task-worktree',
      () => undefined,
      { cwd: worktreeCwd, gitBranch: 'worktree-worker' },
    );

    await recorder.recordSidechainMessages(
      [
        userMessage(
          '30000000-0000-4000-8000-000000000001',
          'child prompt',
          '2026-08-11T00:00:00.000Z',
        ),
      ],
      agentId,
    );
    await recorder.close();
    await store.close();

    const entries = (
      await fs.readFile(
        getSubagentTranscriptPath(projectRoot, sessionId, agentId),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry['type'] === 'user')).toMatchObject({
      cwd: worktreeCwd,
      gitBranch: 'worktree-worker',
      agentId,
    });
  });

  it('keeps child artifacts in the original session bucket after main EnterWorktree', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-stable-session-bucket-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const originalProjectRoot = '/workspace/project';
    const activeWorktreeRoot = '/workspace/project/.qwen/worktrees/main-task';
    const childWorktreeCwd = '/workspace/project/.qwen/worktrees/worker';
    const sessionId = '550e8400-e29b-41d4-a716-446655440011';
    const agentId = 'worker-stable-bucket';
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const config = {
      getProjectRoot: () => activeWorktreeRoot,
      getSessionArtifactProjectRoot: () => originalProjectRoot,
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => sessionId,
      getTargetDir: () => activeWorktreeRoot,
      getTranscriptStore: () => store,
    } as unknown as Config;
    const recorder = await createSubagentTranscriptRecorder(
      config,
      agentId,
      'task-stable-bucket',
      () => undefined,
      { cwd: childWorktreeCwd, gitBranch: 'worktree-worker' },
    );

    await recorder.recordSidechainMessages(
      [
        userMessage(
          '30000000-0000-4000-8000-000000000011',
          'child prompt after parent enter',
          '2026-08-11T00:00:00.000Z',
        ),
      ],
      agentId,
    );
    await recorder.close();
    await store.close();

    const stablePath = getSubagentTranscriptPath(
      originalProjectRoot,
      sessionId,
      agentId,
    );
    const activeBucketPath = getSubagentTranscriptPath(
      activeWorktreeRoot,
      sessionId,
      agentId,
    );
    await expect(fs.stat(stablePath)).resolves.toBeDefined();
    await expect(fs.stat(activeBucketPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const entries = (await fs.readFile(stablePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry['type'] === 'user')).toMatchObject({
      cwd: childWorktreeCwd,
      gitBranch: 'worktree-worker',
    });
  });
});

function userMessage(
  uuid: string,
  content: string,
  timestamp: string,
): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content },
  };
}

function assistantMessage(
  uuid: string,
  content: string,
  timestamp: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `provider-${uuid}`,

      model: 'test-model',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
    },
  };
}

describe('readSubagentTranscript', () => {
  it('resolves the latest sidechain leaf for the requested agent', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-read-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    const agentId = 'worker-1';
    const transcriptPath = getSubagentTranscriptPath(
      projectRoot,
      sessionId,
      agentId,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const entries = [
      {
        ...userMessage(
          '10000000-0000-4000-8000-000000000001',
          'remember marker',
          '2026-08-11T00:00:00.000Z',
        ),
        parentUuid: null,
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...assistantMessage(
          '10000000-0000-4000-8000-000000000002',
          'ready',
          '2026-08-11T00:00:01.000Z',
        ),
        parentUuid: '10000000-0000-4000-8000-000000000001',
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...assistantMessage(
          '20000000-0000-4000-8000-000000000001',
          'unrelated newer agent',
          '2026-08-11T00:00:02.000Z',
        ),
        parentUuid: '10000000-0000-4000-8000-000000000002',
        isSidechain: true,
        agentId: 'worker-2',
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
    ];
    await fs.writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );

    const loaded = await readSubagentTranscript(
      projectRoot,
      sessionId,
      agentId,
    );

    expect(loaded).toMatchObject({
      agentId,
      leafUuid: '10000000-0000-4000-8000-000000000002',
      metadata: null,
    });
    expect(loaded?.messages.map((message) => message.uuid)).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ]);
  });

  it('removes other agents after walking the complete parent chain', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-parent-scope-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440003';
    const agentId = 'worker-1';
    const transcriptPath = getSubagentTranscriptPath(
      projectRoot,
      sessionId,
      agentId,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const entries = [
      {
        ...userMessage(
          '40000000-0000-4000-8000-000000000001',
          'other agent root',
          '2026-08-11T00:00:00.000Z',
        ),
        parentUuid: null,
        isSidechain: true,
        agentId: 'worker-2',
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...userMessage(
          '40000000-0000-4000-8000-000000000002',
          'target agent task',
          '2026-08-11T00:00:01.000Z',
        ),
        parentUuid: '40000000-0000-4000-8000-000000000001',
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...assistantMessage(
          '40000000-0000-4000-8000-000000000003',
          'target result',
          '2026-08-11T00:00:02.000Z',
        ),
        parentUuid: '40000000-0000-4000-8000-000000000002',
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
    ];
    await fs.writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );

    const loaded = await readSubagentTranscript(
      projectRoot,
      sessionId,
      agentId,
    );

    expect(loaded?.messages.map((message) => message.uuid)).toEqual([
      '40000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000003',
    ]);
  });

  it('ignores another agent active leaf and resumes the latest target branch', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-latest-branch-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440004';
    const agentId = 'worker-1';
    const transcriptPath = getSubagentTranscriptPath(
      projectRoot,
      sessionId,
      agentId,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const rootUuid = '50000000-0000-4000-8000-000000000001';
    const oldStableUuid = '50000000-0000-4000-8000-000000000002';
    const latestIncompleteUuid = '50000000-0000-4000-8000-000000000003';
    const otherAgentUuid = '50000000-0000-4000-8000-000000000004';
    const latestIncomplete = assistantMessage(
      latestIncompleteUuid,
      'partial latest response',
      '2026-08-11T00:00:02.000Z',
    );
    latestIncomplete.message = {
      ...latestIncomplete.message,
      stop_reason: null,
    };
    const entries = [
      {
        ...userMessage(rootUuid, 'target root', '2026-08-11T00:00:00.000Z'),
        parentUuid: null,
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...assistantMessage(
          oldStableUuid,
          'older complete response',
          '2026-08-11T00:00:01.000Z',
        ),
        parentUuid: rootUuid,
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...latestIncomplete,
        parentUuid: rootUuid,
        isSidechain: true,
        agentId,
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        ...assistantMessage(
          otherAgentUuid,
          'other agent response',
          '2026-08-11T00:00:03.000Z',
        ),
        parentUuid: null,
        isSidechain: true,
        agentId: 'worker-2',
        cwd: projectRoot,
        sessionId,
        userType: 'external',
        version: '1.0.0',
      },
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: otherAgentUuid,
        explicit: false,
        timestamp: Date.parse('2026-08-11T00:00:04.000Z'),
      },
    ];
    await fs.writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );

    const loaded = await readSubagentTranscript(
      projectRoot,
      sessionId,
      agentId,
    );

    expect(loaded?.leafUuid).toBe(latestIncompleteUuid);
    expect(loaded?.messages.map((message) => message.uuid)).toEqual([
      rootUuid,
      latestIncompleteUuid,
    ]);
  });

  it('continues a reopened sidechain from the restored leaf', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-resume-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440002';
    const agentId = 'memory-probe';
    const transcriptPath = getSubagentTranscriptPath(
      projectRoot,
      sessionId,
      agentId,
    );
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const writerOptions = {
      filePath: transcriptPath,
      sessionId,
      cwd: projectRoot,
      entrypoint: 'cli',
      version: '1.0.0',
    };
    const firstWriter = await store.acquireSubagentWriter(writerOptions);
    const firstUser = userMessage(
      '30000000-0000-4000-8000-000000000001',
      'remember AT-MEM-7319',
      '2026-08-11T00:00:00.000Z',
    );
    const firstAssistant = assistantMessage(
      '30000000-0000-4000-8000-000000000002',
      'ready',
      '2026-08-11T00:00:01.000Z',
    );
    await firstWriter.recordSidechainMessages(
      [firstUser, firstAssistant],
      agentId,
    );
    await firstWriter.close();

    const restored = await readSubagentTranscript(
      projectRoot,
      sessionId,
      agentId,
    );
    expect(restored?.messages).toHaveLength(2);

    const secondWriter = await store.acquireSubagentWriter(writerOptions);
    await secondWriter.recordSidechainMessages(
      [
        userMessage(
          '30000000-0000-4000-8000-000000000003',
          'recall the marker',
          '2026-08-11T00:00:02.000Z',
        ),
        assistantMessage(
          '30000000-0000-4000-8000-000000000004',
          'AT-MEM-7319',
          '2026-08-11T00:00:03.000Z',
        ),
      ],
      agentId,
      restored?.leafUuid,
    );
    await secondWriter.close();
    await store.close();

    const rawEntries = (await fs.readFile(transcriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (entry) => entry['type'] === 'user' || entry['type'] === 'assistant',
      );
    expect(rawEntries).toHaveLength(4);
    expect(
      rawEntries.filter((entry) => entry['parentUuid'] === null),
    ).toHaveLength(1);
    expect(rawEntries[2]).toMatchObject({
      parentUuid: firstAssistant.uuid,
      agentId,
      isSidechain: true,
    });
  });

  it('restores the post-compression state instead of the pre-compression events', async () => {
    const configRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-compact-'),
    );
    tempDirs.push(configRoot);
    setConfigHomeDirOverride(configRoot);
    const projectRoot = '/workspace/project';
    const sessionId = '550e8400-e29b-41d4-a716-446655440005';
    const agentId = 'memory-probe';
    const transcriptPath = getSubagentTranscriptPath(
      projectRoot,
      sessionId,
      agentId,
    );
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const writer = await store.acquireSubagentWriter({
      filePath: transcriptPath,
      sessionId,
      cwd: projectRoot,
      entrypoint: 'cli',
      version: '1.0.0',
    });
    const oldUser = userMessage(
      '60000000-0000-4000-8000-000000000001',
      'large obsolete history',
      '2026-08-11T00:00:00.000Z',
    );
    const oldAssistant = assistantMessage(
      '60000000-0000-4000-8000-000000000002',
      'obsolete response',
      '2026-08-11T00:00:01.000Z',
    );
    const oldLeaf = await writer.recordSidechainMessages(
      [oldUser, oldAssistant],
      agentId,
    );
    const compactBoundary: SystemMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: '60000000-0000-4000-8000-000000000003',
      timestamp: '2026-08-11T00:00:02.000Z',
      content: 'Conversation compacted',
      level: 'info',
      isCompactSummary: true,
      compactMetadata: { trigger: 'auto', preTokens: 100_000 },
    };
    const summary = userMessage(
      '60000000-0000-4000-8000-000000000004',
      'Summary: marker remains available.',
      '2026-08-11T00:00:03.000Z',
    );
    summary.isCompactSummary = true;
    const postCompactAssistant = assistantMessage(
      '60000000-0000-4000-8000-000000000005',
      'ready after compact',
      '2026-08-11T00:00:04.000Z',
    );
    await writer.recordSidechainMessages(
      [compactBoundary, summary, postCompactAssistant],
      agentId,
      oldLeaf,
    );
    await writer.close();
    await store.close();

    const restored = await readSubagentTranscript(
      projectRoot,
      sessionId,
      agentId,
    );

    expect(restored?.leafUuid).toBe(postCompactAssistant.uuid);
    expect(restored?.messages.map((message) => message.uuid)).toEqual([
      compactBoundary.uuid,
      summary.uuid,
      postCompactAssistant.uuid,
    ]);
  });
});
