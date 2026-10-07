/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveSessionName,
  describeSessionKind,
  getSessionRecordPath,
  getSessionRegistryDir,
  listLiveSessions,
  patchSessionRecord,
  registerSession,
  resetRegisteredRecordPathForTest,
  unregisterSession,
  SESSION_KINDS,
  SESSION_REGISTRY_SCHEMA_VERSION,
  readOwnSessionRecord,
} from './session-registry.js';
import {
  readLocalBootId,
  readPidNamespaceId,
} from '../utils/process-liveness.js';
// Namespace import: the boot-id/token outage scenarios below spy on the
// module's exports, which also intercepts the registry's internal calls.
import * as processLiveness from '../utils/process-liveness.js';

/**
 * Records the paths `readRecord` stats, while the real filesystem does the
 * work. The `<pid>.json` filename filter is invisible from the outside —
 * the filename/contents agreement check downstream rejects everything a
 * looser regex would let through — so the only way to hold the filter to
 * its stated job, not reading whatever else lives in `~/.qwen/sessions`,
 * is to watch what it opens.
 */
const statCalls: string[] = [];
let recordStatCalls = false;

vi.mock('node:fs/promises', async () => {
  const real =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  return {
    ...real,
    default: real,
    stat: (...args: Parameters<typeof real.stat>) => {
      if (recordStatCalls) statCalls.push(path.basename(String(args[0])));
      return real.stat(...args);
    },
  };
});

vi.mock('../config/storage.js', () => {
  let mockDir: string | null = '/tmp/session-registry-test';
  return {
    Storage: {
      getGlobalQwenDir: () => {
        if (mockDir === null) {
          // Simulates os.homedir() failing (HOME unset, passwd lookup
          // gone) — the registry's "never throws" promise is tested
          // against exactly this.
          throw new Error('home directory unavailable');
        }
        return mockDir;
      },
    },
    __setMockGlobalDir: (d: string | null) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-registry-'));
  __setMockGlobalDir(tmpDir);
  // The registry captures the registered path at module level; reset it
  // so tests that need the unregistered state never ride test order.
  resetRegisteredRecordPathForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(fileName: string, body: unknown): Promise<string> {
  const dir = getSessionRegistryDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(
    filePath,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  return filePath;
}

/**
 * A record body that `listLiveSessions` must accept and return verbatim:
 * schema 1, this process's (live) PID, and no start token, so the liveness
 * check degrades to "the PID is running" on every platform.
 *
 * Every rejection case below is this body with one field spoiled, so a
 * spoiled field that stops being rejected shows up as a listed record
 * rather than as nothing at all.
 */
function liveBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid: process.pid,
    procStart: null,
    // Records planted here model a writer in THIS process, so the
    // namespace identity is the caller's own — anything else would be
    // skipped by the namespace guard before its fields even matter.
    pidNs: readPidNamespaceId(),
    sessionId: 's',
    cwd: '/w',
    name: 'n',
    startedAt: 5,
    qwenVersion: null,
    ...over,
  };
}

/** This process's shared record filename. */
const OWN = `${process.pid}.json`;
/** Parses the JSON record at `filePath` (default: this process's record). */
const readJson = async (filePath = getSessionRecordPath()) =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
/** Registers `sessionId` for `/w/app`, plus any `extra` fields. */
const register = (
  sessionId = 's1',
  extra: Partial<Parameters<typeof registerSession>[0]> = {},
) => registerSession({ sessionId, cwd: '/w/app', ...extra });
const registered = async (sessionId = 's1') =>
  (await register(sessionId)).registered;
const liveIds = async () =>
  (await listLiveSessions()).map((record) => record.sessionId);
/** A live-shaped body owned by someone else (`sessionId: 'theirs'`). */
const theirs = (over: Record<string, unknown>) =>
  liveBody({ sessionId: 'theirs', ...over });
/** Someone else's record from another machine's boot. */
const otherBoot = () => theirs({ procStart: 'not-this-boot:1' });
const errno = (message: string, code: string) =>
  Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
const expectGone = (filePath = getSessionRecordPath()) =>
  expect(fs.stat(filePath)).rejects.toThrow();
const expectKept = (filePath: string) =>
  expect(fs.stat(filePath)).resolves.toBeDefined();
/** Plants `body` as `fileName`: nothing is listed, and the file is kept or swept. */
async function expectUnlisted(
  fileName: string,
  body: unknown,
  fate: 'kept' | 'swept',
) {
  const filePath = await writeRaw(fileName, body);
  expect(await listLiveSessions()).toEqual([]);
  await (fate === 'kept' ? expectKept(filePath) : expectGone(filePath));
}

/** Plants `foreign` at this PID's path, runs `op`, and asserts it is untouched. */
async function expectForeignSurvives(
  foreign: Record<string, unknown>,
  op: () => Promise<unknown>,
) {
  await writeRaw(OWN, foreign);
  await op();
  expect(await readJson()).toEqual(foreign);
}

// Only Linux has a start token to record or disagree with; elsewhere these
// are visible skips rather than tests that pass without asserting.
const itLinux = it.runIf(process.platform === 'linux');
// Windows synthesizes st_mode from file attributes and `chmod` only toggles the
// read-only bit, so permission assertions are meaningless there; guarded rather
// than deleted, like `session-writer-lease.test.ts`'s identical 0700/0600 pair.
const itPosix = it.runIf(process.platform !== 'win32');
describe('deriveSessionName', () => {
  it('combines the cwd basename with a session-derived suffix', () => {
    const name = deriveSessionName('/home/u/projects/qwen-code', 'abc-123');
    expect(name).toMatch(/^qwen-code-[0-9a-f]{2}$/);
  });

  it('separates two sessions in the same directory', () => {
    const a = deriveSessionName('/w/app', 'session-a');
    const b = deriveSessionName('/w/app', 'session-b');
    expect(a).not.toBe(b);
  });

  it('is stable for the same inputs', () => {
    expect(deriveSessionName('/w/app', 's1')).toBe(
      deriveSessionName('/w/app', 's1'),
    );
  });

  it('strips characters that would not survive a shell or a table', () => {
    const name = deriveSessionName('/w/my project (v2)', 's1');
    expect(name).toMatch(/^[\w.-]+$/);
  });

  it('keeps non-ASCII letters instead of stripping them to a dash', () => {
    // An ASCII-only character class reduces every CJK basename to the
    // same bare dash — zero identifying information for exactly the
    // projects whose names are not ASCII.
    const a = deriveSessionName('/home/u/项目', 's1');
    const b = deriveSessionName('/home/u/別項目', 's1');
    expect(a).toMatch(/^项目-[0-9a-f]{2}$/);
    expect(b).toMatch(/^別項目-[0-9a-f]{2}$/);
    expect(a).not.toBe(b);
  });

  it('falls back to a placeholder when the basename is empty', () => {
    expect(deriveSessionName('/', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });

  it('falls back to a placeholder when the basename strips to dashes only', () => {
    expect(deriveSessionName('/w/!!!', 's1')).toMatch(/^session-[0-9a-f]{2}$/);
  });

  it('caps the basename at 32 characters so the name fits a table cell', () => {
    const name = deriveSessionName(`/w/${'a'.repeat(80)}`, 's1');
    expect(name).toMatch(/^a{32}-[0-9a-f]{2}$/);
    expect(name).toHaveLength(35);
  });

  it('keeps an accent spelled in NFD, the macOS default normalization', () => {
    // NFD spells the accent as a separate combining mark; a class without
    // \p{M} replaces it with a dash and the label loses the accent.
    expect(deriveSessionName('/w/cafe\u0301', 's1')).toMatch(
      /^caf\u00e9-[0-9a-f]{2}$/,
    );
  });

  it('treats canonically equivalent spellings as the same name', () => {
    expect(deriveSessionName('/w/cafe\u0301', 's1')).toBe(
      deriveSessionName('/w/caf\u00e9', 's1'),
    );
  });

  it('keeps combining marks instead of dashing through them', () => {
    // Devanagari vowel signs are combining marks; without \p{M} in the
    // class each one becomes a dash mid-word — the exact mangling the
    // Unicode-aware class exists to prevent.
    expect(
      deriveSessionName(
        '/w/\u092a\u0930\u093f\u092f\u094b\u091c\u0928\u093e',
        's1',
      ),
    ).toMatch(/^\u092a\u0930\u093f\u092f\u094b\u091c\u0928\u093e-[0-9a-f]{2}$/);
  });

  it('truncates by code point without splitting an astral character', () => {
    // U+20000 is two UTF-16 units; a code-unit slice at the boundary
    // would store a trailing lone surrogate in the record.
    const name = deriveSessionName(`/w/${'a'.repeat(31)}\u{20000}`, 's1');
    expect(name.startsWith('a'.repeat(31) + '\u{20000}-')).toBe(true);
    // 31 a's + astral char (2 UTF-16 units) + dash + 2-digit suffix.
    expect(name).toHaveLength(36);
  });
});

describe('describeSessionKind', () => {
  it('reads a record without a kind as the interactive UI', () => {
    // The one caller-visible consequence of the field being optional: a
    // record written before it existed came from the interactive UI,
    // because nothing else registered then.
    expect(describeSessionKind(undefined)).toBe('tui');
    expect(describeSessionKind('')).toBe('tui');
  });

  it('passes every other kind through, known or not', () => {
    for (const kind of SESSION_KINDS) {
      expect(describeSessionKind(kind)).toBe(kind);
    }
    // A build that knows more kinds than this one is describing itself
    // accurately; showing its own word beats showing "unknown".
    expect(describeSessionKind('relay-2')).toBe('relay-2');
  });
});

describe('registerSession', () => {
  it('writes a record for this process and lists it back', async () => {
    const before = Date.now();
    expect((await register('s1', { qwenVersion: '1.2.3' })).registered).toBe(
      true,
    );
    const after = Date.now();

    const live = await listLiveSessions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      pid: process.pid,
      sessionId: 's1',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
    expect(live[0].name).toMatch(/^app-[0-9a-f]{2}$/);
    // Bounds pin the epoch: a seconds-vs-milliseconds refactor (or a
    // constant) ships green through every other assertion here, then
    // breaks the AGE column and the newest-first ordering for everyone.
    expect(live[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(live[0].startedAt).toBeLessThanOrEqual(after);
  });

  it('records the writer’s PID namespace identity', async () => {
    await register();
    expect((await readJson())['pidNs']).toBe(readPidNamespaceId());
  });

  it('records what kind of session registered, defaulting to tui', async () => {
    await register('s1', { kind: 'serve' });
    expect((await listLiveSessions())[0]?.kind).toBe('serve');

    await unregisterSession();
    resetRegisteredRecordPathForTest();
    // The default is not cosmetic: every caller that omits the field is an
    // interactive terminal, and a listing that showed them as unknown
    // would read as a bug in the common case.
    await register();
    expect((await listLiveSessions())[0]?.kind).toBe('tui');
  });

  it('records an explicit name in place of the derived one', async () => {
    await register('s1', { kind: 'external', name: 'live' });
    expect((await listLiveSessions())[0]?.name).toBe('live');
  });

  it('flattens and bounds an explicit name, and falls back when it empties', async () => {
    // A name reaches a fixed-width table and a peer listing, so it gets
    // what a peer-supplied label gets rather than being trusted whole.
    await register('s1', { name: `voice bridge\n${'x'.repeat(80)}` });
    const flattened = (await listLiveSessions())[0]?.name ?? '';
    expect(flattened).not.toContain('\n');
    expect(Array.from(flattened)).toHaveLength(40);
    expect(flattened.endsWith('…')).toBe(true);

    await unregisterSession();
    resetRegisteredRecordPathForTest();
    // Nothing left to address the session by: the derived name is a
    // working handle, and an empty one would be unaddressable.
    await register('s1', { name: '\u0000\u0007' });
    expect((await listLiveSessions())[0]?.name).toMatch(/^app-[0-9a-f]{2}$/);
  });

  it('records an explicit null qwenVersion when it is omitted', async () => {
    // The key must exist as null, not be silently dropped by
    // JSON.stringify(undefined): the record format has a declared
    // schemaVersion, and schema drift on an optional field is still drift.
    await register();
    expect(await readJson()).toHaveProperty('qwenVersion', null);
  });

  itLinux('records the live start token on registration', async () => {
    // The writer side of the PID-reuse guard: a null token here would
    // degrade every later liveness check to a bare kill(pid, 0) and let a
    // recycled PID resurrect this record after exit.
    await register();
    expect((await readJson())['procStart']).toMatch(/^[0-9a-f-]+:\d+$/i);
  });

  itPosix('creates the registry directory as 0700', async () => {
    await register();
    expect((await fs.stat(getSessionRegistryDir())).mode & 0o777).toBe(0o700);
  });

  itPosix('tightens a pre-existing loose registry directory', async () => {
    await fs.mkdir(getSessionRegistryDir(), { recursive: true, mode: 0o755 });
    await fs.chmod(getSessionRegistryDir(), 0o755);

    await register();

    expect((await fs.stat(getSessionRegistryDir())).mode & 0o777).toBe(0o700);
  });

  itPosix('writes the record as 0600', async () => {
    await register();
    expect((await fs.stat(getSessionRecordPath())).mode & 0o777).toBe(0o600);
  });

  itPosix(
    'replaces a pre-planted symlink instead of writing through it',
    async () => {
      // Anything that can create a file in the registry directory could park a
      // symlink at `<pid>.json` to redirect the registration write. With
      // `noFollow` the rename replaces the link; without it the write lands on
      // the attacker's target.
      await fs.mkdir(getSessionRegistryDir(), { recursive: true });
      const outside = path.join(tmpDir, 'outside.txt');
      await fs.writeFile(outside, 'untouched');
      await fs.symlink(outside, getSessionRecordPath());

      expect(await registered()).toBe(true);

      expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
      expect((await fs.lstat(getSessionRecordPath())).isSymbolicLink()).toBe(
        false,
      );
    },
  );

  it('refuses to overwrite a record held by another PID namespace', async () => {
    // Host + devcontainer (or sibling containers) sharing one home can collide
    // on a PID; the loser of an overwrite would lose its record when the winner
    // exits. First writer wins; the second stays undiscoverable — degraded but
    // safe.
    await expectForeignSurvives(theirs({ pidNs: 1 }), async () => {
      expect(await registered('mine')).toBe(false);
    });
  });

  itLinux(
    'refuses to overwrite a record held by another machine’s boot',
    async () => {
      // The initial PID namespace inode is a kernel constant identical on
      // every Linux machine, so machines sharing a home over NFS pass the
      // namespace comparison — only the boot prefix separates them.
      expect(readLocalBootId()).not.toBeNull();
      await expectForeignSurvives(otherBoot(), async () => {
        expect(await registered('mine')).toBe(false);
      });
    },
  );

  itLinux(
    'overwrites a stale record left by a dead previous incarnation of this PID',
    async () => {
      // Same machine and PID, but the recorded token belongs to a process from
      // this boot that is gone: registration must replace the record, or a
      // session on a recycled PID stays hidden from `ps` for its whole
      // lifetime.
      const bootId = readLocalBootId();
      expect(bootId).not.toBeNull();
      await writeRaw(
        OWN,
        liveBody({ procStart: `${bootId}:1`, sessionId: 'stale' }),
      );

      expect(await registered('mine')).toBe(true);

      const raw = await readJson();
      expect(raw['sessionId']).toBe('mine');
      expect(raw['procStart']).toMatch(/^[0-9a-f-]+:\d+$/i);
      expect(raw['procStart']).not.toBe(`${bootId}:1`);
    },
  );

  itLinux(
    'refuses to write a record when the start token stays unreadable',
    async () => {
      // A tokenless Linux record is impersonable by any same-namespace reader —
      // including another machine sharing the home (the initial-namespace inode
      // is identical everywhere). Staying undiscoverable beats writing a record
      // another machine can destroy ours through.
      vi.spyOn(processLiveness, 'readProcStartToken').mockReturnValue(null);

      expect(await registered()).toBe(false);

      await expectGone();
      expect(await listLiveSessions()).toEqual([]);
    },
  );

  itLinux('retries the start token once before refusing', async () => {
    // Boot-id read failures are not cached, so the retry recovers from a
    // transient fd-pressure moment; only a persistent outage refuses.
    vi.spyOn(processLiveness, 'readProcStartToken').mockReturnValueOnce(null);

    expect(await registered()).toBe(true);

    expect((await readJson())['procStart']).toMatch(/^[0-9a-f-]+:\d+$/i);
  });

  itLinux(
    'refuses to write a record when the namespace id stays unreadable',
    async () => {
      // A namespace-less Linux record is unreclaimable litter: every healthy
      // reader's namespace is a number, so the guard hides it from listing AND
      // the sweep's unlink, every later patch fails matchesLocalIdentity, and
      // exit leaves it — poisoning the PID slot for the next session.
      vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);

      expect(await registered()).toBe(false);

      await expectGone();
      expect(await listLiveSessions()).toEqual([]);
    },
  );

  itLinux('retries the namespace id once before refusing', async () => {
    // Mirrors the start-token retry: statSync failures are transient, and
    // only a persistent outage refuses.
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValueOnce(null);

    expect(await registered()).toBe(true);

    expect((await readJson())['pidNs']).toBeTypeOf('number');
  });

  it('refuses to overwrite a record whose read fails transiently', async () => {
    // A stat/readFile failure other than ENOENT (EMFILE, EIO, NFS ESTALE) is a
    // momentary outage on an INTACT file that may belong to a live session on
    // another machine sharing the home: not "unowned".
    await expectForeignSurvives(theirs({ pidNs: 1 }), async () => {
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
        errno('stale file handle', 'ESTALE'),
      );
      expect(await registered('mine')).toBe(false);
    });
  });

  it('still registers when the filesystem does not support chmod', async () => {
    // FAT/exFAT/FUSE-class mounts reject chmod with ENOTSUP/ENOSYS. The record
    // write tolerates that (atomicWriteJSON's tryChmod) and 0700 is
    // unachievable there anyway, so the directory chmod must not abort
    // registration either, or the session stays invisible to `ps` for its whole
    // lifetime.
    vi.spyOn(fs, 'chmod').mockRejectedValue(
      errno('chmod unsupported', 'ENOTSUP'),
    );

    expect(await registered()).toBe(true);

    expect((await readJson())['sessionId']).toBe('s1');
  });

  it('still fails registration on a security-relevant chmod error', async () => {
    // The ENOSYS/ENOTSUP tolerance is narrow: sandbox EPERM, EIO and
    // friends still abort the registration.
    vi.spyOn(fs, 'chmod').mockRejectedValue(
      errno('operation not permitted', 'EPERM'),
    );

    expect(await registered()).toBe(false);

    await expectGone();
  });

  it('leaves a newer-schema record at its path alone on every write path', async () => {
    // A newer build's record is readable but not safely parsable, and under a
    // shared home may be a live session on another machine across a schema
    // bump. All three write paths must treat it like a parsed foreign-identity
    // record: refuse the overwrite, skip the merge, return without unlinking.
    // Register first so patch and unlink run against this test's path.
    await register('s0');
    await expectForeignSurvives(
      theirs({ schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1 }),
      async () => {
        expect(await registered('mine')).toBe(false);
        await patchSessionRecord({ sessionId: 'mine' });
        await unregisterSession();
      },
    );
  });

  it('keeps patching and unlinking the registered record after the home resolution moved', async () => {
    // A relative QWEN_HOME resolves against the cwd on every call and /cd
    // changes the cwd mid-session: patch and unregister must keep hitting the
    // directory registration wrote to, or the /cd patch no-ops and exit leaks
    // the record.
    expect(await registered()).toBe(true);
    const originalPath = getSessionRecordPath();

    __setMockGlobalDir(path.join(tmpDir, 'moved-home'));

    await patchSessionRecord({ sessionId: 'moved' });

    // The patch reached the original record, not the moved resolution —
    // where nothing was created at all.
    expect((await readJson(originalPath))['sessionId']).toBe('moved');
    expect(await listLiveSessions()).toEqual([]);

    // Unregister likewise unlinks the original record via the captured
    // path, without consulting the moved resolution.
    await unregisterSession();
    await expectGone(originalPath);
  });

  it('reports failure instead of throwing when the home dir is unwritable', async () => {
    __setMockGlobalDir(path.join(tmpDir, 'nope', '\0invalid'));
    expect(await registered()).toBe(false);
  });
});

describe('registerSession — one process, several records', () => {
  const mint = (
    sessionId: string,
    cwd: string,
    extra: Partial<Parameters<typeof registerSession>[0]> = {},
  ) => registerSession({ sessionId, cwd, slot: 'own', ...extra });
  /** Mints `a` (/w/one), then `b` (/w/two). */
  const mintPair = async (extra?: Parameters<typeof mint>[2]) =>
    [
      await mint('a', '/w/one', extra),
      await mint('b', '/w/two', extra),
    ] as const;

  it('writes a record of its own per session, keyed by a minted slot', async () => {
    const [first, second] = await mintPair({ kind: 'serve' });

    expect(first.registered && second.registered).toBe(true);
    expect(first.slot).not.toBe(second.slot);
    expect(first.slot).toMatch(/^[0-9a-f]{8}$/);
    // Named by the writer's PID like every other record, so the sweep and
    // the namespace guards judge them exactly as they judge a shared one.
    const files = (await fs.readdir(getSessionRegistryDir())).sort();
    expect(files).toEqual(
      [
        `${process.pid}-${first.slot}.json`,
        `${process.pid}-${second.slot}.json`,
      ].sort(),
    );

    const live = await listLiveSessions();
    expect(live.map((record) => record.sessionId).sort()).toEqual(['a', 'b']);
    expect(live.every((record) => record.pid === process.pid)).toBe(true);
  });

  it('patches and removes one slot without touching its siblings', async () => {
    const [first, second] = await mintPair();

    expect(
      await patchSessionRecord({ ipcPath: '/tmp/shared.sock' }, first.slot),
    ).toBe(true);
    const afterPatch = await listLiveSessions();
    const ipcPathOf = (sessionId: string) =>
      afterPatch.find((record) => record.sessionId === sessionId)?.ipcPath;
    expect(ipcPathOf('a')).toBe('/tmp/shared.sock');
    // The sibling is a separate file: a patch that resolved the path by
    // PID alone would have rewritten whichever record it found first.
    expect(ipcPathOf('b')).toBeUndefined();

    await unregisterSession(second.slot);
    expect(await liveIds()).toEqual(['a']);
  });

  it('reads back the record of the slot it is asked for', async () => {
    const [first, second] = await mintPair();

    expect((await readOwnSessionRecord(first.slot))?.sessionId).toBe('a');
    expect((await readOwnSessionRecord(second.slot))?.sessionId).toBe('b');
    // A slot this process never registered names no record, and must not
    // fall back to the PID-keyed path — that record belongs to whatever
    // else is running under this PID, not to the caller.
    expect(await readOwnSessionRecord('deadbeef')).toBeNull();
    expect(await patchSessionRecord({ sessionId: 'x' }, 'deadbeef')).toBe(
      false,
    );
    await expect(unregisterSession('deadbeef')).resolves.toBeUndefined();
    expect((await listLiveSessions()).length).toBe(2);
  });

  it('never resolves an unknown slot onto a live shared record', async () => {
    // The interesting arm of the rule above: with a shared record at this PID's
    // path, an unknown minted slot must still name nothing. Falling back would
    // let one session read, rewrite and unlink a record of whatever else runs
    // under this PID — invisible to the assertions above, which run with no
    // shared record on disk.
    await registerSession({ sessionId: 'plain', cwd: '/w/plain' });
    expect(await liveIds()).toEqual(['plain']);

    expect(await readOwnSessionRecord('deadbeef')).toBeNull();
    expect(await patchSessionRecord({ sessionId: 'stolen' }, 'deadbeef')).toBe(
      false,
    );
    await unregisterSession('deadbeef');

    expect(await liveIds()).toEqual(['plain']);
  });

  it('keeps a minted record at its own filename when the session id is swapped', async () => {
    // The invariant the design rests on: `/clear` or a session load swaps the
    // id and the record follows by patch. A filename derived from the id (or
    // renamed on a patch) would strand every reader holding the old name.
    const own = await mint('before', '/w/hosted');
    const fileName = `${process.pid}-${own.slot}.json`;
    expect(await fs.readdir(getSessionRegistryDir())).toEqual([fileName]);

    expect(await patchSessionRecord({ sessionId: 'after' }, own.slot)).toBe(
      true,
    );

    expect(await fs.readdir(getSessionRegistryDir())).toEqual([fileName]);
    expect((await readOwnSessionRecord(own.slot))?.sessionId).toBe('after');
    expect((await listLiveSessions())[0]?.sessionId).toBe('after');
  });

  it('keeps the path of a record whose removal could not read it', async () => {
    // A minted path cannot be derived again, so forgetting it on a transient
    // read failure would leave a record this process can never name —
    // advertising a gone session until the PID dies. Every other exit has
    // established the path is not ours.
    const own = await mint('hosted', '/w/hosted');
    const failing = vi
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(errno('EIO', 'EIO') as never);
    await unregisterSession(own.slot);
    failing.mockRestore();
    // Still there, and still addressable: the capture survived.
    expect(await liveIds()).toEqual(['hosted']);

    await unregisterSession(own.slot);
    expect(await listLiveSessions()).toEqual([]);
  });

  it('leaves the shared record alone, and is left alone by it', async () => {
    const own = await mint('hosted', '/w/hosted');
    const plain = await registerSession({
      sessionId: 'plain',
      cwd: '/w/plain',
    });
    // Asserted, not assumed: any of registration's refusal branches
    // hitting this call would leave the half of this test its name comes
    // from checking nothing at all.
    expect(plain.registered).toBe(true);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual(
      [OWN, `${process.pid}-${own.slot}.json`].sort(),
    );

    await unregisterSession();
    const live = await listLiveSessions();
    expect(live.map((record) => record.sessionId)).toEqual(['hosted']);
    expect(live[0]?.name).toBe(deriveSessionName('/w/hosted', 'hosted'));
    await unregisterSession(own.slot);
    expect(await listLiveSessions()).toEqual([]);
  });

  it('sweeps a minted record whose process is gone, and its temp files', async () => {
    // Same reaping the shared name gets: the filename says which PID to
    // check, and a suffix does not change that answer.
    const temp = await writeRaw(
      `${DEAD_PID}-a1b2c3d4.json.0123456789ab.tmp`,
      'partial',
    );
    await fs.utimes(temp, new Date(0), new Date(0));

    await expectUnlisted(
      `${DEAD_PID}-a1b2c3d4.json`,
      liveBody({ pid: DEAD_PID, startedAt: Date.now() }),
      'swept',
    );
    await expectGone(temp);
  });

  it('skips a minted record whose pid disagrees with its filename', async () => {
    // The suffix is the only new thing in the name; the PID in front of it
    // still has to match the record, or nothing can reason about it.
    await expectUnlisted(
      `${process.pid}-a1b2c3d4.json`,
      liveBody({ pid: process.pid + 1 }),
      'kept',
    );
  });
});

describe('never-throw guarantee', () => {
  it('every entry point resolves when the home directory cannot be resolved', async () => {
    // `os.homedir()` throws when HOME is unset and the passwd lookup fails
    // (some containers/CI images); `ps` has no catch, trusting the registry's
    // promise, so a rejection would go unhandled in exactly that environment.
    __setMockGlobalDir(null);

    await expect(listLiveSessions()).resolves.toEqual([]);
    // Resolves (never rejects); the patch did not apply, so it reports
    // false rather than the historical void.
    await expect(patchSessionRecord({ sessionId: 'new' })).resolves.toBe(false);
    await expect(register()).resolves.toMatchObject({ registered: false });
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('patchSessionRecord', () => {
  it('updates a field without dropping the others', async () => {
    await register('old', { qwenVersion: '1.2.3' });
    const [before] = await listLiveSessions();

    await patchSessionRecord({ sessionId: 'new', name: 'renamed' });

    const [record] = await listLiveSessions();
    expect(record).toMatchObject({
      sessionId: 'new',
      name: 'renamed',
      cwd: '/w/app',
      qwenVersion: '1.2.3',
    });
    // Both production patch sites omit `startedAt`; a re-stamp would
    // reset the AGE column and the newest-first ordering on every
    // /clear and /cd.
    expect(record.startedAt).toBe(before.startedAt);
  });

  it('reports true when the patch was written', async () => {
    await register('old');
    await expect(patchSessionRecord({ name: 'renamed' })).resolves.toBe(true);
  });

  it('reports false when the patch was skipped', async () => {
    // No registration: the missing-record skip must be observable, or a
    // caller with no later retry vehicle cannot tell it never landed.
    await expect(patchSessionRecord({ name: 'renamed' })).resolves.toBe(false);
  });

  it('does not recreate a record once the session’s record is gone', async () => {
    // register + unregister leaves the directory but no record; only the
    // missing-record guard stands between a patch and a half-populated record
    // on disk. An empty listing is not enough: a patch-only record fails
    // validation and lists as nothing either way.
    await register('old');
    await unregisterSession();

    await patchSessionRecord({ sessionId: 'new' });

    expect(await listLiveSessions()).toEqual([]);
    await expectGone();
  });

  it('leaves a foreign record sitting at this pid’s path untouched', async () => {
    // `readRecord` does not check filename/contents agreement, so without
    // the pid guard a patch would merge into someone else's record and
    // write back something `listLiveSessions` will neither show nor sweep.
    await register('s0');
    await expectForeignSurvives(theirs({ pid: process.pid + 1 }), () =>
      patchSessionRecord({ sessionId: 'mine' }),
    );
  });

  itLinux(
    'refuses to merge into a stale record left by a dead previous incarnation of this PID',
    async () => {
      // Session A died without unlinking (SIGKILL); PID P was recycled by
      // session B whose registration failed. B's patch passes the pid,
      // namespace and boot checks (same machine); only the start token proves
      // the record is not A's, else the merge grafts B's fields onto A's
      // startedAt/version/name and lists the chimera as live. (A foreign boot
      // prefix is refused by the machine-identity check instead.)
      const bootId = readLocalBootId();
      expect(bootId).not.toBeNull();
      await register('s0');
      const filePath = await writeRaw(
        OWN,
        liveBody({ procStart: `${bootId}:1`, sessionId: 'incarnation-a' }),
      );

      await patchSessionRecord({ sessionId: 'incarnation-b' });

      expect(await readJson(filePath)).toMatchObject({
        sessionId: 'incarnation-a',
      });
    },
  );

  itLinux(
    "refuses to merge when this process's own start token is unreadable",
    async () => {
      // The merge path's mirror of the boot-id outage rule: in the fd-pressure
      // window these patches run in, our own token read can fail while a DEAD
      // previous incarnation's record holds the path. "Cannot compare" means
      // "not ours": the patch is skipped (a later /clear or /cd retries it)
      // instead of grafting onto the stale record and listing the chimera.
      await register('s0');
      const before = await readJson();
      vi.spyOn(processLiveness, 'readProcStartToken').mockReturnValue(null);

      await patchSessionRecord({ sessionId: 'incarnation-b' });

      expect(await readJson()).toEqual(before);
    },
  );

  it('preserves the identity fields across the patch merge', async () => {
    // Both production patch sites run in ordinary use; a merge dropping
    // `procStart` degrades later liveness checks to a bare kill(pid, 0) (a
    // recycled PID resurrects the record), and a dropped `pidNs` hides the
    // session behind the namespace guard.
    await register();
    const before = await readJson();
    if (process.platform === 'linux') {
      // Otherwise the procStart equality pin below is vacuous.
      expect(before['procStart']).not.toBeNull();
    }

    await patchSessionRecord({ sessionId: 'new', cwd: '/w/b' });

    const after = await readJson();
    expect(after['procStart']).toBe(before['procStart']);
    expect(after['pidNs']).toBe(before['pidNs']);
    expect(after['pid']).toBe(process.pid);
  });

  it('still patches a record written without a start token', async () => {
    // Tokenless platforms must keep working through the pid comparison —
    // the guard only fires when BOTH sides have a token to compare.
    await register('s0');
    await writeRaw(OWN, liveBody());

    await patchSessionRecord({ sessionId: 'new' });

    const [record] = await listLiveSessions();
    expect(record.sessionId).toBe('new');
  });

  itLinux(
    'refuses to merge into a boot-prefixed record while the local boot id is unreadable',
    async () => {
      // "Cannot compare" must not become "is ours" on a write path: the record
      // may belong to another machine sharing the home. A writer with an
      // unreadable boot id writes a TOKENLESS record, so refusing boot-prefixed
      // ones costs nothing.
      await register('s0');
      vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue(null);
      // Also pin the token read to the planted record's token: left real, the
      // stale-incarnation guard would refuse the merge on its own (a foreign
      // boot prefix never equals our real token) and shadow the rule under
      // test.
      vi.spyOn(processLiveness, 'readProcStartToken').mockReturnValue(
        'not-this-boot:1',
      );
      await expectForeignSurvives(otherBoot(), () =>
        patchSessionRecord({ sessionId: 'mine' }),
      );
    },
  );

  itLinux(
    'still patches a tokenless record while the local boot id is unreadable',
    async () => {
      // The other half of the outage rule: without a boot id to compare,
      // only TOKENLESS records are accepted — and they still are.
      vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue(null);
      await register('s0');
      await writeRaw(OWN, liveBody());

      await patchSessionRecord({ sessionId: 'new' });

      expect((await readJson())['sessionId']).toBe('new');
    },
  );

  itPosix('keeps the record at 0600 across a patch', async () => {
    await register();
    await patchSessionRecord({ sessionId: 'new' });
    expect((await fs.stat(getSessionRecordPath())).mode & 0o777).toBe(0o600);
  });

  itPosix(
    'replaces a symlinked record instead of patching through it',
    async () => {
      // Mirror of the registration symlink test: the patch path is
      // written on every /clear and /cd, so a dropped `noFollow` would
      // redirect those writes through a pre-planted link just the same.
      await register();
      const outside = path.join(tmpDir, 'outside.json');
      await fs.writeFile(
        outside,
        JSON.stringify(liveBody({ sessionId: 'outside' })),
      );
      await fs.rm(getSessionRecordPath());
      await fs.symlink(outside, getSessionRecordPath());

      await patchSessionRecord({ sessionId: 'patched' });

      expect((await readJson(outside))['sessionId']).toBe('outside');
      expect((await fs.lstat(getSessionRecordPath())).isSymbolicLink()).toBe(
        false,
      );
      const [record] = await listLiveSessions();
      expect(record?.sessionId).toBe('patched');
    },
  );
});

describe('unregisterSession', () => {
  it('removes the record', async () => {
    await register();
    await unregisterSession();
    expect(await listLiveSessions()).toEqual([]);
  });

  it('removes only this process’s record, leaving siblings intact', async () => {
    // Plant a live sibling: a broadened deletion ("also clean up stale
    // records on exit") would wipe it too, and registration is one-shot
    // — the victim would stay invisible in `ps` for its whole lifetime.
    await writeRaw(
      `${process.ppid}.json`,
      liveBody({
        pid: process.ppid,
        sessionId: 's-sibling',
        startedAt: Date.now(),
      }),
    );
    await register();

    await unregisterSession();

    await expectGone();
    expect(await liveIds()).toEqual(['s-sibling']);
  });

  it('leaves a foreign-identity record at its path alone', async () => {
    // The path is keyed by PID alone: the record sitting there may
    // belong to a live session in another namespace that shares the
    // number. Unlinking it would hide that session until it restarts.
    await register('s0');
    await expectForeignSurvives(theirs({ pidNs: 1 }), () =>
      unregisterSession(),
    );
  });

  itLinux(
    'leaves a record from another machine’s boot at its path alone',
    async () => {
      // Mirror of the register-side pin: the boot prefix is the ONLY identity
      // separating two machines sharing one home (the initial namespace inode
      // is a kernel constant), so exit must not unlink the other machine's live
      // record on a PID collision.
      expect(readLocalBootId()).not.toBeNull();
      await register('s0');
      await expectForeignSurvives(otherBoot(), () => unregisterSession());
    },
  );

  it("unlinks a corrupt record at this process's own path", async () => {
    // A write torn by a crash at OUR path cannot belong to anyone else,
    // and exit is the only reclaimer: listLiveSessions never deletes
    // what it cannot parse.
    await register();
    await writeRaw(OWN, 'not json at all');

    await unregisterSession();

    await expectGone();
  });

  itLinux(
    'leaves a boot-prefixed record alone on exit while the local boot id is unreadable',
    async () => {
      // Exit is an UNLINK path, so the outage rule applies: "cannot compare"
      // means "not ours", as the record may be another machine's on a PID
      // collision. The unregister path has no stale-incarnation guard to shadow
      // the rule.
      vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue(null);
      await expectForeignSurvives(otherBoot(), () => unregisterSession());
    },
  );

  it('leaves a record alone on exit when its read fails transiently', async () => {
    // The file is intact and only momentarily unreadable (EMFILE, EIO,
    // NFS ESTALE) — it may be a foreign live record on a PID collision,
    // so exit must not unlink it on the strength of a read failure.
    await register();
    const before = await readJson();
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      errno('stale file handle', 'ESTALE'),
    );

    await unregisterSession();

    expect(await readJson()).toEqual(before);
  });

  it('is a no-op when nothing was registered', async () => {
    await expect(unregisterSession()).resolves.toBeUndefined();
  });
});

describe('listLiveSessions', () => {
  const deadRecordPath = () =>
    path.join(getSessionRegistryDir(), `${DEAD_PID}.json`);

  it('returns an empty list when the registry does not exist', async () => {
    expect(await listLiveSessions()).toEqual([]);
  });

  it('resolves to an empty list when readdir itself fails', async () => {
    // EACCES (a root-owned sessions/ left by a containerized run) or
    // ESTALE/EIO on a degraded shared home must read as "no peers",
    // never as a rejection — `ps` awaits this with no catch.
    await writeRaw(OWN, liveBody());
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(
      errno('permission denied', 'EACCES'),
    );

    await expect(listLiveSessions()).resolves.toEqual([]);
  });

  it('sweeps a record whose process is gone', async () => {
    await expectUnlisted(
      `${DEAD_PID}.json`,
      liveBody({
        pid: DEAD_PID,
        sessionId: 's-dead',
        cwd: '/w/app',
        name: 'app-aa',
        startedAt: Date.now(),
      }),
      'swept',
    );
  });

  itLinux('treats a recycled PID as stale', async () => {
    // Our PID is alive, but the recorded token belongs to a different process
    // on THIS boot, so the record describes a gone session. (A foreign boot
    // prefix would model another machine: skipped, not swept.)
    const bootId = readLocalBootId();
    expect(bootId).not.toBeNull();
    await expectUnlisted(
      OWN,
      liveBody({
        procStart: `${bootId}:1`,
        sessionId: 's-recycled',
        cwd: '/w/app',
        name: 'app-aa',
        startedAt: Date.now(),
      }),
      'swept',
    );
  });

  it('does not unlink a record replaced between the liveness verdict and the sweep', async () => {
    // Session A died uncleanly and the sweep judges its record dead. Before the
    // unlink, the recycled PID's registration passes matchesLocalIdentity
    // against the stale record and renames its fresh record onto the path; the
    // sweep must not delete a record it never judged, or that session stays
    // invisible to `ps` for life.
    await writeRaw(
      `${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, sessionId: 'stale-a', startedAt: 5 }),
    );

    const realReadFile = fs.readFile;
    let readsOfRecord = 0;
    let releaseReread!: () => void;
    const rereadGate = new Promise<void>((resolve) => {
      releaseReread = resolve;
    });
    vi.spyOn(fs, 'readFile').mockImplementation((async (filePath: unknown) => {
      if (String(filePath).endsWith(`${DEAD_PID}.json`)) {
        readsOfRecord += 1;
        // Hold the sweep at the RE-READ (the snapshot read is the
        // first hit) so the replacement lands in the exact window
        // between the verdict and the re-read.
        if (readsOfRecord === 2) await rereadGate;
      }
      return realReadFile(filePath as string, 'utf8');
    }) as unknown as typeof fs.readFile);

    const listing = listLiveSessions();
    await vi.waitFor(() => expect(readsOfRecord).toBe(2));

    await writeRaw(
      `${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, sessionId: 'recycled-b', startedAt: 6 }),
    );
    releaseReread();

    expect(await listing).toEqual([]);
    await expectKept(deadRecordPath());
  });

  it("still lists live records when a sweep's unlink fails", async () => {
    // The sweep's unlink can fail (EACCES, ESTALE) while the rest of
    // the enumeration succeeds; one undeletable dead record must not
    // reject the promise or hide the live sessions.
    await writeRaw(
      `${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, sessionId: 's-dead', startedAt: 1 }),
    );
    await writeRaw(OWN, liveBody({ sessionId: 's-live', startedAt: 2 }));
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(
      errno('permission denied', 'EACCES'),
    );

    expect(await liveIds()).toEqual(['s-live']);
    // The failed unlink leaves the dead record for the next sweep.
    await expectKept(deadRecordPath());
  });

  it('neither lists nor sweeps a record from a different PID namespace, even a dead one', async () => {
    // PID numbers do not resolve across the namespace boundary: kill(pid, 0)
    // here reports ESRCH for a process alive there, and a "matching" starttime
    // can be an unrelated process. Wrong-side liveness is worse than none, so
    // the record is left for a reader on the writer's side, even if its PID
    // looks dead here.
    await expectUnlisted(
      `${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, pidNs: 1 }),
      'kept',
    );
  });

  it('does not list a foreign-namespace record under a live PID', async () => {
    // The sharp end of the guard: without it this record passes plain
    // liveness (the PID is us) and is listed as our session.
    await expectUnlisted(OWN, liveBody({ pidNs: 1 }), 'kept');
  });

  itLinux(
    'neither lists nor sweeps a record from another machine’s boot',
    async () => {
      // Every Linux machine has the same initial-namespace inode, so only the
      // boot prefix separates two machines sharing one home. The PID is dead on
      // this side, so without the guard the sweep unlinks a live session's
      // record on the other machine.
      expect(readLocalBootId()).not.toBeNull();
      await expectUnlisted(
        `${DEAD_PID}.json`,
        liveBody({ pid: DEAD_PID, procStart: 'not-this-boot:1' }),
        'kept',
      );
    },
  );

  itLinux(
    'leaves every boot-prefixed record alone while the local boot id is unreadable',
    async () => {
      // The guard must not be disabled by OUR outage: else the foreign record
      // falls through to `isSameProcess`, which degrades to bare liveness in
      // the same outage, and the sweep unlinks another machine's live record.
      // Tokenless records keep listing: the outage degrades the boot check, not
      // the registry.
      vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue(null);
      const foreign = await writeRaw(
        `${DEAD_PID}.json`,
        liveBody({ pid: DEAD_PID, procStart: 'not-this-boot:1' }),
      );
      await writeRaw(OWN, liveBody());

      expect(await liveIds()).toEqual(['s']);
      await expectKept(foreign);
    },
  );

  it('sweeps registration temp files orphaned by a crashed write', async () => {
    // A writer that dies between the temp write and the rename leaves
    // the temp behind; nothing else ever removes it.
    const orphan = await writeRaw(`${OWN}.0123456789ab.tmp`, '{}');
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(orphan, stale, stale);

    // A fresh temp may belong to a writer mid-rename — the age check
    // must spare it.
    const fresh = await writeRaw(`${OWN}.fedcba987654.tmp`, '{}');

    await listLiveSessions();

    await expectGone(orphan);
    await expectKept(fresh);
  });

  it('ignores near-misses of the minted <pid>-<8 hex>.json shape', async () => {
    // The suffix widened the grammar the sweep unlinks through, so the filter's
    // "matched exactly" claim needs near-misses of the NEW shape too. Each is a
    // name a backup tool, another build or a shared home could drop here; all
    // name a dead PID, so accepting one would list a phantom and delete a file
    // this code never wrote.
    const nearMisses = [
      `${DEAD_PID}-a1b2c3d.json`, // seven hex, not eight
      `${DEAD_PID}-a1b2c3d4e.json`, // nine
      `${DEAD_PID}-A1B2C3D4.json`, // uppercase
      `${DEAD_PID}-a1b2c3g4.json`, // 'g' is not hex
      `${DEAD_PID}-notes.json`, // words
      `${DEAD_PID}-a1b2c3d4-e5f6a7b8.json`, // two suffixes
      `${DEAD_PID}_a1b2c3d4.json`, // underscore, not dash
    ];
    for (const name of nearMisses) {
      await writeRaw(name, liveBody({ pid: DEAD_PID }));
    }

    expect(await listLiveSessions()).toEqual([]);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual(
      [...nearMisses].sort(),
    );
  });

  /** A schema-1 record body for `pid` that skips `liveBody`'s defaults. */
  const bareRecord = (pid: number, over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    pid,
    sessionId: 's',
    cwd: '/w',
    name: 'n',
    startedAt: 1,
    ...over,
  });

  it('ignores files that are not <pid>.json', async () => {
    await writeRaw('2026-planning-notes.json', { hello: 'world' });
    await writeRaw('notes.txt', 'nope');
    await writeRaw('007.json', bareRecord(7));

    expect(await listLiveSessions()).toEqual([]);
    // Critically, none of them were deleted.
    const remaining = await fs.readdir(getSessionRegistryDir());
    expect(remaining.sort()).toEqual([
      '007.json',
      '2026-planning-notes.json',
      'notes.txt',
    ]);
  });

  it('ignores a record whose zero-padded filename parses to its pid', async () => {
    // The agreement check parses the pid from the filename; without a
    // canonical-form rule `007` parses to 7, and a name this code never wrote
    // passes the guard meant to reject it and reaches the sweep's unlink. Linux
    // masks this (its pidNs is never null), so the namespace read is spied to
    // the value other platforms return and the filename grammar decides.
    vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);
    // Live PID arm: the phantom is listed as a live session. Dead PID
    // arm: the sweep unlinks a file this code never wrote.
    const alive = await writeRaw(`0${OWN}`, liveBody({ pidNs: null }));
    const dead = await writeRaw(
      `0${DEAD_PID}.json`,
      liveBody({ pid: DEAD_PID, pidNs: null }),
    );

    expect(await listLiveSessions()).toEqual([]);
    await expectKept(alive);
    await expectKept(dead);
  });

  it('never opens a file that is not named <pid>.json', async () => {
    await writeRaw('2026-planning-notes.json', { hello: 'world' });
    await writeRaw('notes.txt', 'nope');
    // Anchored at both ends, with the dot escaped: `session-2026.json`
    // defeats a regex missing its `^`, `12.json.bak` one missing its `$`,
    // and `12xjson` one whose `.` is a wildcard.
    await writeRaw('session-2026.json', { hello: 'world' });
    await writeRaw('12.json.bak', { hello: 'world' });
    await writeRaw('12xjson', { hello: 'world' });
    await writeRaw(OWN, liveBody());

    statCalls.length = 0;
    recordStatCalls = true;
    try {
      expect(await listLiveSessions()).toEqual([liveBody()]);
    } finally {
      recordStatCalls = false;
    }

    expect(statCalls).toEqual([OWN]);
  });

  it('skips a record whose pid disagrees with its filename', async () => {
    await expectUnlisted(OWN, bareRecord(process.pid + 1), 'kept');
  });

  it('skips malformed and future-schema records without deleting them', async () => {
    await writeRaw('11.json', 'not json at all');
    await writeRaw(
      '12.json',
      bareRecord(12, { schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION + 1 }),
    );
    await writeRaw('13.json', bareRecord(13, { name: 42 }));

    expect(await listLiveSessions()).toEqual([]);
    expect((await fs.readdir(getSessionRegistryDir())).sort()).toEqual([
      '11.json',
      '12.json',
      '13.json',
    ]);
  });

  it('returns a well-formed record verbatim', async () => {
    // The control for every rejection case below, and the only assertion
    // that pins the exact field set a reader gets back.
    await writeRaw(OWN, liveBody());
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it('drops unknown fields rather than passing them on', async () => {
    // Without the drop, arbitrary keys from a hand-planted <pid>.json
    // would ride the typed record into `ps --json` output — and be
    // re-persisted permanently by patchSessionRecord's merge.
    await writeRaw(OWN, { ...liveBody(), extraField: 'x' });
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it('nulls optional fields of the wrong type rather than passing them on', async () => {
    // A numeric `procStart` handed to `isSameProcess` would never equal the
    // string token it reads back, so a live session would be swept; a
    // numeric `qwenVersion` would reach every consumer typed as a string.
    await writeRaw(OWN, liveBody({ procStart: 12345, qwenVersion: 7 }));
    expect(await listLiveSessions()).toEqual([liveBody()]);
  });

  it('keeps a kind it has never heard of, as its writer wrote it', async () => {
    // Forward compatibility: a newer build may register a kind this one
    // does not know, and replacing it with a guess would lose the one
    // thing the record actually says about itself.
    await writeRaw(OWN, liveBody({ kind: 'relay-2' }));
    expect((await listLiveSessions())[0]?.kind).toBe('relay-2');
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['uppercase', 'Serve'],
    ['over sixteen characters', 'a'.repeat(17)],
    ['shaped like a path', '../../etc'],
  ])(
    'drops a kind that is %s, rather than passing it on',
    async (_what, kind) => {
      // Dropped, not defaulted: absent has a meaning of its own, and
      // `describeSessionKind` is the single place that decides how it reads.
      // A record is otherwise usable, so the field goes and the record stays.
      await writeRaw(OWN, liveBody({ kind }));
      expect(await listLiveSessions()).toEqual([liveBody()]);
    },
  );

  it.each([
    ['a string schemaVersion', { schemaVersion: '1' }],
    ['no schemaVersion at all', { schemaVersion: undefined }],
    ['a string pid', { pid: String(process.pid) }],
    ['a non-string sessionId', { sessionId: 42 }],
    ['a non-string cwd', { cwd: null }],
    ['a non-string name', { name: 42 }],
    ['a string startedAt', { startedAt: '5' }],
  ])(
    'skips a record with %s, and never sweeps it',
    async (_what, over: Record<string, unknown>) => {
      await expectUnlisted(OWN, liveBody(over), 'kept');
    },
  );

  it('skips a record whose startedAt is not finite', async () => {
    // JSON has no Infinity literal, but 1e999 parses to one — and an
    // Infinity `startedAt` sorts every real session below it forever.
    await expectUnlisted(
      OWN,
      JSON.stringify(liveBody()).replace('"startedAt":5', '"startedAt":1e999'),
      'kept',
    );
  });

  it('never sweeps 0.json, which no real process can own', async () => {
    // `0.json` clears the filename regex and agrees with its own contents,
    // so only the `pid <= 0` check stops `process.kill(0, 0)` — a
    // whole-process-group signal — from deciding a stranger's file's fate.
    await expectUnlisted('0.json', liveBody({ pid: 0 }), 'kept');
  });

  it('refuses to parse a record larger than 64 KiB', async () => {
    await expectUnlisted(
      OWN,
      liveBody({ cwd: `/w/${'x'.repeat(70_000)}` }),
      'kept',
    );
  });

  it('sorts newest first', async () => {
    await register('s-self');
    await patchSessionRecord({ startedAt: 1000 });
    await writeRaw(
      `${process.ppid}.json`,
      liveBody({
        pid: process.ppid,
        sessionId: 's-parent',
        cwd: '/w/other',
        name: 'other-bb',
        startedAt: 2000,
      }),
    );

    expect(await liveIds()).toEqual(['s-parent', 's-self']);
  });
});

describe('readOwnSessionRecord', () => {
  it('is null before this process registers', async () => {
    expect(await readOwnSessionRecord()).toBeNull();
  });

  it("returns this process's record, including a patched ipcPath", async () => {
    await register();
    await patchSessionRecord({ ipcPath: '/tmp/self.sock' });
    expect(await readOwnSessionRecord()).toMatchObject({
      pid: process.pid,
      sessionId: 's1',
      cwd: '/w/app',
      ipcPath: '/tmp/self.sock',
    });
  });

  it('round-trips the inbox token beside the address, dropping both on clear', async () => {
    await register();
    await patchSessionRecord({ ipcPath: '/tmp/self.sock', ipcToken: 'tok-1' });
    expect(await readOwnSessionRecord()).toMatchObject({
      ipcPath: '/tmp/self.sock',
      ipcToken: 'tok-1',
    });

    await patchSessionRecord({ ipcPath: undefined, ipcToken: undefined });
    const cleared = await readOwnSessionRecord();
    expect(cleared).not.toBeNull();
    expect(cleared).not.toHaveProperty('ipcPath');
    expect(cleared).not.toHaveProperty('ipcToken');
  });

  it("is null for a foreign record sitting at this pid's path", async () => {
    // Same guard patchSessionRecord applies: a record whose pid does not
    // match this process is not ours to read back, whatever its filename.
    await register('s0');
    await writeRaw(OWN, theirs({ pid: process.pid + 1 }));
    expect(await readOwnSessionRecord()).toBeNull();
  });

  itLinux(
    'is null for a stale record left by a dead previous incarnation of this PID',
    async () => {
      const bootId = readLocalBootId();
      expect(bootId).not.toBeNull();
      await register('s0');
      await writeRaw(
        OWN,
        liveBody({ procStart: `${bootId}:1`, sessionId: 'incarnation-a' }),
      );
      expect(await readOwnSessionRecord()).toBeNull();
    },
  );

  itLinux(
    "is null when this process's own start token is unreadable",
    async () => {
      await register('s0');
      vi.spyOn(processLiveness, 'readProcStartToken').mockReturnValue(null);
      expect(await readOwnSessionRecord()).toBeNull();
    },
  );

  it('still reads a record written without a start token', async () => {
    await register('s0');
    await writeRaw(OWN, liveBody({ sessionId: 'tokenless' }));
    expect(await readOwnSessionRecord()).toMatchObject({
      sessionId: 'tokenless',
    });
  });

  it('never throws when the home directory is unavailable', async () => {
    __setMockGlobalDir(null);
    await expect(readOwnSessionRecord()).resolves.toBeNull();
  });
});
