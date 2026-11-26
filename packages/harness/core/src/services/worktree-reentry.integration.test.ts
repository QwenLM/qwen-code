/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createRuntimeConfig } from '../test-utils/worktreeSession.js';
import { releaseConfigWorktreeOwnership } from '../config/worktreeRuntime.js';
import { resetForTest } from '../utils/Shell.js';
import {
  worktreeSessionService,
  toTranscriptWorktreeSession,
  releasePersistedWorktreeSessionOwnership,
  releasePersistedWorktreeOwnerHandoff,
} from './worktreeSessionService.js';
import { readWorktreeOwnerState } from './worktree-owner-state.js';
import { createWorktreeService } from './worktreeService.js';

describe('named worktree reentry', () => {
  let root: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-reentry-')),
    );
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: root },
    );
    resetForTest(root);
    process.chdir(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    process.chdir(originalCwd);
    resetForTest(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function enter(
    sessionId: string,
    record = vi.fn().mockResolvedValue(undefined),
    sparsePaths?: string[],
    configure?: (
      config: ReturnType<typeof createRuntimeConfig>['config'],
    ) => void,
  ) {
    const { config } = createRuntimeConfig(root);
    vi.mocked(config.getSessionId).mockReturnValue(sessionId);
    configure?.(config);
    const prepared = await worktreeSessionService.prepare(
      { sessionId },
      {
        kind: 'create',
        name: 'same',
        originalCwd: root,
        projectRoot: root,
        options: { baseRef: 'head', sparsePaths },
      },
    );
    const context = {
      config,
      sessionId,
      phase: 'runtime' as const,
      recordWorktreeState: record,
    };
    const settings = await worktreeSessionService.enter(context, prepared);
    return { config, context, settings };
  }

  function commit(cwd: string, message: string): string {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
      ],
      { cwd },
    );
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  }

  describe('durable creation baseline', () => {
    const baselinePath = () => path.join(root, '.git/worktrees/same/QWEN_BASE');

    it.each(['keep', 'close'] as const)(
      'preserves committed work after %s and same-name reentry',
      async (exit) => {
        const a = await enter('session-a');
        const base = a.settings.baseSha;
        const tip = commit(a.settings.path, 'work from first session');
        if (exit === 'keep')
          await worktreeSessionService.leave(a.context, {
            action: 'keep',
          });
        else await releaseConfigWorktreeOwnership(a.config);
        commit(root, 'main advanced independently');
        const b = await enter('session-b');
        expect(b.settings.baseSha).toBe(base);
        expect(await fs.readFile(baselinePath(), 'utf8')).toBe(base + '\n');
        await expect(
          worktreeSessionService.finalize(b.context, { action: 'inspect' }),
        ).resolves.toMatchObject({ changedFiles: 0, commits: 1 });
        await expect(
          worktreeSessionService.leave(b.context, {
            action: 'remove',
            force: false,
          }),
        ).rejects.toThrow('contains changes');
        expect(
          execFileSync('git', ['rev-parse', 'worktree-same'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
        ).toBe(tip);
        expect((await fs.stat(b.settings.path)).isDirectory()).toBe(true);
        await worktreeSessionService.leave(b.context, {
          action: 'remove',
          force: true,
        });
        await expect(fs.stat(b.settings.path)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it.each(['missing', 'malformed', 'symlink', 'missing-commit'] as const)(
      'treats a %s baseline as unknown instead of current HEAD',
      async (state) => {
        const a = await enter('session-a');
        const tip = commit(a.settings.path, 'retained work');
        await worktreeSessionService.leave(a.context, {
          action: 'keep',
        });
        await fs.rm(baselinePath(), { force: true });
        if (state === 'malformed') await fs.writeFile(baselinePath(), 'HEAD\n');
        if (state === 'missing-commit')
          await fs.writeFile(baselinePath(), '0'.repeat(40) + '\n');
        if (state === 'symlink') {
          const outside = path.join(root, 'outside-baseline');
          await fs.writeFile(outside, tip + '\n');
          await fs.symlink(outside, baselinePath());
        }
        const b = await enter('session-b');
        if (state !== 'missing-commit') expect(b.settings.baseSha).toBe('');
        await expect(
          worktreeSessionService.finalize(b.context, { action: 'inspect' }),
        ).resolves.toMatchObject({ commits: null });
        await expect(
          worktreeSessionService.leave(b.context, {
            action: 'remove',
            force: false,
          }),
        ).rejects.toThrow('Cannot verify');
        expect(
          execFileSync('git', ['rev-parse', 'worktree-same'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
        ).toBe(tip);
      },
    );

    it('retains the checkout and refuses ordinary deletion after its initial baseline write fails', async () => {
      const write = fs.writeFile;
      const fault = vi
        .spyOn(nativeFs.promises, 'writeFile')
        .mockImplementation(async (...args) => {
          if (path.basename(String(args[0])) === 'QWEN_BASE')
            throw Object.assign(new Error('baseline write denied'), {
              code: 'EACCES',
            });
          return write(...args);
        });
      syncBuiltinESMExports();
      await expect(enter('session-a')).rejects.toThrow(
        'Cannot persist worktree creation baseline',
      );
      fault.mockRestore();
      syncBuiltinESMExports();
      const b = await enter('session-b');
      expect(b.settings.baseSha).toBe('');
      await expect(
        worktreeSessionService.leave(b.context, {
          action: 'remove',
          force: false,
        }),
      ).rejects.toThrow('Cannot verify');
      expect((await fs.stat(b.settings.path)).isDirectory()).toBe(true);
    });

    it.each(['valid', 'missing'] as const)(
      'does not trust a stale transcript baseline when the durable baseline is %s',
      async (state) => {
        const a = await enter('session-a');
        const tip = commit(
          a.settings.path,
          'commit before old buggy transcript',
        );
        await releaseConfigWorktreeOwnership(a.config);
        if (state === 'missing') await fs.rm(baselinePath(), { force: true });
        const { config } = createRuntimeConfig(root);
        vi.mocked(config.getSessionId).mockReturnValue('session-a');
        const context = {
          config,
          sessionId: 'session-a',
          phase: 'restore' as const,
          recordWorktreeState: vi.fn().mockResolvedValue(undefined),
        };
        await worktreeSessionService.restore(context, {
          ...toTranscriptWorktreeSession(a.settings, 'session-a'),
          originalHeadCommit: tip,
        });
        expect(config.getWorktreeSettings()?.baseSha).toBe(
          state === 'valid' ? a.settings.baseSha : '',
        );
        await expect(
          worktreeSessionService.leave(
            { ...context, phase: 'runtime' },
            { action: 'remove', force: false },
          ),
        ).rejects.toThrow(
          state === 'valid' ? 'contains changes' : 'Cannot verify',
        );
        expect((await fs.stat(a.settings.path)).isDirectory()).toBe(true);
      },
    );

    it('preserves committed agent checkout content after reusing its name', async () => {
      const service = await createWorktreeService(root);
      const a = await service.setup('agent-baseline', { baseRef: 'head' });
      commit(a.path, 'agent work from previous run');
      const b = await service.setup('agent-baseline', { baseRef: 'head' });
      expect(b.baseSha).toBe(a.baseSha);
      await expect(service.maybeCleanup(b)).resolves.toBe(false);
      expect((await fs.stat(a.path)).isDirectory()).toBe(true);
    });

    it('rechecks the durable baseline before inspection and removal even if cached settings are stale', async () => {
      const a = await enter('session-a');
      const tip = commit(
        a.settings.path,
        'committed work with stale runtime settings',
      );
      const cached = a.config.getWorktreeSettings()!;
      cached.baseSha = tip;
      cached.originalHeadCommit = tip;
      await expect(
        worktreeSessionService.finalize(a.context, { action: 'inspect' }),
      ).resolves.toMatchObject({ commits: 1 });
      await expect(
        worktreeSessionService.leave(a.context, {
          action: 'remove',
          force: false,
        }),
      ).rejects.toThrow('contains changes');
      expect((await fs.stat(a.settings.path)).isDirectory()).toBe(true);
    });
  });

  it('lets a second live session reuse the directory without deletion authority', async () => {
    const a = await enter('session-a');
    const b = await enter('session-b');
    expect(b.settings.path).toBe(a.settings.path);
    expect(b.settings.lifecycle).toBe('attached');
    expect(
      (await readWorktreeOwnerState(a.settings.path))?.ownerSessionId,
    ).toBe('session-a');
    await expect(
      worktreeSessionService.leave(b.context, {
        action: 'remove',
        force: true,
      }),
    ).rejects.toThrow('Only the current worktree owner');
    expect((await fs.stat(a.settings.path)).isDirectory()).toBe(true);
  });

  it('lets a new session take ownership after the previous owner closes', async () => {
    const a = await enter('session-a');
    await releaseConfigWorktreeOwnership(a.config);
    const b = await enter('session-b');
    expect(b.settings.lifecycle).toBe('owner');
    expect(
      (await readWorktreeOwnerState(b.settings.path))?.ownerSessionId,
    ).toBe('session-b');
    await worktreeSessionService.leave(b.context, {
      action: 'remove',
      force: false,
    });
    await expect(fs.stat(b.settings.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves the previous owner when persisting the new session fails', async () => {
    const a = await enter('session-a');
    await releaseConfigWorktreeOwnership(a.config);
    await expect(
      enter('session-b', vi.fn().mockRejectedValue(new Error('record failed'))),
    ).rejects.toThrow('record failed');
    expect(
      (await readWorktreeOwnerState(a.settings.path))?.ownerSessionId,
    ).toBe('session-a');
    expect((await fs.stat(a.settings.path)).isDirectory()).toBe(true);
  });

  it('settles the old session without releasing the new owner after takeover', async () => {
    const a = await enter('session-a');
    await releaseConfigWorktreeOwnership(a.config);
    const b = await enter('session-b');
    await releasePersistedWorktreeSessionOwnership(
      toTranscriptWorktreeSession(a.settings, 'session-a'),
      'session-a',
    );
    expect(
      (await readWorktreeOwnerState(b.settings.path))?.ownerSessionId,
    ).toBe('session-b');
  });

  it('restores ownership if entry fails after taking over', async () => {
    const a = await enter('session-a');
    await releaseConfigWorktreeOwnership(a.config);
    await expect(
      enter('session-b', undefined, undefined, (config) => {
        vi.mocked(config.getFileHistoryManager).mockReturnValue({
          rebaseCwd: () => {
            throw new Error('rebase failed');
          },
        } as never);
      }),
    ).rejects.toThrow('rebase failed');
    expect(await readWorktreeOwnerState(a.settings.path)).toMatchObject({
      ownerSessionId: 'session-a',
      ownerPid: 0,
    });
  });

  it('settles a persisted handoff after another session takes over its old checkout', async () => {
    const a = await enter('session-a');
    await releaseConfigWorktreeOwnership(a.config);
    const b = await enter('session-b');
    const current = path.join(root, 'other-checkout');
    execFileSync('git', ['worktree', 'add', '--detach', current, 'HEAD'], {
      cwd: root,
      stdio: 'ignore',
    });
    await releasePersistedWorktreeOwnerHandoff(
      {
        ...toTranscriptWorktreeSession(a.settings, 'session-a'),
        worktreePath: current,
        worktreeCwd: current,
        lifecycle: 'attached',
        pendingOwnerReleasePath: a.settings.path,
      },
      'session-a',
    );
    expect(
      (await readWorktreeOwnerState(b.settings.path))?.ownerSessionId,
    ).toBe('session-b');
  });

  it('does not take ownership when the previous process cannot be inspected', async () => {
    const a = await enter('session-a');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect((await enter('session-b')).settings.lifecycle).toBe('attached');
    expect(
      (await readWorktreeOwnerState(a.settings.path))?.ownerSessionId,
    ).toBe('session-a');
  });

  it('keeps deletion authority with the owner while another session is attached', async () => {
    const a = await enter('session-a');
    const b = await enter('session-b');
    expect(b.settings.lifecycle).toBe('attached');
    await worktreeSessionService.leave(a.context, {
      action: 'remove',
      force: false,
    });
    await expect(fs.stat(b.settings.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('takes over after the owner process exits without normal cleanup', async () => {
    const a = await enter('session-a');
    commit(a.settings.path, 'committed work before the owner crashed');
    const ownerPath = path.join(root, '.git/worktrees/same/qwen-worktree.json');
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    await once(child, 'spawn');
    try {
      const state = await readWorktreeOwnerState(a.settings.path);
      await fs.writeFile(
        ownerPath,
        JSON.stringify({
          ...state,
          ownerPid: child.pid,
        }),
      );
      expect((await enter('session-b')).settings.lifecycle).toBe('attached');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const c = await enter('session-c');
      expect(c.settings.lifecycle).toBe('owner');
      expect(c.settings.baseSha).toBe(a.settings.baseSha);
      await expect(
        worktreeSessionService.finalize(c.context, { action: 'inspect' }),
      ).resolves.toMatchObject({ commits: 1 });
      await expect(
        worktreeSessionService.leave(c.context, {
          action: 'remove',
          force: false,
        }),
      ).rejects.toThrow('contains changes');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });

  it('keeps legacy ownership and rejects malformed process metadata', async () => {
    const a = await enter('session-a');
    const ownerPath = path.join(root, '.git/worktrees/same/qwen-worktree.json');
    await fs.writeFile(
      ownerPath,
      JSON.stringify({ version: 1, ownerSessionId: 'session-a' }),
    );
    expect((await enter('session-b')).settings.lifecycle).toBe('attached');
    await fs.writeFile(
      ownerPath,
      JSON.stringify({ version: 1, ownerSessionId: 'session-a', ownerPid: -1 }),
    );
    await expect(enter('session-c')).rejects.toThrow(
      'Cannot verify worktree ownership',
    );
    expect((await fs.stat(a.settings.path)).isDirectory()).toBe(true);
  });

  it('does not change sparse checkout when attaching to a live owner', async () => {
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    await fs.writeFile(path.join(root, 'app/file.txt'), 'keep');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-q',
        '-m',
        'app',
      ],
      { cwd: root },
    );
    const a = await enter('session-a');
    const b = await enter('session-b', undefined, ['other']);
    expect(b.settings.lifecycle).toBe('attached');
    expect(
      await fs.readFile(path.join(a.settings.path, 'app/file.txt'), 'utf8'),
    ).toBe('keep');
  });

  it('does not let a retired configuration release a reopened session ownership', async () => {
    const old = await enter('session-a');
    const { config: reopened } = createRuntimeConfig(root);
    vi.mocked(reopened.getSessionId).mockReturnValue('session-a');
    await worktreeSessionService.restore(
      {
        config: reopened,
        sessionId: 'session-a',
        phase: 'restore',
        recordWorktreeState: vi.fn().mockResolvedValue(undefined),
      },
      toTranscriptWorktreeSession(old.settings, 'session-a'),
    );
    const currentOwner = await readWorktreeOwnerState(old.settings.path);
    await releaseConfigWorktreeOwnership(old.config);
    expect(await readWorktreeOwnerState(old.settings.path)).toEqual(
      currentOwner,
    );
    expect((await enter('session-c')).settings.lifecycle).toBe('attached');
    await releaseConfigWorktreeOwnership(reopened);
    expect((await readWorktreeOwnerState(old.settings.path))?.ownerPid).toBe(0);
  });

  it('rolls back process ownership when restoring the runtime fails after claiming', async () => {
    const old = await enter('session-a');
    await releaseConfigWorktreeOwnership(old.config);
    const previousOwner = await readWorktreeOwnerState(old.settings.path);
    const { config: reopened } = createRuntimeConfig(root);
    vi.mocked(reopened.getSessionId).mockReturnValue('session-a');
    vi.mocked(reopened.getFileHistoryManager).mockReturnValue({
      rebaseCwd: () => {
        throw new Error('restore rebase failed');
      },
    } as never);
    await expect(
      worktreeSessionService.restore(
        {
          config: reopened,
          sessionId: 'session-a',
          phase: 'restore',
          recordWorktreeState: vi.fn().mockResolvedValue(undefined),
        },
        toTranscriptWorktreeSession(old.settings, 'session-a'),
      ),
    ).rejects.toThrow('restore rebase failed');
    expect(reopened.getWorktreeSettings()).toBeUndefined();
    expect(await readWorktreeOwnerState(old.settings.path)).toEqual(
      previousOwner,
    );
    expect((await enter('session-c')).settings.lifecycle).toBe('owner');
  });

  it('does not perform fallible temporary cleanup after ownership replacement commits', async () => {
    const old = await enter('session-a');
    await releaseConfigWorktreeOwnership(old.config);
    const unlink = fs.unlink;
    const cleanup = vi
      .spyOn(nativeFs.promises, 'unlink')
      .mockImplementation(async (file) => {
        if (String(file).endsWith('.tmp'))
          throw Object.assign(new Error('temporary cleanup failed'), {
            code: 'EIO',
          });
        return unlink(file);
      });
    syncBuiltinESMExports();
    expect((await enter('session-b')).settings.lifecycle).toBe('owner');
    expect(
      cleanup.mock.calls.some(([file]) => String(file).endsWith('.tmp')),
    ).toBe(false);
  });

  it.each(['enter', 'restore'] as const)(
    'retains cleanup evidence when %s ownership rollback also fails',
    async (operation) => {
      const old = await enter('session-a');
      await releaseConfigWorktreeOwnership(old.config);
      const { config } = createRuntimeConfig(root);
      const sessionId = operation === 'restore' ? 'session-a' : 'session-b';
      vi.mocked(config.getSessionId).mockReturnValue(sessionId);
      vi.mocked(config.getFileHistoryManager).mockReturnValue({
        rebaseCwd: () => {
          throw new Error('runtime failed');
        },
      } as never);
      const rename = fs.rename;
      let replacements = 0;
      const fault = vi
        .spyOn(nativeFs.promises, 'rename')
        .mockImplementation(async (from, to) => {
          if (String(from).endsWith('.tmp') && ++replacements === 2)
            throw Object.assign(new Error('rollback write failed'), {
              code: 'EIO',
            });
          return rename(from, to);
        });
      syncBuiltinESMExports();
      const context = {
        config,
        sessionId,
        phase: 'runtime' as const,
        recordWorktreeState: vi.fn().mockResolvedValue(undefined),
      };
      const attempt =
        operation === 'restore'
          ? worktreeSessionService.restore(
              context,
              toTranscriptWorktreeSession(old.settings, 'session-a'),
            )
          : worktreeSessionService
              .prepare(
                { sessionId },
                {
                  kind: 'create',
                  name: 'same',
                  originalCwd: root,
                  projectRoot: root,
                  options: { baseRef: 'head' },
                },
              )
              .then((prepared) =>
                worktreeSessionService.enter(context, prepared),
              );
      await expect(attempt).rejects.toThrow(/rollback|Recovery also failed/);
      fault.mockRestore();
      syncBuiltinESMExports();
      expect(config.getWorktreeSettings()?.lifecycle).toBe('owner');
      await releaseConfigWorktreeOwnership(config);
      expect((await readWorktreeOwnerState(old.settings.path))?.ownerPid).toBe(
        0,
      );
      expect((await enter('session-c')).settings.lifecycle).toBe('owner');
    },
  );
});
