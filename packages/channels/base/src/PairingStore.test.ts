import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PairingStore } from './PairingStore.js';
import type { CreatePairingRequestResult } from './PairingStore.js';
import { getWorkspaceScopeDirName } from './paths.js';

function codeOf(result: CreatePairingRequestResult): string {
  if ('code' in result) return result.code;
  throw new Error(
    `expected a pairing code, got rejection "${result.rejected}"`,
  );
}

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

    const result = storeA.createRequest('sender-1', 'Sender One');
    expect(result).toEqual({ code: expect.any(String) });

    expect(storeA.listPending()).toHaveLength(1);
    expect(storeB.listPending()).toHaveLength(0);
  });

  it('isolates allowlists: approval in one workspace does not approve in another', () => {
    const storeA = new PairingStore('support-bot', workspaceA);
    const storeB = new PairingStore('support-bot', workspaceB);

    const code = codeOf(storeA.createRequest('sender-1', 'Sender One'));
    const approved = storeA.approve(code);
    expect(approved?.senderId).toBe('sender-1');

    expect(storeA.isApproved('sender-1')).toBe(true);
    expect(storeB.isApproved('sender-1')).toBe(false);
  });

  it('approves a group without approving the member who requested it', () => {
    const store = new PairingStore('support-bot', workspaceA);
    const result = store.createGroupRequest(
      'group-1',
      'Release Team',
      'sender-1',
      'Alice',
    );

    expect(result).toEqual({ code: expect.any(String) });
    expect(store.listPending()).toEqual([
      expect.objectContaining({
        senderId: 'sender-1',
        senderName: 'Alice',
        subject: {
          type: 'group',
          id: 'group-1',
          name: 'Release Team',
        },
      }),
    ]);

    store.approve(codeOf(result));

    expect(store.isGroupApproved('group-1')).toBe(true);
    expect(store.isApproved('group-1')).toBe(false);
    expect(store.revoke('group-1')).toBe(false);
    expect(store.isApproved('sender-1')).toBe(false);
  });

  it('reuses one pending request per group regardless of the initiating sender', () => {
    const store = new PairingStore('support-bot', workspaceA);

    const first = store.createGroupRequest(
      'group-1',
      'Release Team',
      'alice',
      'Alice',
    );
    const second = store.createGroupRequest(
      'group-1',
      'Release Team',
      'bob',
      'Bob',
    );

    expect(first).toEqual({ code: expect.any(String) });
    expect(second).toEqual(first);
    expect(store.listPending()).toEqual([
      expect.objectContaining({
        senderId: 'alice',
        senderName: 'Alice',
        subject: { type: 'group', id: 'group-1', name: 'Release Team' },
        code: codeOf(first),
      }),
    ]);
  });

  it('limits each sender to one pending request across subjects', () => {
    const store = new PairingStore('support-bot', workspaceA);

    const first = store.createGroupRequest(
      'group-1',
      'Release Team',
      'alice',
      'Alice',
    );
    expect(first).toEqual({ code: expect.any(String) });

    // Same sender, different subjects: no additional slots.
    expect(
      store.createGroupRequest('group-2', 'Platform Team', 'alice', 'Alice'),
    ).toEqual({ rejected: 'sender_pending' });
    expect(store.createRequest('alice', 'Alice')).toEqual({
      rejected: 'sender_pending',
    });

    // Re-mentioning the same subject still returns its existing code.
    expect(
      store.createGroupRequest('group-1', 'Release Team', 'alice', 'Alice'),
    ).toEqual(first);

    // Other senders are unaffected until the shared cap (3) is reached.
    expect(
      store.createGroupRequest('group-2', 'Platform Team', 'bob', 'Bob'),
    ).toEqual({ code: expect.any(String) });
    expect(store.createRequest('carol', 'Carol')).toEqual({
      code: expect.any(String),
    });
    expect(store.createRequest('dave', 'Dave')).toEqual({
      rejected: 'cap_reached',
    });
  });

  it('frees the sender slot once their pending request is approved', () => {
    const store = new PairingStore('support-bot', workspaceA);
    const code = codeOf(
      store.createGroupRequest('group-1', 'Release Team', 'alice', 'Alice'),
    );

    expect(store.createRequest('alice', 'Alice')).toEqual({
      rejected: 'sender_pending',
    });

    store.approve(code);

    expect(store.createRequest('alice', 'Alice')).toEqual({
      code: expect.any(String),
    });
  });

  it('isolates group approvals and revocation by workspace', () => {
    const storeA = new PairingStore('support-bot', workspaceA);
    const storeB = new PairingStore('support-bot', workspaceB);

    for (const store of [storeA, storeB]) {
      const code = codeOf(
        store.createGroupRequest(
          'group-1',
          'Release Team',
          'sender-1',
          'Alice',
        ),
      );
      store.approve(code);
    }

    expect(storeA.revokeGroup('group-1')).toBe(true);
    expect(storeA.isGroupApproved('group-1')).toBe(false);
    expect(storeB.isGroupApproved('group-1')).toBe(true);
  });

  it('keeps group approvals separate from similarly named channel user approvals', () => {
    const groupStore = new PairingStore('support', workspaceA);
    const userStore = new PairingStore('support-group', workspaceA);
    const code = codeOf(
      groupStore.createGroupRequest(
        'shared-id',
        'Release Team',
        'sender-1',
        'Alice',
      ),
    );

    groupStore.approve(code);

    expect(groupStore.isGroupApproved('shared-id')).toBe(true);
    expect(userStore.isApproved('shared-id')).toBe(false);
    expect(userStore.revoke('shared-id')).toBe(false);
    expect(groupStore.isGroupApproved('shared-id')).toBe(true);
  });

  it('revokes an approved sender only from the selected workspace', () => {
    const storeA = new PairingStore('support-bot', workspaceA);
    const storeB = new PairingStore('support-bot', workspaceB);

    for (const store of [storeA, storeB]) {
      const code = codeOf(store.createRequest('sender-1', 'Sender One'));
      store.approve(code);
    }

    expect(storeA.revoke('sender-1')).toBe(true);
    expect(storeA.isApproved('sender-1')).toBe(false);
    expect(storeB.isApproved('sender-1')).toBe(true);
  });

  it('keeps path-traversal channel names inside the workspace scope', () => {
    // Channel names come from unrestricted config keys. Without encoding,
    // `../support` climbs out of the scope directory and both workspaces
    // share one file at the channels root — silently undoing the isolation.
    const storeA = new PairingStore('../support', workspaceA);
    const code = codeOf(storeA.createRequest('mallory', 'Mallory'));
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

    const result = store.createRequest('sender-1', 'Sender One');
    expect(result).toEqual({ code: expect.any(String) });
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
    const code = codeOf(store.createRequest('sender-1', 'Sender One'));
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

    it('copies the legacy group allowlist into the scoped store', () => {
      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'support-bot-groups.json'),
        JSON.stringify(['legacy-group']),
      );
      const store = new PairingStore('support-bot', workspaceA);

      expect(store.isGroupApproved('legacy-group')).toBe(true);
    });

    it('copies legacy global state into the scoped store once', () => {
      seedLegacy();
      const store = new PairingStore('support-bot', workspaceA);

      expect(store.isApproved('legacy-sender')).toBe(true);
      expect(store.listPending().map((r) => r.senderId)).toEqual([
        'pending-sender',
      ]);
    });

    it('approves a legacy pending request as a user request', () => {
      seedLegacy();
      const store = new PairingStore('support-bot', workspaceA);

      const approved = store.approve('ABCDEFGH');

      expect(approved?.subject).toEqual({
        type: 'user',
        id: 'pending-sender',
        name: 'Pending',
      });
      expect(store.isApproved('pending-sender')).toBe(true);
      expect(store.getGroupAllowlist()).toEqual([]);
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

      const code = codeOf(storeA.createRequest('new-sender', 'New Sender'));
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

    it('does not mutate the legacy baseline when revoking in one workspace', () => {
      seedLegacy();
      const storeA = new PairingStore('support-bot', workspaceA);

      expect(storeA.revoke('legacy-sender')).toBe(true);
      expect(storeA.isApproved('legacy-sender')).toBe(false);

      const storeB = new PairingStore('support-bot', workspaceB);
      expect(storeB.isApproved('legacy-sender')).toBe(true);
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
      const result = store.createRequest('new-sender', 'New');
      expect(result).toEqual({ code: expect.any(String) });
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

    it('migrates legacy files written under a raw channel name that encodes differently', () => {
      // Pre-scoping code wrote legacy files under the RAW name; the encoded
      // name is only for scoped destinations. A name with a space must still
      // find its legacy state.
      fs.mkdirSync(channelsRoot(), { recursive: true });
      fs.writeFileSync(
        path.join(channelsRoot(), 'my channel-allowlist.json'),
        JSON.stringify(['spaced-sender']),
      );
      const store = new PairingStore('my channel', workspaceA);
      expect(store.isApproved('spaced-sender')).toBe(true);
    });

    it('retries a partially failed migration instead of locking in incomplete state', () => {
      // First run: pairing file copies, allowlist copy fails (directory
      // masquerading as the file). The sentinel must NOT be written, so a
      // later construction — after the operator fixes the file — completes
      // the migration instead of silently dropping approved senders.
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
      const badAllowlist = path.join(
        channelsRoot(),
        'support-bot-allowlist.json',
      );
      fs.mkdirSync(badAllowlist, { recursive: true });

      const first = new PairingStore('support-bot', workspaceA);
      expect(first.listPending().map((r) => r.senderId)).toEqual([
        'pending-sender',
      ]);
      expect(first.isApproved('legacy-sender')).toBe(false);

      // Operator repairs the legacy allowlist; the next construction picks
      // it up because the gate never closed.
      fs.rmdirSync(badAllowlist);
      fs.writeFileSync(badAllowlist, JSON.stringify(['legacy-sender']));
      const second = new PairingStore('support-bot', workspaceA);
      expect(second.isApproved('legacy-sender')).toBe(true);
    });

    it('never overwrites existing scoped state with legacy content', () => {
      const store = new PairingStore('support-bot', workspaceA);
      const code = codeOf(store.createRequest('scoped-sender', 'Scoped'));
      store.approve(code);

      seedLegacy();
      const reopened = new PairingStore('support-bot', workspaceA);
      expect(reopened.isApproved('scoped-sender')).toBe(true);
      expect(reopened.isApproved('legacy-sender')).toBe(false);
    });
  });
});

describe('group allowlist durability', () => {
  let qwenHome: string;
  let workspace: string;
  let prevQwenHome: string | undefined;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-ws-'));
    prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    if (prevQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = prevQwenHome;
    }
    for (const dir of [qwenHome, workspace]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const groupsPath = () =>
    path.join(
      qwenHome,
      'channels',
      getWorkspaceScopeDirName(workspace),
      'support-bot-groups.json',
    );

  it('refuses to rebuild an unreadable group allowlist on approve', () => {
    const store = new PairingStore('support-bot', workspace);
    const code = codeOf(
      store.createGroupRequest('group-a', 'Group A', 'sender-1', 'Alice'),
    );
    fs.mkdirSync(path.dirname(groupsPath()), { recursive: true });
    fs.writeFileSync(groupsPath(), '["group-b", "group-c"'); // torn JSON

    expect(() => store.approve(code)).toThrow(/unreadable group allowlist/);

    // The pending request must survive the failed approve so the code stays
    // usable, and the corrupt file must be left untouched for the operator.
    expect(store.listPending()).toHaveLength(1);
    expect(fs.readFileSync(groupsPath(), 'utf-8')).toBe(
      '["group-b", "group-c"',
    );
  });

  it('fails closed and logs when the group allowlist is unreadable', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const store = new PairingStore('support-bot', workspace);
      fs.mkdirSync(path.dirname(groupsPath()), { recursive: true });
      fs.writeFileSync(groupsPath(), 'not json');

      expect(store.isGroupApproved('group-b')).toBe(false);
      expect(store.getGroupAllowlist()).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('group allowlist'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps stored approvals when approving into an existing allowlist', () => {
    const store = new PairingStore('support-bot', workspace);
    fs.mkdirSync(path.dirname(groupsPath()), { recursive: true });
    fs.writeFileSync(groupsPath(), JSON.stringify(['group-b'], null, 2));
    const code = codeOf(
      store.createGroupRequest('group-a', 'Group A', 'sender-1', 'Alice'),
    );

    const approved = store.approve(code);

    expect(approved?.subject.id).toBe('group-a');
    expect(store.getGroupAllowlist()).toEqual(['group-b', 'group-a']);
    // The atomic write must not leave a temp file behind.
    expect(
      fs
        .readdirSync(path.dirname(groupsPath()))
        .filter((name) => name.includes('.tmp')),
    ).toEqual([]);
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
