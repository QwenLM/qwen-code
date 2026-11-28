/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from "../config/brand.js";

import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_NAME } from '../config/brand.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { Entry } from '../protocol/transcript/entry.js';
import { TranscriptStore } from '../services/transcript/store.js';
import type { TranscriptWriterHandle } from '../services/transcript/writer-handle.js';
import { getSessionTranscriptPath } from '../services/transcript-paths.js';
import {
  cleanupStaleAgentWorktrees,
  createAgentWorktree,
  removeAgentWorktree,
} from '../services/worktreeService.js';
import { currentCwdForTest, resetForTest } from '../utils/Shell.js';
import { resolveAgentWorktreeProjectRoot } from '../agents/run-agent.js';
import {
  claimWorktreeOwnership,
  readWorktreeOwnerState,
} from '../services/worktree-owner-state.js';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitWorktreeTool } from './exitWorktree.js';
import { ShellTool } from './shell.js';
import {
  worktreeSessionService,
  toTranscriptWorktreeSession,
  releasePersistedWorktreeSessionOwnership,
} from '../services/worktreeSessionService.js';
import {
  resolveTranscriptSessionById,
  listTranscriptSessions,
} from '../services/transcriptSessionService.js';
import { TranscriptRepository } from '../services/transcript/repository.js';
import * as worktreeService from '../services/worktreeService.js';
import * as worktreeOwnerState from '../services/worktree-owner-state.js';
import { FileHistoryManager } from '../file-history/file-history.js';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { withWorktreeReservation } from '../services/worktree/creationReservation.js';
import * as worktreeReservation from '../services/worktree/creationReservation.js';
import { Storage } from '../config/storage.js';
import { SessionStateStore } from '../services/session-state-store.js';
import { resolveSelectedTranscriptSession } from '../services/worktree-discovery.js';
import { migrateLegacyWorktreeTranscript } from '../services/legacyWorktreeTranscriptMigration.js';

const ORIGINAL_PROCESS_CWD = process.cwd();

describe('worktree session runtime integration', () => {
  let tempRoot: string;
  let repoRoot: string;
  let configHome: string;
  let store: TranscriptStore | undefined;
  let writer: TranscriptWriterHandle | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'worktree-runtime-integration-'),
    );
    tempRoot = await fs.realpath(tempRoot);
    repoRoot = path.join(tempRoot, 'repo');
    configHome = path.join(tempRoot, 'config');
    await fs.mkdir(repoRoot, { recursive: true });
    repoRoot = await fs.realpath(repoRoot);
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test-user@example.com',
        'commit',
        '-m',
        'initial',
      ],
      { cwd: repoRoot, stdio: 'ignore' },
    );

    process.chdir(repoRoot);
    resetForTest(repoRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (writer) {
      await writer.close().catch(() => undefined);
      writer = undefined;
    }
    if (store) {
      await store.close().catch(() => undefined);
      store = undefined;
    }
    process.chdir(ORIGINAL_PROCESS_CWD);
    resetForTest(ORIGINAL_PROCESS_CWD);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function createRuntime(
    sessionId: string = randomUUID(),
    acpMode = false,
    transcriptProjectRoot = repoRoot,
    enableHooks = acpMode,
  ) {
    const homeTranscriptPath = getSessionTranscriptPath(
      transcriptProjectRoot,
      sessionId,
      configHome,
    );
    store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    writer = await store.acquireSessionWriter({
      filePath: homeTranscriptPath,
      sessionId,
      cwd: repoRoot,
      gitBranch: 'main',
      entrypoint: 'cli',
      version: 'integration-test',
    });
    const activeWriter = writer;
    const config = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
      transcriptStore: store,
      acpMode,
      enableHooks,
    });
    config.registerSessionRuntimeBinding({
      getTranscriptPath: () => activeWriter.getSessionFilePath(),
      refreshRuntimeContext: async () => undefined,
      synchronizeWorktreeRuntimeState: (state) =>
        activeWriter.synchronizeWorktreeRuntimeState(state),
      recordWorktreeState: async (state) => {
        await activeWriter.recordWorktreeState(state);
      },
    });
    return { config, homeTranscriptPath, sessionId };
  }

  async function createNestedCheckout(projectRoot: string, target: string) {
    const nestedRepo = path.join(projectRoot, 'nested');
    await fs.mkdir(nestedRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: nestedRepo,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test-user@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: nestedRepo, stdio: 'ignore' },
    );
    execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
      cwd: nestedRepo,
      stdio: 'ignore',
    });
    return nestedRepo;
  }

  it.each(['writeFile', 'sync', 'close'] as const)(
    'does not leave an owner after a partial metadata %s failure',
    async (failurePoint) => {
      const { config, homeTranscriptPath, sessionId } = await createRuntime(
        undefined,
        true,
      );
      await writer!.recordWorktreeState(null);
      await writer!.flush();
      const prepared = await worktreeSessionService.prepare(
        { sessionId },
        {
          kind: 'create',
          name: 'failed-claim',
          originalCwd: repoRoot,
          projectRoot: repoRoot,
          options: { baseRef: 'head' },
        },
      );
      const open = fs.open;
      vi.spyOn(nativeFs.promises, 'open').mockImplementation(
        async (...args) => {
          const handle = await open(...args);
          if (
            String(args[0]).endsWith('qwen-worktree.json') &&
            args[1] === 'wx'
          ) {
            const close = handle.close.bind(handle);
            const writeFile = handle.writeFile.bind(handle);
            vi.spyOn(handle, failurePoint).mockImplementation(async () => {
              if (failurePoint === 'writeFile') await writeFile('{', 'utf8');
              if (failurePoint === 'close') await close();
              throw Object.assign(new Error('owner metadata I/O failure'), {
                code: 'EIO',
              });
            });
          }
          return handle;
        },
      );
      syncBuiltinESMExports();

      await expect(
        worktreeSessionService.enter(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          prepared,
        ),
      ).rejects.toThrow('Cannot verify worktree ownership');

      expect(
        await worktreeOwnerState.inspectWorktreeOwnership(
          prepared.settings.path,
          sessionId,
        ),
      ).toBe('not-owned');
      expect(config.getWorkingDir()).toBe(repoRoot);
      const index = await store!.repository().loadIndex(homeTranscriptPath);
      expect(index!.metadata.worktreeSessions.get(sessionId)).toBeNull();
    },
  );

  it('retains ownership recovery evidence when failed metadata writes cannot be cleaned up', async () => {
    const { config, homeTranscriptPath, sessionId } = await createRuntime(
      undefined,
      true,
    );
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      {
        kind: 'create',
        name: 'retained-claim',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
        options: { baseRef: 'head' },
      },
    );
    const open = fs.open;
    const unlink = fs.unlink;
    vi.spyOn(nativeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('qwen-worktree.json') && args[1] === 'wx') {
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('owner sync failed'), { code: 'EIO' }),
        );
      }
      return handle;
    });
    vi.spyOn(nativeFs.promises, 'unlink').mockImplementation(async (file) => {
      if (String(file).endsWith('qwen-worktree.json')) {
        throw Object.assign(new Error('owner cleanup denied'), {
          code: 'EACCES',
        });
      }
      return unlink(file);
    });
    syncBuiltinESMExports();

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        prepared,
      ),
    ).resolves.toMatchObject({
      worktreeCwd: prepared.settings.worktreeCwd,
      entryWarning: expect.stringMatching(/checkout retained/i),
    });

    const index = await store!.repository().loadIndex(homeTranscriptPath);
    const state = index!.metadata.worktreeSessions.get(sessionId);
    expect(state).toMatchObject({
      worktreePath: prepared.settings.path,
      sessionId,
      lifecycle: 'owner',
    });
    expect(config.getWorkingDir()).toBe(prepared.settings.worktreeCwd);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        state!,
      ),
    ).resolves.toMatchObject({
      status: 'restored',
      settings: { lifecycle: 'owner' },
    });
  });

  it.each(['before-claim', 'after-claim'] as const)(
    'recovers the checkout after a process dies %s without losing ownership evidence',
    async (crashPoint) => {
      const sessionId = randomUUID();
      const transcriptPath = getSessionTranscriptPath(
        repoRoot,
        sessionId,
        configHome,
      );
      const source = new URL('../', import.meta.url).href;
      // 在真实 owner 文件的创建/落盘边界杀死独立进程，避免 catch 补偿掩盖崩溃窗口。
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          createRequire(import.meta.url).resolve('tsx'),
          '--input-type=module',
          '-e',
          `
          import fs from 'node:fs';
          import { createRequire, syncBuiltinESMExports } from 'node:module';
          import { makeFakeConfig } from ${JSON.stringify(source + 'test-utils/config.ts')};
          import { TranscriptStore } from ${JSON.stringify(source + 'services/transcript/store.ts')};
          import { worktreeSessionService } from ${JSON.stringify(source + 'services/worktreeSessionService.ts')};
          const project = ${JSON.stringify(repoRoot)};
          const sessionId = ${JSON.stringify(sessionId)};
          const store = new TranscriptStore({coordinatorOptions: {flushIntervalMs: 0}});
          const writer = await store.acquireSessionWriter({
            filePath: ${JSON.stringify(transcriptPath)}, sessionId, cwd: project,
            entrypoint: 'cli', gitBranch: 'main',
          });
          await writer.recordWorktreeState(null);
          await writer.flush();
          const config = makeFakeConfig({sessionId, targetDir: project, cwd: project, acpMode: true, transcriptStore: store});
          config.registerSessionRuntimeBinding({
            getTranscriptPath: () => writer.getSessionFilePath(),
            synchronizeWorktreeRuntimeState: state => writer.synchronizeWorktreeRuntimeState(state),
          });
          const prepared = await worktreeSessionService.prepare({sessionId}, {
            kind: 'create', name: 'crash-entry', originalCwd: project, projectRoot: project,
            options: {baseRef: 'head'},
          });
          const open = fs.promises.open;
          const crash = () => {
            // 模拟异常退出后已过租期；不让恢复测试真实等待一分钟。
            const { getLocks } = createRequire(${JSON.stringify(import.meta.url)})('proper-lockfile/lib/lockfile.js');
            for (const lockPath of Object.keys(getLocks())) fs.utimesSync(lockPath + '.lock', 0, 0);
            process.kill(process.pid, 'SIGKILL');
          };
          fs.promises.open = async (...args) => {
            const isOwner = String(args[0]).endsWith('qwen-worktree.json') && args[1] === 'wx';
            if (isOwner && ${JSON.stringify(crashPoint)} === 'before-claim') crash();
            const handle = await open(...args);
            if (isOwner) {
              const close = handle.close.bind(handle);
              handle.close = async () => {
                await close();
                crash();
              };
            }
            return handle;
          };
          syncBuiltinESMExports();
          await worktreeSessionService.enter({config, sessionId, phase: 'runtime',
            recordWorktreeState: (...args) => writer.recordWorktreeState(...args)}, prepared);
        `,
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 },
      );
      expect(child).toMatchObject({ signal: 'SIGKILL' });

      const { config } = await createRuntime(sessionId, true);
      try {
        const index = await store!.repository().loadIndex(transcriptPath);
        const persisted = index!.metadata.worktreeSessions.get(sessionId);
        expect(persisted).toMatchObject({
          worktreePath: path.join(
            repoRoot,
            '.qwen',
            'worktrees',
            'crash-entry',
          ),
          sessionId,
        });
        const restored = await worktreeSessionService.restore(
          {
            config,
            sessionId,
            phase: 'restore',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          persisted!,
        );
        expect(restored).toMatchObject({
          status: 'restored',
          settings: {
            lifecycle: crashPoint === 'after-claim' ? 'owner' : 'attached',
          },
        });
        await worktreeSessionService.leave(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          { action: 'keep' },
        );
        expect(
          await readWorktreeOwnerState(persisted!.worktreePath),
        ).toBeNull();
      } finally {
        await config.dispose();
      }
    },
  );

  it.each([
    'repository',
    'subdirectory',
    'non-git',
    'legacy-subdirectory',
  ] as const)(
    'restores a nested repository checkout entered from a %s project',
    async (projectKind) => {
      if (projectKind !== 'repository') {
        repoRoot =
          projectKind === 'non-git'
            ? path.join(tempRoot, 'workspace')
            : path.join(repoRoot, 'apps');
        await fs.mkdir(repoRoot);
      }
      const target = path.join(tempRoot, 'nested-checkout');
      await createNestedCheckout(repoRoot, target);
      if (projectKind === 'legacy-subdirectory') {
        // 即使目标巧合地存在同名目录，也不能套用外层仓库的相对路径。
        await fs.mkdir(path.join(target, 'apps'));
      }
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      try {
        const entered = await new EnterWorktreeTool(config)
          .build({ path: target })
          .execute(new AbortController().signal);
        expect(entered.error).toBeUndefined();
        expect(config.getWorkingDir()).toBe(target);
        const state = toTranscriptWorktreeSession(
          config.getWorktreeSettings()!,
          sessionId,
        );
        if (projectKind === 'legacy-subdirectory') delete state.worktreeCwd;
        const context = {
          config,
          sessionId,
          phase: 'runtime' as const,
          recordWorktreeState: (
            ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
          ) => writer!.recordWorktreeState(...args),
        };
        await worktreeSessionService.leave(context, { action: 'keep' });
        const restored = await worktreeSessionService.restore(
          { ...context, phase: 'restore' },
          state,
        );
        expect(restored).toMatchObject({ status: 'restored' });
        expect(config.getWorktreeSettings()).toMatchObject({
          originalCwd: repoRoot,
          worktreeCwd: target,
          lifecycle: 'attached',
        });
        expect(writer!.getSessionFilePath()).toBe(homeTranscriptPath);
      } finally {
        await config.dispose();
      }
    },
  );

  it('settles a nested repository owner handoff when restoring an attached checkout', async () => {
    const previous = path.join(tempRoot, 'previous');
    const target = path.join(tempRoot, 'target');
    const nestedRepo = await createNestedCheckout(repoRoot, previous);
    execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
      cwd: nestedRepo,
      stdio: 'ignore',
    });
    const { config, sessionId } = await createRuntime();
    try {
      await claimWorktreeOwnership(previous, sessionId);
      const result = await worktreeSessionService.restore(
        {
          config,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        {
          sessionId,
          originalCwd: repoRoot,
          worktreeName: 'target',
          worktreePath: target,
          worktreeCwd: target,
          lifecycle: 'attached',
          enteredExisting: true,
          pendingOwnerReleasePath: previous,
        },
      );
      expect(result).toMatchObject({ status: 'restored' });
      expect(await readWorktreeOwnerState(previous)).toBeNull();
      expect(config.getWorktreeSettings()).toMatchObject({
        lifecycle: 'attached',
      });
      expect(
        config.getWorktreeSettings()?.pendingOwnerReleasePath,
      ).toBeUndefined();
    } finally {
      await config.dispose();
    }
  });

  it.each(['keep', 'switch'] as const)(
    '%s removes an aliased Hook checkout and its children from the runtime workspace',
    async (operation) => {
      const { config, sessionId } = await createRuntime();
      const checkout = path.join(tempRoot, 'hook-checkout');
      const alias = path.join(tempRoot, 'hook-alias');
      const extra = path.join(tempRoot, 'extra');
      await fs.mkdir(extra);
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      try {
        const prepared = await worktreeSessionService.prepare(
          {
            sessionId,
            createHookAdapter: {
              hasWorktreeCreateHook: () => true,
              executeWorktreeCreateHook: async () => {
                execFileSync(
                  'git',
                  ['worktree', 'add', '--detach', checkout, 'HEAD'],
                  {
                    cwd: repoRoot,
                    stdio: 'ignore',
                  },
                );
                await fs.symlink(checkout, alias, 'dir');
                return { worktreePath: alias };
              },
            },
          },
          {
            kind: 'create',
            name: 'hook-alias',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        await worktreeSessionService.enter(context, prepared);
        const nested = path.join(checkout, 'nested');
        await fs.mkdir(nested);
        config.getWorkspaceContext().addDirectory(nested);
        config.getWorkspaceContext().addDirectory(extra);

        let expectedCwd = repoRoot;
        if (operation === 'keep') {
          await worktreeSessionService.leave(context, { action: 'keep' });
        } else {
          const next = await worktreeSessionService.prepare(
            { sessionId, activeWorktreeSettings: config.getWorktreeSettings() },
            {
              kind: 'create',
              name: 'next',
              originalCwd: repoRoot,
              projectRoot: repoRoot,
              options: { baseRef: 'head' },
            },
          );
          expectedCwd = (await worktreeSessionService.enter(context, next))
            .worktreeCwd;
        }
        expect(config.getWorkingDir()).toBe(expectedCwd);
        expect(config.getSessionArtifactProjectRoot()).toBe(repoRoot);
        expect(
          [...config.getWorkspaceContext().getDirectories()].sort(),
        ).toEqual([expectedCwd, extra].sort());
      } finally {
        await config.dispose();
      }
    },
  );

  it('settles the registered owner when switching away from a manually deleted checkout', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime(
      undefined,
      true,
    );
    try {
      const entered = await new EnterWorktreeTool(config)
        .build({ name: 'deleted-before-switch' })
        .execute(new AbortController().signal);
      expect(entered.error).toBeUndefined();
      const previous = config.getWorktreeSettings()!;
      const layout = (await resolveGitRepositoryLayout(previous.path))!;
      const ownerPath = path.join(layout.gitDir, 'qwen-worktree.json');
      await fs.rm(previous.path, { recursive: true });

      const prepared = await worktreeSessionService.prepare(
        { sessionId, activeWorktreeSettings: previous },
        {
          kind: 'create',
          name: 'after-deleted-checkout',
          originalCwd: repoRoot,
          projectRoot: repoRoot,
        },
      );
      const next = await worktreeSessionService.enter(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        prepared,
      );
      expect(next.lifecycle).toBe('owner');
      await expect(fs.stat(ownerPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        (await readEntries(homeTranscriptPath))
          .filter((entry) => entry.type === 'worktree-state')
          .at(-1)!.worktreeSession,
      ).toMatchObject({ worktreePath: next.path, lifecycle: 'owner' });
      expect(next.pendingOwnerReleasePath).toBeUndefined();
    } finally {
      await config.dispose();
    }
  });

  it.each([
    ['new', 'alias'],
    ['new', 'checkout'],
    ['legacy', 'alias'],
    ['legacy', 'checkout'],
    ['legacy', 'replaced-alias'],
  ] as const)(
    'preserves owner recovery for a %s Hook session after its %s is deleted',
    async (format, removed) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime(
        undefined,
        true,
      );
      const checkout = path.join(tempRoot, 'hook-checkout');
      const alias = path.join(tempRoot, 'hook-alias');
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      try {
        const prepared = await worktreeSessionService.prepare(
          {
            sessionId,
            createHookAdapter: {
              hasWorktreeCreateHook: () => true,
              executeWorktreeCreateHook: async () => {
                execFileSync(
                  'git',
                  ['worktree', 'add', '--detach', checkout, 'HEAD'],
                  {
                    cwd: repoRoot,
                    stdio: 'ignore',
                  },
                );
                await fs.symlink(checkout, alias, 'dir');
                return { worktreePath: alias };
              },
            },
          },
          {
            kind: 'create',
            name: 'hook-alias',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        const settings = await worktreeSessionService.enter(context, prepared);
        const state = toTranscriptWorktreeSession(settings, sessionId);
        // 历史记录保存别名和真实 cwd；别名失效时不能猜测根目录并清空证据。
        if (format === 'legacy') state.worktreePath = alias;
        await writer!.recordWorktreeState(state);
        const layout = (await resolveGitRepositoryLayout(checkout))!;
        const ownerPath = path.join(layout.gitDir, 'qwen-worktree.json');
        if (removed === 'checkout') await fs.rm(checkout, { recursive: true });
        else {
          await fs.unlink(alias);
          if (removed === 'replaced-alias') await fs.mkdir(alias);
        }
        const before = await fs.readFile(homeTranscriptPath, 'utf8');
        const freshConfig = makeFakeConfig({
          sessionId,
          targetDir: repoRoot,
          cwd: repoRoot,
          acpMode: true,
        });
        try {
          const result = await worktreeSessionService.restore(
            { ...context, config: freshConfig, phase: 'restore' },
            state,
          );
          if (format === 'legacy') {
            expect(result.status).toBe('failed');
            await expect(
              releasePersistedWorktreeSessionOwnership(state, sessionId),
            ).rejects.toThrow(/worktree.*path|checkout.*identity/i);
            expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
            expect(
              JSON.parse(await fs.readFile(ownerPath, 'utf8')),
            ).toMatchObject({ ownerSessionId: sessionId });
          } else {
            expect(state.worktreePath).toBe(checkout);
            expect(result.status).toBe(
              removed === 'alias' ? 'restored' : 'fallback',
            );
            if (removed === 'checkout') {
              await expect(fs.stat(ownerPath)).rejects.toMatchObject({
                code: 'ENOENT',
              });
            } else {
              expect(freshConfig.getWorkingDir()).toBe(checkout);
              expect(await readWorktreeOwnerState(checkout)).toMatchObject({
                ownerSessionId: sessionId,
              });
            }
          }
        } finally {
          await freshConfig.dispose();
        }
      } finally {
        await config.dispose();
      }
    },
  );

  it.each(['resume', 'delete'] as const)(
    'preserves registered Hook ownership when %s encounters a missing Git pointer',
    async (operation) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      const checkout = path.join(tempRoot, 'hook-linked-checkout');
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      try {
        const prepared = await worktreeSessionService.prepare(
          {
            sessionId,
            createHookAdapter: {
              hasWorktreeCreateHook: () => true,
              executeWorktreeCreateHook: async () => {
                execFileSync(
                  'git',
                  ['worktree', 'add', '--detach', checkout, 'HEAD'],
                  { cwd: repoRoot, stdio: 'ignore' },
                );
                return { worktreePath: checkout };
              },
            },
          },
          {
            kind: 'create',
            name: 'hook',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        const state = toTranscriptWorktreeSession(
          await worktreeSessionService.enter(context, prepared),
          sessionId,
        );
        const layout = (await resolveGitRepositoryLayout(checkout))!;
        const ownerPath = path.join(layout.gitDir, 'qwen-worktree.json');
        await fs.unlink(path.join(checkout, '.git'));
        const before = await fs.readFile(homeTranscriptPath, 'utf8');
        if (operation === 'resume') {
          const freshConfig = makeFakeConfig({
            sessionId,
            targetDir: repoRoot,
            cwd: repoRoot,
            acpMode: true,
          });
          try {
            expect(
              await worktreeSessionService.restore(
                { ...context, config: freshConfig, phase: 'restore' },
                state,
              ),
            ).toMatchObject({ status: 'failed' });
            expect(freshConfig.getWorkingDir()).toBe(repoRoot);
            expect(
              JSON.parse(await fs.readFile(ownerPath, 'utf8')),
            ).toMatchObject({
              ownerSessionId: sessionId,
            });
          } finally {
            await freshConfig.dispose();
          }
        } else {
          await releasePersistedWorktreeSessionOwnership(state, sessionId);
          await expect(fs.stat(ownerPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
        await expect(
          fs.stat(path.join(checkout, '.qwen-worktree.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await config.dispose();
      }
    },
  );

  it('uses the non-Git original project when creating another Hook worktree after resume', async () => {
    repoRoot = path.join(tempRoot, 'non-git-project');
    await fs.mkdir(repoRoot);
    const { config, sessionId } = await createRuntime(undefined, true);
    const first = path.join(tempRoot, 'first-hook');
    const second = path.join(tempRoot, 'second-hook');
    const prepareContext = {
      sessionId,
      createHookAdapter: {
        hasWorktreeCreateHook: () => true,
        executeWorktreeCreateHook: async (name: string) => {
          const worktreePath = name === 'first' ? first : second;
          await fs.mkdir(worktreePath);
          return { worktreePath };
        },
      },
      removeHookAdapter: {
        executeWorktreeRemoveHook: async (worktreePath: string) => {
          await fs.rm(worktreePath, { recursive: true });
          return { status: 'removed' as const };
        },
      },
    };
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: (
        ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
      ) => writer!.recordWorktreeState(...args),
    };
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
      acpMode: true,
    });
    try {
      const firstPrepared = await worktreeSessionService.prepare(prepareContext, {
        kind: 'create',
        name: 'first',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
      });
      const state = toTranscriptWorktreeSession(
        await worktreeSessionService.enter(context, firstPrepared),
        sessionId,
      );
      expect(
        await worktreeSessionService.restore(
          { ...context, config: freshConfig, phase: 'restore' },
          state,
        ),
      ).toMatchObject({ status: 'restored' });
      // 即使调用方仍传旧运行根，非 Git Hook 的目录映射也必须以原项目为准。
      const next = await worktreeSessionService.prepare(prepareContext, {
        kind: 'create',
        name: 'second',
        originalCwd: freshConfig.getSessionArtifactProjectRoot(),
        projectRoot: freshConfig.getProjectRoot(),
      });
      await worktreeSessionService.enter(
        { ...context, config: freshConfig },
        next,
      );
      expect(freshConfig.getWorkingDir()).toBe(second);
      expect(freshConfig.getSessionArtifactProjectRoot()).toBe(repoRoot);
      expect(await readWorktreeOwnerState(first)).toBeNull();
      expect(await readWorktreeOwnerState(second)).toMatchObject({
        ownerSessionId: sessionId,
      });
    } finally {
      await freshConfig.dispose();
      await config.dispose();
    }
  });

  it.each(['resume', 'delete', 'remove'] as const)(
    'retains verifiable separate Git ownership during Hook %s',
    async (operation) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime(
        undefined,
        true,
      );
      const checkout = path.join(tempRoot, 'hook-clone');
      const gitDir = path.join(tempRoot, 'hook-private-git');
      const ownerPath = path.join(gitDir, 'qwen-worktree.json');
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      try {
        const prepared = await worktreeSessionService.prepare(
          {
            sessionId,
            createHookAdapter: {
              hasWorktreeCreateHook: () => true,
              executeWorktreeCreateHook: async () => {
                execFileSync(
                  'git',
                  ['clone', `--separate-git-dir=${gitDir}`, repoRoot, checkout],
                  { cwd: repoRoot, stdio: 'ignore' },
                );
                return { worktreePath: checkout };
              },
            },
          },
          {
            kind: 'create',
            name: 'hook-clone',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        const settings = await worktreeSessionService.enter(context, prepared);
        const state = toTranscriptWorktreeSession(settings, sessionId);
        if (operation === 'remove') {
          // 正常 Hook 删除不能因 checkout 消失而丢失独立 Git 目录中的 owner。
          const result = await worktreeSessionService.leave(
            {
              ...context,
              removeHookAdapter: {
                executeWorktreeRemoveHook: async () => {
                  await fs.rm(checkout, { recursive: true });
                  return { status: 'removed' };
                },
              },
            },
            { action: 'remove', force: true },
          );
          expect(result.cleanup).toBeUndefined();
          await expect(fs.stat(ownerPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(
            (await readEntries(homeTranscriptPath))
              .filter((entry) => entry.type === 'worktree-state')
              .at(-1)!.worktreeSession,
          ).toBeNull();
          return;
        }

        await fs.rm(checkout, { recursive: true });
        const before = await fs.readFile(homeTranscriptPath, 'utf8');
        if (operation === 'resume') {
          const freshConfig = makeFakeConfig({
            sessionId,
            targetDir: repoRoot,
            cwd: repoRoot,
            acpMode: true,
          });
          try {
            expect(
              await worktreeSessionService.restore(
                { ...context, config: freshConfig, phase: 'restore' },
                state,
              ),
            ).toMatchObject({
              status: 'fallback',
              pendingCleanup: expect.any(String),
            });
          } finally {
            await freshConfig.dispose();
          }
        } else {
          await expect(
            releasePersistedWorktreeSessionOwnership(state, sessionId),
          ).rejects.toThrow(/ownership/i);
        }
        if (operation === 'resume') {
          expect(
            (await readEntries(homeTranscriptPath))
              .filter((entry) => entry.type === 'worktree-state')
              .at(-1)!.worktreeSession,
          ).toMatchObject({ pendingExit: true, worktreePath: checkout });
        } else {
          expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
        }
        expect(JSON.parse(await fs.readFile(ownerPath, 'utf8'))).toMatchObject({
          ownerSessionId: sessionId,
        });
        // 恢复真实 Git 指针后仍可重试结算，不要求新增或手改会话字段。
        await fs.mkdir(checkout);
        await fs.writeFile(path.join(checkout, '.git'), `gitdir: ${gitDir}\n`);
        await releasePersistedWorktreeSessionOwnership(state, sessionId);
        await expect(fs.stat(ownerPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await config.dispose();
      }
    },
  );

  it.each(['linked', 'clone', 'directory'] as const)(
    'continues in the original project after an externally deleted Hook %s without losing cleanup evidence',
    async (kind) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime(
        undefined,
        true,
      );
      const checkout = path.join(tempRoot, 'external-hook');
      if (kind === 'linked') {
        execFileSync('git', ['worktree', 'add', '--detach', checkout], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
      } else if (kind === 'clone') {
        execFileSync('git', ['clone', repoRoot, checkout], { stdio: 'ignore' });
      } else {
        await fs.mkdir(checkout);
      }
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      const prepared = await worktreeSessionService.prepare(
        {
          sessionId,
          createHookAdapter: {
            hasWorktreeCreateHook: () => true,
            executeWorktreeCreateHook: async () => ({ worktreePath: checkout }),
          },
        },
        {
          kind: 'create',
          name: 'external-hook',
          originalCwd: repoRoot,
          projectRoot: repoRoot,
        },
      );
      await worktreeSessionService.enter(context, prepared);
      if (kind === 'linked') {
        execFileSync('git', ['worktree', 'remove', '--force', checkout], {
          cwd: repoRoot,
        });
      } else {
        await fs.rm(checkout, { recursive: true });
      }
      const freshConfig = makeFakeConfig({
        sessionId,
        targetDir: repoRoot,
        cwd: repoRoot,
        acpMode: true,
        transcriptStore: store,
      });
      freshConfig.registerSessionRuntimeBinding({
        getTranscriptPath: () => homeTranscriptPath,
        refreshRuntimeContext: async () => undefined,
        recordWorktreeState: context.recordWorktreeState,
        synchronizeWorktreeRuntimeState: (state) =>
          writer!.synchronizeWorktreeRuntimeState(state),
      });
      try {
        // 从真实 JSONL 重新读取两次，保证回退后的下一次恢复仍可继续。
        for (let attempt = 0; attempt < 2; attempt++) {
          const state = (await readEntries(homeTranscriptPath))
            .filter((entry) => entry.type === 'worktree-state')
            .at(-1)!.worktreeSession!;
          expect(
            await worktreeSessionService.restore(
              { ...context, config: freshConfig, phase: 'restore' },
              state,
            ),
          ).toMatchObject({
            status: 'fallback',
            pendingCleanup: expect.any(String),
          });
          expect(freshConfig.getWorkingDir()).toBe(repoRoot);
          expect(freshConfig.getWorktreeSettings()).toBeUndefined();
          await writer!.recordMessages([createUserMessage('continue')]);
          await writer!.flush();
          expect(
            (await readEntries(homeTranscriptPath))
              .filter((entry) => entry.type === 'user')
              .at(-1),
          ).toMatchObject({ cwd: repoRoot, gitBranch: 'main' });
        }
        // 尚无法定位的 owner 不能被新 Enter 的状态覆盖。
        const result = await new EnterWorktreeTool(freshConfig)
          .build({ name: 'next' })
          .execute(new AbortController().signal);
        expect(result.error).toBeDefined();
        expect(
          (await readEntries(homeTranscriptPath))
            .filter((entry) => entry.type === 'worktree-state')
            .at(-1)!.worktreeSession,
        ).toMatchObject({ pendingExit: true, worktreePath: checkout });
      } finally {
        await freshConfig.dispose();
        await config.dispose();
      }
    },
  );

  it.each(['missing', 'pending-exit'] as const)(
    'preserves the original alias artifact bucket on %s fallback',
    async (reason) => {
      const canonicalRepo = repoRoot;
      const alias = path.join(tempRoot, 'repo-alias');
      const target = path.join(tempRoot, 'checkout');
      await fs.symlink(repoRoot, alias, 'dir');
      execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
        cwd: canonicalRepo,
        stdio: 'ignore',
      });
      repoRoot = alias;
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      try {
        if (reason === 'missing') {
          execFileSync('git', ['worktree', 'remove', '--force', target], {
            cwd: canonicalRepo,
            stdio: 'ignore',
          });
        }
        const result = await worktreeSessionService.restore(
          {
            config,
            sessionId,
            phase: 'restore',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          {
            sessionId,
            originalCwd: alias,
            worktreeName: 'checkout',
            worktreePath: target,
            worktreeCwd: target,
            lifecycle: 'attached',
            ...(reason === 'pending-exit'
              ? { pendingExit: true as const }
              : {}),
          },
        );
        expect(result.status).toBe('fallback');
        expect(config.getSessionArtifactProjectRoot()).toBe(alias);
        expect(config.getWorktreeSettings()).toBeUndefined();
        expect(writer!.getSessionFilePath()).toBe(homeTranscriptPath);
      } finally {
        await config.dispose();
      }
    },
  );

  it.each(['enter', 'restore'] as const)(
    '%s removes the original checkout alias from the runtime workspace without moving session artifacts',
    async (operation) => {
      const canonicalOriginalRoot = repoRoot;
      const originalAlias = path.join(tempRoot, 'repo-alias');
      await fs.symlink(repoRoot, originalAlias, 'dir');
      const worktreePath = path.join(tempRoot, 'target');
      execFileSync(
        'git',
        ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
        {
          cwd: repoRoot,
          stdio: 'ignore',
        },
      );
      const extraDirectory = path.join(tempRoot, 'extra');
      await fs.mkdir(extraDirectory);
      repoRoot = originalAlias;
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      config.getWorkspaceContext().addDirectory(extraDirectory);
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      try {
        if (operation === 'enter') {
          const prepared = await worktreeSessionService.prepare(
            { sessionId },
            {
              kind: 'attach',
              path: worktreePath,
              originalCwd: originalAlias,
              launchRoot: originalAlias,
            },
          );
          await worktreeSessionService.enter(context, prepared);
        } else {
          const outcome = await worktreeSessionService.restore(
            { ...context, phase: 'restore' },
            {
              sessionId,
              lifecycle: 'attached',
              worktreeName: 'target',
              worktreePath,
              worktreeCwd: worktreePath,
              originalCwd: originalAlias,
            },
          );
          expect(outcome.status).toBe('restored');
        }
        const workspace = config.getWorkspaceContext();
        expect(
          workspace.isPathWithinWorkspace(
            path.join(canonicalOriginalRoot, 'README.md'),
          ),
        ).toBe(false);
        expect(
          workspace.isPathWithinWorkspace(path.join(worktreePath, 'README.md')),
        ).toBe(true);
        expect(workspace.isPathWithinWorkspace(extraDirectory)).toBe(true);
        expect(config.getSessionArtifactProjectRoot()).toBe(originalAlias);
        expect(config.getWorktreeSettings()?.originalCwd).toBe(originalAlias);
        expect(writer!.getSessionFilePath()).toBe(homeTranscriptPath);
      } finally {
        await config.dispose();
      }
    },
  );

  it('attaches to a named checkout without changing the live owner sparse checkout', async () => {
    await fs.mkdir(path.join(repoRoot, 'omit'));
    await fs.writeFile(
      path.join(repoRoot, 'omit', 'file.txt'),
      'owner content',
    );
    execFileSync('git', ['add', 'omit'], { cwd: repoRoot });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'tracked nested file',
      ],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const { config: first, sessionId } = await createRuntime('first', true);
    const request = {
      kind: 'create' as const,
      name: 'shared',
      originalCwd: repoRoot,
      projectRoot: repoRoot,
    };
    const firstPrepared = await worktreeSessionService.prepare(
      { sessionId },
      request,
    );
    await worktreeSessionService.enter(
      {
        config: first,
        sessionId,
        phase: 'runtime',
        recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
      },
      firstPrepared,
    );
    const second = makeFakeConfig({
      sessionId: 'second',
      targetDir: repoRoot,
      cwd: repoRoot,
      acpMode: true,
    });
    const record = vi.fn();

    await expect(
      (async () => {
        const secondPrepared = await worktreeSessionService.prepare(
          { sessionId: 'second' },
          { ...request, options: { sparsePaths: ['include'] } },
        );
        await worktreeSessionService.enter(
          {
            config: second,
            sessionId: 'second',
            phase: 'runtime',
            recordWorktreeState: record,
          },
          secondPrepared,
        );
      })(),
    ).resolves.toBeUndefined();

    expect(
      await fs.readFile(
        path.join(firstPrepared.settings.path, 'omit', 'file.txt'),
        'utf8',
      ),
    ).toBe('owner content');
    expect(second.getWorkingDir()).toBe(firstPrepared.settings.worktreeCwd);
    expect(second.getWorktreeSettings()?.lifecycle).toBe('attached');
    expect(first.getWorkingDir()).toBe(firstPrepared.settings.worktreeCwd);
    expect(
      await readWorktreeOwnerState(firstPrepared.settings.path),
    ).toMatchObject({ ownerSessionId: 'first' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'attached' }),
    );

    // 附着完成后必须释放预占，原 owner 仍可再次进入。
    const ownerPrepared = await worktreeSessionService.prepare(
      { sessionId },
      request,
    );
    const retained = await worktreeSessionService.enter(
      {
        config: first,
        sessionId,
        phase: 'runtime',
        recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
      },
      ownerPrepared,
    );
    expect(retained.lifecycle).toBe('owner');
  });

  it('rejects a named checkout from another repository before entering it', async () => {
    const { config, sessionId } = await createRuntime('foreign-checkout', true);
    const foreignRepo = path.join(tempRoot, 'foreign-repo');
    const target = path.join(repoRoot, '.qwen', 'worktrees', 'foreign');
    await fs.mkdir(foreignRepo);
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: foreignRepo,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'foreign fixture',
      ],
      { cwd: foreignRepo, stdio: 'ignore' },
    );
    execFileSync('git', ['worktree', 'add', '-b', 'foreign', target], {
      cwd: foreignRepo,
      stdio: 'ignore',
    });

    await expect(
      (async () => {
        const prepared = await worktreeSessionService.prepare(
          { sessionId },
          {
            kind: 'create',
            name: 'foreign',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        await worktreeSessionService.enter(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          prepared,
        );
      })(),
    ).rejects.toThrow(/original Git repository/i);
    expect(config.getWorkingDir()).toBe(repoRoot);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('creates a named worktree in a pre-existing empty directory', async () => {
    const { config, sessionId } = await createRuntime('empty-directory', true);
    const target = path.join(repoRoot, '.qwen', 'worktrees', 'empty');
    await fs.mkdir(target, { recursive: true });
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      {
        kind: 'create',
        name: 'empty',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
        options: { baseRef: 'head' },
      },
    );
    await worktreeSessionService.enter(
      {
        config,
        sessionId,
        phase: 'runtime',
        recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
      },
      prepared,
    );
    expect(await fs.readFile(path.join(target, 'README.md'), 'utf8')).toBe(
      '# fixture\n',
    );
    expect(await readWorktreeOwnerState(target)).toMatchObject({
      ownerSessionId: sessionId,
    });
  });

  it('rejects a missing attach without creating its parent directory', async () => {
    await expect(
      worktreeSessionService.prepare(
        { sessionId: 'missing-attach' },
        {
          kind: 'attach',
          path: '../typo/wt',
          originalCwd: repoRoot,
          launchRoot: repoRoot,
        },
      ),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(tempRoot, 'typo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'attaches to a writable checkout under a read-only parent',
    async () => {
      const { config, sessionId } = await createRuntime(
        'readonly-parent',
        true,
      );
      const parent = path.join(tempRoot, 'readonly-parent');
      const target = path.join(parent, 'checkout');
      await fs.mkdir(parent);
      execFileSync(
        'git',
        ['worktree', 'add', '-b', 'readonly-parent', target],
        {
          cwd: repoRoot,
          stdio: 'ignore',
        },
      );
      await fs.chmod(parent, 0o555);
      try {
        const prepared = await worktreeSessionService.prepare(
          { sessionId },
          {
            kind: 'attach',
            path: target,
            originalCwd: repoRoot,
            launchRoot: repoRoot,
          },
        );
        await worktreeSessionService.enter(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (state) => writer!.recordWorktreeState(state),
          },
          prepared,
        );
        expect(config.getWorkingDir()).toBe(target);
        expect(config.getWorktreeSettings()?.lifecycle).toBe('attached');
      } finally {
        await fs.chmod(parent, 0o755);
        await config.dispose();
      }
    },
  );

  it('keeps crash-stale reservations outside the checkout and reclaims them on retry', async () => {
    const target = path.join(repoRoot, 'external-checkout');
    const entriesBefore = await fs.readdir(repoRoot);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '-e',
        `
        import fs from 'node:fs';
        import { createRequire } from 'node:module';
        import { withWorktreeReservation } from ${JSON.stringify(new URL('../services/worktree/creationReservation.ts', import.meta.url).href)};
        await withWorktreeReservation(${JSON.stringify(target)}, async () => {
          const { getLocks } = createRequire(${JSON.stringify(import.meta.url)})('proper-lockfile/lib/lockfile.js');
          for (const lockPath of Object.keys(getLocks())) fs.utimesSync(lockPath + '.lock', 0, 0);
          process.kill(process.pid, 'SIGKILL');
        });
      `,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 },
    );
    try {
      expect(child).toMatchObject({ signal: 'SIGKILL' });
      expect(await fs.readdir(repoRoot)).toEqual(entriesBefore);
    } finally {
      await withWorktreeReservation(target, async (reservation) => {
        reservation.assertHeld();
      });
    }
  });

  it.each(['create', 'attach'] as const)(
    'refuses %s while another session is preparing the same checkout',
    async (kind) => {
      const { config, sessionId } = await createRuntime('preparing', true);
      const request = {
        kind: 'create' as const,
        name: 'reserved',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
        options: { baseRef: 'head' as const },
      };
      const prepared = await worktreeSessionService.prepare(
        { sessionId },
        request,
      );
      // 固定创建完成、owner 尚未写入的交错点，不依赖线程调度或延时。
      try {
        if (kind === 'create') {
          // 独立进程也必须看到预占；进程内 Promise 锁不能通过此断言。
          execFileSync(
            process.execPath,
            [
              '--import',
              createRequire(import.meta.url).resolve('tsx'),
              '--input-type=module',
              '-e',
              `import { worktreeSessionService } from ${JSON.stringify(new URL('../services/worktreeSessionService.ts', import.meta.url).href)};
             try {
               await worktreeSessionService.prepare({ sessionId: 'other-process' }, ${JSON.stringify(request)});
             } catch (error) {
               if (/in progress|being prepared/i.test(error.message)) process.exit(0);
               throw error;
             }
             throw new Error('Another process entered the unclaimed checkout');`,
            ],
            {
              cwd: repoRoot,
              timeout: 20_000,
              stdio: 'pipe',
              // 配置与临时目录不同的 CLI 进程仍必须看到同一实际路径的预占。
              env: {
                ...process.env,
                [ENV_CONFIG_DIR]: path.join(tempRoot, 'other-config'),
                QODERCN_CONFIG_DIR: path.join(tempRoot, 'other-config-cn'),
                TMPDIR: tempRoot,
              },
            },
          );
        }
        await expect(
          worktreeSessionService.prepare(
            { sessionId: 'contender' },
            kind === 'create'
              ? request
              : {
                  kind: 'attach',
                  path: prepared.settings.path,
                  originalCwd: repoRoot,
                  launchRoot: repoRoot,
                },
          ),
        ).rejects.toThrow(/in progress|being prepared/i);
        expect(await readWorktreeOwnerState(prepared.settings.path)).toBeNull();
      } finally {
        await worktreeSessionService.enter(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (...args) =>
              writer!.recordWorktreeState(...args),
          },
          prepared,
        );
      }
      expect(
        await readWorktreeOwnerState(prepared.settings.path),
      ).toMatchObject({
        ownerSessionId: sessionId,
      });
    },
  );

  it.each(['prepare', 'enter'] as const)(
    'releases the creation reservation after %s fails',
    async (phase) => {
      const { config, sessionId } = await createRuntime('retry-create', true);
      const request = {
        kind: 'create' as const,
        name: 'retry-create',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
        options: { baseRef: 'head' as const },
      };
      if (phase === 'prepare') {
        await expect(
          worktreeSessionService.prepare(
            { sessionId },
            {
              ...request,
              options: { ...request.options, sparsePaths: ['..'] },
            },
          ),
        ).rejects.toThrow(/Invalid worktree sparsePaths/);
      } else {
        const prepared = await worktreeSessionService.prepare(
          { sessionId },
          request,
        );
        await expect(
          worktreeSessionService.enter(
            {
              config,
              sessionId,
              phase: 'runtime',
              recordWorktreeState: async () => {
                throw new Error('disk full');
              },
            },
            prepared,
          ),
        ).rejects.toThrow('disk full');
      }

      const retry = await worktreeSessionService.prepare(
        { sessionId },
        request,
      );
      await worktreeSessionService.enter(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        retry,
      );
      expect(config.getWorktreeSettings()?.lifecycle).toBe('owner');
    },
  );

  it.each(['git', 'plain'] as const)(
    'protects a %s hook checkout across competing names, restart and keep',
    async (kind) => {
      const { config, sessionId } = await createRuntime('hook-owner', true);
      const target = path.join(tempRoot, 'hook-checkout');
      if (kind === 'git') {
        execFileSync('git', ['worktree', 'add', '-b', 'hook', target], {
          cwd: repoRoot, stdio: 'ignore',
        });
      } else {
        await fs.mkdir(target);
      }
      const createHookAdapter = {
        hasWorktreeCreateHook: () => true,
        executeWorktreeCreateHook: async () => ({ worktreePath: target }),
      };
      const request = {
        kind: 'create' as const, name: 'hook',
        originalCwd: repoRoot, projectRoot: repoRoot,
      };
      const context = {
        config, sessionId, phase: 'runtime' as const,
        recordWorktreeState: (...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>) =>
          writer!.recordWorktreeState(...args),
      };
      const prepared = await worktreeSessionService.prepare(
        { sessionId, createHookAdapter }, request,
      );
      try {
        await expect(worktreeSessionService.prepare(
          { sessionId: 'competitor', createHookAdapter },
          { ...request, name: 'another-name' },
        )).rejects.toThrow(/in progress/i);
      } finally {
        await worktreeSessionService.enter(context, prepared);
      }
      await expect(worktreeSessionService.prepare(
        { sessionId: 'competitor', createHookAdapter },
        { ...request, name: 'another-name' },
      )).rejects.toThrow(/owned by another/i);
      if (kind === 'git') {
        await expect(worktreeSessionService.prepare(
          { sessionId: 'git-attach' },
          { kind: 'attach', path: target, originalCwd: repoRoot, launchRoot: repoRoot },
        )).rejects.toThrow(/owned by another/i);
      }
      expect(await readWorktreeOwnerState(target)).toMatchObject({ ownerSessionId: sessionId });
      const nested = path.join(target, 'nested');
      await fs.mkdir(nested);
      expect(await readWorktreeOwnerState(nested)).toBeNull();
      const state = toTranscriptWorktreeSession(config.getWorktreeSettings()!, sessionId);
      const restored = await worktreeSessionService.restore(context, state);
      expect(restored).toMatchObject({ status: 'restored', settings: { lifecycle: 'owner' } });
      await worktreeSessionService.leave(context, { action: 'keep' });
      expect(await readWorktreeOwnerState(target)).toBeNull();
      expect((await fs.stat(target)).isDirectory()).toBe(true);
    },
  );

  it('refuses to forget a Git owner when its checkout marker disappears', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime(
      'damaged-marker',
      true,
    );
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: (
        state: Parameters<TranscriptWriterHandle['recordWorktreeState']>[0],
      ) => writer!.recordWorktreeState(state),
    };
    const request = {
      kind: 'create' as const,
      name: 'A',
      originalCwd: repoRoot,
      projectRoot: repoRoot,
      options: { baseRef: 'head' as const },
    };
    await worktreeSessionService.enter(
      context,
      await worktreeSessionService.prepare({ sessionId }, request),
    );
    const first = config.getWorktreeSettings()!;
    const layout = (await resolveGitRepositoryLayout(first.path))!;
    const before = await fs.readFile(homeTranscriptPath, 'utf8');
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      { ...request, name: 'B' },
    );
    await fs.unlink(path.join(first.path, '.git'));
    await expect(
      worktreeSessionService.enter(context, prepared),
    ).rejects.toThrow(/previous worktree ownership/i);
    expect(config.getWorktreeSettings()?.path).toBe(first.path);
    expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(layout.gitDir, 'qwen-worktree.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ ownerSessionId: sessionId });
  });

  it.each([
    'new',
    'legacy',
    'interrupted-migration',
    'copied-migration',
    'EXDEV',
    'EPERM',
    'ENOTSUP',
  ] as const)(
    'keeps %s Hook clone ownership out of Git add, stash and clean',
    async (kind) => {
      const { config, sessionId } = await createRuntime('hook-clone', true);
      const target = path.join(tempRoot, 'hook-clone');
      execFileSync(
        'git',
        [
          'clone',
          ...(kind === 'EXDEV'
            ? [`--separate-git-dir=${path.join(tempRoot, 'private-git')}`]
            : []),
          repoRoot,
          target,
        ],
        { stdio: 'ignore' },
      );
      if (kind !== 'new') {
        await fs.writeFile(
          path.join(target, '.qwen-worktree.json'),
          JSON.stringify({
            version: 1,
            ownerSessionId: sessionId,
            originalCwd: repoRoot,
          }),
        );
        if (kind === 'interrupted-migration') {
          await fs.link(
            path.join(target, '.qwen-worktree.json'),
            path.join(target, '.git', 'qwen-worktree.json'),
          );
        }
        if (kind === 'copied-migration') {
          await fs.copyFile(
            path.join(target, '.qwen-worktree.json'),
            path.join(target, '.git', 'qwen-worktree.json'),
          );
        }
        if (kind === 'EXDEV' || kind === 'EPERM' || kind === 'ENOTSUP') {
          vi.spyOn(nativeFs.promises, 'link').mockRejectedValue(
            Object.assign(new Error('hard links unsupported'), { code: kind }),
          );
          syncBuiltinESMExports();
        }
        const restored = await worktreeSessionService.restore(
          {
            config,
            sessionId,
            phase: 'restore',
            recordWorktreeState: (state) => writer!.recordWorktreeState(state),
          },
          {
            worktreeName: 'hook-clone',
            worktreePath: target,
            worktreeCwd: target,
            originalCwd: repoRoot,
            sessionId,
            hookBased: true,
            lifecycle: 'owner',
          },
        );
        expect(restored.status).toBe('restored');
      } else {
        const prepared = await worktreeSessionService.prepare(
          {
            sessionId,
            createHookAdapter: {
              hasWorktreeCreateHook: () => true,
              executeWorktreeCreateHook: async () => ({ worktreePath: target }),
            },
          },
          {
            kind: 'create',
            name: 'hook-clone',
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        await worktreeSessionService.enter(
          {
            config,
            sessionId,
            phase: 'runtime',
            recordWorktreeState: (state) => writer!.recordWorktreeState(state),
          },
          prepared,
        );
      }
      execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'add', '-A'], {
        cwd: target,
      });
      expect(
        execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: target,
          encoding: 'utf8',
        }),
      ).toBe('');
      execFileSync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'stash', '-u'],
        { cwd: target, stdio: 'ignore' },
      );
      execFileSync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'clean', '-fd'],
        { cwd: target },
      );
      expect(await readWorktreeOwnerState(target)).toMatchObject({
        ownerSessionId: sessionId,
      });
      await worktreeSessionService.leave(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (state) => writer!.recordWorktreeState(state),
        },
        { action: 'keep' },
      );
      expect(await readWorktreeOwnerState(target)).toBeNull();
    },
  );

  it('preserves both owners when a conflicting private marker appears during copy fallback', async () => {
    const target = path.join(tempRoot, 'copy-race');
    execFileSync('git', ['clone', repoRoot, target], { stdio: 'ignore' });
    const legacyPath = path.join(target, '.qwen-worktree.json');
    const privatePath = path.join(target, '.git', 'qwen-worktree.json');
    const legacy = JSON.stringify({
      version: 1,
      ownerSessionId: 'legacy-owner',
      originalCwd: repoRoot,
    });
    const foreign = JSON.stringify({
      version: 1,
      ownerSessionId: 'foreign-owner',
      originalCwd: repoRoot,
    });
    await fs.writeFile(legacyPath, legacy);
    vi.spyOn(nativeFs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );
    const open = nativeFs.promises.open;
    vi.spyOn(nativeFs.promises, 'open').mockImplementation(
      async (...args) => {
        if (args[0] === privatePath && args[1] === 'wx') {
          await fs.writeFile(privatePath, foreign, { flag: 'wx' });
        }
        return Reflect.apply(open, nativeFs.promises, args);
      },
    );
    syncBuiltinESMExports();
    expect(await claimWorktreeOwnership(target, 'legacy-owner', repoRoot)).toBe(
      'unavailable',
    );
    expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacy);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(foreign);
  });

  it.each(['native', 'zero-inode'] as const)(
    'does not overwrite conflicting legacy and private Hook clone owners (%s)',
    async (kind) => {
      const target = path.join(tempRoot, 'conflicting-hook-clone');
      execFileSync('git', ['clone', repoRoot, target], { stdio: 'ignore' });
      const legacyPath = path.join(target, '.qwen-worktree.json');
      const privatePath = path.join(target, '.git', 'qwen-worktree.json');
      const legacy = JSON.stringify({
        version: 1,
        ownerSessionId: 'legacy-session',
        originalCwd: repoRoot,
      });
      const current = JSON.stringify({
        version: 1,
        ownerSessionId: 'current-session',
        originalCwd: repoRoot,
      });
      await fs.writeFile(legacyPath, legacy);
      await fs.writeFile(privatePath, current);
      if (kind === 'zero-inode') {
        const lstat = nativeFs.promises.lstat;
        vi.spyOn(nativeFs.promises, 'lstat').mockImplementation(
          async (...args) => {
            const stat = await Reflect.apply(lstat, nativeFs.promises, args);
            if ([legacyPath, privatePath].includes(String(args[0]))) {
              stat.ino = 0;
              stat.dev = 0;
            }
            return stat;
          },
        );
        syncBuiltinESMExports();
      }
      expect(
        await claimWorktreeOwnership(target, 'legacy-session', repoRoot),
      ).toBe('unavailable');
      expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacy);
      expect(await fs.readFile(privatePath, 'utf8')).toBe(current);
    },
  );

  it('settles pending Git ownership through the original registration when the old checkout marker disappears', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime(
      'damaged-handoff',
      true,
    );
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: (
        state: Parameters<TranscriptWriterHandle['recordWorktreeState']>[0],
      ) => writer!.recordWorktreeState(state),
    };
    const request = {
      kind: 'create' as const,
      name: 'A',
      originalCwd: repoRoot,
      projectRoot: repoRoot,
      options: { baseRef: 'head' as const },
    };
    await worktreeSessionService.enter(
      context,
      await worktreeSessionService.prepare({ sessionId }, request),
    );
    const first = config.getWorktreeSettings()!.path;
    const layout = (await resolveGitRepositoryLayout(first))!;
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      { ...request, name: 'B' },
    );
    vi.spyOn(
      worktreeOwnerState,
      'releaseWorktreeOwnershipForHandoff',
    ).mockResolvedValueOnce('unavailable');
    await worktreeSessionService.enter(context, prepared);
    const state = toTranscriptWorktreeSession(
      config.getWorktreeSettings()!,
      sessionId,
    );
    await fs.unlink(path.join(first, '.git'));
    expect(await worktreeSessionService.restore(context, state)).toMatchObject({
      status: 'restored',
    });
    await expect(
      fs.stat(path.join(layout.gitDir, 'qwen-worktree.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      config.getWorktreeSettings()?.pendingOwnerReleasePath,
    ).toBeUndefined();
    const entries = await readEntries(homeTranscriptPath);
    expect(entries.at(-1)).toMatchObject({
      type: 'worktree-state',
      worktreeSession: { worktreePath: state.worktreePath },
    });
    expect((await fs.stat(first)).isDirectory()).toBe(true);
  });

  it('reenters the pending handoff target using the already held reservation', async () => {
    const { config, sessionId } = await createRuntime(
      'return-to-pending',
      true,
    );
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: (
        state: Parameters<TranscriptWriterHandle['recordWorktreeState']>[0],
      ) => writer!.recordWorktreeState(state),
    };
    const request = {
      kind: 'create' as const,
      name: 'A',
      originalCwd: repoRoot,
      projectRoot: repoRoot,
      options: { baseRef: 'head' as const },
    };
    await worktreeSessionService.enter(
      context,
      await worktreeSessionService.prepare({ sessionId }, request),
    );
    const first = config.getWorktreeSettings()!.path;
    const preparedB = await worktreeSessionService.prepare(
      { sessionId },
      { ...request, name: 'B' },
    );
    vi.spyOn(
      worktreeOwnerState,
      'releaseWorktreeOwnershipForHandoff',
    ).mockResolvedValueOnce('unavailable');
    await worktreeSessionService.enter(context, preparedB);
    expect(config.getWorktreeSettings()?.pendingOwnerReleasePath).toBe(first);
    const preparedA = await worktreeSessionService.prepare(
      { sessionId, activeWorktreeSettings: config.getWorktreeSettings() },
      {
        kind: 'attach',
        path: first,
        originalCwd: repoRoot,
        launchRoot: repoRoot,
      },
    );
    await worktreeSessionService.enter(context, preparedA);
    expect(config.getWorktreeSettings()).toMatchObject({
      path: first,
      lifecycle: 'attached',
    });
    expect(
      config.getWorktreeSettings()?.pendingOwnerReleasePath,
    ).toBeUndefined();
    expect(await readWorktreeOwnerState(first)).toBeNull();
  });

  it.each(['release', 'confirmation'] as const)(
    'settles hook handoffs after a %s failure and restart',
    async (failure) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime(
        'hook-handoff',
        true,
      );
      const first = path.join(tempRoot, 'first-hook');
      const second = path.join(tempRoot, 'second-hook');
      await fs.mkdir(first);
      await fs.mkdir(second);
      const createHookAdapter = {
        hasWorktreeCreateHook: () => true,
        executeWorktreeCreateHook: async (name: string) => ({
          worktreePath: name === 'first' ? first : second,
        }),
      };
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: (
          ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
        ) => writer!.recordWorktreeState(...args),
      };
      for (const name of ['first', 'second']) {
        const prepared = await worktreeSessionService.prepare(
          { sessionId, createHookAdapter },
          {
            kind: 'create',
            name,
            originalCwd: repoRoot,
            projectRoot: repoRoot,
          },
        );
        if (name === 'second') {
          if (failure === 'release') {
            vi.spyOn(
              worktreeOwnerState,
              'releaseWorktreeOwnershipForHandoff',
            ).mockResolvedValueOnce('unavailable');
          } else {
            const record = writer!.recordWorktreeState.bind(writer!);
            vi.spyOn(writer!, 'recordWorktreeState').mockImplementation(
              async (...args) => {
                const state = args[0];
                if (
                  state?.worktreePath === second &&
                  !state.pendingOwnerReleasePath
                ) {
                  throw new Error('handoff confirmation write failed');
                }
                await record(...args);
              },
            );
          }
        }
        await worktreeSessionService.enter(context, prepared);
      }
      await writer!.close();
      await config.dispose();
      const resumed = await createRuntime(sessionId, true);
      const index = await store!.repository().loadIndex(homeTranscriptPath);
      const state = index!.metadata.worktreeSessions.get(sessionId)!;
      expect(state.pendingOwnerReleasePath).toBe(first);
      const resumeContext = { ...context, config: resumed.config };
      if (failure === 'release') {
        const before = await fs.readFile(homeTranscriptPath, 'utf8');
        const readFile = nativeFs.promises.readFile;
        const spy = vi
          .spyOn(nativeFs.promises, 'readFile')
          .mockImplementation(async (...args) => {
            if (String(args[0]) === path.join(first, '.qwen-worktree.json')) {
              throw Object.assign(new Error('owner metadata is inaccessible'), {
                code: 'EACCES',
              });
            }
            return Reflect.apply(readFile, nativeFs.promises, args);
          });
        syncBuiltinESMExports();
        try {
          expect(
            await worktreeSessionService.restore(resumeContext, state),
          ).toMatchObject({ status: 'failed' });
          await expect(
            releasePersistedWorktreeSessionOwnership(state, sessionId),
          ).rejects.toThrow();
        } finally {
          spy.mockRestore();
          syncBuiltinESMExports();
        }
        expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
        expect(resumed.config.getWorkingDir()).toBe(repoRoot);
        expect(await readWorktreeOwnerState(second)).toMatchObject({
          ownerSessionId: sessionId,
        });
      }
      await expect(
        worktreeSessionService.restore(resumeContext, state),
      ).resolves.toMatchObject({ status: 'restored' });
      expect(await readWorktreeOwnerState(first)).toBeNull();
      expect(
        resumed.config.getWorktreeSettings()?.pendingOwnerReleasePath,
      ).toBeUndefined();
      // 删除也必须接受尚未清除标记的旧 JSONL，不能要求先成功 Resume 一次。
      await releasePersistedWorktreeSessionOwnership(state, sessionId);
      expect(await readWorktreeOwnerState(second)).toBeNull();
    },
  );

  it.each(['lstat', 'open'] as const)(
    'refuses hook ownership when Git metadata %s is inaccessible',
    async (operation) => {
      const target = path.join(tempRoot, 'inaccessible-git-hook');
      execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      expect(await claimWorktreeOwnership(target, 'owner-a', repoRoot)).toBe(
        'owned',
      );
      const original = nativeFs.promises[operation];
      const spy = vi
        .spyOn(nativeFs.promises, operation)
        .mockImplementation(async (...args) => {
          if (String(args[0]) === path.join(target, '.git')) {
            throw Object.assign(new Error('Git metadata is inaccessible'), {
              code: 'EACCES',
            });
          }
          return Reflect.apply(original, nativeFs.promises, args);
        });
      syncBuiltinESMExports();
      try {
        expect(
          await worktreeOwnerState.inspectWorktreeOwnership(target, 'owner-b'),
        ).toBe('unavailable');
        expect(await claimWorktreeOwnership(target, 'owner-b', repoRoot)).toBe(
          'unavailable',
        );
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }
      expect(await readWorktreeOwnerState(target)).toMatchObject({
        ownerSessionId: 'owner-a',
      });
      await expect(
        fs.stat(path.join(target, '.qwen-worktree.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refuses ambiguous Git and hook owner markers without releasing either owner', async () => {
    const { config } = await createRuntime('owner-a', true);
    const target = path.join(tempRoot, 'ambiguous-hook');
    execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    expect(await claimWorktreeOwnership(target, 'owner-a', repoRoot)).toBe(
      'owned',
    );
    const layout = await resolveGitRepositoryLayout(target);
    const gitOwnerPath = path.join(layout!.gitDir, 'qwen-worktree.json');
    const hiddenOwnerPath = path.join(target, '.qwen-worktree.json');
    await fs.writeFile(
      hiddenOwnerPath,
      JSON.stringify({
        version: 1,
        ownerSessionId: 'owner-b',
        originalCwd: repoRoot,
      }),
    );
    expect(
      await worktreeOwnerState.inspectWorktreeOwnership(target, 'owner-b'),
    ).toBe('unavailable');
    expect(
      await worktreeOwnerState.releaseWorktreeOwnershipForHandoff(
        target,
        'owner-a',
      ),
    ).toBe('unavailable');
    expect(JSON.parse(await fs.readFile(gitOwnerPath, 'utf8'))).toMatchObject({
      ownerSessionId: 'owner-a',
    });
    expect(
      JSON.parse(await fs.readFile(hiddenOwnerPath, 'utf8')),
    ).toMatchObject({ ownerSessionId: 'owner-b' });
    const restored = await worktreeSessionService.restore(
      {
        config,
        sessionId: 'owner-a',
        phase: 'restore',
        recordWorktreeState: (state) => writer!.recordWorktreeState(state),
      },
      {
        sessionId: 'owner-a',
        originalCwd: repoRoot,
        worktreePath: target,
        worktreeCwd: target,
        worktreeName: 'ambiguous',
        lifecycle: 'owner',
      },
    );
    expect(restored).toMatchObject({
      status: 'failed',
      message: expect.stringContaining(hiddenOwnerPath),
    });
  });

  it.each(['missing', 'malformed'] as const)(
    'settles a verified registration despite an unrelated %s gitdir record',
    async (kind) => {
      const target = path.join(tempRoot, 'registered-owner');
      execFileSync('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      expect(await claimWorktreeOwnership(target, 'owner-a')).toBe('owned');
      const layout = (await resolveGitRepositoryLayout(target))!;
      const unrelated = path.join(
        layout.commonDir,
        'worktrees',
        'unrelated-broken',
      );
      await fs.mkdir(unrelated);
      if (kind === 'malformed')
        await fs.writeFile(path.join(unrelated, 'gitdir'), '');
      expect(
        await worktreeOwnerState.releaseWorktreeOwnershipForHandoff(
          target,
          'owner-a',
          repoRoot,
          false,
        ),
      ).toBe('released');
      await expect(
        fs.stat(path.join(layout.gitDir, 'qwen-worktree.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
    },
  );

  it('rejects registered handoffs shadowed by conflicting Hook metadata', async () => {
    const oldCheckout = path.join(tempRoot, 'shadowed-checkout');
    execFileSync('git', ['worktree', 'add', '--detach', oldCheckout, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    expect(await claimWorktreeOwnership(oldCheckout, 'owner-a')).toBe('owned');
    const layout = (await resolveGitRepositoryLayout(oldCheckout))!;
    const shadow = JSON.stringify({
      version: 1,
      ownerSessionId: 'owner-a',
      originalCwd: tempRoot,
    });
    const hiddenPath = path.join(oldCheckout, '.qwen-worktree.json');
    await fs.unlink(path.join(oldCheckout, '.git'));
    await fs.writeFile(hiddenPath, shadow);
    const current = path.join(tempRoot, 'current-checkout');
    await fs.mkdir(current);
    await expect(
      releasePersistedWorktreeSessionOwnership(
        {
          sessionId: 'owner-a',
          originalCwd: repoRoot,
          worktreePath: current,
          worktreeCwd: current,
          worktreeName: 'current',
          lifecycle: 'attached',
          hookBased: true,
          pendingOwnerReleasePath: oldCheckout,
        },
        'owner-a',
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(hiddenPath, 'utf8')).toBe(shadow);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(layout.gitDir, 'qwen-worktree.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ ownerSessionId: 'owner-a' });
  });

  it('settles a Hook handoff with durable source proof after its source directory was deleted', async () => {
    const source = path.join(tempRoot, 'deleted-hook-source');
    const oldHook = path.join(tempRoot, 'old-hook');
    const currentHook = path.join(tempRoot, 'current-hook');
    await fs.mkdir(source);
    await fs.mkdir(oldHook);
    await fs.mkdir(currentHook);
    expect(await claimWorktreeOwnership(oldHook, 'hook-session', source)).toBe(
      'owned',
    );
    await fs.rmdir(source);
    await expect(
      releasePersistedWorktreeSessionOwnership(
        {
          sessionId: 'hook-session',
          originalCwd: source,
          worktreePath: currentHook,
          worktreeName: 'current',
          worktreeCwd: currentHook,
          lifecycle: 'attached',
          hookBased: true,
          pendingOwnerReleasePath: oldHook,
        },
        'hook-session',
      ),
    ).resolves.toBeUndefined();
    expect(await readWorktreeOwnerState(oldHook)).toBeNull();
    expect((await fs.stat(oldHook)).isDirectory()).toBe(true);
  });

  it('releases hook ownership when removal confirms cleanup but retains the directory', async () => {
    const { config, sessionId } = await createRuntime('hook-cleanup', true);
    const target = path.join(tempRoot, 'hook-cleanup');
    await fs.mkdir(target);
    const prepared = await worktreeSessionService.prepare({
      sessionId, createHookAdapter: {
        hasWorktreeCreateHook: () => true,
        executeWorktreeCreateHook: async () => ({ worktreePath: target }),
      },
    }, { kind: 'create', name: 'hook', originalCwd: repoRoot, projectRoot: repoRoot });
    const context = {
      config, sessionId, phase: 'runtime' as const,
      recordWorktreeState: (...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>) => writer!.recordWorktreeState(...args),
      removeHookAdapter: { executeWorktreeRemoveHook: async () => ({ status: 'removed' as const }) },
    };
    await worktreeSessionService.enter(context, prepared);
    await worktreeSessionService.leave(context, { action: 'remove', force: true });
    expect(await readWorktreeOwnerState(target)).toBeNull();
    expect(config.getWorktreeSettings()).toBeUndefined();
  });

  it('blocks ownership settlement and attach until remove has finished', async () => {
    const { config, sessionId } = await createRuntime('removing-owner', true);
    const context = {
      config, sessionId, phase: 'runtime' as const,
      recordWorktreeState: (...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>) =>
        writer!.recordWorktreeState(...args),
    };
    const prepared = await worktreeSessionService.prepare({ sessionId }, {
      kind: 'create', name: 'remove-race', originalCwd: repoRoot, projectRoot: repoRoot,
      options: { baseRef: 'head' },
    });
    const settings = await worktreeSessionService.enter(context, prepared);
    const cleanup = worktreeService.cleanupWorktreeSession;
    let resumeCleanup!: () => void;
    let reachedCleanup!: () => void;
    const gate = new Promise<void>((resolve) => { resumeCleanup = resolve; });
    const reached = new Promise<void>((resolve) => { reachedCleanup = resolve; });
    vi.spyOn(worktreeService, 'cleanupWorktreeSession').mockImplementation(async (...args) => {
      reachedCleanup();
      await gate;
      return cleanup(...args);
    });
    const removing = worktreeSessionService.leave(context, { action: 'remove', force: true });
    await reached;
    try {
      await expect(releasePersistedWorktreeSessionOwnership(
        toTranscriptWorktreeSession(settings, sessionId), sessionId,
      )).rejects.toThrow(/in progress/i);
      await expect(worktreeSessionService.prepare({ sessionId: 'attaching' }, {
        kind: 'attach', path: settings.path, originalCwd: repoRoot, launchRoot: repoRoot,
      })).rejects.toThrow(/in progress/i);
      expect(await readWorktreeOwnerState(settings.path)).toMatchObject({ ownerSessionId: sessionId });
    } finally {
      resumeCleanup();
      await removing;
    }
    await expect(fs.stat(settings.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports the retained checkout when persistence fails after losing the reservation', async () => {
    const { config, sessionId } = await createRuntime('lost-lock', true);
    const prepared = await worktreeSessionService.prepare({ sessionId }, {
      kind: 'create', name: 'lost-lock', originalCwd: repoRoot, projectRoot: repoRoot,
      options: { baseRef: 'head' },
    });
    // 只注入锁库报告的失锁事件；创建、持久化失败补偿与目录检查走真实实现。
    const lockfile = createRequire(import.meta.url)('proper-lockfile/lib/lockfile.js') as {
      getLocks(): Record<string, { options: { onCompromised(error: Error): void } }>;
    };
    await expect(worktreeSessionService.enter({
      config, sessionId, phase: 'runtime',
      recordWorktreeState: async () => {
        for (const held of Object.values(lockfile.getLocks())) {
          held.options.onCompromised(new Error('lost reservation'));
        }
        throw new Error('disk full');
      },
    }, prepared)).rejects.toThrow(new RegExp(`disk full.*[Cc]heckout retained at ${prepared.settings.path}`));
    expect((await fs.stat(prepared.settings.path)).isDirectory()).toBe(true);
    expect(config.getWorkingDir()).toBe(repoRoot);
  });

  it('notifies the Headless CwdChanged hook once after startup worktree state is committed', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime(
      undefined,
      false,
      repoRoot,
      true,
    );
    const cwdChanges: Array<{
      oldCwd: string;
      newCwd: string;
      writerCwd: string | undefined;
    }> = [];
    vi.spyOn(config.getHookSystem()!, 'fireCwdChangedEvent').mockImplementation(
      async (oldCwd, newCwd) => {
        const state = (await readEntries(homeTranscriptPath))
          .filter((entry) => entry.type === 'worktree-state')
          .at(-1)?.worktreeSession;
        cwdChanges.push({ oldCwd, newCwd, writerCwd: state?.worktreeCwd });
        return { success: true, allOutputs: [], errors: [], totalDuration: 0 };
      },
    );
    try {
      const prepared = await worktreeSessionService.prepare(
        { sessionId },
        {
          kind: 'create',
          name: 'headless-startup',
          originalCwd: repoRoot,
          projectRoot: repoRoot,
        },
      );
      await worktreeSessionService.enter(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
        },
        prepared,
      );
      await vi.waitFor(() =>
        expect(cwdChanges).toEqual([
          {
            oldCwd: repoRoot,
            newCwd: prepared.settings.worktreeCwd,
            writerCwd: prepared.settings.worktreeCwd,
          },
        ]),
      );
    } finally {
      await config.dispose();
    }
  });

  it('keeps ACP shell cwd and cwd hooks isolated across worktree sessions', async () => {
    // ACP Host 的 cwd 不属于任一 Session，Enter 和 Remove 都不能修改它。
    process.chdir(tempRoot);
    const { config: second } = await createRuntime('second', true);
    const first = makeFakeConfig({
      sessionId: 'first',
      targetDir: repoRoot,
      cwd: repoRoot,
      acpMode: true,
      enableHooks: true,
    });
    const firstHook = vi
      .spyOn(first.getHookSystem()!, 'fireCwdChangedEvent')
      .mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
    const secondHook = vi
      .spyOn(second.getHookSystem()!, 'fireCwdChangedEvent')
      .mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
    const entered = await new EnterWorktreeTool(second)
      .build({ name: 'second-checkout' })
      .execute(new AbortController().signal);
    expect(entered.error).toBeUndefined();
    const worktreeCwd = second.getWorkingDir();
    const shell = async (config: typeof first, command: string) => {
      const result = await new ShellTool(config)
        .build({ command })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      return result.llmContent;
    };
    expect(await shell(first, 'pwd')).toContain(repoRoot);
    expect(await shell(first, 'pwd')).not.toContain(worktreeCwd);
    expect(firstHook).not.toHaveBeenCalled();
    expect(secondHook).toHaveBeenCalledWith(repoRoot, worktreeCwd);
    expect(process.cwd()).toBe(tempRoot);

    const subdirectory = path.join(repoRoot, 'only-first');
    await fs.mkdir(subdirectory);
    await shell(first, 'cd only-first');
    const [firstResult, secondResult] = await Promise.all([
      shell(first, 'pwd'),
      shell(second, 'pwd'),
    ]);
    expect(firstResult).toContain(subdirectory);
    expect(secondResult).toContain(worktreeCwd);
    expect(firstHook).toHaveBeenCalledWith(repoRoot, subdirectory);
    expect(secondHook).not.toHaveBeenCalledWith(repoRoot, subdirectory);

    const exited = await new ExitWorktreeTool(second)
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);
    expect(exited.error).toBeUndefined();
    expect(second.getWorkingDir()).toBe(repoRoot);
    expect(process.cwd()).toBe(tempRoot);
    await expect(fs.stat(worktreeCwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await shell(first, 'pwd')).toContain(subdirectory);
  });

  async function readEntries(filePath: string): Promise<Entry[]> {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);
  }

  it('persists an entered worktree before the first prompt and makes it resumable', async () => {
    const { config, homeTranscriptPath, sessionId } = await createRuntime();
    const result = await new EnterWorktreeTool(config)
      .build({ name: 'before-prompt' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(await readEntries(homeTranscriptPath)).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: expect.objectContaining({ lifecycle: 'owner' }),
      }),
    );
    const selected = await resolveTranscriptSessionById(
      repoRoot, sessionId, undefined,
      { projectDir: path.dirname(homeTranscriptPath) },
    );
    expect(selected).toMatchObject({
      sessionPath: homeTranscriptPath,
      sessionInfo: { id: sessionId, messageCount: 0 },
    });
    const freshConfig = makeFakeConfig({
      sessionId, targetDir: repoRoot, cwd: repoRoot,
    });
    expect(
      await worktreeSessionService.restore(
        {
          config: freshConfig, sessionId, phase: 'restore',
          recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
        },
        selected!.sessionInfo.worktreeSession!,
      ),
    ).toMatchObject({ status: 'restored', settings: { lifecycle: 'owner' } });
    expect(
      await listTranscriptSessions(repoRoot, undefined, {
        lightweight: true,
        projectDir: path.dirname(homeTranscriptPath),
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })]),
    );
  });

  it('refuses runtime entry without session persistence before creating a checkout', async () => {
    const config = makeFakeConfig({
      targetDir: repoRoot,
      cwd: repoRoot,
      sessionPersistence: false,
    });
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: async () => undefined,
      recordWorktreeState: async () => undefined,
    });
    const result = await new EnterWorktreeTool(config)
      .build({ name: 'no-persistence' })
      .execute(new AbortController().signal);
    expect(result.error?.message).toMatch(/persistence/i);
    expect(config.getWorktreeSettings()).toBeUndefined();
    await expect(
      fs.stat(path.join(repoRoot, '.qwen/worktrees/no-persistence')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when no runtime writer is bound', async () => {
    const config = makeFakeConfig({ targetDir: repoRoot, cwd: repoRoot });
    await expect(config.recordWorktreeState(null)).rejects.toThrow(
      /transcript/i,
    );
  });

  it('preserves earlier checkpoint contents after a worktree round trip and resume', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    const checkpointRoot = path.join(tempRoot, 'checkpoints');
    const history = new FileHistoryManager({
      cwd: repoRoot,
      sessionId,
      checkpointRoot,
      recordSnapshot: (entry) => writer!.recordFileHistorySnapshot(entry),
    });
    config.setFileHistoryManager(history);
    const filePath = path.join(repoRoot, 'README.md');
    const first = createUserMessage('first edit');
    await fs.writeFile(filePath, 'before-first-edit');
    await writer!.recordMessages([first]);
    await history.makeSnapshot(first.uuid);
    await history.trackEdit(filePath, first.uuid);
    await fs.writeFile(filePath, 'after-first-edit');

    expect(
      (
        await new EnterWorktreeTool(config)
          .build({ name: 'checkpoint-round-trip' })
          .execute(new AbortController().signal)
      ).error,
    ).toBeUndefined();
    expect(
      (
        await new ExitWorktreeTool(config)
          .build({ action: 'keep' })
          .execute(new AbortController().signal)
      ).error,
    ).toBeUndefined();

    const second = createUserMessage('second edit in original checkout');
    await writer!.recordMessages([second]);
    await history.makeSnapshot(second.uuid);
    await history.trackEdit(filePath, second.uuid);
    await fs.writeFile(filePath, 'after-second-edit');
    await writer!.close();
    writer = undefined;
    await store!.close();
    store = undefined;

    const resumed = await new TranscriptRepository().resolveSession(
      homeTranscriptPath,
    );
    const restoredHistory = new FileHistoryManager({
      cwd: repoRoot,
      sessionId,
      checkpointRoot,
    });
    await restoredHistory.rehydrateFromResume({
      sourceSessionId: sessionId,
      snapshots: resumed!.fileHistorySnapshots,
    });
    expect(
      (await restoredHistory.rewindDetailed(first.uuid)).failedFiles,
    ).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe('before-first-edit');
    expect(
      (await restoredHistory.rewindDetailed(second.uuid)).failedFiles,
    ).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe('after-first-edit');
  });

  it.each([false, true])(
    'preserves the project and excludes unscoped snapshots on a second resume from a retained legacy bucket (interrupted=%s)',
    async (interrupted) => {
      vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(configHome);
      const worktreePath = path.join(
        repoRoot,
        '.qwen',
        'worktrees',
        'missing',
      );
      const { config, sessionId, homeTranscriptPath } = await createRuntime(
        undefined,
        false,
        worktreePath,
      );
      const legacyState = {
        originalCwd: repoRoot,
        worktreePath,
        worktreeName: 'missing',
        sessionId,
        lifecycle: 'owner' as const,
      };
      const sidecar = new SessionStateStore({
        projectRoot: worktreePath,
        sessionId,
        encryptPrivateSegments: false,
      });
      await sidecar.setSegment('worktreeSession', legacyState);
      writer!.synchronizeWorktreeRuntimeState(legacyState);
      const message = createUserMessage('legacy worktree edit');
      await writer!.recordMessages([message]);
      await writer!.recordFileHistorySnapshot({
        messageId: message.uuid,
        isSnapshotUpdate: false,
        snapshot: {
          messageId: message.uuid,
          timestamp: new Date(),
          trackedFileBackups: {
            'README.md': {
              backupFileName: null,
              version: 1,
              backupTime: new Date(),
            },
          },
        },
      });
      expect(
        (await new TranscriptRepository().resolveSession(homeTranscriptPath))!
          .fileHistorySnapshots,
      ).toHaveLength(1);
      const selected = await resolveSelectedTranscriptSession(
        (await resolveTranscriptSessionById(worktreePath, sessionId))!
          .sessionInfo,
      );
      let stateToRestore = selected.sessionInfo.worktreeSession!;
      let failConfirmation = interrupted;
      // JSONL 中尚无 worktree-state，原项目身份仅由 sidecar 提供。
      const restore = () =>
        worktreeSessionService.restore(
          {
            config,
            sessionId,
            phase: 'restore',
            recordWorktreeState: async (...args) => {
              if (failConfirmation && args[0] === null) {
                failConfirmation = false;
                throw new Error('interrupted fallback confirmation');
              }
              await writer!.recordWorktreeState(...args);
            },
          },
          stateToRestore,
        );
      if (interrupted) {
        await expect(restore()).rejects.toThrow(
          'interrupted fallback confirmation',
        );
        const retry = await resolveSelectedTranscriptSession(
          (await resolveTranscriptSessionById(worktreePath, sessionId))!
            .sessionInfo,
        );
        stateToRestore = retry.sessionInfo.worktreeSession!;
      }
      await expect(restore()).resolves.toMatchObject({ status: 'fallback' });
      await migrateLegacyWorktreeTranscript({
        sessionId,
        selectedPath: homeTranscriptPath,
        originalCwd: repoRoot,
        relocate: (cwd) =>
          writer!.relocate({
            filePath: getSessionTranscriptPath(cwd, sessionId),
            cwd,
            worktreeSession: null,
          }),
      });
      expect(writer!.getSessionFilePath()).toBe(homeTranscriptPath);
      const newMessage = createUserMessage('ordinary edit after fallback');
      await writer!.recordMessages([newMessage]);
      await writer!.recordFileHistorySnapshot({
        messageId: newMessage.uuid,
        isSnapshotUpdate: false,
        snapshot: {
          messageId: newMessage.uuid,
          cwd: repoRoot,
          timestamp: new Date(),
          trackedFileBackups: {},
        },
      });
      await writer!.recordWorktreeState(null);
      await writer!.close();
      writer = undefined;
      await store!.close();
      store = undefined;
      const resumed = await new TranscriptRepository().resolveSession(
        homeTranscriptPath,
      );
      expect(
        resumed!.index.metadata.worktreeSessions.get(sessionId),
      ).toBeNull();
      const history = new FileHistoryManager({
        cwd: repoRoot,
        sessionId,
        checkpointRoot: path.join(tempRoot, 'checkpoints'),
      });
      history.restoreStateFromSnapshots(resumed!.fileHistorySnapshots);
      expect(
        resumed!.fileHistorySnapshots.map((snapshot) => snapshot.messageId),
      ).toEqual([newMessage.uuid]);
      await expect(history.rewindDetailed(message.uuid)).rejects.toThrow(
        message.uuid,
      );
      expect(await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8')).toBe(
        '# fixture\n',
      );
      const secondResume = await resolveSelectedTranscriptSession(
        (await resolveTranscriptSessionById(worktreePath, sessionId))!
          .sessionInfo,
      );
      expect(secondResume.sessionInfo).toMatchObject({
        worktreeSession: null,
        originalCwd: repoRoot,
        transcriptProjectRoot: worktreePath,
      });
      await config.dispose();
    },
  );

  it('rejects a deleted linked checkout replaced with an ordinary directory inside the repository', async () => {
    const { config, sessionId } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'replaced' })
      .execute(new AbortController().signal);
    const state = toTranscriptWorktreeSession(
      config.getWorktreeSettings()!,
      sessionId,
    );
    process.chdir(repoRoot);
    execFileSync('git', ['worktree', 'remove', '--force', state.worktreePath], {
      cwd: repoRoot,
    });
    await fs.mkdir(state.worktreePath, { recursive: true });
    const restored = await worktreeSessionService.restore(
      {
        config,
        sessionId,
        phase: 'restore',
        recordWorktreeState: (value) => writer!.recordWorktreeState(value),
      },
      state,
    );
    expect(restored).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects a handoff to a child of the current checkout without releasing its owner', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'handoff-child' })
      .execute(new AbortController().signal);
    const state = toTranscriptWorktreeSession(
      config.getWorktreeSettings()!,
      sessionId,
    );
    const child = path.join(state.worktreePath, 'apps');
    await fs.mkdir(child);
    const before = await fs.readFile(homeTranscriptPath, 'utf8');
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    const result = await worktreeSessionService.restore(
      {
        config: freshConfig,
        sessionId,
        phase: 'restore',
        recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
      },
      { ...state, pendingOwnerReleasePath: child },
    );
    expect(result.status).toBe('failed');
    expect(await readWorktreeOwnerState(state.worktreePath)).toMatchObject({
      ownerSessionId: sessionId,
    });
    expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
    expect(freshConfig.getWorktreeSettings()).toBeUndefined();
  });

  it('preserves persisted owner authority when owner metadata cannot be verified', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'unavailable-owner' })
      .execute(new AbortController().signal);
    const state = toTranscriptWorktreeSession(
      config.getWorktreeSettings()!,
      sessionId,
    );
    const layout = await resolveGitRepositoryLayout(state.worktreePath);
    const ownerFile = path.join(layout!.gitDir, 'qwen-worktree.json');
    const owner = await fs.readFile(ownerFile, 'utf8');
    const before = await fs.readFile(homeTranscriptPath, 'utf8');
    await fs.writeFile(ownerFile, '{');
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    const context = {
      config: freshConfig,
      sessionId,
      phase: 'restore' as const,
      recordWorktreeState: (
        ...args: Parameters<TranscriptWriterHandle['recordWorktreeState']>
      ) => writer!.recordWorktreeState(...args),
    };
    expect((await worktreeSessionService.restore(context, state)).status).toBe(
      'failed',
    );
    expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
    expect(freshConfig.getWorktreeSettings()).toBeUndefined();
    await fs.writeFile(ownerFile, owner);
    expect(await worktreeSessionService.restore(context, state)).toMatchObject({
      status: 'restored',
      settings: { lifecycle: 'owner' },
    });
  });

  it.each(['keep', 'remove'] as const)(
    'keeps a recoverable exit intent until %s cleanup has completed',
    async (action) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      await new EnterWorktreeTool(config)
        .build({ name: `exit-${action}` })
        .execute(new AbortController().signal);
      const worktreePath = config.getWorktreeSettings()!.path;
      const checkpoints: Array<{ state: unknown; ownerExists: boolean }> = [];
      await worktreeSessionService.leave(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: async (...args) => {
            await writer!.recordWorktreeState(...args);
            checkpoints.push({
              state: (await readEntries(homeTranscriptPath))
                .filter((entry) => entry.type === 'worktree-state')
                .at(-1),
              ownerExists:
                (await readWorktreeOwnerState(worktreePath)) !== null,
            });
          },
        },
        { action, force: false },
      );
      expect(checkpoints[0]).toMatchObject({
        state: { worktreeSession: { pendingExit: true, worktreePath } },
        ownerExists: true,
      });
      expect(checkpoints.at(-1)).toMatchObject({
        state: { worktreeSession: null },
        ownerExists: false,
      });
    },
  );

  it.each([false, true])(
    'returns to the original project after partial Git removal (final write fails: %s)',
    async (failFinalWrite) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      await new EnterWorktreeTool(config)
        .build({ name: 'partial-removal' })
        .execute(new AbortController().signal);
      const worktreePath = config.getWorktreeSettings()!.path;
      const marker = await fs.readFile(path.join(worktreePath, '.git'));
      vi.spyOn(worktreeService, 'cleanupWorktreeSession').mockImplementationOnce(
        async () => {
          // 模拟 Git 已注销 checkout，却因权限错误留下目录和失效 .git 指针。
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
            cwd: repoRoot,
          });
          await fs.mkdir(worktreePath);
          await fs.writeFile(path.join(worktreePath, '.git'), marker);
          await fs.writeFile(
            path.join(worktreePath, 'retained.txt'),
            'user data',
          );
          return {
            removed: false,
            reason: 'cleanup-failed',
            message: 'Permission denied',
          };
        },
      );
      const result = await worktreeSessionService.leave(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: async (state) => {
            if (failFinalWrite && state === null)
              throw new Error('final write unavailable');
            await writer!.recordWorktreeState(state);
          },
        },
        { action: 'remove', force: true },
      );
      expect(result).toMatchObject({
        action: 'remove',
        cleanup: { status: 'partial' },
      });
      expect(config.getWorkingDir()).toBe(repoRoot);
      expect(config.getWorktreeSettings()).toBeUndefined();
      const state = (await readEntries(homeTranscriptPath))
        .filter((entry) => entry.type === 'worktree-state')
        .at(-1)!.worktreeSession;
      if (failFinalWrite) {
        expect(state).toMatchObject({ pendingExit: true });
        const freshConfig = makeFakeConfig({
          sessionId,
          targetDir: repoRoot,
          cwd: repoRoot,
        });
        expect(
          await worktreeSessionService.restore(
            {
              config: freshConfig,
              sessionId,
              phase: 'restore',
              recordWorktreeState: (...args) =>
                writer!.recordWorktreeState(...args),
            },
            state!,
          ),
        ).toMatchObject({ status: 'fallback' });
        expect(freshConfig.getWorkingDir()).toBe(repoRoot);
      } else {
        expect(state).toBeNull();
      }
      expect(
        await fs.readFile(path.join(worktreePath, 'retained.txt'), 'utf8'),
      ).toBe('user data');
      expect(
        (await readEntries(homeTranscriptPath))
          .filter((entry) => entry.type === 'worktree-state')
          .at(-1)!.worktreeSession,
      ).toBeNull();
    },
  );

  it('settles a partial exit before entering another checkout without losing the old durable owner', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'unfinished-exit' })
      .execute(new AbortController().signal);
    const oldPath = config.getWorktreeSettings()!.path;
    const layout = (await resolveGitRepositoryLayout(oldPath))!;
    const ownerPath = path.join(layout.gitDir, 'qwen-worktree.json');
    vi.spyOn(worktreeService, 'cleanupWorktreeSession').mockImplementationOnce(
      async () => {
        // checkout 标记已删除，但 Git 登记和 owner 仍需后续结算。
        await fs.unlink(path.join(oldPath, '.git'));
        return {
          removed: false,
          reason: 'cleanup-failed',
          message: 'Partial removal',
        };
      },
    );
    vi.spyOn(
      worktreeOwnerState,
      'releaseWorktreeOwnershipForHandoff',
    ).mockResolvedValueOnce('unavailable');
    expect(
      await worktreeSessionService.leave(
        {
          config,
          sessionId,
          phase: 'runtime',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        { action: 'remove', force: true },
      ),
    ).toMatchObject({ cleanup: { status: 'partial' } });
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(JSON.parse(await fs.readFile(ownerPath, 'utf8'))).toMatchObject({
      ownerSessionId: sessionId,
    });
    expect(
      (await readEntries(homeTranscriptPath))
        .filter((entry) => entry.type === 'worktree-state')
        .at(-1)!.worktreeSession,
    ).toMatchObject({ pendingExit: true, worktreePath: oldPath });

    const result = await new EnterWorktreeTool(config)
      .build({ name: 'after-unfinished-exit' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readEntries(homeTranscriptPath))
        .filter((entry) => entry.type === 'worktree-state')
        .at(-1)!.worktreeSession,
    ).toMatchObject({ worktreePath: config.getWorktreeSettings()!.path });
  });

  it.each([
    ['resume', false],
    ['delete', false],
    ['resume', true],
    ['delete', true],
  ] as const)(
    'settles the registered owner through a parent alias before %s discards a missing checkout state (hook=%s)',
    async (operation, hookBased) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      await new EnterWorktreeTool(config)
        .build({ name: 'missing-owned-checkout' })
        .execute(new AbortController().signal);
      const state = {
        ...toTranscriptWorktreeSession(
          config.getWorktreeSettings()!,
          sessionId,
        ),
        hookBased,
      };
      const layout = (await resolveGitRepositoryLayout(state.worktreePath))!;
      const worktreeParentAlias = path.join(tempRoot, 'worktree-parent-alias');
      await fs.symlink(
        path.dirname(state.worktreePath),
        worktreeParentAlias,
        'dir',
      );
      const canonicalCheckout = state.worktreePath;
      state.worktreePath = path.join(
        worktreeParentAlias,
        path.basename(canonicalCheckout),
      );
      state.worktreeCwd = state.worktreePath;
      process.chdir(repoRoot);
      await fs.rm(canonicalCheckout, { recursive: true });

      if (operation === 'resume') {
        const freshConfig = makeFakeConfig({
          sessionId,
          targetDir: repoRoot,
          cwd: repoRoot,
        });
        await expect(
          worktreeSessionService.restore(
            {
              config: freshConfig,
              sessionId,
              phase: 'restore',
              recordWorktreeState: (...args) =>
                writer!.recordWorktreeState(...args),
            },
            state,
          ),
        ).resolves.toMatchObject({ status: 'fallback' });
        expect(freshConfig.getWorkingDir()).toBe(repoRoot);
        expect(
          (await readEntries(homeTranscriptPath))
            .filter((entry) => entry.type === 'worktree-state')
            .at(-1)!.worktreeSession,
        ).toBeNull();
      } else {
        await releasePersistedWorktreeSessionOwnership(state, sessionId);
      }
      await expect(
        fs.stat(path.join(layout.gitDir, 'qwen-worktree.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['resume', 'delete'] as const)(
    'preserves recovery evidence when %s cannot identify a missing checkout owner',
    async (operation) => {
      const { config, sessionId, homeTranscriptPath } = await createRuntime();
      await new EnterWorktreeTool(config)
        .build({ name: 'unverifiable-missing-checkout' })
        .execute(new AbortController().signal);
      const state = toTranscriptWorktreeSession(
        config.getWorktreeSettings()!,
        sessionId,
      );
      const layout = (await resolveGitRepositoryLayout(state.worktreePath))!;
      process.chdir(repoRoot);
      await fs.rm(state.worktreePath, { recursive: true });
      await fs.writeFile(path.join(layout.gitDir, 'gitdir'), '');
      const before = await fs.readFile(homeTranscriptPath, 'utf8');

      if (operation === 'resume') {
        const freshConfig = makeFakeConfig({
          sessionId,
          targetDir: repoRoot,
          cwd: repoRoot,
        });
        await expect(
          worktreeSessionService.restore(
            {
              config: freshConfig,
              sessionId,
              phase: 'restore',
              recordWorktreeState: (...args) =>
                writer!.recordWorktreeState(...args),
            },
            state,
          ),
        ).resolves.toMatchObject({ status: 'failed' });
      } else {
        await expect(
          releasePersistedWorktreeSessionOwnership(state, sessionId),
        ).rejects.toThrow('Cannot release worktree ownership');
      }
      expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(layout.gitDir, 'qwen-worktree.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ ownerSessionId: sessionId });
    },
  );

  it('settles an interrupted exit through the original repository when the checkout marker is gone', async () => {
    const { config, sessionId } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'missing-exit-marker' })
      .execute(new AbortController().signal);
    const state = {
      ...toTranscriptWorktreeSession(config.getWorktreeSettings()!, sessionId),
      pendingExit: true as const,
    };
    const layout = (await resolveGitRepositoryLayout(state.worktreePath))!;
    await writer!.recordWorktreeState(state);
    await fs.unlink(path.join(state.worktreePath, '.git'));
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    expect(
      await worktreeSessionService.restore(
        {
          config: freshConfig,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
        },
        state,
      ),
    ).toMatchObject({ status: 'fallback' });
    expect(freshConfig.getWorkingDir()).toBe(repoRoot);
    await expect(
      fs.stat(path.join(layout.gitDir, 'qwen-worktree.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await fs.readFile(path.join(state.worktreePath, 'README.md'), 'utf8'),
    ).toBe('# fixture\n');
  });

  it('preserves exit recovery when the original Git registration is malformed', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'unverifiable-exit' })
      .execute(new AbortController().signal);
    const state = {
      ...toTranscriptWorktreeSession(config.getWorktreeSettings()!, sessionId),
      pendingExit: true as const,
    };
    const layout = (await resolveGitRepositoryLayout(state.worktreePath))!;
    await writer!.recordWorktreeState(state);
    await fs.unlink(path.join(state.worktreePath, '.git'));
    await fs.writeFile(path.join(layout.gitDir, 'gitdir'), '');
    const before = await fs.readFile(homeTranscriptPath, 'utf8');
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    expect(
      await worktreeSessionService.restore(
        {
          config: freshConfig,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) => writer!.recordWorktreeState(...args),
        },
        state,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(await fs.readFile(homeTranscriptPath, 'utf8')).toBe(before);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(layout.gitDir, 'qwen-worktree.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ ownerSessionId: sessionId });
  });

  it('finishes an interrupted exit without deleting the retained checkout on resume', async () => {
    const { config, sessionId } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'exit-resume' })
      .execute(new AbortController().signal);
    const state = {
      ...toTranscriptWorktreeSession(config.getWorktreeSettings()!, sessionId),
      pendingExit: true as const,
    };
    await writer!.recordWorktreeState(state);
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    expect(
      await worktreeSessionService.restore(
        {
          config: freshConfig,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        state,
      ),
    ).toMatchObject({ status: 'fallback' });
    expect(freshConfig.getWorkingDir()).toBe(repoRoot);
    expect(await readWorktreeOwnerState(state.worktreePath)).toBeNull();
    expect((await fs.stat(state.worktreePath)).isDirectory()).toBe(true);
  });

  it('resumes the exit intent when cleanup succeeded but its final write failed', async () => {
    const { config, sessionId, homeTranscriptPath } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'exit-final-write' })
      .execute(new AbortController().signal);
    const worktreePath = config.getWorktreeSettings()!.path;
    const result = await worktreeSessionService.leave(
      {
        config,
        sessionId,
        phase: 'runtime',
        recordWorktreeState: async (state) => {
          if (state === null) throw new Error('final write unavailable');
          await writer!.recordWorktreeState(state);
        },
      },
      { action: 'keep' },
    );
    expect(result).toMatchObject({
      action: 'keep',
      cleanup: { status: 'partial' },
    });
    expect(config.getWorkingDir()).toBe(repoRoot);
    expect(await readWorktreeOwnerState(worktreePath)).toBeNull();
    await writer!.recordMessages([
      createUserMessage('continue after interrupted exit'),
    ]);
    await writer!.flush();
    expect(
      (await readEntries(homeTranscriptPath))
        .filter((entry) => entry.type === 'user')
        .at(-1),
    ).toMatchObject({ cwd: repoRoot, gitBranch: 'main' });
    const state = (await readEntries(homeTranscriptPath))
      .filter((entry) => entry.type === 'worktree-state')
      .at(-1)!.worktreeSession!;
    expect(state.pendingExit).toBe(true);
    const freshConfig = makeFakeConfig({
      sessionId,
      targetDir: repoRoot,
      cwd: repoRoot,
    });
    expect(
      await worktreeSessionService.restore(
        {
          config: freshConfig,
          sessionId,
          phase: 'restore',
          recordWorktreeState: (...args) =>
            writer!.recordWorktreeState(...args),
        },
        state,
      ),
    ).toMatchObject({ status: 'fallback' });
    expect(
      (await readEntries(homeTranscriptPath))
        .filter((entry) => entry.type === 'worktree-state')
        .at(-1)!.worktreeSession,
    ).toBeNull();
  });

  it('maps the project subdirectory from a linked source checkout into the new checkout', async () => {
    await fs.mkdir(path.join(repoRoot, 'apps/desktop'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'apps/desktop/app.txt'), 'fixture');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'app',
      ],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const sourceRoot = path.join(tempRoot, 'source');
    execFileSync('git', ['worktree', 'add', '-b', 'source', sourceRoot], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    const originalCwd = path.join(sourceRoot, 'apps/desktop');
    const prepared = await worktreeSessionService.prepare(
      { sessionId: randomUUID() },
      {
        kind: 'create',
        name: 'from-linked',
        originalCwd,
        projectRoot: originalCwd,
      },
    );
    expect(prepared.settings.worktreeCwd).toBe(
      path.join(prepared.settings.path, 'apps/desktop'),
    );
  });

  it('moves one session into and back out of a worktree without moving its JSONL', async () => {
    const { config, homeTranscriptPath, sessionId } = await createRuntime();
    await writer!.recordMessages([
      createUserMessage('before enter', {
        uuid: '00000000-0000-4000-8000-000000000001',
      }),
    ]);

    const enterResult = await new EnterWorktreeTool(config)
      .build({ name: 'runtime-keep' })
      .execute(new AbortController().signal);

    expect(enterResult.error).toBeUndefined();
    const settings = config.getWorktreeSettings();
    expect(settings).toMatchObject({
      lifecycle: 'owner',
      originalCwd: repoRoot,
      worktreeBranch: 'worktree-runtime-keep',
      sessionId,
    });
    const worktreePath = settings!.path;
    const worktreeTranscriptPath = getSessionTranscriptPath(
      worktreePath,
      sessionId,
      configHome,
    );
    expect(process.cwd()).toBe(worktreePath);
    expect(currentCwdForTest()).toBe(worktreePath);
    expect(writer!.filePath).toBe(homeTranscriptPath);

    await writer!.recordMessages([
      createUserMessage('inside worktree', {
        uuid: '00000000-0000-4000-8000-000000000002',
      }),
    ]);
    await writer!.flush();
    const insideEntries = await readEntries(homeTranscriptPath);
    expect(
      insideEntries.find(
        (entry) =>
          entry.type === 'user' &&
          entry.uuid === '00000000-0000-4000-8000-000000000001',
      ),
    ).toMatchObject({ cwd: repoRoot, gitBranch: 'main' });
    expect(
      insideEntries.find(
        (entry) =>
          entry.type === 'user' &&
          entry.uuid === '00000000-0000-4000-8000-000000000002',
      ),
    ).toMatchObject({
      cwd: worktreePath,
      gitBranch: 'worktree-runtime-keep',
    });
    expect(
      insideEntries.some((entry) => entry.type === 'relocated'),
    ).toBe(false);
    expect(insideEntries).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: expect.objectContaining({
          worktreePath,
          lifecycle: 'owner',
        }),
      }),
    );

    const exitResult = await new ExitWorktreeTool(config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(exitResult.error).toBeUndefined();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(currentCwdForTest()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await expect(fs.access(worktreePath)).resolves.toBeUndefined();
    await expect(fs.access(worktreeTranscriptPath)).rejects.toThrow();

    await writer!.recordMessages([
      createUserMessage('after exit', {
        uuid: '00000000-0000-4000-8000-000000000003',
      }),
    ]);
    await writer!.flush();
    const finalEntries = await readEntries(homeTranscriptPath);
    expect(
      finalEntries.find(
        (entry) =>
          entry.type === 'user' &&
          entry.uuid === '00000000-0000-4000-8000-000000000003',
      ),
    ).toMatchObject({ type: 'user', cwd: repoRoot, gitBranch: 'main' });
    expect(finalEntries).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: null,
      }),
    );
  });

  it('releases ownership on explicit keep so a later session can attach', async () => {
    const firstRuntime = await createRuntime();
    const firstEnter = await new EnterWorktreeTool(firstRuntime.config)
      .build({ name: 'kept-for-attach' })
      .execute(new AbortController().signal);
    expect(firstEnter.error).toBeUndefined();
    const keptWorktreePath = firstRuntime.config.getWorktreeSettings()!.path;
    expect(await readWorktreeOwnerState(keptWorktreePath)).toMatchObject({
      ownerSessionId: firstRuntime.sessionId,
    });

    const firstExit = await new ExitWorktreeTool(firstRuntime.config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);
    expect(firstExit.error).toBeUndefined();
    expect(await readWorktreeOwnerState(keptWorktreePath)).toBeNull();

    await writer!.close();
    writer = undefined;
    await store!.close();
    store = undefined;

    const secondRuntime = await createRuntime();
    const secondEnter = await new EnterWorktreeTool(secondRuntime.config)
      .build({ path: keptWorktreePath })
      .execute(new AbortController().signal);
    expect(secondEnter.error).toBeUndefined();
    expect(secondRuntime.config.getWorktreeSettings()).toMatchObject({
      path: keptWorktreePath,
      lifecycle: 'attached',
      enteredExisting: true,
    });

    const secondExit = await new ExitWorktreeTool(secondRuntime.config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);
    expect(secondExit.error).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    await expect(fs.access(keptWorktreePath)).resolves.toBeUndefined();
  });

  it('enters an existing registered worktree as attached and only allows keep', async () => {
    const manualWorktreePath = path.join(tempRoot, 'manual-existing');
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'manual-existing', manualWorktreePath, 'HEAD'],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const canonicalManualPath = await fs.realpath(manualWorktreePath);
    const { config, homeTranscriptPath } = await createRuntime();

    const entered = await new EnterWorktreeTool(config)
      .build({ path: canonicalManualPath })
      .execute(new AbortController().signal);

    expect(entered.error).toBeUndefined();
    expect(entered.toolUseResult).toMatchObject({
      worktreePath: canonicalManualPath,
      worktreeBranch: 'manual-existing',
    });
    expect(config.getWorktreeSettings()).toMatchObject({
      path: canonicalManualPath,
      lifecycle: 'attached',
      enteredExisting: true,
      originalCwd: repoRoot,
    });
    expect(config.getWorktreeSettings()).not.toHaveProperty('sessionId');
    expect(process.cwd()).toBe(canonicalManualPath);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await writer!.flush();
    expect(await readEntries(homeTranscriptPath)).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: expect.objectContaining({
          worktreePath: canonicalManualPath,
          lifecycle: 'attached',
          enteredExisting: true,
        }),
      }),
    );

    const refused = await new ExitWorktreeTool(config)
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);
    expect(refused.llmContent).toContain('does not own the worktree');
    expect(config.getWorktreeSettings()?.path).toBe(canonicalManualPath);
    expect(process.cwd()).toBe(canonicalManualPath);
    await expect(fs.access(canonicalManualPath)).resolves.toBeUndefined();

    const kept = await new ExitWorktreeTool(config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);
    expect(kept.error).toBeUndefined();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await expect(fs.access(canonicalManualPath)).resolves.toBeUndefined();
    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    ).toContain(`worktree ${canonicalManualPath}`);
    expect(await readEntries(homeTranscriptPath)).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: null,
      }),
    );
  });

  it('rejects an existing directory that is not a registered worktree', async () => {
    const ordinaryDirectory = path.join(repoRoot, 'ordinary-directory');
    await fs.mkdir(ordinaryDirectory);
    const { config, homeTranscriptPath } = await createRuntime();

    const result = await new EnterWorktreeTool(config)
      .build({ path: ordinaryDirectory })
      .execute(new AbortController().signal);

    expect(result.error).toMatchObject({ type: 'execution_failed' });
    expect(result.llmContent).toContain('is not registered by git');
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
  });

  it('rejects an existing worktree owned by another CLI session', async () => {
    const managedPath = path.join(
      repoRoot,
      '.qwen',
      'worktrees',
      'other-owner',
    );
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'worktree-other-owner', managedPath, 'HEAD'],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    await expect(
      claimWorktreeOwnership(managedPath, 'another-session'),
    ).resolves.toBe('owned');
    const { config, homeTranscriptPath } = await createRuntime('this-session');

    const result = await new EnterWorktreeTool(config)
      .build({ path: managedPath })
      .execute(new AbortController().signal);

    expect(result.error).toMatchObject({ type: 'execution_failed' });
    expect(result.llmContent).toContain(`owned by another active ${BRAND_NAME} session`);
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
  });

  it('switches from an owned worktree to a managed sibling and preserves the old worktree', async () => {
    const siblingPath = path.join(
      repoRoot,
      '.qwen',
      'worktrees',
      'switch-target',
    );
    await fs.mkdir(path.dirname(siblingPath), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'worktree-switch-target', siblingPath, 'HEAD'],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const { config, homeTranscriptPath, sessionId } = await createRuntime();
    const firstEnter = await new EnterWorktreeTool(config)
      .build({ name: 'switch-owner' })
      .execute(new AbortController().signal);
    expect(firstEnter.error).toBeUndefined();
    const oldWorktreePath = config.getWorktreeSettings()!.path;
    expect(await readWorktreeOwnerState(oldWorktreePath)).toMatchObject({
      ownerSessionId: sessionId,
    });

    const switched = await new EnterWorktreeTool(config)
      .build({ path: siblingPath })
      .execute(new AbortController().signal);

    expect(switched.error).toBeUndefined();
    expect(switched.llmContent).toContain(
      `previous worktree is preserved at ${oldWorktreePath}`,
    );
    expect(config.getWorktreeSettings()).toMatchObject({
      path: siblingPath,
      lifecycle: 'attached',
      enteredExisting: true,
      originalCwd: repoRoot,
    });
    expect(process.cwd()).toBe(siblingPath);
    await expect(fs.access(oldWorktreePath)).resolves.toBeUndefined();
    await expect(readWorktreeOwnerState(oldWorktreePath)).resolves.toBeNull();
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await writer!.flush();
    expect(await readEntries(homeTranscriptPath)).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: expect.objectContaining({
          worktreePath: siblingPath,
          enteredExisting: true,
        }),
      }),
    );

    const kept = await new ExitWorktreeTool(config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);
    expect(kept.error).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await expect(fs.access(oldWorktreePath)).resolves.toBeUndefined();
    await expect(fs.access(siblingPath)).resolves.toBeUndefined();
  });

  it('rejects the current checkout, main checkout, and a Git-locked worktree path', async () => {
    const lockedPath = path.join(
      repoRoot,
      '.qwen',
      'worktrees',
      'locked-existing',
    );
    await fs.mkdir(path.dirname(lockedPath), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'locked-existing', lockedPath, 'HEAD'],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    execFileSync('git', ['worktree', 'lock', '--reason', 'test', lockedPath], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    const { config, homeTranscriptPath } = await createRuntime();

    const currentResult = await new EnterWorktreeTool(config)
      .build({ path: repoRoot })
      .execute(new AbortController().signal);
    expect(currentResult.error).toMatchObject({ type: 'execution_failed' });
    expect(currentResult.llmContent).toContain('current working directory');

    const entered = await new EnterWorktreeTool(config)
      .build({ name: 'validation-owner' })
      .execute(new AbortController().signal);
    expect(entered.error).toBeUndefined();
    const ownedPath = config.getWorktreeSettings()!.path;

    const mainResult = await new EnterWorktreeTool(config)
      .build({ path: repoRoot })
      .execute(new AbortController().signal);
    expect(mainResult.error).toMatchObject({ type: 'execution_failed' });
    expect(mainResult.llmContent).toContain('main working tree');

    const lockedResult = await new EnterWorktreeTool(config)
      .build({ path: lockedPath })
      .execute(new AbortController().signal);
    expect(lockedResult.error).toMatchObject({ type: 'execution_failed' });
    expect(lockedResult.llmContent).toContain('locked by another worktree owner');
    expect(config.getWorktreeSettings()?.path).toBe(ownedPath);
    expect(process.cwd()).toBe(ownedPath);

    const removed = await new ExitWorktreeTool(config)
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);
    expect(removed.error).toBeUndefined();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
  });

  it('finalize removes a clean worktree branch ahead of the original checkout', async () => {
    const { config, sessionId } = await createRuntime();
    execFileSync('git', ['checkout', '-b', 'remote-base'], { cwd: repoRoot });
    execFileSync(
      'git',
      [
        '-c', 'user.name=Test User',
        '-c', 'user.email=test-user@example.com',
        'commit', '--allow-empty', '-m', 'remote advance',
      ],
      { cwd: repoRoot },
    );
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      {
        kind: 'create',
        name: 'clean-remove',
        originalCwd: repoRoot,
        projectRoot: repoRoot,
        options: { baseRef: 'head' },
      },
    );
    execFileSync('git', ['checkout', 'main'], { cwd: repoRoot });
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: (
        ...args: Parameters<typeof config.recordWorktreeState>
      ) => config.recordWorktreeState(...args),
    };
    await worktreeSessionService.enter(context, prepared);
    const settings = config.getWorktreeSettings()!;
    await expect(
      worktreeSessionService.finalize(context, { action: 'inspect' }),
    ).resolves.toMatchObject({ changedFiles: 0, commits: 0 });

    await expect(
      worktreeSessionService.finalize(context, { action: 'remove', force: false }),
    ).resolves.toEqual({ action: 'remove' });

    await expect(fs.access(settings.path)).rejects.toThrow();
    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }),
    ).not.toContain(settings.path);
    expect(
      spawnSync(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/heads/${settings.worktreeBranch}`],
        { cwd: repoRoot },
      ).status,
    ).toBe(1);
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
  });

  it('finalize reports partial cleanup when another checkout prevents branch deletion', async () => {
    const { config, sessionId } = await createRuntime();
    await new EnterWorktreeTool(config)
      .build({ name: 'shared-branch-remove' })
      .execute(new AbortController().signal);
    const settings = config.getWorktreeSettings()!;
    execFileSync(
      'git',
      ['worktree', 'add', '--force', path.join(tempRoot, 'other-checkout'), settings.worktreeBranch!],
      { cwd: repoRoot },
    );

    const result = await worktreeSessionService.finalize(
      {
        config,
        sessionId,
        phase: 'runtime',
        recordWorktreeState: (...args) => config.recordWorktreeState(...args),
      },
      { action: 'remove', force: false },
    );

    expect(result).toMatchObject({
      action: 'remove',
      cleanup: {
        status: 'partial',
        message: expect.stringContaining(`git branch delete failed for ${settings.worktreeBranch}`),
      },
    });
    await expect(fs.access(settings.path)).rejects.toThrow();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
  });

  it('refuses dirty removal, then removes only after explicit discard', async () => {
    const { config, homeTranscriptPath } = await createRuntime();
    await writer!.recordMessages([createUserMessage('start dirty removal')]);
    const enterResult = await new EnterWorktreeTool(config)
      .build({ name: 'runtime-remove' })
      .execute(new AbortController().signal);
    expect(enterResult.error).toBeUndefined();
    const worktreePath = config.getWorktreeSettings()!.path;
    await fs.writeFile(path.join(worktreePath, 'untracked.txt'), 'keep me\n');

    const refused = await new ExitWorktreeTool(config)
      .build({ action: 'remove' })
      .execute(new AbortController().signal);

    expect(refused.llmContent).toContain('uncommitted file(s)');
    expect(config.getWorktreeSettings()?.path).toBe(worktreePath);
    expect(process.cwd()).toBe(worktreePath);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await expect(fs.access(worktreePath)).resolves.toBeUndefined();

    const removed = await new ExitWorktreeTool(config)
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);

    expect(removed.error).toBeUndefined();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    await expect(fs.access(worktreePath)).rejects.toThrow();
    const entries = await readEntries(homeTranscriptPath);
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: null,
      }),
    );
  });

  it('does not merge or overwrite a conflicting JSONL in the worktree bucket', async () => {
    const { config, homeTranscriptPath, sessionId } = await createRuntime();
    await writer!.recordMessages([createUserMessage('start conflict check')]);
    const enterResult = await new EnterWorktreeTool(config)
      .build({ name: 'runtime-collision' })
      .execute(new AbortController().signal);
    expect(enterResult.error).toBeUndefined();
    const worktreePath = config.getWorktreeSettings()!.path;
    const worktreeTranscriptPath = getSessionTranscriptPath(
      worktreePath,
      sessionId,
      configHome,
    );
    await fs.mkdir(path.dirname(worktreeTranscriptPath), { recursive: true });
    await fs.writeFile(worktreeTranscriptPath, '{"sentinel":true}\n');

    const exited = await new ExitWorktreeTool(config)
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(exited.error).toBeUndefined();
    expect(config.getWorktreeSettings()).toBeUndefined();
    expect(process.cwd()).toBe(repoRoot);
    expect(writer!.filePath).toBe(homeTranscriptPath);
    expect(await fs.readFile(worktreeTranscriptPath, 'utf8')).toBe(
      '{"sentinel":true}\n',
    );
    expect(await readEntries(homeTranscriptPath)).toContainEqual(
      expect.objectContaining({
        type: 'worktree-state',
        worktreeSession: null,
      }),
    );
  });

  it('roots a child-agent worktree at the main repository when the parent is already isolated', async () => {
    const { config } = await createRuntime();
    const entered = await new EnterWorktreeTool(config)
      .build({ name: 'runtime-parent' })
      .execute(new AbortController().signal);
    expect(entered.error).toBeUndefined();
    const parentWorktreePath = config.getWorktreeSettings()!.path;

    const childRoot = await resolveAgentWorktreeProjectRoot(
      parentWorktreePath,
      false,
    );
    expect(childRoot).toBe(repoRoot);
    expect(
      await resolveAgentWorktreeProjectRoot(parentWorktreePath, true),
    ).toBe(parentWorktreePath);

    await fs.writeFile(
      path.join(parentWorktreePath, 'parent-only.txt'),
      'parent worktree commit\n',
    );
    execFileSync('git', ['add', 'parent-only.txt'], {
      cwd: parentWorktreePath,
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test-user@example.com',
        'commit',
        '-m',
        'parent worktree change',
      ],
      { cwd: parentWorktreePath, stdio: 'ignore' },
    );
    const parentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: parentWorktreePath,
      encoding: 'utf8',
    }).trim();

    const child = await createAgentWorktree(
      'agent-general-purpose-integration',
      childRoot,
      { baseRef: 'head', fromCwd: parentWorktreePath },
    );
    expect(child.gitRoot).toBe(repoRoot);
    expect(child.headCommit).toBe(parentHead);
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: child.worktreePath,
        encoding: 'utf8',
      }).trim(),
    ).toBe(parentHead);
    await expect(
      fs.readFile(path.join(child.worktreePath, 'parent-only.txt'), 'utf8'),
    ).resolves.toBe('parent worktree commit\n');
    expect(child.worktreePath).toBe(
      path.join(repoRoot, '.qwen', 'worktrees', 'agent-general-purpose-integration'),
    );
    expect(child.worktreePath).not.toContain(
      path.join(parentWorktreePath, '.qwen', 'worktrees'),
    );

    expect(
      await removeAgentWorktree(
        child.worktreePath,
        child.worktreeBranch,
        child.gitRoot,
      ),
    ).toBe(true);
    const removedParent = await new ExitWorktreeTool(config)
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);
    expect(removedParent.error).toBeUndefined();
  });

  it('preserves an expired agent worktree that contains untracked files', async () => {
    execFileSync(
      'git',
      ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const child = await createAgentWorktree(
      'agent-general-purpose-abcdef0',
      repoRoot,
    );
    const untrackedPath = path.join(child.worktreePath, 'generated.txt');
    await fs.writeFile(untrackedPath, 'must survive cleanup\n');
    const expired = new Date(0);
    await fs.utimes(child.worktreePath, expired, expired);

    await expect(
      cleanupStaleAgentWorktrees(new Date(), repoRoot),
    ).resolves.toBe(0);
    await expect(fs.readFile(untrackedPath, 'utf8')).resolves.toBe(
      'must survive cleanup\n',
    );

    expect(
      await removeAgentWorktree(
        child.worktreePath,
        child.worktreeBranch,
        child.gitRoot,
      ),
    ).toBe(true);
  });

  it.each(['owned', 'incomplete', 'unowned'] as const)(
    'only sweeps expired worktrees without ownership evidence: %s',
    async (ownership) => {
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      const child = await createAgentWorktree(
        'agent-cleanup-abcdef0',
        repoRoot,
        { baseRef: 'head' },
      );
      const layout = await resolveGitRepositoryLayout(child.worktreePath);
      const ownerPath = path.join(layout!.gitDir, 'qwen-worktree.json');
      if (ownership === 'owned') {
        await claimWorktreeOwnership(child.worktreePath, 'persisted-session');
      } else if (ownership === 'incomplete') {
        await fs.writeFile(ownerPath, '{');
      }
      const expired = new Date(0);
      await fs.utimes(child.worktreePath, expired, expired);

      const removed = await cleanupStaleAgentWorktrees(new Date(), repoRoot);
      expect(removed).toBe(ownership === 'unowned' ? 1 : 0);
      if (ownership === 'unowned') {
        await expect(fs.stat(child.worktreePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        await expect(
          fs.readFile(path.join(child.worktreePath, 'README.md'), 'utf8'),
        ).resolves.toBe('# fixture\n');
        expect(await fs.readFile(ownerPath, 'utf8')).toContain(
          ownership === 'owned' ? 'persisted-session' : '{',
        );
      }
    },
  );

  it.each(['owned', 'incomplete', 'unowned'] as const)(
    'only resumes an agent checkout without session ownership evidence: %s',
    async (ownership) => {
      const slug = 'agent-resume-abcdef0';
      const child = await createAgentWorktree(slug, repoRoot, {
        baseRef: 'head',
      });
      const layout = await resolveGitRepositoryLayout(child.worktreePath);
      const ownerPath = path.join(layout!.gitDir, 'qwen-worktree.json');
      if (ownership === 'owned') {
        await claimWorktreeOwnership(child.worktreePath, 'persisted-session');
      } else if (ownership === 'incomplete') {
        await fs.writeFile(ownerPath, '{');
      }

      const resumed = createAgentWorktree(slug, repoRoot, { baseRef: 'head' });
      if (ownership === 'unowned') {
        await expect(resumed).resolves.toMatchObject({
          worktreePath: child.worktreePath,
        });
      } else {
        await expect(resumed).rejects.toThrow(/ownership/i);
        expect(await fs.readFile(ownerPath, 'utf8')).toContain(
          ownership === 'owned' ? 'persisted-session' : '{',
        );
      }
      await expect(
        fs.readFile(path.join(child.worktreePath, 'README.md'), 'utf8'),
      ).resolves.toBe('# fixture\n');
    },
  );

  it('does not create an agent checkout while a session transition reserves its path', async () => {
    const slug = 'agent-create-abcdef0';
    const target = path.join(repoRoot, '.qwen', 'worktrees', slug);
    await withWorktreeReservation(target, async () => {
      await expect(
        createAgentWorktree(slug, repoRoot, { baseRef: 'head' }),
      ).rejects.toThrow(/in progress/i);
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await expect(
      createAgentWorktree(slug, repoRoot, { baseRef: 'head' }),
    ).resolves.toMatchObject({ worktreePath: target });
  });

  it.each([
    ['stale', 'tracked edit'],
    ['stale', 'detached commit'],
    ['bridge', 'tracked edit'],
    ['bridge', 'detached commit'],
  ] as const)(
    'preserves %s cleanup when a %s is made before its reservation',
    async (cleanup, change) => {
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      const child = await createAgentWorktree(
        'agent-concurrent-abcdef0',
        repoRoot,
        {
          baseRef: 'head',
        },
      );
      const expired = new Date(0);
      await fs.utimes(child.worktreePath, expired, expired);
      const reserve = worktreeReservation.withWorktreeReservation;
      vi.spyOn(worktreeReservation, 'withWorktreeReservation').mockImplementation(
        (target, operation, reservations) =>
          reserve(
            target,
            async (reservation) => {
              // 真实写入发生在扫描之后；目录年龄不能代表已有文件或 HEAD 未变化。
              await fs.writeFile(
                path.join(child.worktreePath, 'README.md'),
                'new work\n',
              );
              if (change === 'detached commit') {
                execFileSync('git', ['checkout', '--detach'], {
                  cwd: child.worktreePath,
                  stdio: 'ignore',
                });
                execFileSync(
                  'git',
                  [
                    '-c',
                    'user.name=Test User',
                    '-c',
                    'user.email=test-user@example.com',
                    'commit',
                    '-am',
                    'new work',
                  ],
                  {
                    cwd: child.worktreePath,
                    stdio: 'ignore',
                  },
                );
              }
              await fs.utimes(child.worktreePath, expired, expired);
              return operation(reservation);
            },
            reservations,
          ),
      );

      if (cleanup === 'stale') {
        await expect(
          cleanupStaleAgentWorktrees(new Date(), repoRoot),
        ).resolves.toBe(0);
      } else {
        const bridge = new worktreeService.WorktreeService(repoRoot);
        await expect(
          bridge.maybeCleanup({
            name: path.basename(child.worktreePath),
            path: child.worktreePath,
            baseSha: child.headCommit,
            worktreeBranch: child.worktreeBranch,
          }),
        ).resolves.toBe(false);
      }
      await expect(
        fs.readFile(path.join(child.worktreePath, 'README.md'), 'utf8'),
      ).resolves.toBe('new work\n');
    },
  );

  it('preserves an agent checkout reused after the stale cleanup scan', async () => {
    const slug = 'agent-reused-abcdef0';
    const child = await createAgentWorktree(slug, repoRoot, {
      baseRef: 'head',
    });
    const cutoff = new Date(Date.now() - 1000);
    await fs.utimes(child.worktreePath, new Date(0), new Date(0));
    expect((await fs.stat(child.worktreePath)).mtimeMs).toBeLessThan(
      cutoff.getTime(),
    );
    await createAgentWorktree(slug, repoRoot, { baseRef: 'head' });

    await expect(
      removeAgentWorktree(
        child.worktreePath,
        child.worktreeBranch,
        repoRoot,
        { staleCutoff: cutoff },
      ),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(child.worktreePath, 'README.md'), 'utf8'),
    ).resolves.toBe('# fixture\n');
  });

  it('does not remove an agent checkout while a session transition holds its reservation', async () => {
    const child = await createAgentWorktree('agent-cleanup-abcdef0', repoRoot, {
      baseRef: 'head',
    });
    const remove = () =>
      removeAgentWorktree(
        child.worktreePath,
        child.worktreeBranch,
        child.gitRoot,
      );
    await withWorktreeReservation(child.worktreePath, async () => {
      await expect(remove()).resolves.toBe(false);
      await expect(fs.stat(child.worktreePath)).resolves.toBeDefined();
    });
    await expect(remove()).resolves.toBe(true);
    await expect(fs.stat(child.worktreePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves unmerged branch commits when sweeping a clean detached agent checkout', async () => {
    const child = await createAgentWorktree('agent-history-abcdef0', repoRoot, {
      baseRef: 'head',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test-user@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'preserve this work',
      ],
      { cwd: child.worktreePath, stdio: 'ignore' },
    );
    const committed = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: child.worktreePath,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '--detach', 'main'], {
      cwd: child.worktreePath,
      stdio: 'ignore',
    });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    await fs.utimes(child.worktreePath, new Date(0), new Date(0));

    await expect(
      cleanupStaleAgentWorktrees(new Date(), repoRoot),
    ).resolves.toBe(1);
    const retainedBranch = spawnSync(
      'git',
      ['rev-parse', '--verify', `refs/heads/${child.worktreeBranch}`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(retainedBranch.status).toBe(0);
    expect(retainedBranch.stdout.trim()).toBe(committed);
  });

  it.each(['renamed', 'detached'] as const)(
    'reports the actual branch when reusing a %s checkout',
    async (headState) => {
      const child = await createAgentWorktree(
        'agent-branch-abcdef0',
        repoRoot,
        {
          baseRef: 'head',
        },
      );
      execFileSync(
        'git',
        headState === 'renamed'
          ? ['branch', '-m', 'user-renamed-branch']
          : ['checkout', '--detach'],
        { cwd: child.worktreePath, stdio: 'ignore' },
      );
      const resumed = await worktreeService.getOrCreateWorktree(
        repoRoot,
        'agent-branch-abcdef0',
        { baseRef: 'head' },
      );
      expect(resumed.worktreeBranch).toBe(
        headState === 'renamed' ? 'user-renamed-branch' : undefined,
      );
    },
  );

  it('keeps a user-renamed branch after removing its clean agent checkout', async () => {
    const child = await createAgentWorktree('agent-renamed-abcdef0', repoRoot, {
      baseRef: 'head',
    });
    execFileSync('git', ['branch', '-m', 'user-kept-branch'], {
      cwd: child.worktreePath,
      stdio: 'ignore',
    });
    await expect(
      removeAgentWorktree(child.worktreePath, 'user-kept-branch', repoRoot),
    ).resolves.toBe(true);
    expect(
      spawnSync(
        'git',
        ['show-ref', '--verify', 'refs/heads/user-kept-branch'],
        {
          cwd: repoRoot,
          stdio: 'ignore',
        },
      ).status,
    ).toBe(0);
  });

  it.each(['setup', 'cleanup'] as const)(
    'preserves session-owned worktrees in the bridge %s entry point',
    async (operation) => {
      const service = new worktreeService.WorktreeService(repoRoot);
      const info = await service.setup('bridge-owned', { baseRef: 'head' });
      await claimWorktreeOwnership(info.path, 'persisted-session');
      if (operation === 'setup') {
        await expect(
          service.setup('bridge-owned', { baseRef: 'head' }),
        ).rejects.toThrow(/ownership/i);
      } else {
        process.chdir(info.path);
        await expect(service.maybeCleanup(info)).resolves.toBe(false);
        expect(process.cwd()).toBe(info.path);
      }
      expect(await readWorktreeOwnerState(info.path)).toMatchObject({
        ownerSessionId: 'persisted-session',
      });
      await expect(
        fs.readFile(path.join(info.path, 'README.md'), 'utf8'),
      ).resolves.toBe('# fixture\n');
    },
  );

  it.each(['setup', 'cleanup'] as const)(
    'respects a concurrent session reservation in the bridge %s entry point',
    async (operation) => {
      const service = new worktreeService.WorktreeService(repoRoot);
      const info = await service.setup('bridge-reserved', { baseRef: 'head' });
      await withWorktreeReservation(info.path, async () => {
        if (operation === 'setup') {
          await expect(
            service.setup('bridge-reserved', { baseRef: 'head' }),
          ).rejects.toThrow(/in progress/i);
        } else {
          await expect(service.maybeCleanup(info)).resolves.toBe(false);
        }
        await expect(
          fs.readFile(path.join(info.path, 'README.md'), 'utf8'),
        ).resolves.toBe('# fixture\n');
      });
      await expect(service.maybeCleanup(info)).resolves.toBe(true);
    },
  );

  it('creates and cleans an unnamed bridge checkout without leaving cwd inside it', async () => {
    const service = new worktreeService.WorktreeService(repoRoot);
    const info = await service.setup(undefined, { baseRef: 'head' });
    expect(info.created).toBe(true);
    expect(path.basename(info.path)).toBe(info.name);
    expect(info.baseSha).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
    );
    process.chdir(info.path);
    await expect(service.maybeCleanup(info)).resolves.toBe(true);
    expect(process.cwd()).toBe(repoRoot);
    await expect(fs.stat(info.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves modified bridge checkout files', async () => {
    const service = new worktreeService.WorktreeService(repoRoot);
    const info = await service.setup('bridge-modified', { baseRef: 'head' });
    await fs.writeFile(path.join(info.path, 'README.md'), 'keep my edits\n');
    await expect(service.maybeCleanup(info)).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(info.path, 'README.md'), 'utf8'),
    ).resolves.toBe('keep my edits\n');
  });

  it('rejects an agent checkout registered by a different repository', async () => {
    const slug = 'agent-foreign-abcdef0';
    const target = path.join(repoRoot, '.qwen', 'worktrees', slug);
    await createNestedCheckout(repoRoot, target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'another repository\n');

    await expect(
      createAgentWorktree(slug, repoRoot, { baseRef: 'head' }),
    ).rejects.toThrow(/ownership|repository/i);
    await expect(
      removeAgentWorktree(target, undefined, repoRoot),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(target, 'keep.txt'), 'utf8'),
    ).resolves.toBe('another repository\n');
  });
});
