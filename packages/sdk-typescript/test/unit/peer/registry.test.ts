/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from '../../../src/peer/identity.js';
import {
  pidOfRecordFilename,
  readLiveSessionRecords,
  removeOwnRecord,
  removeOwnRecordSync,
  resolveQwenHome,
  type SessionRecord,
  writeOwnRecord,
} from '../../../src/peer/registry.js';

const isPosix = process.platform !== 'win32';
const isLinux = process.platform === 'linux';

let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qpr-')), 'sessions');
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

function ownRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    pidNs: readPidNamespaceId(),
    sessionId: 'own',
    cwd: '/w',
    name: 'own',
    startedAt: 10,
    qwenVersion: null,
    kind: 'external',
    ipcPath: '/tmp/own.sock',
    ipcToken: 'tok',
    ...overrides,
  };
}

function plant(name: string, contents: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(
    filePath,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return filePath;
}

describe('pidOfRecordFilename', () => {
  it.each([
    ['123.json', 123],
    ['123-0a1b2c3d.json', 123],
    ['007.json', null],
    ['2026-notes.json', null],
    ['123-0A1B2C3D.json', null],
    ['123-0a1b2c3.json', null],
    ['123.json.0a1b2c3d4e5f.tmp', null],
    ['0.json', null],
  ])('%s -> %s', (name, pid) => {
    expect(pidOfRecordFilename(name)).toBe(pid);
  });
});

describe('writeOwnRecord', () => {
  it('publishes the PID-keyed record, owner-only, with no temporary left behind', async () => {
    const written = await writeOwnRecord(dir, ownRecord());
    expect(path.basename(written)).toBe(`${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(written, 'utf8'))).toEqual(ownRecord());
    expect(fs.readdirSync(dir)).toEqual([`${process.pid}.json`]);
    if (isPosix) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    }
  });

  it('takes a minted name when this process already holds the PID-keyed one', async () => {
    const first = await writeOwnRecord(dir, ownRecord({ sessionId: 'one' }));
    const second = await writeOwnRecord(dir, ownRecord({ sessionId: 'two' }));
    expect(path.basename(second)).toMatch(
      new RegExp(`^${process.pid}-[0-9a-f]{8}\\.json$`),
    );
    expect(JSON.parse(fs.readFileSync(first, 'utf8')).sessionId).toBe('one');
  });

  it('will not replace a newer schema, another namespace, or a symlink', async () => {
    const shared = `${process.pid}.json`;
    for (const setup of [
      () => plant(shared, { ...ownRecord(), schemaVersion: 2 }),
      () => plant(shared, { ...ownRecord({ sessionId: 'x' }), pidNs: -1 }),
      ...(isPosix
        ? [
            () => {
              fs.mkdirSync(dir, { recursive: true });
              fs.symlinkSync('/dev/null', path.join(dir, shared));
            },
          ]
        : []),
    ]) {
      fs.rmSync(dir, { recursive: true, force: true });
      setup();
      const before = fs.lstatSync(path.join(dir, shared));
      const written = await writeOwnRecord(dir, ownRecord());
      expect(path.basename(written)).not.toBe(shared);
      expect(fs.lstatSync(path.join(dir, shared)).ino).toBe(before.ino);
    }
  });

  it.runIf(isLinux)(
    'replaces a record left by an earlier process that had this PID',
    async () => {
      const token = readProcStartToken(process.pid)!;
      const [boot, ticks] = token.split(':');
      plant(`${process.pid}.json`, {
        ...ownRecord({ sessionId: 'predecessor' }),
        procStart: `${boot}:${Number(ticks) + 1}`,
      });
      const written = await writeOwnRecord(dir, ownRecord());
      expect(path.basename(written)).toBe(`${process.pid}.json`);
    },
  );

  it('replaces a torn file at the PID-keyed name', async () => {
    plant(`${process.pid}.json`, '{"schemaVersion":1,"pid"');
    const written = await writeOwnRecord(dir, ownRecord());
    expect(path.basename(written)).toBe(`${process.pid}.json`);
  });
});

describe('removeOwnRecord', () => {
  it('removes only the record for its own session id', async () => {
    const written = await writeOwnRecord(dir, ownRecord());
    await removeOwnRecord(written, 'someone-else');
    expect(fs.existsSync(written)).toBe(true);
    removeOwnRecordSync(written, 'someone-else');
    expect(fs.existsSync(written)).toBe(true);
    await removeOwnRecord(written, 'own');
    expect(fs.existsSync(written)).toBe(false);
    await expect(removeOwnRecord(written, 'own')).resolves.toBeUndefined();
  });
});

describe('readLiveSessionRecords', () => {
  it('lists live records newest first, and deletes nothing it skips', async () => {
    const dead = 2 ** 22 + 7;
    await writeOwnRecord(dir, ownRecord({ sessionId: 'older', startedAt: 1 }));
    await writeOwnRecord(dir, ownRecord({ sessionId: 'newer', startedAt: 2 }));
    plant('999999.json', ownRecord({ sessionId: 'name-mismatch' }));
    plant(`00${process.pid}.json`, ownRecord({ sessionId: 'padded' }));
    plant('2026-notes.json', ownRecord({ sessionId: 'notes', pid: 2026 }));
    plant(`${dead}.json`, {
      ...ownRecord({ sessionId: 'dead', pid: dead }),
      procStart: null,
    });
    plant(`${process.pid}-aaaaaaaa.json`, {
      ...ownRecord({ sessionId: 'other-namespace' }),
      pidNs: -1,
    });
    plant(`${process.pid}-bbbbbbbb.json`, {
      ...ownRecord({ sessionId: 'newer-schema' }),
      schemaVersion: 2,
    });
    plant(
      `${process.pid}-cccccccc.json`,
      JSON.stringify({
        ...ownRecord({ sessionId: 'huge' }),
        pad: 'x'.repeat(70_000),
      }),
    );
    if (isLinux) {
      plant(`${process.pid}-dddddddd.json`, {
        ...ownRecord({ sessionId: 'other-boot' }),
        procStart: `not-${readLocalBootId()}:1`,
      });
    }
    const before = fs.readdirSync(dir).sort();

    const live = await readLiveSessionRecords(dir);

    expect(live.map((r) => r.sessionId)).toEqual(['newer', 'older']);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('drops a malformed kind and an empty inbox, and keeps a kind it does not know', async () => {
    plant(`${process.pid}-11111111.json`, {
      ...ownRecord({ sessionId: 'bad-kind' }),
      kind: 'Not A Kind',
      ipcPath: '',
      ipcToken: '',
    });
    plant(`${process.pid}-22222222.json`, {
      ...ownRecord({ sessionId: 'future-kind' }),
      kind: 'voice-relay',
    });
    const live = await readLiveSessionRecords(dir);
    const bad = live.find((r) => r.sessionId === 'bad-kind')!;
    expect(bad).not.toHaveProperty('kind');
    expect(bad).not.toHaveProperty('ipcPath');
    expect(bad).not.toHaveProperty('ipcToken');
    expect(live.find((r) => r.sessionId === 'future-kind')?.kind).toBe(
      'voice-relay',
    );
  });

  it('reads a missing directory as nobody', async () => {
    await expect(readLiveSessionRecords(dir)).resolves.toEqual([]);
  });
});

describe('resolveQwenHome', () => {
  const saved = process.env['QWEN_HOME'];
  afterEach(() => {
    if (saved === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = saved;
  });

  it('prefers an explicit home, then QWEN_HOME, then ~/.qwen', () => {
    process.env['QWEN_HOME'] = '/from/env';
    expect(resolveQwenHome('/explicit')).toBe(path.resolve('/explicit'));
    expect(resolveQwenHome()).toBe(path.resolve('/from/env'));
    delete process.env['QWEN_HOME'];
    expect(resolveQwenHome()).toBe(path.join(os.homedir(), '.qwen'));
  });

  it('expands a leading ~ and resolves a relative path against the working directory', () => {
    expect(resolveQwenHome('~/alt/home')).toBe(
      path.join(os.homedir(), 'alt', 'home'),
    );
    expect(resolveQwenHome('rel/home')).toBe(path.resolve('rel/home'));
  });
});
