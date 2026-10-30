/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  LocalManagedSessionResourceStore,
  MANAGED_SESSION_RESOURCE_LIMITS,
} from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import { UNVERIFIABLE_IDENTITY_CODE } from '../utils/no-follow-open.js';

type DirectorySyncFault = (Error & NodeJS.ErrnoException) | null;

const directorySyncFault = vi.hoisted<{
  error: DirectorySyncFault;
  target: string | null;
  hits: string[];
}>(() => ({ error: null, target: null, hits: [] }));

const chmodFault = vi.hoisted<{
  error: (Error & NodeJS.ErrnoException) | null;
}>(() => ({ error: null }));

const lstatFault = vi.hoisted<{ path: string | null }>(() => ({
  path: null,
}));

// Simulates a path-based rename resolving inside a swapped directory: the
// bytes land outside the session tree and no entry appears at `target`.
const renameRedirect = vi.hoisted<{ directory: string | null }>(() => ({
  directory: null,
}));

// Simulates the persistent shape: the bytes land outside and the kind
// directory keeps pointing there, so a target-only identity check resolves
// the outside file and compares it to itself.
const renameSwap = vi.hoisted<{ outside: string | null }>(() => ({
  outside: null,
}));

const directoryOpens = vi.hoisted<string[]>(() => []);

const noFollowFault = vi.hoisted<{
  error: (Error & { code?: string }) | null;
  calls: string[];
  override: null | ((filePath: string) => Promise<unknown>);
}>(() => ({ error: null, calls: [], override: null }));

// Everything stays real except the directory fsync. The store imports `open`
// by name, so `vi.spyOn` cannot reach it; the seam is the same one
// `services/sessionService.test.ts` uses for its own directory-sync fault
// case. `syncDirectory` opens the containing directory read-only purely to
// fsync it, while `publish` opens the pending file `'wx'` — so fault only the
// `'r'` handle, and only when it names the kind directory. The ancestor syncs
// this change added run first and must keep succeeding, or `publish` never
// reaches the post-rename guard these cases pin.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === 'r') {
        directoryOpens.push(args[0] as string);
      }
      if (chmodFault.error !== null) {
        handle.chmod = () => Promise.reject(chmodFault.error!);
      }
      const failure = directorySyncFault.error;
      if (
        failure !== null &&
        args[1] === 'r' &&
        args[0] === directorySyncFault.target
      ) {
        directorySyncFault.hits.push(args[0] as string);
        handle.sync = () => Promise.reject(failure);
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [from, to] = args;
      if (renameRedirect.directory !== null) {
        return actual.rename(
          from,
          path.join(renameRedirect.directory, path.basename(to as string)),
        );
      }
      if (renameSwap.outside !== null) {
        const outside = renameSwap.outside;
        await actual.rename(
          from,
          path.join(outside, path.basename(to as string)),
        );
        const directory = path.dirname(to as string);
        await actual.rm(directory, { recursive: true, force: true });
        await actual.symlink(outside, directory);
        return;
      }
      return actual.rename(from, to);
    },
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (chmodFault.error !== null) throw chmodFault.error;
      return actual.chmod(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (lstatFault.path !== null && args[0] === lstatFault.path) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
          mode: 0o755,
        } as Awaited<ReturnType<typeof actual.lstat>>;
      }
      return actual.lstat(...args);
    },
  };
});

// `openNoFollow` reaches `fs.promises.open` through the default `node:fs`
// import, so the mock above is not a seam for it. The helper module is.
vi.mock('../utils/no-follow-open.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/no-follow-open.js')>();
  return {
    ...actual,
    openNoFollow: async (filePath: string) => {
      noFollowFault.calls.push(filePath);
      if (noFollowFault.override !== null) {
        return (await noFollowFault.override(filePath)) as Awaited<
          ReturnType<typeof actual.openNoFollow>
        >;
      }
      if (noFollowFault.error !== null) throw noFollowFault.error;
      return actual.openNoFollow(filePath);
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  renameRedirect.directory = null;
  renameSwap.outside = null;
  directoryOpens.length = 0;
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-resources-'),
  );
  temporaryDirectories.add(root);
  return root;
}

const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
};

async function createStore(): Promise<{
  store: LocalManagedSessionResourceStore;
  runtimeBaseDir: string;
}> {
  const root = await createRoot();
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  return {
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    runtimeBaseDir,
  };
}

describe('managed session resource store', () => {
  it('round trips published bytes', async () => {
    const { store } = await createStore();
    const content = Buffer.from('list the files in this repository', 'utf8');
    const ref = await store.publish('managed-input', content);

    expect(ref.kind).toBe('managed-input');
    expect(ref.schemaVersion).toBe(1);
    expect(ref.byteLength).toBe(content.byteLength);
    expect(ref.digest).toBe(createHash('sha256').update(content).digest('hex'));
    expect(await store.read(ref)).toEqual(content);
  });

  it('names resources opaquely rather than by content digest', async () => {
    const { store } = await createStore();
    const content = Buffer.from('same bytes', 'utf8');
    const first = await store.publish('managed-input', content);
    const second = await store.publish('managed-input', content);

    expect(first.digest).toBe(second.digest);
    expect(first.resourceId).not.toBe(second.resourceId);
    expect(first.resourceId).not.toContain(first.digest);
    expect(await store.read(first)).toEqual(content);
    expect(await store.read(second)).toEqual(content);
  });

  it('leaves no pending file behind', async () => {
    const { store } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    const entries = await fs.readdir(path.join(store.sessionRoot, ref.kind));
    expect(entries).toEqual([ref.resourceId]);
  });

  it('stores resources under the controlled runtime directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    expect(store.sessionRoot).toBe(
      path.join(runtimeBaseDir, 'resources', sessionKey.sessionId),
    );
    await expect(
      fs.stat(path.join(store.sessionRoot, ref.kind, ref.resourceId)),
    ).resolves.toBeDefined();
  });

  it('rejects content that no longer matches its digest', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    await fs.writeFile(
      path.join(store.sessionRoot, ref.kind, ref.resourceId),
      'tampered',
      'utf8',
    );
    await expect(store.read(ref)).rejects.toThrow(
      /does not match its recorded digest/,
    );
  });

  it('rejects content whose length changed', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    await fs.writeFile(
      path.join(store.sessionRoot, ref.kind, ref.resourceId),
      'short',
      'utf8',
    );
    await expect(store.read(ref)).rejects.toThrow(
      /on disk where 8 was recorded/,
    );
  });

  it('rejects content truncated after it was read', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    noFollowFault.override = async () => ({
      stat: async () => ({ isFile: () => true, size: 8 }),
      readFile: async () => Buffer.from('short'),
      close: async () => undefined,
    });
    try {
      await expect(store.read(ref)).rejects.toThrow(
        /is 5 bytes where 8 was recorded/,
      );
    } finally {
      noFollowFault.override = null;
    }
  });

  it('refuses a leaf that stops being a regular file while it is opened', async () => {
    const { store } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    noFollowFault.override = async () => ({
      stat: async () => ({ isFile: () => false, size: 8 }),
      readFile: async () => {
        throw new Error('must not be read');
      },
      close: async () => undefined,
    });
    try {
      await expect(store.read(ref)).rejects.toThrow(
        /changed while it was being read/,
      );
    } finally {
      noFollowFault.override = null;
    }
  });

  it('reports a missing resource rather than returning empty content', async () => {
    const { store } = await createStore();
    const ref: ManagedSessionDurableRef = {
      resourceId: 'absent',
      kind: 'managed-input',
      schemaVersion: 1,
      byteLength: 1,
      digest: 'a'.repeat(64),
    };
    await expect(store.read(ref)).rejects.toThrow(/is not present for session/);
  });

  it('refuses a kind or resource id that escapes its directory', async () => {
    const { store } = await createStore();
    await expect(
      store.publish('../escape', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/kind must be a single path segment/);
    await expect(
      store.read({
        resourceId: '../../etc/passwd',
        kind: 'managed-input',
        schemaVersion: 1,
        byteLength: 1,
        digest: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/resourceId must be a single path segment/);
  });

  it.skipIf(process.platform === 'win32')(
    'creates the session and kind directories privately',
    async () => {
      const { store } = await createStore();
      const ref = await store.publish(
        'managed-input',
        Buffer.from('x', 'utf8'),
      );

      for (const directory of [
        store.sessionRoot,
        path.join(store.sessionRoot, ref.kind),
      ]) {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o777).toBe(0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a pre-existing directory to 0700',
    async () => {
      const { store } = await createStore();
      const kindDir = path.join(store.sessionRoot, 'managed-input');
      await fs.mkdir(kindDir, { recursive: true, mode: 0o755 });
      await fs.chmod(store.sessionRoot, 0o755);
      await fs.chmod(kindDir, 0o755);

      const ref = await store.publish(
        'managed-input',
        Buffer.from('x', 'utf8'),
      );

      for (const directory of [
        store.sessionRoot,
        path.join(store.sessionRoot, ref.kind),
      ]) {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o777).toBe(0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'publishes when a directory cannot be tightened',
    async () => {
      const { store } = await createStore();
      const kindDir = path.join(store.sessionRoot, 'managed-input');
      await fs.mkdir(kindDir, { recursive: true, mode: 0o755 });
      await fs.chmod(store.sessionRoot, 0o755);
      await fs.chmod(kindDir, 0o755);
      chmodFault.error = Object.assign(new Error('EPERM'), {
        code: 'EPERM',
      });
      try {
        const ref = await store.publish(
          'managed-input',
          Buffer.from('x', 'utf8'),
        );
        expect(await store.read(ref)).toEqual(Buffer.from('x', 'utf8'));
      } finally {
        chmodFault.error = null;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not chmod through a replaced directory entry',
    async () => {
      const { store, runtimeBaseDir } = await createStore();
      const outside = path.join(runtimeBaseDir, 'outside');
      await fs.mkdir(outside, { recursive: true, mode: 0o755 });
      await fs.chmod(outside, 0o755);
      const kindDir = path.join(store.sessionRoot, 'managed-input');
      await fs.mkdir(store.sessionRoot, { recursive: true });
      await fs.symlink(outside, kindDir);
      lstatFault.path = kindDir;
      try {
        await store
          .publish('managed-input', Buffer.from('x', 'utf8'))
          .catch(() => undefined);
        expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
      } finally {
        lstatFault.path = null;
      }
    },
  );

  it('refuses to publish through a symlinked session directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(path.dirname(store.sessionRoot), { recursive: true });
    await fs.symlink(outside, store.sessionRoot);

    await expect(
      store.publish('managed-input', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/resource directory is not private/);
  });

  it('refuses to publish through a symlinked resources directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.dirname(store.sessionRoot));

    await expect(
      store.publish('managed-input', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/resource directory is not private/);
  });

  it('refuses to publish through a symlinked kind directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(store.sessionRoot, { recursive: true });
    await fs.symlink(outside, path.join(store.sessionRoot, 'managed-input'));

    await expect(
      store.publish('managed-input', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/resource directory is not private/);
  });

  it('refuses a publish whose rename landed outside the session directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    renameRedirect.directory = outside;

    await expect(
      store.publish('managed-input', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/was not published inside its session directory/);
    expect(
      await fs.readdir(path.join(store.sessionRoot, 'managed-input')),
    ).toEqual([]);
  });

  it('refuses a publish whose kind directory is still swapped after the rename', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    renameSwap.outside = outside;

    await expect(
      store.publish('managed-input', Buffer.from('x', 'utf8')),
    ).rejects.toThrow(/was not published inside its session directory/);
  });

  it('syncs only the kind directory once the directories exist', async () => {
    const { store } = await createStore();
    await store.publish('managed-input', Buffer.from('warm', 'utf8'));
    directoryOpens.length = 0;

    await store.publish('managed-input', Buffer.from('steady', 'utf8'));

    expect(directoryOpens).toEqual([
      path.join(store.sessionRoot, 'managed-input'),
    ]);
  });

  it('refuses to read a resource replaced by a symlink', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const ref = await store.publish(
      'managed-input',
      Buffer.from('original', 'utf8'),
    );
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.writeFile(outside, 'original', 'utf8');
    await fs.unlink(path.join(store.sessionRoot, ref.kind, ref.resourceId));
    await fs.symlink(
      outside,
      path.join(store.sessionRoot, ref.kind, ref.resourceId),
    );

    await expect(store.read(ref)).rejects.toThrow(/is not a regular file/);
  });

  it('refuses to read through a symlinked kind directory', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const content = Buffer.from('outside copy', 'utf8');
    const ref = await store.publish('managed-input', content);
    const kindDir = path.join(store.sessionRoot, ref.kind);
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, ref.resourceId), content);
    await fs.rm(kindDir, { recursive: true, force: true });
    await fs.symlink(outside, kindDir);

    await expect(store.read(ref)).rejects.toThrow(
      /resource directory is not private/,
    );
  });

  it('maps an ELOOP from the no-follow open to a record error', async () => {
    const { store } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    noFollowFault.error = Object.assign(new Error('ELOOP'), {
      code: 'ELOOP',
    });
    try {
      await expect(store.read(ref)).rejects.toThrow(/is not a regular file/);
    } finally {
      noFollowFault.error = null;
    }
  });

  it('maps an unverifiable identity to a record error', async () => {
    const { store } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    noFollowFault.error = Object.assign(new Error('EUNVERIFIABLE'), {
      code: UNVERIFIABLE_IDENTITY_CODE,
    });
    try {
      await expect(store.read(ref)).rejects.toThrow(
        /could not be identity-verified/,
      );
    } finally {
      noFollowFault.error = null;
    }
  });

  it('never opens a symlinked leaf', async () => {
    const { store, runtimeBaseDir } = await createStore();
    const ref = await store.publish('managed-input', Buffer.from('x', 'utf8'));
    const outside = path.join(runtimeBaseDir, 'outside');
    await fs.writeFile(outside, 'x', 'utf8');
    const leaf = path.join(store.sessionRoot, ref.kind, ref.resourceId);
    await fs.unlink(leaf);
    await fs.symlink(outside, leaf);
    noFollowFault.calls = [];

    await expect(store.read(ref)).rejects.toThrow(/is not a regular file/);
    expect(noFollowFault.calls).not.toContain(leaf);
  });

  it('refuses a publish above the byte limit', async () => {
    const { store } = await createStore();
    const bytes = Buffer.alloc(
      MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes + 1,
    );

    await expect(store.publish('managed-tool-outcome', bytes)).rejects.toThrow(
      /is the maximum/,
    );
  });

  it('accepts a publish exactly at the byte limit', async () => {
    const { store } = await createStore();
    const bytes = Buffer.alloc(
      MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes,
    );
    const ref = await store.publish('managed-tool-outcome', bytes);
    expect(ref.byteLength).toBe(
      MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes,
    );
  });
});

describe('managed session input durability', () => {
  it('recovers the original prompt content after a cold reopen', async () => {
    const root = await createRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(root, 'chats', 'session-1.jsonl');
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const prompt = Buffer.from('summarise the design docs', 'utf8');
    const contentRef = await store.publish('managed-input', prompt);
    const admissionRef = await store.publish(
      'managed-admission',
      Buffer.from('{"source":"web_shell"}', 'utf8'),
    );

    const definitionRef = await store.publish(
      'managed-definition',
      Buffer.from('{}', 'utf8'),
    );
    const rootSnapshotRef = await store.publish(
      'managed-root',
      Buffer.from('{}', 'utf8'),
    );

    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      journal: LocalJsonlManagedSessionJournalStore.fromLease(
        lease,
        sessionKey,
      ),
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: { definitionRef, rootSnapshotRef, createdBy: 'daemon' },
    });
    await authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'cmd-1',
        sessionKey,
        contentDigest: contentRef.digest,
      },
      {
        inputId: 'in-1',
        turnId: 'turn-1',
        source: 'web_shell',
        contentRef,
        deadline: null,
        admissionRef,
        wakeReason: 'input',
      },
    );
    await lease.release();

    // Cold reopen: nothing from the first authority survives in memory.
    const reopenLease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const reopened = await LocalManagedSessionAuthority.open({
      journal: LocalJsonlManagedSessionJournalStore.fromLease(
        reopenLease,
        sessionKey,
      ),
      sessionKey,
      cwd: '/workspace',
      version: 'test',
    });
    const accepted = reopened.readEvents()[0];
    expect(accepted.kind).toBe('input.accepted');

    const recoveredRef = accepted.payload[
      'contentRef'
    ] as unknown as ManagedSessionDurableRef;
    const recoveredStore = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    expect(await recoveredStore.read(recoveredRef)).toEqual(prompt);
    await reopenLease.release();
  });
});

describe('directory sync refusal', () => {
  // `syncDirectory` tolerates a refused directory fsync only on win32, and
  // only for the three codes the sibling stores carrying this identical guard
  // tolerate (`services/session-writer-lease.ts`, `serve/conversations/
  // standalone-deletion-journal.ts`). Neither premise was pinned before: a
  // real directory fsync succeeds on the Linux lane that gates this PR, so the
  // whole catch body never ran. Widening it is not harmless — `publish` would
  // resolve a ref whose rename was never persisted, the transaction would
  // record it, and the loss would surface much later as `read` reporting the
  // resource absent ("a failure, not a cache miss").
  async function withDirectorySyncRefusal<T>(
    platform: NodeJS.Platform,
    code: string,
    body: (context: {
      store: LocalManagedSessionResourceStore;
      failure: Error & NodeJS.ErrnoException;
    }) => Promise<T>,
  ): Promise<T> {
    const platformStub = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue(platform);
    const failure = Object.assign(new Error('directory sync refused'), {
      code,
    });
    directorySyncFault.error = failure;
    directorySyncFault.hits = [];
    try {
      const { store } = await createStore();
      // Arm the fault on the kind directory so it reaches the post-rename
      // sync; the ancestor syncs this change added must keep succeeding.
      directorySyncFault.target = path.join(store.sessionRoot, 'managed-input');
      return await body({ store, failure });
    } finally {
      // This file's `afterEach` does not restore mocks, so both the fault and
      // the platform stub are cleared here or they leak into every later case.
      directorySyncFault.error = null;
      directorySyncFault.target = null;
      directorySyncFault.hits = [];
      platformStub.mockRestore();
    }
  }

  it.each(['EACCES', 'EINVAL', 'EPERM'] as const)(
    'tolerates the win32 %s refusal and still round trips the bytes',
    async (code) => {
      await withDirectorySyncRefusal('win32', code, async ({ store }) => {
        const content = Buffer.from('bytes that outlive the refusal', 'utf8');
        const ref = await store.publish('managed-input', content);
        expect(ref.byteLength).toBe(content.byteLength);
        expect(directorySyncFault.hits).toContain(
          path.join(store.sessionRoot, 'managed-input'),
        );
        expect(await store.read(ref)).toEqual(content);
      });
    },
  );

  it('rejects a win32 refusal outside the tolerated codes', async () => {
    await withDirectorySyncRefusal(
      'win32',
      'EIO',
      async ({ store, failure }) => {
        await expect(
          store.publish('managed-input', Buffer.from('x', 'utf8')),
        ).rejects.toBe(failure);
      },
    );
  });

  it('does not swallow the same refusal off win32', async () => {
    await withDirectorySyncRefusal(
      'linux',
      'EPERM',
      async ({ store, failure }) => {
        await expect(
          store.publish('managed-input', Buffer.from('x', 'utf8')),
        ).rejects.toBe(failure);
      },
    );
  });
});
