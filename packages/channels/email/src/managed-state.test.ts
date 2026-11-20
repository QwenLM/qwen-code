import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedEmailStateStore,
  validManagedState,
  type ManagedEmailState,
} from './managed-state.js';
import type { EmailSettings } from './config.js';

const settings = {
  address: 'agent@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapUser: 'agent',
  imapPassword: 'secret',
  folder: 'INBOX',
  smtpHost: 'smtp.example.com',
  smtpUser: 'agent',
  smtpPassword: 'secret',
  allowedUsers: ['alice@example.com'],
  privatePolicy: 'allowlist',
  pollInterval: 5,
} as unknown as EmailSettings;

function freshState(): ManagedEmailState {
  return {
    version: 1,
    uidValidity: '1',
    generation: 1,
    lastUid: 0,
    pending: [],
    outbound: [],
    recent: [],
    routes: [],
  };
}

function pendingState(uid: number, eventId: string): ManagedEmailState {
  return {
    ...freshState(),
    lastUid: uid,
    pending: [{ uid, eventId }],
  };
}

const tempDirs: string[] = [];
function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-email-store-'));
  tempDirs.push(dir);
  return dir;
}
beforeEach(() => {
  vi.stubEnv('QWEN_HOME', tempCwd());
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('ManagedEmailStateStore registration-identity keying', () => {
  it('keys the ledger file by identity under the shared mailbox directory', () => {
    const cwd = tempCwd();
    const a = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    const b = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-b|chan|actor|ws|.',
    );
    // Same mailbox -> same (Legacy-shared) lock directory; different
    // registration -> different ledger file beneath it.
    expect(a.directory).toBe(b.directory);
    expect(a.file).not.toBe(b.file);
    expect(dirname(a.file)).toBe(a.directory);
    expect(basename(a.file)).toMatch(/^managed-state-[0-9a-f]{16}\.json$/);
  });

  it('a destination change never loads one registration pending under another', () => {
    const cwd = tempCwd();
    const a = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    const b = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-b|chan|actor|ws|.',
    );
    a.save(pendingState(5, '1:5'));
    expect(a.load()?.pending[0]?.eventId).toBe('1:5');
    expect(b.load()).toBeUndefined();
  });

  it('a workspace change within one tenant isolates the ledger', () => {
    const cwd = tempCwd();
    const a = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    const c = new ManagedEmailStateStore(
      'mail',
      cwd,
      settings,
      'cp|tenant-a|chan|actor|ws-2|.',
    );
    a.save(pendingState(5, '1:5'));
    expect(c.file).not.toBe(a.file);
    expect(c.load()).toBeUndefined();
  });

  it('load() names the file and keeps the cause for an unreadable ledger', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    // A directory at the ledger path is unreadable (EISDIR), not invalid JSON.
    mkdirSync(store.file);
    expect(() => store.load()).toThrow(/could not be read/);
    expect(() => store.load()).toThrow(store.file);
  });

  it('load() distinguishes invalid JSON from an invalid state', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(store.file, '{not json');
    expect(() => store.load()).toThrow(/not valid JSON/);
    writeFileSync(store.file, JSON.stringify({ version: 1 }));
    expect(() => store.load()).toThrow(/is invalid/);
  });

  it('reports a stranded legacy ledger with counts and does not adopt it', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify({
        ...pendingState(5, '1:5'),
        outbound: [{ deliveryId: 'd-0', ordinal: 0, messageId: '<m@x>' }],
      }),
    );
    const stranded = store.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.path).toBe(join(store.directory, 'managed-state.json'));
    expect(stranded!.pending).toBe(1);
    expect(stranded!.outbound).toBe(1);
    expect(stranded!.readable).toBe(true);
    expect(store.load()).toBeUndefined();
  });

  it('a quiescent 0/0 legacy is readable with zero counts', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify(freshState()),
    );
    const stranded = store.strandedLegacyLedger()!;
    expect(stranded.pending).toBe(0);
    expect(stranded.outbound).toBe(0);
    expect(stranded.readable).toBe(true);
  });

  it('a corrupt legacy is flagged unreadable, not a loss-free empty', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(join(store.directory, 'managed-state.json'), '{not json');
    const stranded = store.strandedLegacyLedger()!;
    expect(stranded.readable).toBe(false);
    expect(stranded.pending).toBe(0);
    expect(stranded.outbound).toBe(0);
  });

  it('still reports a legacy staged after a rollback (keyed ledger exists)', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    store.save(freshState());
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify(pendingState(7, '1:7')),
    );
    const stranded = store.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.pending).toBe(1);
    expect(store.load()).toEqual(freshState());
  });

  it('archives the legacy by rename, never deletes, and stops re-reporting it', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const legacyPath = join(store.directory, 'managed-state.json');
    writeFileSync(legacyPath, JSON.stringify(pendingState(5, '1:5')));
    const archived = store.archiveStrandedLegacy();
    expect(archived).toBeDefined();
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(archived!)).toBe(true);
    expect(archived!.startsWith(`${legacyPath}.stranded-`)).toBe(true);
    // The archived claims are preserved for inspection.
    const archivedState = JSON.parse(readFileSync(archived!, 'utf8'));
    expect(archivedState.pending).toHaveLength(1);
    expect(store.strandedLegacyLedger()).toBeUndefined();
    expect(
      readdirSync(store.directory).filter((f) =>
        f.startsWith('managed-state.json.stranded-'),
      ),
    ).toHaveLength(1);
  });

  it('no legacy means nothing to report or archive', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    expect(store.strandedLegacyLedger()).toBeUndefined();
    expect(store.archiveStrandedLegacy()).toBeUndefined();
  });

  it('the saved state round-trips through the validator', () => {
    const store = new ManagedEmailStateStore(
      'mail',
      tempCwd(),
      settings,
      'cp|tenant-a|chan|actor|ws|.',
    );
    const state = pendingState(5, '1:5');
    store.save(state);
    expect(validManagedState(store.load())).toBe(true);
  });
});
