/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../config/brand.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSameRepoWorktreePaths,
  listAllProjectTranscriptSessions,
  listSameRepoTranscriptSessionScopes,
  listSameRepoTranscriptSessions,
  resolveSameRepoTranscriptSession as resolveSameRepoTranscriptSessionForRead,
  resolveLatestSameRepoTranscriptSession as resolveLatestSameRepoTranscriptSessionForRead,
  resolveSelectedTranscriptSession as resolveSelectedTranscriptSessionForRead,
  isSameOrChildPath,
} from './worktree-discovery.js';
import { createTestTranscriptWriter } from './transcript/testing/fixtures.js';
import {
  getSessionTranscriptPath,
  getTranscriptProjectsDir,
} from './transcript-paths.js';
import type {
  RuntimeConfigEntry,
  TranscriptWorktreeSession,
  TranscriptMessage,
} from '../protocol/transcript/entry.js';
import { _resetConfigHomeDirCache, sanitizePath } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import * as gitUtils from '../utils/gitUtils.js';
import { SessionStateStore } from './session-state-store.js';
import type { PersistedWorktreeState } from './legacyWorktreeSessionState.js';

let tempHomeDir: string;
let tempRepoDir: string;

async function resolveSameRepoTranscriptSession(...args: Parameters<typeof resolveSameRepoTranscriptSessionForRead>) {
  const result = await resolveSameRepoTranscriptSessionForRead(...args);
  result.resumeAttempt?.finish();
  return result;
}

async function resolveLatestSameRepoTranscriptSession(...args: Parameters<typeof resolveLatestSameRepoTranscriptSessionForRead>) {
  const result = await resolveLatestSameRepoTranscriptSessionForRead(...args);
  result.resumeAttempt?.finish();
  return result;
}

async function resolveSelectedTranscriptSession(...args: Parameters<typeof resolveSelectedTranscriptSessionForRead>) {
  const result = await resolveSelectedTranscriptSessionForRead(...args);
  result.resumeAttempt?.finish();
  return result;
}

beforeEach(async () => {
  tempHomeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'worktree-discovery-test-'),
  );
  tempRepoDir = realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-repo-')),
  );
  vi.stubEnv('HOME', tempHomeDir);
  vi.stubEnv(ENV_CONFIG_DIR, tempHomeDir);
  _resetConfigHomeDirCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetConfigHomeDirCache();
  await fs.rm(tempHomeDir, { recursive: true, force: true });
  await fs.rm(tempRepoDir, { recursive: true, force: true });
});

function makeUserMessage(
  sessionId: string,
  content: string,
  timestamp: string,
  cwd = '/workspace/demo',
): TranscriptMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    cwd,
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
  cwd = '/workspace/demo',
): TranscriptMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    cwd,
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

async function writeSession(
  projectRoot: string,
  sessionId: string,
  messages: TranscriptMessage[],
  options: {
    mtime?: Date;
    directories?: readonly string[];
    worktreeSession?: TranscriptWorktreeSession | null;
    runtimeConfig?: Omit<
      RuntimeConfigEntry,
      'type' | 'sessionId' | 'timestamp'
    >;
  } = {},
) {
  const filePath = getSessionTranscriptPath(projectRoot, sessionId);
  const { writer } = await createTestTranscriptWriter({
    filePath,
    sessionId,
    cwd: projectRoot,
    entrypoint: 'cli',
    userType: 'external',
    version: '1.0.0',
    flushIntervalMs: 0,
    ...(options.directories
      ? { initialWorkspaceDirectories: options.directories }
      : {}),
  });

  await writer.recordMessages(messages);
  if (options.worktreeSession !== undefined) {
    await writer.recordWorktreeState(options.worktreeSession);
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

async function renameSessionBucketWithDifferentRootCase(
  projectRoot: string,
  sessionPath: string,
): Promise<string> {
  const rootBucketName = sanitizePath(projectRoot);
  const caseVariantRootBucketName = rootBucketName.replace(
    /[a-zA-Z]/,
    (character) =>
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase(),
  );
  const bucketDir = path.dirname(sessionPath);
  const bucketName = path.basename(bucketDir);
  if (
    caseVariantRootBucketName === rootBucketName ||
    !bucketName.startsWith(`${rootBucketName}-`)
  ) {
    throw new Error('Test fixture could not create a case-variant bucket');
  }

  const caseVariantBucketDir = path.join(
    path.dirname(bucketDir),
    `${caseVariantRootBucketName}${bucketName.slice(rootBucketName.length)}`,
  );
  await fs.rename(bucketDir, caseVariantBucketDir);
  return caseVariantBucketDir;
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', {
    cwd: dir,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
}

function addWorktree(repoDir: string, name: string): string {
  const worktreePath = path.join(repoDir, '.qwen', 'worktrees', name);
  execSync(`git worktree add -b worktree-${name} "${worktreePath}"`, {
    cwd: repoDir,
    stdio: 'ignore',
  });
  return worktreePath;
}

async function writeLegacyWorktreeState(
  store: SessionStateStore,
  state: PersistedWorktreeState | null,
): Promise<void> {
  if (state) {
    await store.setSegment('worktreeSession', state, { encrypted: false });
  } else {
    await store.deleteSegment('worktreeSession');
  }
}

// ---------------------------------------------------------------------------
// getSameRepoWorktreePaths
// ---------------------------------------------------------------------------

describe('getSameRepoWorktreePaths', () => {
  it('returns empty array for non-git directory', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'));
    try {
      const result = await getSameRepoWorktreePaths(nonGitDir);
      expect(result).toEqual([]);
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('returns single path for repo with no extra worktrees', async () => {
    initGitRepo(tempRepoDir);

    const result = await getSameRepoWorktreePaths(tempRepoDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(tempRepoDir);
  });

  it('returns multiple paths for repo with worktrees', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    // Call from main repo
    const fromMain = await getSameRepoWorktreePaths(tempRepoDir);
    expect(fromMain).toHaveLength(2);
    expect(fromMain[0]).toBe(tempRepoDir); // current first
    expect(fromMain[1]).toBe(worktreePath);

    // Call from worktree
    const fromWorktree = await getSameRepoWorktreePaths(worktreePath);
    expect(fromWorktree).toHaveLength(2);
    expect(fromWorktree[0]).toBe(worktreePath); // current first
    expect(fromWorktree[1]).toBe(tempRepoDir);
  });
});

// ---------------------------------------------------------------------------
// listSameRepoTranscriptSessions
// ---------------------------------------------------------------------------

describe('listSameRepoTranscriptSessions', () => {
  it('lists sessions from a single project root (no worktrees)', async () => {
    const projectRoot = '/workspace/main-repo';
    const sessionId = 'session-main-1';

    await writeSession(projectRoot, sessionId, [
      makeUserMessage(sessionId, 'hello from main', '2026-05-01T00:00:00Z'),
      makeAssistantMessage(sessionId, 'hi back', '2026-05-01T00:00:05Z'),
    ]);

    // Non-git path → getSameRepoWorktreePaths returns [] → single-bucket fallback
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: projectRoot,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].transcriptProjectRoot).toBe(projectRoot);
    expect(sessions[0].sourceWorktreePath).toBeUndefined();
  });

  it('merges sessions from main repo and worktree buckets using real git worktree', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const mainSessionId = 'session-main-1';
    const worktreeSessionId = 'session-wt-1';

    await writeSession(
      tempRepoDir,
      mainSessionId,
      [
        makeUserMessage(
          mainSessionId,
          'hello from main',
          '2026-05-01T00:00:00Z',
        ),
        makeAssistantMessage(mainSessionId, 'hi', '2026-05-01T00:00:05Z'),
      ],
      { mtime: new Date('2026-05-01T00:10:00Z') },
    );

    await writeSession(
      worktreePath,
      worktreeSessionId,
      [
        makeUserMessage(
          worktreeSessionId,
          'hello from worktree',
          '2026-05-02T00:00:00Z',
        ),
        makeAssistantMessage(
          worktreeSessionId,
          'hi from wt',
          '2026-05-02T00:00:05Z',
        ),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    // Query from worktree — should discover main repo sessions too
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: worktreePath,
    });

    expect(sessions).toHaveLength(2);

    // Sorted by lastUpdated desc — worktree session should be first (newer)
    expect(sessions[0].id).toBe(worktreeSessionId);
    expect(sessions[0].transcriptProjectRoot).toBe(worktreePath);
    expect(sessions[0].sourceWorktreePath).toBeUndefined(); // same as currentProjectRoot

    expect(sessions[1].id).toBe(mainSessionId);
    expect(sessions[1].transcriptProjectRoot).toBe(tempRepoDir);
    expect(sessions[1].sourceWorktreePath).toBe(tempRepoDir); // cross-worktree

    // Indexes should be re-numbered after merge
    expect(sessions[0].index).toBe(1);
    expect(sessions[1].index).toBe(2);
  });

  it('deduplicates sessions with same id across worktrees (keeps newest)', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const sessionId = 'shared-session-id';

    // Same session id in both buckets — main has older mtime
    await writeSession(
      tempRepoDir,
      sessionId,
      [
        makeUserMessage(sessionId, 'hello from main', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(sessionId, 'hi', '2026-05-01T00:00:05Z'),
      ],
      { mtime: new Date('2026-05-01T00:10:00Z') },
    );

    await writeSession(
      worktreePath,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'hello from worktree',
          '2026-05-02T00:00:00Z',
        ),
        makeAssistantMessage(sessionId, 'hi wt', '2026-05-02T00:00:05Z'),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: worktreePath,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    // Should keep the worktree version (newer mtime)
    expect(sessions[0].transcriptProjectRoot).toBe(worktreePath);
  });

  it('deduplicates current and all scopes independently', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');
    const sessionId = 'shared-session-id';

    await writeSession(
      tempRepoDir,
      sessionId,
      [
        makeUserMessage(sessionId, 'older main copy', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(sessionId, 'main reply', '2026-05-01T00:00:05Z'),
      ],
      { mtime: new Date('2026-05-01T00:10:00Z') },
    );

    await writeSession(
      worktreePath,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'newer worktree copy',
          '2026-05-02T00:00:00Z',
        ),
        makeAssistantMessage(
          sessionId,
          'worktree reply',
          '2026-05-02T00:00:05Z',
        ),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(scopes.current).toHaveLength(1);
    expect(scopes.current[0]).toMatchObject({
      id: sessionId,
      index: 1,
      transcriptProjectRoot: tempRepoDir,
    });
    expect(scopes.current[0].sourceWorktreePath).toBeUndefined();
    expect(scopes.all).toHaveLength(1);
    expect(scopes.all[0]).toMatchObject({
      id: sessionId,
      index: 1,
      transcriptProjectRoot: worktreePath,
      sourceWorktreePath: worktreePath,
    });
    expect(scopes.current[0]).not.toBe(scopes.all[0]);
  });

  it('keeps a single-worktree subdirectory bucket in the current scope', async () => {
    initGitRepo(tempRepoDir);
    const subdirectory = path.join(tempRepoDir, 'packages', 'cli');
    await fs.mkdir(subdirectory, { recursive: true });
    const sessionId = 'subdirectory-session';

    await writeSession(subdirectory, sessionId, [
      makeUserMessage(
        sessionId,
        'subdirectory session',
        '2026-05-01T00:00:00Z',
        subdirectory,
      ),
      makeAssistantMessage(
        sessionId,
        'subdirectory reply',
        '2026-05-01T00:00:05Z',
        subdirectory,
      ),
    ]);

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: subdirectory,
    });

    expect(scopes.current.map((session) => session.id)).toEqual([sessionId]);
    expect(scopes.all.map((session) => session.id)).toEqual([sessionId]);
    expect(scopes.current[0].sourceWorktreePath).toBeUndefined();
  });

  it('keeps a removed managed-worktree session discoverable without treating it as current', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'removed-feature');
    const sessionId = 'removed-worktree-session';

    await writeSession(worktreePath, sessionId, [
      makeUserMessage(
        sessionId,
        'continue after removing the worktree',
        '2026-05-01T00:00:00Z',
        worktreePath,
      ),
      makeAssistantMessage(
        sessionId,
        'worktree reply',
        '2026-05-01T00:00:05Z',
        worktreePath,
      ),
    ]);
    await writeLegacyWorktreeState(
      new SessionStateStore({ projectRoot: worktreePath, sessionId }),
      {
        originalCwd: tempRepoDir,
        worktreePath,
        worktreeName: 'removed-feature',
        sessionId,
      },
    );

    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(scopes.current).toHaveLength(0);
    expect(scopes.all).toHaveLength(1);
    expect(scopes.all[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: worktreePath,
      sourceWorktreePath: worktreePath,
      displayProjectPath: tempRepoDir,
    });

    const resolved = await resolveSameRepoTranscriptSession(
      tempRepoDir,
      sessionId,
    );
    expect(resolved.sessionInfo.transcriptProjectRoot).toBe(worktreePath);
    expect(resolved.messages).toHaveLength(2);
  });

  it('uses persisted worktree state when a removed-worktree transcript was stored in the main bucket', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'removed-main-bucket');
    const sessionId = 'removed-worktree-main-bucket-session';

    await writeSession(tempRepoDir, sessionId, [
      makeUserMessage(
        sessionId,
        'transcript stayed in the main bucket',
        '2026-05-01T00:00:00Z',
        tempRepoDir,
      ),
    ]);
    await writeLegacyWorktreeState(
      new SessionStateStore({ projectRoot: tempRepoDir, sessionId }),
      {
        originalCwd: tempRepoDir,
        worktreePath,
        worktreeName: 'removed-main-bucket',
        sessionId,
      },
    );

    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(scopes.current).toHaveLength(0);
    expect(scopes.all).toHaveLength(1);
    expect(scopes.all[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: tempRepoDir,
      sourceWorktreePath: worktreePath,
      displayProjectPath: tempRepoDir,
    });
  });

  it('blocks selected legacy resume on unreadable sidecar and remains recoverable after repair', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'sidecar-repair');
    const sessionId = 'sidecar-repair';
    const sessionPath = await writeSession(tempRepoDir, sessionId, [
      makeUserMessage(
        sessionId,
        'resume safely',
        '2026-05-01T00:00:00Z',
        tempRepoDir,
      ),
    ]);
    const stateStore = new SessionStateStore({
      projectRoot: tempRepoDir,
      sessionId,
    });
    await writeLegacyWorktreeState(stateStore, {
      originalCwd: tempRepoDir,
      worktreePath,
      worktreeName: 'sidecar-repair',
      sessionId,
      lifecycle: 'owner',
    });
    const sidecarPath = stateStore.getSessionStatePath();
    const sidecar = await fs.readFile(sidecarPath);
    const transcript = await fs.readFile(sessionPath);
    await fs.writeFile(sidecarPath, '{broken');
    const [listed] = await listSameRepoTranscriptSessions({
      currentProjectRoot: tempRepoDir,
    });
    expect(listed.id).toBe(sessionId);
    await expect(resolveSelectedTranscriptSession(listed)).rejects.toThrow();
    await expect(
      resolveSameRepoTranscriptSession(tempRepoDir, sessionId),
    ).rejects.toThrow();
    expect(await fs.readFile(sessionPath)).toEqual(transcript);
    await fs.writeFile(sidecarPath, sidecar);
    const recovered = await resolveSameRepoTranscriptSession(
      tempRepoDir,
      sessionId,
    );
    expect(recovered.sessionInfo.worktreeSession).toMatchObject({
      worktreePath,
      lifecycle: 'owner',
    });
  });

  it('uses persisted worktree ownership for a main-bucket transcript from any worktree', async () => {
    initGitRepo(tempRepoDir);
    const ownerWorktreePath = addWorktree(tempRepoDir, 'state-owner');
    const peerWorktreePath = addWorktree(tempRepoDir, 'state-peer');
    const sessionId = 'main-bucket-state-owner-session';

    await writeSession(tempRepoDir, sessionId, [
      makeUserMessage(
        sessionId,
        'transcript belongs to the state owner',
        '2026-05-01T00:00:00Z',
        tempRepoDir,
      ),
    ]);
    await writeLegacyWorktreeState(
      new SessionStateStore({ projectRoot: tempRepoDir, sessionId }),
      {
        originalCwd: tempRepoDir,
        worktreePath: ownerWorktreePath,
        worktreeName: 'state-owner',
        sessionId,
      },
    );

    const fromOwner = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: ownerWorktreePath,
    });
    expect(fromOwner.current).toHaveLength(1);
    expect(fromOwner.current[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: tempRepoDir,
      cwd: ownerWorktreePath,
      worktreeSession: {
        originalCwd: tempRepoDir,
        worktreePath: ownerWorktreePath,
        worktreeName: 'state-owner',
        sessionId,
        lifecycle: 'attached',
      },
    });
    expect(fromOwner.current[0].sourceWorktreePath).toBeUndefined();

    const fromPeer = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: peerWorktreePath,
    });
    expect(fromPeer.current).toHaveLength(0);
    expect(fromPeer.all).toHaveLength(1);
    expect(fromPeer.all[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: tempRepoDir,
      sourceWorktreePath: ownerWorktreePath,
    });
  });

  it('does not attribute a removed managed-worktree session to main when another worktree remains', async () => {
    initGitRepo(tempRepoDir);
    const removedWorktreePath = addWorktree(tempRepoDir, 'removed-feature');
    addWorktree(tempRepoDir, 'active-feature');
    const sessionId = 'removed-worktree-with-active-peer';

    await writeSession(removedWorktreePath, sessionId, [
      makeUserMessage(
        sessionId,
        'resume after removing one of several worktrees',
        '2026-05-01T00:00:00Z',
        removedWorktreePath,
      ),
    ]);

    execSync(`git worktree remove --force "${removedWorktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(scopes.current).toHaveLength(0);
    expect(scopes.all).toHaveLength(1);
    expect(scopes.all[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: removedWorktreePath,
      sourceWorktreePath: removedWorktreePath,
    });
  });

  it('treats a session rebound to the original cwd as current while its transcript remains in a removed worktree bucket', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'rebound-feature');
    const sessionId = 'rebound-worktree-session';

    await writeSession(
      worktreePath,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'continue after rebinding to the original cwd',
          '2026-05-01T00:00:00Z',
          worktreePath,
        ),
      ],
      { directories: [worktreePath] },
    );
    const stateStore = new SessionStateStore({
      projectRoot: worktreePath,
      sessionId,
    });
    await writeLegacyWorktreeState(stateStore, {
      originalCwd: tempRepoDir,
      worktreePath,
      worktreeName: 'rebound-feature',
      sessionId,
    });

    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });
    await stateStore.setWorkspaceDirectories([tempRepoDir]);
    await writeLegacyWorktreeState(stateStore, null);

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(scopes.current).toHaveLength(1);
    expect(scopes.current[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: worktreePath,
      displayProjectPath: tempRepoDir,
    });
    expect(scopes.current[0].sourceWorktreePath).toBeUndefined();
    expect(scopes.all).toHaveLength(1);
  });

  it('does not treat a session rebound to main as current from another active worktree', async () => {
    initGitRepo(tempRepoDir);
    const removedWorktreePath = addWorktree(tempRepoDir, 'rebound-to-main');
    const activeWorktreePath = addWorktree(tempRepoDir, 'active-peer');
    const sessionId = 'rebound-main-from-active-peer';

    await writeSession(
      removedWorktreePath,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'stay associated with main',
          '2026-05-01T00:00:00Z',
          removedWorktreePath,
        ),
      ],
      { directories: [removedWorktreePath] },
    );
    const stateStore = new SessionStateStore({
      projectRoot: removedWorktreePath,
      sessionId,
    });
    await writeLegacyWorktreeState(stateStore, {
      originalCwd: tempRepoDir,
      worktreePath: removedWorktreePath,
      worktreeName: 'rebound-to-main',
      sessionId,
    });

    execSync(`git worktree remove --force "${removedWorktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });
    await stateStore.setWorkspaceDirectories([tempRepoDir]);
    await writeLegacyWorktreeState(stateStore, null);

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: activeWorktreePath,
    });

    expect(scopes.current).toHaveLength(0);
    expect(scopes.all).toHaveLength(1);
    expect(scopes.all[0]).toMatchObject({
      id: sessionId,
      displayProjectPath: tempRepoDir,
      sourceWorktreePath: tempRepoDir,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveSameRepoTranscriptSession
// ---------------------------------------------------------------------------

describe('resolveSameRepoTranscriptSession', () => {
  it('preserves the original project after leaving a session retained in its legacy bucket', async () => {
    initGitRepo(tempRepoDir);
    const checkout = addWorktree(tempRepoDir, 'retained');
    const sessionId = randomUUID();
    const sessionPath = await writeSession(
      checkout,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'work in checkout',
          '2026-05-01T00:00:00Z',
          checkout,
        ),
      ],
      {
        directories: [checkout],
        worktreeSession: {
          originalCwd: tempRepoDir,
          worktreePath: checkout,
          worktreeCwd: checkout,
          worktreeName: 'retained',
          sessionId,
          lifecycle: 'attached',
        },
      },
    );
    // Exit 后没有新消息，最后一条消息与物理 bucket 都仍指向旧 checkout。
    await fs.appendFile(
      sessionPath,
      JSON.stringify({
        type: 'worktree-state',
        sessionId,
        timestamp: '2026-05-01T00:01:00Z',
        worktreeSession: null,
      }) + '\n',
    );

    const resolved = await resolveSameRepoTranscriptSession(
      checkout,
      sessionId,
    );

    expect(resolved.sessionPath).toBe(sessionPath);
    expect(resolved.sessionInfo).toMatchObject({
      worktreeSession: null,
      originalCwd: tempRepoDir,
      displayProjectPath: tempRepoDir,
      transcriptProjectRoot: checkout,
    });
  });

  it('resolves an explicitly ordinary UUID from the current bucket without worktree discovery', async () => {
    initGitRepo(tempRepoDir);
    const sessionId = 'session-current-ordinary';
    await writeSession(
      tempRepoDir,
      sessionId,
      [
        makeUserMessage(sessionId, 'hello', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(sessionId, 'hi', '2026-05-01T00:00:05Z'),
      ],
      { worktreeSession: null },
    );
    const debug = vi.spyOn(runLogger, 'debug');

    const result = await resolveSameRepoTranscriptSession(
      tempRepoDir,
      sessionId,
    );

    expect(result.sessionInfo.worktreeSession).toBeNull();
    expect(result.sessionInfo.transcriptProjectRoot).toBe(tempRepoDir);
    expect(debug).not.toHaveBeenCalledWith(
      expect.stringContaining('getSameRepoWorktreePaths'),
    );
  });

  it('resolves an ordinary session saved under a symlinked cwd bucket (logical !== real)', async () => {
    initGitRepo(tempRepoDir);
    // tempRepoDir is already realpath-resolved. Expose it through a symlink to
    // mimic a worker launched with a logical cwd that differs from its realpath.
    const logicalCwd = path.join(
      path.dirname(tempRepoDir),
      `worktree-logical-${randomUUID()}`,
    );
    await fs.symlink(tempRepoDir, logicalCwd, 'dir');
    try {
      const sessionId = randomUUID();
      // No worktreeSession recorded: the session must be found through the
      // same-repo bucket search, which resolves cwd via realpath.
      await writeSession(logicalCwd, sessionId, [
        makeUserMessage(sessionId, 'hello', '2026-05-01T00:00:00Z', logicalCwd),
        makeAssistantMessage(
          sessionId,
          'hi',
          '2026-05-01T00:00:05Z',
          logicalCwd,
        ),
      ]);

      const result = await resolveSameRepoTranscriptSession(
        logicalCwd,
        sessionId,
      );

      expect(result.sessionInfo.id).toBe(sessionId);
      expect(result.sessionInfo.transcriptProjectRoot).toBe(logicalCwd);
    } finally {
      await fs.rm(logicalCwd, { force: true });
    }
  });

  it('resolves a JSONL worktree UUID from the current bucket without reading legacy state', async () => {
    initGitRepo(tempRepoDir);
    const sessionId = 'session-current-worktree';
    const worktreePath = path.join(
      tempRepoDir,
      '.qwen',
      'worktrees',
      'feature',
    );
    const worktreeSession: TranscriptWorktreeSession = {
      originalCwd: tempRepoDir,
      preEnterOriginalCwd: tempRepoDir,
      worktreePath,
      worktreeCwd: worktreePath,
      worktreeName: 'feature',
      sessionId,
      lifecycle: 'owner',
    };
    await writeSession(
      tempRepoDir,
      sessionId,
      [
        makeUserMessage(sessionId, 'hello', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(sessionId, 'hi', '2026-05-01T00:00:05Z'),
      ],
      { worktreeSession },
    );
    await writeLegacyWorktreeState(
      new SessionStateStore({ projectRoot: tempRepoDir, sessionId }),
      {
        originalCwd: '/wrong/source',
        worktreePath: '/wrong/worktree',
        worktreeName: 'wrong',
        sessionId,
      },
    );
    const debug = vi.spyOn(runLogger, 'debug');

    const result = await resolveSameRepoTranscriptSession(
      tempRepoDir,
      sessionId,
    );

    expect(result.sessionInfo.worktreeSession).toEqual(worktreeSession);
    expect(debug).not.toHaveBeenCalledWith(
      expect.stringContaining('getSameRepoWorktreePaths'),
    );
  });

  it('resolves a session from a different worktree by UUID', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const mainSessionId = 'session-main-uuid';

    await writeSession(tempRepoDir, mainSessionId, [
      makeUserMessage(
        mainSessionId,
        'main session content',
        '2026-05-01T00:00:00Z',
      ),
      makeAssistantMessage(mainSessionId, 'response', '2026-05-01T00:00:05Z'),
    ]);

    // Resolve from worktree root — should find the main root session
    const result = await resolveSameRepoTranscriptSession(
      worktreePath,
      mainSessionId,
    );

    expect(result.sessionInfo.id).toBe(mainSessionId);
    expect(result.sessionInfo.transcriptProjectRoot).toBe(tempRepoDir);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('resolves a session by numeric index across worktrees', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const mainSessionId = 'session-main-idx';
    const worktreeSessionId = 'session-wt-idx';

    await writeSession(
      tempRepoDir,
      mainSessionId,
      [
        makeUserMessage(mainSessionId, 'main content', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(
          mainSessionId,
          'main resp',
          '2026-05-01T00:00:05Z',
        ),
      ],
      { mtime: new Date('2026-05-01T00:10:00Z') },
    );

    await writeSession(
      worktreePath,
      worktreeSessionId,
      [
        makeUserMessage(
          worktreeSessionId,
          'wt content',
          '2026-05-02T00:00:00Z',
        ),
        makeAssistantMessage(
          worktreeSessionId,
          'wt resp',
          '2026-05-02T00:00:05Z',
        ),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    // Index 1 should be the most recent (worktree session)
    const result1 = await resolveSameRepoTranscriptSession(worktreePath, '1');
    expect(result1.sessionInfo.id).toBe(worktreeSessionId);

    // Index 2 should be the main session
    const result2 = await resolveSameRepoTranscriptSession(worktreePath, '2');
    expect(result2.sessionInfo.id).toBe(mainSessionId);
  });

  it('preserves runtime config when resolving across same-repo worktrees', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const sessionId = 'session-runtime-config';
    await writeSession(
      tempRepoDir,
      sessionId,
      [
        makeUserMessage(sessionId, 'hello', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(sessionId, 'hi', '2026-05-01T00:00:05Z'),
      ],
      {
        runtimeConfig: {
          model: 'q35model_preview',
          reasoningEffort: null,
          contextWindow: 128000,
        },
      },
    );

    const result = await resolveSameRepoTranscriptSession(
      worktreePath,
      sessionId,
    );

    expect(result.runtimeConfig).toMatchObject({
      model: 'q35model_preview',
      reasoningEffort: null,
      contextWindow: 128000,
    });
  });

  it('throws for invalid session identifier with worktree search info', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    await writeSession(tempRepoDir, 'some-session', [
      makeUserMessage('some-session', 'hello', '2026-05-01T00:00:00Z'),
      makeAssistantMessage('some-session', 'hi', '2026-05-01T00:00:05Z'),
    ]);

    await expect(
      resolveSameRepoTranscriptSession(worktreePath, 'nonexistent-id'),
    ).rejects.toThrow(/Invalid session identifier/);
  });
});

// ---------------------------------------------------------------------------
// resolveLatestSameRepoTranscriptSession
// ---------------------------------------------------------------------------

describe('resolveLatestSameRepoTranscriptSession', () => {
  it('resolves the most recent session across worktrees', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    const mainSessionId = 'session-main-latest';
    const worktreeSessionId = 'session-wt-latest';

    // Main session is older
    await writeSession(
      tempRepoDir,
      mainSessionId,
      [
        makeUserMessage(mainSessionId, 'old main', '2026-05-01T00:00:00Z'),
        makeAssistantMessage(mainSessionId, 'old resp', '2026-05-01T00:00:05Z'),
      ],
      { mtime: new Date('2026-05-01T00:10:00Z') },
    );

    // Worktree session is newer
    await writeSession(
      worktreePath,
      worktreeSessionId,
      [
        makeUserMessage(worktreeSessionId, 'new wt', '2026-05-02T00:00:00Z'),
        makeAssistantMessage(
          worktreeSessionId,
          'new resp',
          '2026-05-02T00:00:05Z',
        ),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    // Query from main repo — should find worktree session as latest
    const result = await resolveLatestSameRepoTranscriptSession(tempRepoDir);

    expect(result.sessionInfo.id).toBe(worktreeSessionId);
    expect(result.sessionInfo.transcriptProjectRoot).toBe(worktreePath);
  });

  it('throws when no sessions exist', async () => {
    await expect(
      resolveLatestSameRepoTranscriptSession('/empty/project'),
    ).rejects.toThrow(/No previous sessions found/);
  });
});

// ---------------------------------------------------------------------------
// isSameOrChildPath
// ---------------------------------------------------------------------------

describe('isSameOrChildPath', () => {
  it('returns true for same path', () => {
    expect(isSameOrChildPath('/tmp/repo', '/tmp/repo')).toBe(true);
  });

  it('returns true for child path', () => {
    expect(isSameOrChildPath('/tmp/repo/packages/foo', '/tmp/repo')).toBe(true);
  });

  it('returns false for sibling path with similar prefix', () => {
    expect(isSameOrChildPath('/tmp/repo-extra', '/tmp/repo')).toBe(false);
  });

  it('returns false for parent path', () => {
    expect(isSameOrChildPath('/tmp', '/tmp/repo')).toBe(false);
  });

  it('returns false for unrelated path', () => {
    expect(isSameOrChildPath('/other/dir', '/tmp/repo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subdirectory bucket discovery
// ---------------------------------------------------------------------------

describe('subdirectory bucket discovery', () => {
  it.each([
    ['managed', false],
    ['managed', true],
    ['clone', true],
    ['directory', true],
    ['removed-linked', true],
  ] as const)(
    'discovers the original bucket for a %s worktree with startup metadata (named=%s)',
    async (kind, named) => {
      initGitRepo(tempRepoDir);
      const originalCwd = path.join(tempRepoDir, 'app');
      await fs.mkdir(originalCwd);
      const checkout = path.join(tempHomeDir, 'checkout');
      if (kind === 'clone') {
        execFileSync('git', ['clone', tempRepoDir, checkout], {
          stdio: 'ignore',
        });
      } else if (kind === 'directory') {
        await fs.mkdir(checkout);
      } else {
        execFileSync(
          'git',
          ['-C', tempRepoDir, 'worktree', 'add', '--detach', checkout],
          { stdio: 'ignore' },
        );
      }
      const runtimeCwd = path.join(checkout, 'app');
      await fs.mkdir(runtimeCwd);
      const sessionId = randomUUID();
      const sessionPath = getSessionTranscriptPath(originalCwd, sessionId);
      const { writer, store } = await createTestTranscriptWriter({
        filePath: sessionPath,
        sessionId,
        cwd: originalCwd,
        entrypoint: 'cli',
        initialWorkspaceDirectories: [originalCwd],
      });
      try {
        await writer.recordRuntimeConfig({ model: 'test-model' });
        await writer.recordWorktreeState(null);
        await writer.recordWorktreeState({
          sessionId,
          originalCwd,
          worktreePath: checkout,
          worktreeCwd: runtimeCwd,
          worktreeName: kind,
          hookBased: kind !== 'managed',
          lifecycle: 'attached',
        });
        if (named) await writer.recordCustomTitle('测试会话');
        await writer.recordMessages([
          makeUserMessage(
            sessionId,
            'hello from worktree',
            new Date().toISOString(),
            runtimeCwd,
          ),
        ]);
      } finally {
        await store.close();
      }
      if (kind === 'removed-linked') {
        execFileSync(
          'git',
          ['-C', tempRepoDir, 'worktree', 'remove', '--force', checkout],
          { stdio: 'ignore' },
        );
      }

      for (const currentProjectRoot of [tempRepoDir, originalCwd]) {
        const sessions = await listSameRepoTranscriptSessions({
          currentProjectRoot,
        });
        expect(
          sessions.find((session) => session.id === sessionId),
        ).toMatchObject({ transcriptProjectRoot: originalCwd });
        expect(
          (await resolveLatestSameRepoTranscriptSession(currentProjectRoot))
            .sessionPath,
        ).toBe(sessionPath);
        expect(
          (
            await resolveSameRepoTranscriptSession(
              currentProjectRoot,
              sessionId,
            )
          ).sessionPath,
        ).toBe(sessionPath);
      }
      expect(
        (await listAllProjectTranscriptSessions()).find(
          (session) => session.id === sessionId,
        ),
      ).toMatchObject({ transcriptProjectRoot: originalCwd });
    },
  );

  it.each(['cwd', 'worktree-state'] as const)(
    'finds a legacy bucket whose matching %s appears after startup metadata',
    async (source) => {
      initGitRepo(tempRepoDir);
      const originalCwd = path.join(tempRepoDir, 'legacy');
      await fs.mkdir(originalCwd);
      const sessionId = randomUUID();
      const sessionPath = await writeSession(
        originalCwd,
        sessionId,
        [
          makeUserMessage(
            sessionId,
            'legacy prompt',
            new Date().toISOString(),
            source === 'cwd' ? originalCwd : '/removed-hook/app',
          ),
        ],
        source === 'cwd'
          ? {}
          : {
              worktreeSession: {
                sessionId,
                originalCwd,
                worktreePath: '/removed-hook',
                worktreeName: 'hook',
                hookBased: true,
              },
            },
      );
      const content = await fs.readFile(sessionPath, 'utf8');
      const metadata = `${JSON.stringify({ type: 'custom-title', sessionId, customTitle: 'legacy title' })}\n`;
      await fs.writeFile(sessionPath, metadata.repeat(6) + content);
      const resolved =
        await resolveLatestSameRepoTranscriptSession(tempRepoDir);
      expect(resolved.sessionPath).toBe(sessionPath);
      expect(resolved.sessionInfo.transcriptProjectRoot).toBe(originalCwd);
    },
  );

  it.each([
    { label: '恢复文件系统根仓库下的子目录会话', independent: false },
    { label: '排除文件系统根仓库下的独立嵌套仓库会话', independent: true },
  ])('$label', async ({ independent }) => {
    // 使用当前平台的根路径：Windows 为盘符根，POSIX 为 /，不修改真实根目录。
    const root = path.parse(tempRepoDir).root;
    const sessionId = randomUUID();
    await writeSession(tempRepoDir, sessionId, [
      makeUserMessage(
        sessionId,
        'root bucket fixture',
        new Date().toISOString(),
        tempRepoDir,
      ),
    ]);
    vi.spyOn(gitUtils, 'resolveGitRepositoryLayout').mockImplementation(
      async (cwd) => {
        const worktreeRoot =
          independent && cwd === tempRepoDir ? tempRepoDir : root;
        return {
          worktreeRoot,
          gitDir: path.join(worktreeRoot, '.git'),
          commonDir: path.join(worktreeRoot, '.git'),
          isWorktree: false,
        };
      },
    );

    const resumed = resolveSameRepoTranscriptSession(root, sessionId);
    if (independent) {
      await expect(resumed).rejects.toThrow(/Invalid session identifier/);
    } else {
      const result = await resumed;
      expect(result.sessionInfo.id).toBe(sessionId);
      expect(result.sessionInfo.transcriptProjectRoot).toBe(tempRepoDir);
    }
  });

  it('discovers subdir bucket and sets transcriptProjectRoot to subdir path', async () => {
    initGitRepo(tempRepoDir);
    // Add a worktree so getSameRepoWorktreePaths returns >1, triggering multi-bucket scan.
    addWorktree(tempRepoDir, 'feature');

    // Create a subdirectory in main repo.
    const subdirPath = path.join(tempRepoDir, 'packages', 'foo');
    await fs.mkdir(subdirPath, { recursive: true });

    // Write a session as if started from the subdirectory.
    const subdirSessionId = 'session-subdir-1';
    await writeSession(subdirPath, subdirSessionId, [
      makeUserMessage(
        subdirSessionId,
        'hello from subdir',
        '2026-05-01T00:00:00Z',
        subdirPath,
      ),
      makeAssistantMessage(
        subdirSessionId,
        'hi subdir',
        '2026-05-01T00:00:05Z',
        subdirPath,
      ),
    ]);

    // Also write a session at the main repo root.
    const mainSessionId = 'session-main-root';
    await writeSession(
      tempRepoDir,
      mainSessionId,
      [
        makeUserMessage(
          mainSessionId,
          'hello from root',
          '2026-05-02T00:00:00Z',
          tempRepoDir,
        ),
        makeAssistantMessage(
          mainSessionId,
          'hi root',
          '2026-05-02T00:00:05Z',
          tempRepoDir,
        ),
      ],
      { mtime: new Date('2026-05-02T00:10:00Z') },
    );

    // Query from main repo root — should discover the subdir bucket too.
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: tempRepoDir,
    });

    // Should find both sessions.
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Find the subdir session.
    const subdirSession = sessions.find((s) => s.id === subdirSessionId);
    expect(subdirSession).toBeDefined();
    // The transcriptProjectRoot should be the subdir path (realpath-resolved).
    expect(subdirSession!.transcriptProjectRoot).toBe(realpathSync(subdirPath));
  });

  it('resolves a Windows subdir session when the bucket root casing differs', async () => {
    initGitRepo(tempRepoDir);
    const subdirPath = path.join(tempRepoDir, 'packages', 'foo');
    await fs.mkdir(subdirPath, { recursive: true });

    const sessionId = 'session-windows-bucket-case';
    const sessionPath = await writeSession(subdirPath, sessionId, [
      makeUserMessage(
        sessionId,
        'hello from mixed-case bucket',
        '2026-05-01T00:00:00Z',
        subdirPath,
      ),
      makeAssistantMessage(
        sessionId,
        'hi from mixed-case bucket',
        '2026-05-01T00:00:05Z',
        subdirPath,
      ),
    ]);
    const caseVariantBucketDir = await renameSessionBucketWithDifferentRootCase(
      tempRepoDir,
      sessionPath,
    );
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const resolved = await resolveSameRepoTranscriptSession(
      tempRepoDir,
      sessionId,
    );

    expect(resolved.sessionPath).toBe(
      path.join(caseVariantBucketDir, `${sessionId}.jsonl`),
    );
    expect(resolved.sessionInfo.transcriptProjectDir).toBe(
      caseVariantBucketDir,
    );
  });

  it('keeps subdir bucket name matching case-sensitive off Windows', async () => {
    initGitRepo(tempRepoDir);
    const subdirPath = path.join(tempRepoDir, 'packages', 'foo');
    await fs.mkdir(subdirPath, { recursive: true });

    const sessionId = 'session-linux-bucket-case';
    const sessionPath = await writeSession(subdirPath, sessionId, [
      makeUserMessage(
        sessionId,
        'hello from case-distinct bucket',
        '2026-05-01T00:00:00Z',
        subdirPath,
      ),
    ]);
    await renameSessionBucketWithDifferentRootCase(tempRepoDir, sessionPath);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    await expect(
      resolveSameRepoTranscriptSession(tempRepoDir, sessionId),
    ).rejects.toThrow(/Invalid session identifier/);
  });
});

// ---------------------------------------------------------------------------
// Sibling false positive prevention
// ---------------------------------------------------------------------------

describe('sibling false positive prevention', () => {
  it('does not include sibling project bucket with similar sanitized prefix', async () => {
    initGitRepo(tempRepoDir);
    // Add a worktree so getSameRepoWorktreePaths returns >1, triggering multi-bucket scan.
    addWorktree(tempRepoDir, 'feature');

    // Create a sibling directory that shares the same sanitized prefix pattern.
    // e.g., if tempRepoDir is /tmp/worktree-repo-xxx, create /tmp/worktree-repo-xxx-extra
    // as a separate non-git project.
    const siblingDir = tempRepoDir + '-extra';
    await fs.mkdir(siblingDir, { recursive: true });

    // Write a session in the sibling dir (simulates a separate project).
    const siblingSessionId = 'session-sibling-1';
    await writeSession(siblingDir, siblingSessionId, [
      makeUserMessage(
        siblingSessionId,
        'hello from sibling',
        '2026-05-03T00:00:00Z',
        siblingDir,
      ),
      makeAssistantMessage(
        siblingSessionId,
        'hi sibling',
        '2026-05-03T00:00:05Z',
        siblingDir,
      ),
    ]);

    // Write a session in the real repo.
    const mainSessionId = 'session-main-only';
    await writeSession(tempRepoDir, mainSessionId, [
      makeUserMessage(mainSessionId, 'hello from main', '2026-05-01T00:00:00Z'),
      makeAssistantMessage(mainSessionId, 'hi', '2026-05-01T00:00:05Z'),
    ]);

    // Query from the real repo — sibling bucket should NOT appear.
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: tempRepoDir,
    });

    const siblingSession = sessions.find((s) => s.id === siblingSessionId);
    expect(siblingSession).toBeUndefined();

    // Main session should still be found.
    const mainSession = sessions.find((s) => s.id === mainSessionId);
    expect(mainSession).toBeDefined();

    // Cleanup sibling.
    await fs.rm(siblingDir, { recursive: true, force: true });
  });

  it('does not include a nested independent Git repository', async () => {
    initGitRepo(tempRepoDir);
    const nestedRepoDir = path.join(tempRepoDir, 'vendor', 'independent');
    await fs.mkdir(nestedRepoDir, { recursive: true });
    initGitRepo(nestedRepoDir);

    const nestedSessionId = 'session-nested-independent';
    await writeSession(nestedRepoDir, nestedSessionId, [
      makeUserMessage(
        nestedSessionId,
        'hello from nested independent repository',
        '2026-05-03T00:00:00Z',
        nestedRepoDir,
      ),
    ]);

    const scopes = await listSameRepoTranscriptSessionScopes({
      currentProjectRoot: tempRepoDir,
    });

    expect(
      scopes.current.some((session) => session.id === nestedSessionId),
    ).toBe(false);
    expect(scopes.all.some((session) => session.id === nestedSessionId)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Nested worktree longest-match
// ---------------------------------------------------------------------------

describe('nested worktree longest-match ownership', () => {
  it('assigns ownerWorktreePath to the most specific worktree', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'feature');

    // Create a subdirectory inside the worktree (not main repo).
    const wtSubdir = path.join(worktreePath, 'packages', 'bar');
    await fs.mkdir(wtSubdir, { recursive: true });

    // Write a session as if started from the worktree subdirectory.
    const wtSubdirSessionId = 'session-wt-subdir';
    await writeSession(wtSubdir, wtSubdirSessionId, [
      makeUserMessage(
        wtSubdirSessionId,
        'hello from wt subdir',
        '2026-05-01T00:00:00Z',
        wtSubdir,
      ),
      makeAssistantMessage(
        wtSubdirSessionId,
        'hi wt subdir',
        '2026-05-01T00:00:05Z',
        wtSubdir,
      ),
    ]);

    // Query from main repo — should discover the worktree subdir session.
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: tempRepoDir,
    });

    const wtSubdirSession = sessions.find((s) => s.id === wtSubdirSessionId);
    expect(wtSubdirSession).toBeDefined();
    // transcriptProjectRoot should be the worktree subdir (cwd), not main repo root.
    expect(wtSubdirSession!.transcriptProjectRoot).toBe(realpathSync(wtSubdir));
    // sourceWorktreePath should indicate it came from the feature worktree, not main repo.
    // Since main repo is currentProjectRoot and the session belongs to the feature worktree,
    // it should be marked as cross-worktree.
    expect(wtSubdirSession!.sourceWorktreePath).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Long path (>MAX_SANITIZED_LENGTH) subdir bucket discovery
// ---------------------------------------------------------------------------

describe('long path hashed bucket discovery', () => {
  it('discovers subdir bucket when paths exceed MAX_SANITIZED_LENGTH', async () => {
    initGitRepo(tempRepoDir);
    addWorktree(tempRepoDir, 'feature');

    // Create a deeply nested subdirectory that, when combined with tempRepoDir,
    // produces a sanitized path exceeding 200 characters.
    const deepSegment = 'a'.repeat(30);
    const deepSubdir = path.join(
      tempRepoDir,
      deepSegment,
      deepSegment,
      deepSegment,
      deepSegment,
      deepSegment,
      'leaf',
    );
    await fs.mkdir(deepSubdir, { recursive: true });

    // Verify the sanitized path actually exceeds MAX_SANITIZED_LENGTH.
    const { sanitizePath: sp } = await import('../utils/paths.js');
    const sanitized = deepSubdir.replace(/[^a-zA-Z0-9]/g, '-');
    expect(sanitized.length).toBeGreaterThan(200);
    // Confirm that sanitizePath produces a hashed result.
    const bucketName = sp(deepSubdir);
    expect(bucketName.length).toBeLessThanOrEqual(200 + 1 + 10); // truncated + '-' + hash

    // Write a session in the deep subdir bucket.
    const deepSessionId = 'session-deep-subdir';
    await writeSession(deepSubdir, deepSessionId, [
      makeUserMessage(
        deepSessionId,
        'hello from deep',
        '2026-05-01T00:00:00Z',
        deepSubdir,
      ),
      makeAssistantMessage(
        deepSessionId,
        'hi deep',
        '2026-05-01T00:00:05Z',
        deepSubdir,
      ),
    ]);

    // Query from main repo root — should discover the deep subdir bucket.
    const sessions = await listSameRepoTranscriptSessions({
      currentProjectRoot: tempRepoDir,
    });

    const deepSession = sessions.find((s) => s.id === deepSessionId);
    expect(deepSession).toBeDefined();
    expect(deepSession!.transcriptProjectRoot).toBe(realpathSync(deepSubdir));
  });
});

// ---------------------------------------------------------------------------
// All-project session discovery
// ---------------------------------------------------------------------------

describe('all-project session discovery', () => {
  it('keeps explicit ordinary JSONL state authoritative over a legacy sidecar', async () => {
    const project = path.join(tempRepoDir, 'explicit-ordinary');
    await fs.mkdir(project, { recursive: true });
    await writeSession(
      project,
      'ordinary-session',
      [
        makeUserMessage(
          'ordinary-session',
          'ordinary session',
          '2026-05-01T00:00:00Z',
          project,
        ),
      ],
      { worktreeSession: null },
    );
    await writeLegacyWorktreeState(
      new SessionStateStore({
        projectRoot: project,
        sessionId: 'ordinary-session',
      }),
      {
        originalCwd: tempRepoDir,
        worktreePath: project,
        worktreeName: 'stale-worktree',
        sessionId: 'ordinary-session',
      },
    );

    const sessions = await listAllProjectTranscriptSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'ordinary-session',
      displayProjectPath: realpathSync(project),
      worktreeSession: null,
    });
  });

  it('shows the rebound project path when transcript storage remains under a removed worktree bucket', async () => {
    initGitRepo(tempRepoDir);
    const worktreePath = addWorktree(tempRepoDir, 'all-project-rebound');
    const sessionId = 'all-project-rebound-session';

    await writeSession(
      worktreePath,
      sessionId,
      [
        makeUserMessage(
          sessionId,
          'show the rebound project path',
          '2026-05-01T00:00:00Z',
          worktreePath,
        ),
      ],
      { directories: [worktreePath] },
    );
    const stateStore = new SessionStateStore({
      projectRoot: worktreePath,
      sessionId,
    });
    await writeLegacyWorktreeState(stateStore, {
      originalCwd: tempRepoDir,
      worktreePath,
      worktreeName: 'all-project-rebound',
      sessionId,
    });

    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: tempRepoDir,
      stdio: 'ignore',
    });
    await stateStore.setWorkspaceDirectories([tempRepoDir]);
    await writeLegacyWorktreeState(stateStore, null);

    const sessions = await listAllProjectTranscriptSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      transcriptProjectRoot: worktreePath,
      displayProjectPath: tempRepoDir,
    });
  });

  it('lists identifiable project buckets, skips damaged buckets, and sorts by update time', async () => {
    const projectA = path.join(tempRepoDir, 'project-a');
    const projectB = path.join(tempRepoDir, 'project-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    await writeSession(
      projectA,
      'session-a',
      [
        makeUserMessage(
          'session-a',
          'project a',
          '2026-05-01T00:00:00Z',
          projectA,
        ),
      ],
      { mtime: new Date('2026-05-01T00:00:00Z') },
    );
    await writeLegacyWorktreeState(
      new SessionStateStore({ projectRoot: projectA, sessionId: 'session-a' }),
      {
        originalCwd: tempRepoDir,
        worktreePath: projectA,
        worktreeName: 'project-a-worktree',
        sessionId: 'session-a',
      },
    );
    await writeSession(
      projectB,
      'session-b',
      [
        makeUserMessage(
          'session-b',
          'project b',
          '2026-05-02T00:00:00Z',
          projectB,
        ),
      ],
      { mtime: new Date('2026-05-02T00:00:00Z') },
    );

    const damagedBucket = path.join(getTranscriptProjectsDir(), 'damaged');
    await fs.mkdir(damagedBucket, { recursive: true });
    await fs.writeFile(
      path.join(damagedBucket, 'broken.jsonl'),
      '{not-json}\n',
      'utf8',
    );

    const sessions = await listAllProjectTranscriptSessions();

    expect(sessions.map((session) => session.id)).toEqual([
      'session-b',
      'session-a',
    ]);
    expect(sessions[0]).toMatchObject({
      index: 1,
      transcriptProjectRoot: realpathSync(projectB),
      sessionPath: getSessionTranscriptPath(projectB, 'session-b'),
    });
    expect(sessions[1]).toMatchObject({
      index: 2,
      transcriptProjectRoot: realpathSync(projectA),
      displayProjectPath: tempRepoDir,
      sessionPath: getSessionTranscriptPath(projectA, 'session-a'),
      worktreeSession: {
        originalCwd: tempRepoDir,
        worktreePath: projectA,
        worktreeName: 'project-a-worktree',
        sessionId: 'session-a',
        lifecycle: 'attached',
      },
    });
  });

  it('resolves the exact selected transcript path even when another project reuses the session id', async () => {
    const projectA = path.join(tempRepoDir, 'selected-a');
    const projectB = path.join(tempRepoDir, 'selected-b');
    await fs.mkdir(projectA, { recursive: true });
    await fs.mkdir(projectB, { recursive: true });

    await writeSession(projectA, 'shared-session', [
      makeUserMessage(
        'shared-session',
        'selected project a',
        '2026-05-01T00:00:00Z',
        projectA,
      ),
    ]);
    const selected = (await listAllProjectTranscriptSessions()).find(
      (session) => session.transcriptProjectRoot === realpathSync(projectA),
    );
    expect(selected).toBeDefined();

    await writeSession(projectB, 'shared-session', [
      makeUserMessage(
        'shared-session',
        'different project b',
        '2026-05-02T00:00:00Z',
        projectB,
      ),
    ]);

    const resolved = await resolveSelectedTranscriptSession(selected!);

    expect(resolved.sessionPath).toBe(
      getSessionTranscriptPath(projectA, 'shared-session'),
    );
    expect(resolved.messages[0]).toMatchObject({
      type: 'user',
      message: { content: 'selected project a' },
    });
  });
});
