import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import {
  createWorktreeSessionMarkerExclusive,
  GitWorktreeService,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  writeWorktreeSession,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import type { AcpSessionBridge } from '../serve/acp-session-bridge.js';
import type { SessionArchiveState } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../serve/workspace-registry.js';

export interface RetentionTestRuntime {
  runtime: WorkspaceRuntime;
  repo: string;
  head: string;
  service: SessionService;
  git: GitWorktreeService;
  home: string;
}

function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

export function makeRetentionRepo(
  root: string,
  name: string,
): RetentionTestRuntime {
  const repo = path.join(root, `repo-${name}`);
  const home = path.join(root, `home-${name}`);
  const runtimeBaseDir = path.join(root, `storage-${name}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  git(repo, home, 'init', '-q');
  git(repo, home, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, home, 'config', 'user.name', 'Retention Test');
  git(repo, home, 'config', 'user.email', 'retention@example.invalid');
  git(repo, home, 'config', 'commit.gpgsign', 'false');
  git(repo, home, 'config', 'core.fileMode', 'true');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), `base-${name}\n`);
  fs.writeFileSync(path.join(repo, 'delete-me.txt'), 'removed-in-snapshot\n');
  git(repo, home, 'add', '.');
  git(repo, home, 'commit', '-qm', 'initial', '--no-verify');
  const head = git(repo, home, 'rev-parse', 'HEAD');
  const runtimeBase = runtimeBaseDir;
  const runtime = {
    workspaceId: name,
    workspaceCwd: repo,
    primary: name === 'primary',
    trusted: true,
    removable: true,
    sessionRuntimeBaseDir: runtimeBase,
    generationGuard: createWorkspaceGenerationGuard(),
    env: {
      mode: 'parent-process',
      overlayKeys: [],
      effectiveEnv: {
        PATH: process.env['PATH'],
        HOME: home,
        QWEN_HOME: path.join(home, '.qwen'),
        QWEN_RUNTIME_DIR: runtimeBase,
        LC_ALL: 'C.UTF-8',
      },
    },
    bridge: {
      getSessionSummary: () => {
        const error = new Error('Offline retained session');
        Object.assign(error, {
          name: 'SessionNotFoundError',
          code: 'session_not_found',
        });
        throw error;
      },
    } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    repo,
    head,
    service: new SessionService(repo, { runtimeBaseDir }),
    git: new GitWorktreeService(repo),
    home,
  };
}

export async function makeRetainedSession(
  target: RetentionTestRuntime,
  options: {
    slug: string;
    dirty?: boolean;
    branch?: string;
    activity?: string;
    archiveState?: SessionArchiveState;
  },
): Promise<{
  id: string;
  worktreePath: string;
  sidecarPath: string;
  transcriptPath: string;
  sidecar: WorktreeSession;
}> {
  const { repo, head, home, git: serviceRoot, service } = target;
  const slug = options.slug;
  const created = await serviceRoot.createUserWorktree(slug, head, {
    detached: true,
  });
  if (!created.success || !created.worktree) {
    throw new Error(created.error ?? `Could not create fixture ${slug}`);
  }
  const worktreePath = created.worktree.path;
  const sessionId = randomUUID();
  const archiveState = options.archiveState ?? 'active';
  const branch = options.branch ?? '';
  if (branch) git(worktreePath, home, 'checkout', '-b', branch);
  if (options.dirty) {
    const tracked = path.join(worktreePath, 'tracked.txt');
    fs.writeFileSync(tracked, `dirty-${slug}\n`);
    fs.chmodSync(tracked, 0o755);
    fs.writeFileSync(
      path.join(worktreePath, 'untracked.bin'),
      Buffer.from([0, 1, 2, 255]),
    );
    fs.rmSync(path.join(worktreePath, 'delete-me.txt'));
  }
  await createWorktreeSessionMarkerExclusive(worktreePath, sessionId);
  const sidecar: WorktreeSession = {
    slug,
    worktreePath,
    worktreeBranch: branch,
    originalCwd: repo,
    workspaceCwd: repo,
    originalBranch: 'main',
    originalHeadCommit: head,
    worktreeBase: head,
  };
  const sidecarPath = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    archiveState,
  );
  await writeWorktreeSession(sidecarPath, sidecar);
  const transcriptPath = path.join(
    path.dirname(sidecarPath),
    `${sessionId}.jsonl`,
  );
  const activity = options.activity ?? new Date().toISOString();
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      version: 1,
      sessionId,
      cwd: worktreePath,
      type: 'user',
      role: 'user',
      timestamp: activity,
      content: `fixture prompt for ${slug}`,
    }) + '\n',
  );
  await service.setLastUserPromptAt(sessionId, activity);
  fs.utimesSync(transcriptPath, new Date(activity), new Date(activity));
  fs.utimesSync(sidecarPath, new Date(activity), new Date(activity));
  return { id: sessionId, worktreePath, sidecarPath, transcriptPath, sidecar };
}

export function configureRetention(
  target: RetentionTestRuntime,
  value: unknown,
): void {
  const dir = path.join(target.repo, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    value === 'raw'
      ? '{not-json'
      : JSON.stringify({ $version: 4, worktree: { maxRetained: value } }),
  );
}
