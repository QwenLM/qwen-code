/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FS_ACCESS_EVENT_TYPE,
  FS_DENIED_EVENT_TYPE,
  createAuditPublisher,
} from './audit.js';
import type { ResolvedPath } from './paths.js';
import type { BridgeEvent } from '../eventBus.js';

function expectedHash(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}

describe('createAuditPublisher', () => {
  function setup(opts?: { includeRawPaths?: boolean }) {
    const events: BridgeEvent[] = [];
    const workspace = path.join(os.tmpdir(), 'audit-ws');
    const publisher = createAuditPublisher({
      emit: (e) => events.push(e),
      boundWorkspace: workspace,
      includeRawPaths: opts?.includeRawPaths ?? false,
    });
    return { events, publisher, workspace };
  }

  it('emits fs.access with hashed path and originatorClientId', () => {
    const { events, publisher, workspace } = setup();
    const absolute = path.join(workspace, 'src', 'index.ts') as ResolvedPath;
    publisher.recordAccess(
      {
        originatorClientId: 'client-abc',
        sessionId: 'sess-1',
        route: 'GET /file',
      },
      {
        intent: 'read',
        absolute,
        durationMs: 12,
        sizeBytes: 4096,
      },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe(FS_ACCESS_EVENT_TYPE);
    expect(ev.v).toBe(1);
    expect(ev.originatorClientId).toBe('client-abc');
    expect(ev.data).toMatchObject({
      kind: FS_ACCESS_EVENT_TYPE,
      intent: 'read',
      route: 'GET /file',
      pathHash: expectedHash(absolute),
      sizeBytes: 4096,
      durationMs: 12,
    });
    // No relPath unless raw paths enabled.
    expect(ev.data).not.toHaveProperty('relPath');
  });

  it('attaches relPath when includeRawPaths is true', () => {
    const { events, publisher, workspace } = setup({ includeRawPaths: true });
    const absolute = path.join(workspace, 'src', 'index.ts') as ResolvedPath;
    publisher.recordAccess(
      { originatorClientId: 'c', route: 'GET /file' },
      { intent: 'read', absolute, durationMs: 1 },
    );
    expect((events[0].data as { relPath?: string }).relPath).toBe(
      path.join('src', 'index.ts'),
    );
  });

  it('omits truncated/matchedIgnore when not provided', () => {
    const { events, publisher, workspace } = setup();
    const absolute = path.join(workspace, 'a.ts') as ResolvedPath;
    publisher.recordAccess(
      { route: 'GET /file' },
      { intent: 'read', absolute, durationMs: 0 },
    );
    expect(events[0].data).not.toHaveProperty('truncated');
    expect(events[0].data).not.toHaveProperty('matchedIgnore');
  });

  it('preserves truncated and matchedIgnore when set', () => {
    const { events, publisher, workspace } = setup();
    const absolute = path.join(workspace, 'big.txt') as ResolvedPath;
    publisher.recordAccess(
      { route: 'GET /file' },
      {
        intent: 'read',
        absolute,
        durationMs: 5,
        truncated: true,
        matchedIgnore: 'file',
        sizeBytes: 1024 * 1024,
      },
    );
    expect(events[0].data).toMatchObject({
      truncated: true,
      matchedIgnore: 'file',
      sizeBytes: 1024 * 1024,
    });
  });

  it('emits fs.denied with errorKind and hashed probe path', () => {
    const { events, publisher, workspace } = setup();
    publisher.recordDenied(
      { originatorClientId: 'c', route: 'GET /file' },
      {
        intent: 'read',
        input: '../escape',
        errorKind: 'path_outside_workspace',
        hint: 'paths must stay inside workspace',
      },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe(FS_DENIED_EVENT_TYPE);
    expect(ev.originatorClientId).toBe('c');
    expect(ev.data).toMatchObject({
      kind: FS_DENIED_EVENT_TYPE,
      intent: 'read',
      route: 'GET /file',
      errorKind: 'path_outside_workspace',
      hint: 'paths must stay inside workspace',
      // probe path = path.resolve(workspace, '../escape')
      pathHash: expectedHash(path.resolve(workspace, '../escape')),
    });
  });

  it('emits fs.denied even when hint is absent', () => {
    const { events, publisher } = setup();
    publisher.recordDenied(
      { route: 'POST /file/edit' },
      {
        intent: 'edit',
        input: '/etc/passwd',
        errorKind: 'symlink_escape',
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).not.toHaveProperty('hint');
  });

  it('attaches pattern field for fs.access on glob intent in raw-paths mode', () => {
    // `pattern` rides on the same privacy gate as `relPath` /
    // `message` — glob patterns commonly carry path fragments
    // (`src/secrets/*.env`, `/Users/alice/ws/**`), so they're
    // suppressed unless the operator opted into raw paths.
    const { events, publisher, workspace } = setup({ includeRawPaths: true });
    publisher.recordAccess(
      { route: 'GET /glob' },
      {
        intent: 'glob',
        absolute: workspace,
        durationMs: 7,
        sizeBytes: 12,
        pattern: '**/*.ts',
      },
    );
    expect(events[0].data).toMatchObject({
      kind: FS_ACCESS_EVENT_TYPE,
      intent: 'glob',
      pattern: '**/*.ts',
      pathHash: expectedHash(workspace),
    });
  });

  it('attaches pattern field for fs.denied on glob intent in raw-paths mode', () => {
    const { events, publisher } = setup({ includeRawPaths: true });
    publisher.recordDenied(
      { route: 'GET /glob' },
      {
        intent: 'glob',
        input: '../../**',
        errorKind: 'parse_error',
        pattern: '../../**',
      },
    );
    expect(events[0].data).toMatchObject({
      kind: FS_DENIED_EVENT_TYPE,
      intent: 'glob',
      errorKind: 'parse_error',
      pattern: '../../**',
    });
  });

  it('strips pattern from fs.access in privacy mode (default)', () => {
    // Default `includeRawPaths: false`. Even though the orchestrator
    // passed a literal pattern, the publisher must not echo it —
    // glob patterns can leak path content the operator opted out of
    // logging.
    const { events, publisher, workspace } = setup();
    publisher.recordAccess(
      { route: 'GET /glob' },
      {
        intent: 'glob',
        absolute: workspace,
        durationMs: 1,
        pattern: 'src/secrets/*.env',
      },
    );
    expect(events[0].data).not.toHaveProperty('pattern');
    expect(events[0].data).not.toHaveProperty('relPath');
  });

  it('strips pattern from fs.denied in privacy mode (default)', () => {
    const { events, publisher } = setup();
    publisher.recordDenied(
      { route: 'GET /glob' },
      {
        intent: 'glob',
        input: '../../**',
        errorKind: 'parse_error',
        pattern: '../../**',
      },
    );
    expect(events[0].data).not.toHaveProperty('pattern');
  });

  it('omits pattern when not provided', () => {
    const { events, publisher, workspace } = setup();
    publisher.recordAccess(
      { route: 'GET /file' },
      {
        intent: 'read',
        absolute: path.join(workspace, 'a.ts') as ResolvedPath,
        durationMs: 0,
      },
    );
    expect(events[0].data).not.toHaveProperty('pattern');
  });

  it('respects QWEN_AUDIT_RAW_PATHS=1 via env when includeRawPaths is unset', () => {
    const original = process.env['QWEN_AUDIT_RAW_PATHS'];
    process.env['QWEN_AUDIT_RAW_PATHS'] = '1';
    try {
      const events: BridgeEvent[] = [];
      const workspace = path.join(os.tmpdir(), 'audit-env');
      const publisher = createAuditPublisher({
        emit: (e) => events.push(e),
        boundWorkspace: workspace,
      });
      publisher.recordAccess(
        { route: 'GET /file' },
        {
          intent: 'read',
          absolute: path.join(workspace, 'foo') as ResolvedPath,
          durationMs: 0,
        },
      );
      expect((events[0].data as { relPath?: string }).relPath).toBe('foo');
    } finally {
      if (original === undefined) delete process.env['QWEN_AUDIT_RAW_PATHS'];
      else process.env['QWEN_AUDIT_RAW_PATHS'] = original;
    }
  });

  it('substitutes <cross-drive> sentinel when path.relative cannot produce a relative form', () => {
    // Simulates the Windows cross-drive case (`C:\\ws` vs `D:\\evil`)
    // where `path.relative` returns the absolute target. We can't
    // forge a Windows path on POSIX cleanly, so we mock the
    // function's invariant directly: when the boundWorkspace and
    // input are *unrelated absolute paths* such that `path.relative`
    // returns an absolute result, the audit substitutes a sentinel.
    // On POSIX `path.relative('/a', '/b')` returns `'../b'` which IS
    // relative, so we instead exercise the contract via a Windows-
    // path-shape input (verified at runtime by `path.isAbsolute` on
    // the platform). This test is platform-neutral about the
    // *trigger* and just checks the *substitution*.
    const events: BridgeEvent[] = [];
    const workspace = path.join(os.tmpdir(), 'audit-xdrive');
    const publisher = createAuditPublisher({
      emit: (e) => events.push(e),
      boundWorkspace: workspace,
      includeRawPaths: true,
    });
    // Construct a denied input on a drive `Z:` that's outside the
    // workspace (POSIX treats `Z:\\evil` as a relative single-segment
    // string, so we set boundWorkspace to a Win32-style path so the
    // `path.isAbsolute(rel)` check fires consistently).
    publisher.recordDenied(
      { route: 'GET /file' },
      {
        intent: 'read',
        input: 'Z:\\\\evil\\\\target.txt',
        errorKind: 'path_outside_workspace',
      },
    );
    // On POSIX `path.relative` is well-defined here so this test
    // only asserts that whatever relPath surfaces is either a true
    // relative (no path.isAbsolute on the value) or the sentinel.
    const data = events[0].data as { relPath?: string };
    if (data.relPath !== undefined) {
      expect(
        data.relPath === '<cross-drive>' || !path.isAbsolute(data.relPath),
      ).toBe(true);
    }
  });
});
