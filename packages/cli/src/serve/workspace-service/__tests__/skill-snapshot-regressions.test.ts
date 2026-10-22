/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import { createDaemonWorkspaceService } from '../index.js';
import { createWorkspaceSkillsStatusProvider } from '../../workspace-skills-status.js';
import type {
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
} from '../types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function inventory(
  names: string[],
  workspaceCwd = '/workspace',
): ServeWorkspaceSkillsStatus {
  return {
    v: 1,
    workspaceCwd,
    initialized: true,
    skills: names.map((name) => ({
      kind: 'skill',
      status: 'ok',
      name,
      description: name,
      level: 'project',
      modelInvocable: true,
      installedPath: path.join(
        workspaceCwd,
        '.qwen',
        'skills',
        name,
        'SKILL.md',
      ),
    })),
  };
}

function service(overrides: Partial<DaemonWorkspaceServiceDeps> = {}) {
  return createDaemonWorkspaceService({
    boundWorkspace: '/workspace',
    isWorkspaceTrusted: () => true,
    contextFilename: 'QWEN.md',
    persistDisabledTools: vi.fn().mockResolvedValue(undefined),
    persistDisabledSkills: vi
      .fn()
      .mockResolvedValue({ changed: true, disabled: [] }),
    persistDisabledSkillsBatch: vi.fn().mockResolvedValue({
      outcomes: [],
      settingsChanges: [],
    }),
    queryWorkspaceStatus: vi.fn(async (_method, idle) => idle()),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({}),
    publishWorkspaceEvent: vi.fn(),
    ...overrides,
  });
}

const ctx: WorkspaceRequestContext = {
  route: 'TEST /workspace/skills',
  workspaceCwd: '/workspace',
};

async function withInstalledSkills(
  names: string[],
  run: (status: ServeWorkspaceSkillsStatus) => Promise<void>,
) {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), 'skill-delete-race-'),
  );
  try {
    const status = inventory(names, workspace);
    for (const skill of status.skills) {
      await fs.mkdir(path.dirname(skill.installedPath!), { recursive: true });
      await fs.writeFile(
        skill.installedPath!,
        `---\nname: ${skill.name}\ndescription: Fixture skill\n---\nInstructions.\n`,
      );
    }
    await run(status);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

describe('Skill snapshot correctness regressions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 6_000])(
    'returns local skills after ACP times out with a %i ms local read',
    async (localDelay) => {
      const local = vi.fn(
        () =>
          new Promise<ServeWorkspaceSkillsStatus>((resolve) => {
            setTimeout(() => resolve(inventory(['local-review'])), localDelay);
          }),
      );
      const svc = service({
        queryWorkspaceStatus: vi.fn(
          () =>
            new Promise<never>((_resolve, reject) => {
              setTimeout(
                () => reject(new Error('ACP request timed out')),
                10_000,
              );
            }),
        ),
        workspaceSkillsStatusProvider: local,
      });

      const read = svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(10_000 + localDelay + 1);

      await expect(read).resolves.toMatchObject({
        initialized: true,
        skills: [{ name: 'local-review' }],
      });
      expect(local).toHaveBeenCalledOnce();
    },
  );

  it('distinguishes unavailable inventory from an initialized empty catalog', async () => {
    const query = vi.fn().mockRejectedValue(new Error('child unavailable'));
    const local = vi.fn().mockRejectedValue(new Error('local unavailable'));
    const svc = service({
      queryWorkspaceStatus: query,
      workspaceSkillsStatusProvider: local,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await svc.getWorkspaceSkillsStatus(ctx);
      expect(result).toMatchObject({ initialized: false, skills: [] });
      expect(result.errors).toEqual([
        expect.objectContaining({
          kind: 'skills',
          status: 'error',
          error: expect.stringContaining('unavailable'),
        }),
      ]);
      expect(result.snapshot).toBeUndefined();
    }
    expect(query).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledOnce();

    const empty = service({
      queryWorkspaceStatus: vi.fn().mockResolvedValue(inventory([])),
    });
    const result = await empty.getWorkspaceSkillsStatus(ctx);
    expect(result).toMatchObject({ initialized: true, skills: [] });
    expect(result.errors).toBeUndefined();
    expect(result.snapshot).toBeDefined();
  });

  it.each([2_500, 6_000])(
    'advances inventory across three warm polls with %i ms responses',
    async (delayMs) => {
      let count = 0;
      const query = vi.fn().mockImplementation(() => {
        const name = `child-${++count}`;
        return new Promise<ServeWorkspaceSkillsStatus>((resolve) => {
          setTimeout(() => resolve(inventory([name])), delayMs);
        });
      });
      const svc = service({ queryWorkspaceStatus: query });
      const initial = svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(delayMs);
      expect((await initial).skills[0]?.name).toBe('child-1');
      for (let cycle = 0; cycle < 3; cycle++) {
        await svc.getWorkspaceSkillsStatus(ctx);
        await vi.advanceTimersByTimeAsync(delayMs);
        expect((await svc.getWorkspaceSkillsStatus(ctx)).skills[0]?.name).toBe(
          `child-${cycle + 2}`,
        );
      }
    },
  );

  it('advances slow observations while one-second polling starts retries', async () => {
    let count = 0;
    const query = vi.fn().mockImplementation(() => {
      const name = `child-${++count}`;
      return new Promise<ServeWorkspaceSkillsStatus>((resolve) => {
        setTimeout(() => resolve(inventory([name])), 6_000);
      });
    });
    const svc = service({ queryWorkspaceStatus: query });
    const initial = svc.getWorkspaceSkillsStatus(ctx);
    await vi.advanceTimersByTimeAsync(6_000);
    await initial;
    for (let second = 0; second < 16; second++) {
      await svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const current = await svc.getWorkspaceSkillsStatus(ctx);
    expect(current.skills[0]?.name).toBe('child-4');
    expect(current.snapshot?.refreshing).toBe(true);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it.each([false, true])(
    'does not replace a newer published observation with a late result (clock rollback: %s)',
    async (rollback) => {
      const late = deferred<ServeWorkspaceSkillsStatus>();
      const newer = deferred<ServeWorkspaceSkillsStatus>();
      const query = vi
        .fn()
        .mockResolvedValueOnce(inventory(['initial']))
        .mockImplementationOnce(() => late.promise)
        .mockImplementationOnce(() => newer.promise);
      const svc = service({ queryWorkspaceStatus: query });
      await svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      await svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      if (rollback) vi.setSystemTime(9_000);
      await svc.getWorkspaceSkillsStatus(ctx);
      newer.resolve(inventory(['newer']));
      await vi.advanceTimersByTimeAsync(0);
      const published = await svc.getWorkspaceSkillsStatus(ctx);
      late.resolve(inventory(['late']));
      await vi.advanceTimersByTimeAsync(0);
      const afterLate = await svc.getWorkspaceSkillsStatus(ctx);
      expect(afterLate.skills[0]?.name).toBe('newer');
      expect(afterLate.snapshot).toEqual(published.snapshot);
      expect(query).toHaveBeenCalledTimes(3);
    },
  );

  it('waits for slow local enumeration after the child is unavailable', async () => {
    const local = vi.fn(
      () =>
        new Promise<ServeWorkspaceSkillsStatus>((resolve) => {
          setTimeout(() => resolve(inventory(['local-review'])), 6_000);
        }),
    );
    const svc = service({ workspaceSkillsStatusProvider: local });

    const read = svc.getWorkspaceSkillsStatus(ctx);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(read).resolves.toMatchObject({
      initialized: true,
      skills: [{ name: 'local-review' }],
    });
    expect(local).toHaveBeenCalledOnce();
  });

  it('returns a successful superseded cold observation without publishing it', async () => {
    const old = deferred<ServeWorkspaceSkillsStatus>();
    const query = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(inventory(['current-review']));
    const svc = service({ queryWorkspaceStatus: query });

    const read = svc.getWorkspaceSkillsStatus(ctx);
    await vi.advanceTimersByTimeAsync(0);
    svc.invalidateWorkspaceSkillsStatus();
    old.resolve(inventory(['observed-review']));

    await expect(read).resolves.toMatchObject({
      initialized: true,
      skills: [{ name: 'observed-review' }],
    });
    await expect(svc.getWorkspaceSkillsStatus(ctx)).resolves.toMatchObject({
      initialized: true,
      skills: [{ name: 'current-review' }],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'rejects a cold result after runtime retirement (invalidated: %s)',
    async (invalidate) => {
      let active = true;
      const pending = deferred<ServeWorkspaceSkillsStatus>();
      const svc = service({
        queryWorkspaceStatus: vi.fn().mockImplementation(() => pending.promise),
        assertGenerationOpen: () => {
          if (!active) throw new Error('retired runtime');
        },
      });
      const read = svc.getWorkspaceSkillsStatus(ctx);
      await vi.advanceTimersByTimeAsync(0);
      if (invalidate) svc.invalidateWorkspaceSkillsStatus();
      active = false;
      pending.resolve(inventory(['review']));
      await expect(read).rejects.toThrow('retired runtime');
    },
  );

  it('deletes an installed skill after a six-second authoritative read', async () => {
    await withInstalledSkills(['review'], async (status) => {
      const svc = service({
        boundWorkspace: status.workspaceCwd,
        queryWorkspaceStatus: vi.fn().mockImplementation(
          () =>
            new Promise<ServeWorkspaceSkillsStatus>((resolve) => {
              setTimeout(() => resolve(status), 6_000);
            }),
        ),
      });
      const result = svc.deleteWorkspaceSkill(
        { ...ctx, workspaceCwd: status.workspaceCwd },
        'review',
        'workspace',
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(result).resolves.toEqual({
        skillName: 'review',
        scope: 'workspace',
        deleted: true,
      });
      await expect(
        fs.stat(status.skills[0]!.installedPath!),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps warm inventory available while a refused delete checks fresh inventory', async () => {
    const pending = deferred<ServeWorkspaceSkillsStatus>();
    const query = vi
      .fn()
      .mockResolvedValueOnce(inventory(['review']))
      .mockImplementationOnce(() => pending.promise);
    const svc = service({ queryWorkspaceStatus: query });
    const initial = await svc.getWorkspaceSkillsStatus(ctx);

    const deletion = svc.deleteWorkspaceSkill(ctx, 'typo', 'workspace');
    let duringDelete: ServeWorkspaceSkillsStatus | undefined;
    void svc.getWorkspaceSkillsStatus(ctx).then((result) => {
      duringDelete = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(duringDelete?.skills.map((skill) => skill.name)).toEqual(['review']);
    expect(duringDelete?.snapshot?.observedAt).toBe(
      initial.snapshot?.observedAt,
    );

    pending.resolve(inventory(['review']));
    await expect(deletion).rejects.toMatchObject({
      name: 'WorkspaceSkillNotFoundError',
      skillName: 'typo',
    });
    const afterDelete = await svc.getWorkspaceSkillsStatus(ctx);
    expect(afterDelete.skills.map((skill) => skill.name)).toEqual(['review']);
    expect(afterDelete.snapshot?.observedAt).toBe(initial.snapshot?.observedAt);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['read', 'delete'] as const)(
    'refreshes the local provider for a foreground %s after an external install',
    async (operation) => {
      await withInstalledSkills([], async ({ workspaceCwd }) => {
        const qwenHome = path.join(workspaceCwd, 'isolated-home');
        await fs.mkdir(qwenHome);
        vi.stubEnv('QWEN_HOME', qwenHome);
        try {
          const svc = service({
            boundWorkspace: workspaceCwd,
            workspaceSkillsStatusProvider:
              createWorkspaceSkillsStatusProvider(),
          });
          const request = { ...ctx, workspaceCwd };
          const initial = await svc.getWorkspaceSkillsStatus(request);
          expect(initial.initialized).toBe(true);
          expect(initial.skills.map((skill) => skill.name)).not.toContain(
            'later-installed',
          );
          const skillPath = path.join(
            workspaceCwd,
            '.qwen',
            'skills',
            'later-installed',
            'SKILL.md',
          );
          await fs.mkdir(path.dirname(skillPath), { recursive: true });
          await fs.writeFile(
            skillPath,
            '---\nname: later-installed\ndescription: Newly installed fixture\n---\nInstructions.\n',
          );

          if (operation === 'read') {
            const current = await svc.getWorkspaceSkillsStatus(request, {
              requireFresh: true,
            });
            expect(current.skills.map((skill) => skill.name)).toContain(
              'later-installed',
            );
            expect(
              (await svc.getWorkspaceSkillsStatus(request)).snapshot
                ?.observedAt,
            ).toBe(initial.snapshot?.observedAt);
          } else {
            await expect(
              svc.deleteWorkspaceSkill(request, 'later-installed', 'workspace'),
            ).resolves.toEqual({
              skillName: 'later-installed',
              scope: 'workspace',
              deleted: true,
            });
            await expect(fs.stat(skillPath)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          }
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
  );

  it('deletes different skills concurrently after both inventory reads succeed', async () => {
    await withInstalledSkills(['review', 'plan'], async (status) => {
      const workspace = status.workspaceCwd;
      const first = deferred<ServeWorkspaceSkillsStatus>();
      const second = deferred<ServeWorkspaceSkillsStatus>();
      const query = vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockResolvedValue(status);
      const svc = service({
        boundWorkspace: workspace,
        queryWorkspaceStatus: query,
      });
      const request = { ...ctx, workspaceCwd: workspace };

      const deleteReview = svc.deleteWorkspaceSkill(
        request,
        'review',
        'workspace',
      );
      await vi.advanceTimersByTimeAsync(0);
      const deletePlan = svc.deleteWorkspaceSkill(request, 'plan', 'workspace');
      const results = Promise.allSettled([deleteReview, deletePlan]);
      await vi.advanceTimersByTimeAsync(0);
      first.resolve(status);
      second.resolve(status);

      expect(await results).toEqual([
        {
          status: 'fulfilled',
          value: { skillName: 'review', scope: 'workspace', deleted: true },
        },
        {
          status: 'fulfilled',
          value: { skillName: 'plan', scope: 'workspace', deleted: true },
        },
      ]);
      for (const skill of status.skills) {
        await expect(fs.stat(skill.installedPath!)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    });
  });
});
