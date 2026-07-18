import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PairingStore } from './PairingStore.js';
import { getWorkspaceScopeDirName } from './paths.js';

describe('PairingStore workspace scoping (#7017)', () => {
  let qwenHome: string;
  let workspaceA: string;
  let workspaceB: string;
  let prevQwenHome: string | undefined;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-home-'));
    workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-ws-a-'));
    workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-ws-b-'));
    prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    if (prevQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = prevQwenHome;
    }
    for (const dir of [qwenHome, workspaceA, workspaceB]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const channelsRoot = () => path.join(qwenHome, 'channels');

  it('isolates pending requests between workspaces using the same channel name', () => {
    const storeA = new PairingStore('support-bot', workspaceA);
    const storeB = new PairingStore('support-bot', workspaceB);

    const code = storeA.createRequest('sender-1', 'Sender One');
    expect(code).toBeTruthy();

    expect(storeA.listPending()).toHaveLength(1);
    expect(storeB.listPending()).toHaveLength(0);
  });

  it('isolates allowlists: approval in one workspace does not approve in another', () => {
    const storeA = new PairingStore('support-bot', workspaceA);
    const storeB = new PairingStore('support-bot', workspaceB);

    const code = storeA.createRequest('sender-1', 'Sender One')!;
    const approved = storeA.approve(code);
    expect(approved?.senderId).toBe('sender-1');

    expect(storeA.isApproved('sender-1')).toBe(true);
    expect(storeB.isApproved('sender-1')).toBe(false);
  });

  it('keeps path-traversal channel names inside the workspace scope', () => {
    // Channel names come from unrestricted config keys. Without encoding,
    // `../support` climbs out of the scope directory and both workspaces
    // share one file at the channels root — silently undoing the isolation.
    const storeA = new PairingStore('../support', workspaceA);
    const code = storeA.createRequest('mallory', 'Mallory')!;
    storeA.approve(code);

    const storeB = new PairingStore('../support', workspaceB);
    expect(storeB.isApproved('mallory')).toBe(false);

    // Nothing may leak to the channels root.
    const rootFiles = fs
      .readdirSync(channelsRoot())
      .filter((f) => f.endsWith('.json'));
    expect(rootFiles).toEqual([]);
  });

  it('maps equivalent spellings of the same workspace to the same store', () => {
    const store = new PairingStore('support-bot', workspaceA);
    const sameViaRelativeHop = new PairingStore(
      'support-bot',
      path.join(workspaceA, 'sub', '..'),
    );

    const code = store.createRequest('sender-1', 'Sender One');
    expect(code).toBeTruthy();
    expect(sameViaRelativeHop.listPending()).toHaveLength(1);
  });

  it('writes scoped files under channels/<workspace-scope>/, not the global dir', () => {
    const store = new PairingStore('support-bot', workspaceA);
    store.createRequest('sender-1', 'Sender One');

    const scopeDir = path.join(
      channelsRoot(),
      getWorkspaceScopeDirName(workspaceA),
    );
    expect(fs.existsSync(path.join(scopeDir, 'support-bot-pairing.json'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(channelsRoot(), 'support-bot-pairing.json')),
    ).toBe(false);
  });

  it('keeps the legacy global layout when no workspace is given', () => {
    const store = new PairingStore('support-bot');
    const code = store.createRequest('sender-1', 'Sender One')!;
    store.approve(code);

    expect(
      fs.existsSync(path.join(channelsRoot(), 'support-bot-allowlist.json')),
    ).toBe(true);
  });

  describe('legacy migration (grandfathering)', () => {
    const seedLegacy = () => {
      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-allowlist.json'),
        JSON.stringify(['legacy-sender']),
      );
      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-pairing.json'),
        JSON.stringify([
          {
            senderId: 'pending-sender',
            senderName: 'Pending',
            code: 'ABCDEFGH',
            createdAt: Date.now(),
          },
        ]),
      );
    };

    it('copies legacy global state into the scoped store once', () => {
      seedLegacy();
      const store = new PairingStore('support-bot', workspaceA);

      expect(store.isApproved('legacy-sender')).toBe(true);
      expect(store.listPending().map((r) => r.senderId)).toEqual([
        'pending-sender',
      ]);
    });

    it('lets every workspace grandfather the same legacy baseline (copy, not move)', () => {
      seedLegacy();
      const storeA = new PairingStore('support-bot', workspaceA);
      const storeB = new PairingStore('support-bot', workspaceB);

      expect(storeA.isApproved('legacy-sender')).toBe(true);
      expect(storeB.isApproved('legacy-sender')).toBe(true);
      expect(
        fs.existsSync(path.join(channelsRoot(), 'support-bot-allowlist.json')),
      ).toBe(true);
    });

    it('diverges after migration: post-migration approvals stay per-workspace', () => {
      seedLegacy();
      const storeA = new PairingStore('support-bot', workspaceA);
      const storeB = new PairingStore('support-bot', workspaceB);

      const code = storeA.createRequest('new-sender', 'New Sender')!;
      storeA.approve(code);

      expect(storeA.isApproved('new-sender')).toBe(true);
      expect(storeB.isApproved('new-sender')).toBe(false);
      // The legacy global file is left untouched by scoped writes.
      const legacy = JSON.parse(
        fs.readFileSync(
          path.join(channelsRoot(), 'support-bot-allowlist.json'),
          'utf-8',
        ),
      ) as string[];
      expect(legacy).toEqual(['legacy-sender']);
    });

    it('does not resurrect senders revoked by deleting the scoped allowlist file', () => {
      seedLegacy();
      const store = new PairingStore('support-bot', workspaceA);
      expect(store.isApproved('legacy-sender')).toBe(true);

      // Operator "revokes" by deleting the scoped allowlist file. The scope
      // directory itself remains, which marks the migration as done — the
      // legacy allowlist must not be copied back in on the next start.
      const scopedDir = path.join(
        channelsRoot(),
        getWorkspaceScopeDirName(workspaceA),
      );
      fs.rmSync(path.join(scopedDir, 'support-bot-allowlist.json'));

      const reopened = new PairingStore('support-bot', workspaceA);
      expect(reopened.isApproved('legacy-sender')).toBe(false);
    });

    it('does not absorb a legacy file that appears after the scope is in use', () => {
      // Scope comes into existence with only a pending file in the legacy
      // layout — the allowlist shows up later (e.g. written by an older
      // version still running). An in-use scope must not import it.
      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-pairing.json'),
        JSON.stringify([
          {
            senderId: 'pending-sender',
            senderName: 'Pending',
            code: 'ABCDEFGH',
            createdAt: Date.now(),
          },
        ]),
      );
      const store = new PairingStore('support-bot', workspaceA);
      expect(store.listPending().map((r) => r.senderId)).toEqual([
        'pending-sender',
      ]);

      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-allowlist.json'),
        JSON.stringify(['late-legacy-sender']),
      );
      const reopened = new PairingStore('support-bot', workspaceA);
      expect(reopened.isApproved('late-legacy-sender')).toBe(false);
    });

    it('closes the migration gate even when no legacy files existed at first startup', () => {
      // Rolling upgrade: this workspace first runs on new code before any
      // legacy state exists; an older version writes the global files later.
      // The first construction must still mark the migration as done so the
      // late legacy allowlist is not absorbed afterwards.
      const first = new PairingStore('support-bot', workspaceA);
      expect(first.isApproved('legacy-sender')).toBe(false);

      seedLegacy();
      const reopened = new PairingStore('support-bot', workspaceA);
      expect(reopened.isApproved('legacy-sender')).toBe(false);
      expect(reopened.listPending()).toEqual([]);
    });

    it('starts empty and does not throw when a legacy file is unreadable', () => {
      // A directory masquerading as the legacy allowlist file makes
      // copyFileSync throw — the constructor must stay best-effort.
      fs.mkdirSync(path.join(channelsRoot(), 'support-bot-allowlist.json'), {
        recursive: true,
      });
      const store = new PairingStore('support-bot', workspaceA);
      expect(store.isApproved('anyone')).toBe(false);
      const code = store.createRequest('new-sender', 'New')!;
      expect(typeof code).toBe('string');
    });

    it('migrates every channel of a workspace, not only the first one constructed', () => {
      // One process starts several channels in turn (channel start supports
      // this); a directory-level gate would let only the first migrate.
      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'chan-a-allowlist.json'),
        JSON.stringify(['sender-a']),
      );
      fs.writeFileSync(
        path.join(channelsRoot(), 'chan-b-allowlist.json'),
        JSON.stringify(['sender-b']),
      );

      const storeA = new PairingStore('chan-a', workspaceA);
      const storeB = new PairingStore('chan-b', workspaceA);
      expect(storeA.isApproved('sender-a')).toBe(true);
      expect(storeB.isApproved('sender-b')).toBe(true);
    });

    it('migrates a channel whose legacy file appears after another channel initialized the scope', () => {
      // chan-a runs first with no legacy state; chan-b's legacy allowlist
      // exists when chan-b starts later in the same (now existing) scope dir.
      const storeA = new PairingStore('chan-a', workspaceA);
      expect(storeA.isApproved('anyone')).toBe(false);

      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'chan-b-allowlist.json'),
        JSON.stringify(['sender-b']),
      );
      const storeB = new PairingStore('chan-b', workspaceA);
      expect(storeB.isApproved('sender-b')).toBe(true);
    });

    it('still migrates the allowlist when the legacy pairing file is unreadable', () => {
      fs.mkdirSync(channelsRoot(), { recursive: true });
      // Directory masquerading as the pairing file makes its copy throw.
      fs.mkdirSync(path.join(channelsRoot(), 'support-bot-pairing.json'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-allowlist.json'),
        JSON.stringify(['legacy-sender']),
      );

      const store = new PairingStore('support-bot', workspaceA);
      expect(store.isApproved('legacy-sender')).toBe(true);
    });

    it('never overwrites existing scoped state with legacy content', () => {
      const store = new PairingStore('support-bot', workspaceA);
      const code = store.createRequest('scoped-sender', 'Scoped')!;
      store.approve(code);

      seedLegacy();
      const reopened = new PairingStore('support-bot', workspaceA);
      expect(reopened.isApproved('scoped-sender')).toBe(true);
      expect(reopened.isApproved('legacy-sender')).toBe(false);
    });
  });
});

describe('getWorkspaceScopeDirName', () => {
  it('is stable for a given path and unique across paths', () => {
    const a = getWorkspaceScopeDirName('/projects/app');
    expect(getWorkspaceScopeDirName('/projects/app')).toBe(a);
    expect(getWorkspaceScopeDirName('/other/app')).not.toBe(a);
  });

  it('keeps a recognizable basename and sanitizes unsafe characters', () => {
    const scope = getWorkspaceScopeDirName('/projects/my app!');
    expect(scope.startsWith('my_app_-')).toBe(true);
    expect(scope).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});
