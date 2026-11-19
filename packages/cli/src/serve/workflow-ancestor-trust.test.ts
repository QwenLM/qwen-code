/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowAncestorTrustContext } from '@qwen-code/acp-bridge/workflowAncestorTrust';
import type { DaemonTrustPolicySnapshot } from '../config/daemon-trust-policy.js';
import { TrustLevel } from '../config/trustedFolders.js';
import {
  createWorkflowAncestorTrustHandler,
  readWorkflowTrustAdmission,
  type WorkflowTrustPolicyPublication,
} from './workflow-ancestor-trust.js';

describe('daemon workflow ancestor trust handler', () => {
  let directory: string;
  let repo: string;
  let target: string;
  let context: WorkflowAncestorTrustContext;
  let policy: DaemonTrustPolicySnapshot;
  let published: WorkflowTrustPolicyPublication;
  let closed: boolean;
  let owner: boolean;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'qwen-parent-ancestor-')),
    );
    repo = path.join(directory, 'repo');
    target = path.join(repo, 'packages', 'app');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(repo, '.git'));
    context = {
      sessionId: 'owner-session',
      workspaceCwd: target,
      effectiveCwd: target,
      canonicalTargetDir: target,
      ancestorDirs: [path.dirname(target), repo],
    };
    policy = {
      revision: 'admission',
      folderTrustEnabled: true,
      ideTrust: undefined,
      trustedFolders: { [repo]: TrustLevel.TRUST_FOLDER },
    };
    published = { publication: 0, snapshot: policy };
    closed = false;
    owner = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function createHandler(
    admissionPolicy = { publication: 0, snapshot: policy },
  ) {
    return createWorkflowAncestorTrustHandler({
      generationGuard: {
        get closed() {
          return closed;
        },
      },
      admissionPolicy,
      getPublished: () => published,
      isCurrentOwner: (sessionId) => owner && sessionId === context.sessionId,
      ideScopeCwd: path.join(directory, 'primary'),
    });
  }

  it('authorizes the exact Git ancestor chain under its own admission', async () => {
    await expect(createHandler()(context)).resolves.toMatchObject({
      trusted: [true, true],
    });
  });

  it('uses fresh admission while the published boot snapshot is older', async () => {
    published = {
      publication: 0,
      snapshot: { ...policy, revision: 'boot', trustedFolders: {} },
    };
    await expect(createHandler()(context)).resolves.toMatchObject({
      trusted: [true, true],
    });
  });

  it('uses a newer publication for revocation and recovery without rebuilding', async () => {
    const handler = createHandler();
    published = {
      publication: 1,
      snapshot: { ...policy, revision: 'revoked', trustedFolders: {} },
    };
    await expect(handler(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
    published = { publication: 2, snapshot: policy };
    await expect(handler(context)).resolves.toMatchObject({
      trusted: [true, true],
    });
    published = { publication: 3 };
    await expect(handler(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
  });

  it('cannot replace a newer publication with a genuinely older admission read', async () => {
    published = { publication: 1, snapshot: policy };
    const admission = await readWorkflowTrustAdmission(
      async () => policy,
      () => published,
    );
    published = {
      publication: 2,
      snapshot: { ...policy, revision: 'newer-revocation', trustedFolders: {} },
    };
    await expect(createHandler(admission)(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
  });

  it.each(['owner', 'closed', 'session'] as const)(
    'rejects an unavailable %s before filesystem access',
    async (condition) => {
      const handler = createHandler();
      if (condition === 'owner') owner = false;
      if (condition === 'closed') closed = true;
      const lstat = vi.spyOn(fs, 'lstat');
      await expect(
        handler({
          ...context,
          ...(condition === 'session' ? { sessionId: 'unknown' } : {}),
        }),
      ).resolves.toMatchObject({ trusted: [false, false] });
      expect(lstat).not.toHaveBeenCalled();
    },
  );

  it.each(['skipped', 'duplicate', 'target', 'sibling', 'beyond-git'] as const)(
    'rejects a %s ancestor list',
    async (condition) => {
      const ancestors =
        condition === 'skipped'
          ? [repo]
          : condition === 'duplicate'
            ? [path.dirname(target), path.dirname(target)]
            : condition === 'target'
              ? [target, repo]
              : condition === 'sibling'
                ? [path.join(repo, 'packages-other'), repo]
                : [...context.ancestorDirs, directory];
      await expect(
        createHandler()({ ...context, ancestorDirs: ancestors }),
      ).resolves.toMatchObject({ trusted: ancestors.map(() => false) });
    },
  );

  it('honors nested Git boundaries and rejects symbolic Git markers', async () => {
    await fs.mkdir(path.join(path.dirname(target), '.git'));
    await expect(createHandler()(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
    await expect(
      createHandler()({ ...context, ancestorDirs: [path.dirname(target)] }),
    ).resolves.toMatchObject({ trusted: [true] });
    await fs.rm(path.join(path.dirname(target), '.git'), { recursive: true });
    await fs.rm(path.join(repo, '.git'), { recursive: true });
    await fs.symlink(target, path.join(repo, '.git'), 'dir');
    await expect(createHandler()(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
  });

  it('accepts the shared enumerator worktree Git file boundary', async () => {
    await fs.rm(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git'), 'gitdir: ../git/worktrees/app');
    await expect(createHandler()(context)).resolves.toMatchObject({
      trusted: [true, true],
    });
  });

  it.each(['owner', 'generation', 'publication'] as const)(
    'discards a grant if %s changes during filesystem validation',
    async (condition) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lstat = fs.lstat;
      vi.spyOn(fs, 'lstat').mockImplementationOnce(async (location) => {
        await pending;
        return lstat(location);
      });
      const result = createHandler()(context);
      await vi.waitFor(() => expect(fs.lstat).toHaveBeenCalledOnce());
      if (condition === 'owner') owner = false;
      if (condition === 'generation') closed = true;
      if (condition === 'publication') {
        published = { publication: 1, snapshot: policy };
      }
      release();
      await expect(result).resolves.toMatchObject({ trusted: [false, false] });
    },
  );

  it.each(['owner', 'generation', 'publication'] as const)(
    'invalidates a returned decision if %s changes before bridge release',
    async (condition) => {
      const decision = await createHandler()(context);
      expect(decision.trusted).toEqual([true, true]);
      expect(decision.isCurrent()).toBe(true);
      if (condition === 'owner') owner = false;
      if (condition === 'generation') closed = true;
      if (condition === 'publication') {
        published = { publication: 1, snapshot: policy };
      }
      expect(decision.isCurrent()).toBe(false);
    },
  );

  it('keeps denied unknown paths invalid after returning', async () => {
    const decision = await createHandler()({
      ...context,
      ancestorDirs: [path.join(directory, 'unknown')],
    });
    expect(decision.trusted).toEqual([false]);
    expect(decision.isCurrent()).toBe(false);
  });

  it('fails closed when an owner lookup throws', async () => {
    const handler = createWorkflowAncestorTrustHandler({
      generationGuard: { closed: false },
      admissionPolicy: { publication: 0, snapshot: policy },
      getPublished: () => published,
      isCurrentOwner: () => {
        throw new Error('removed');
      },
      ideScopeCwd: directory,
    });
    await expect(handler(context)).resolves.toMatchObject({
      trusted: [false, false],
    });
  });

  it('preserves disabled-trust directory checks in the daemon', async () => {
    policy = { ...policy, folderTrustEnabled: false, trustedFolders: {} };
    const handler = createHandler();
    await expect(handler(context)).resolves.toMatchObject({
      trusted: [true, true],
    });
    if (process.platform === 'win32') return;
    await fs.chmod(repo, 0o777);
    try {
      await expect(handler(context)).resolves.toMatchObject({
        trusted: [true, false],
      });
    } finally {
      await fs.chmod(repo, 0o755);
    }
  });
});

describe('workflow trust admission', () => {
  const snapshot: DaemonTrustPolicySnapshot = {
    revision: 'fresh',
    folderTrustEnabled: false,
    ideTrust: undefined,
    trustedFolders: {},
  };

  it('tags only a stable read with the matching publication', async () => {
    let publication = 0;
    const readSnapshot = vi.fn(async () => {
      if (publication === 0) publication++;
      return snapshot;
    });
    await expect(
      readWorkflowTrustAdmission(readSnapshot, () => ({ publication })),
    ).resolves.toEqual({ publication: 1, snapshot });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('bounds reads under continuous policy churn', async () => {
    let publication = 0;
    const readSnapshot = vi.fn(async () => {
      publication++;
      return snapshot;
    });
    await expect(
      readWorkflowTrustAdmission(readSnapshot, () => ({ publication })),
    ).rejects.toThrow('changed during workspace admission');
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  });
});
