/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewPermissionBridge,
  type ReviewBridgeDaemon,
  type PermissionRequestData,
} from './reviewPermissionBridge.js';
import type { ReviewPolicy } from './reviewClassifier.js';

function fakeDaemon(frames: Array<{ type: string; data: unknown }>) {
  const votes: Array<{ requestId: string; outcome: unknown }> = [];
  const daemon: ReviewBridgeDaemon = {
    async *subscribeEvents() {
      for (const f of frames) yield f;
    },
    async respondToSessionPermission(_sid, requestId, response) {
      votes.push({ requestId, outcome: response.outcome });
      return true;
    },
  };
  return { daemon, votes };
}

const allowOnce = [
  { optionId: 'ok', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
];

function permFrame(
  requestId: string,
  toolCall: PermissionRequestData['toolCall'],
  options: PermissionRequestData['options'] = allowOnce,
) {
  return {
    type: 'permission_request',
    data: { requestId, sessionId: 's', toolCall, options },
  };
}

describe('ReviewPermissionBridge — baseline vote / escalate', () => {
  it('auto-approves a read call with the allow_once option', async () => {
    const { daemon, votes } = fakeDaemon([
      permFrame('q1', { kind: 'read', rawInput: {} }),
    ]);
    const bridge = new ReviewPermissionBridge({ daemon });
    const policy: ReviewPolicy = {
      autoApprove: true,
      autofix: false,
      comment: false,
      worktreeRoot: null,
    };
    await bridge.open('s', policy);
    await bridge.drain('s');
    expect(votes).toEqual([
      { requestId: 'q1', outcome: { outcome: 'selected', optionId: 'ok' } },
    ]);
  });

  it('escalates an edit call (autofix off): no vote, onEscalate fires', async () => {
    const { daemon, votes } = fakeDaemon([
      permFrame('q2', { kind: 'edit', rawInput: {} }),
    ]);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: false,
      comment: false,
      worktreeRoot: null,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('escalates when no allow_once option is offered', async () => {
    const { daemon, votes } = fakeDaemon([
      permFrame('q3', { kind: 'read', rawInput: {} }, [
        { optionId: 'always', kind: 'allow_always' },
      ]),
    ]);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: false,
      comment: false,
      worktreeRoot: null,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('vote mode (autoApprove false) escalates a read call', async () => {
    const { daemon, votes } = fakeDaemon([
      permFrame('q4', { kind: 'read', rawInput: {} }),
    ]);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: false,
      autofix: false,
      comment: false,
      worktreeRoot: null,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('calls onResume for a non-permission frame', async () => {
    const { daemon, votes } = fakeDaemon([
      { type: 'session_update', data: {} },
    ]);
    const resumed: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onResume: (sid) => resumed.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: false,
      comment: false,
      worktreeRoot: null,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(resumed).toEqual(['s']);
  });
});

describe('ReviewPermissionBridge — Guard 2 realpath edit confinement', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rpb-root-'));
    outside = await mkdtemp(join(tmpdir(), 'rpb-out-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function autofixPolicy(): ReviewPolicy {
    return {
      autoApprove: true,
      autofix: true,
      comment: false,
      worktreeRoot: root,
    };
  }

  async function runEdit(rawInput: Record<string, unknown>) {
    const { daemon, votes } = fakeDaemon([
      permFrame('e1', { kind: 'edit', rawInput }),
    ]);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', autofixPolicy());
    await bridge.drain('s');
    return { votes, escalated };
  }

  it('votes for an in-tree real file', async () => {
    await writeFile(join(root, 'src.ts'), 'x');
    const { votes, escalated } = await runEdit({ file_path: 'src.ts' });
    expect(votes).toEqual([
      { requestId: 'e1', outcome: { outcome: 'selected', optionId: 'ok' } },
    ]);
    expect(escalated).toEqual([]);
  });

  it('votes for a new file whose parent is in-tree', async () => {
    await mkdir(join(root, 'sub'));
    // sub/new.ts does not exist yet; parent `sub` is in-tree.
    const { votes, escalated } = await runEdit({ file_path: 'sub/new.ts' });
    expect(votes).toEqual([
      { requestId: 'e1', outcome: { outcome: 'selected', optionId: 'ok' } },
    ]);
    expect(escalated).toEqual([]);
  });

  it('ESCALATES an in-tree symlink pointing at an EXISTING file outside the worktree', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'sensitive');
    await symlink(secret, join(root, 'evil')); // evil -> outside/secret.txt
    const { votes, escalated } = await runEdit({ file_path: 'evil' });
    expect(votes).toEqual([]); // NO vote cast
    expect(escalated).toEqual(['s']);
  });

  it('ESCALATES a DANGLING in-tree symlink whose destination does not exist yet', async () => {
    // The dangerous case: write_file would CREATE the destination outside the
    // tree by following the link. realpath(target) throws ENOENT just like a
    // genuine new file — only lstat distinguishes them.
    const dest = join(outside, 'authorized_keys'); // deliberately NOT created
    await symlink(dest, join(root, 'evil'));
    const { votes, escalated } = await runEdit({ file_path: 'evil' });
    expect(votes).toEqual([]); // NO vote cast
    expect(escalated).toEqual(['s']);
  });

  it('ESCALATES a new file under a symlinked directory that escapes the tree', async () => {
    await symlink(outside, join(root, 'linkdir')); // linkdir -> outside
    // linkdir/new.ts is string-inside (relative, no `..`) but its realpath'd
    // parent resolves outside the worktree.
    const { votes, escalated } = await runEdit({ file_path: 'linkdir/new.ts' });
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('ESCALATES when a decoy path field escapes even though the primary is in-tree', async () => {
    await writeFile(join(root, 'src.ts'), 'x');
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'sensitive');
    await symlink(secret, join(root, 'evil'));
    const { votes, escalated } = await runEdit({
      file_path: 'src.ts',
      path: 'evil',
    });
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('ESCALATES when the worktree root itself cannot be realpath-resolved', async () => {
    const { daemon, votes } = fakeDaemon([
      permFrame('e1', { kind: 'edit', rawInput: { file_path: 'src.ts' } }),
    ]);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: true,
      comment: false,
      worktreeRoot: join(root, 'does-not-exist'),
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });
});
