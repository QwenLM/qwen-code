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
});
