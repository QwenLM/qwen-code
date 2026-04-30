import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSessionHeader, readSessionJsonl } from '../jsonl.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('session jsonl: permission mode normalization', () => {
  it('normalizes canonical permissionMode and previousPermissionMode in header reads', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-header-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
      permissionMode: 'execute',
      previousPermissionMode: 'explore',
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf-8');

    const loadedHeader = readSessionHeader(sessionFile);
    expect(loadedHeader?.permissionMode).toBe('allow-all');
    expect(loadedHeader?.previousPermissionMode).toBe('safe');
  });

  it('normalizes canonical mode values when loading full session', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-full-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 's2',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 1,
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        contextTokens: 0,
        costUsd: 0,
      },
      permissionMode: 'explore',
      previousPermissionMode: 'execute',
    };

    const message = {
      id: 'm1',
      type: 'user',
      content: 'hello',
      timestamp: Date.now(),
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, 'utf-8');

    const loaded = readSessionJsonl(sessionFile);
    expect(loaded?.permissionMode).toBe('safe');
    expect(loaded?.previousPermissionMode).toBe('allow-all');
  });
});
