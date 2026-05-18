/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Ignore } from '@qwen-code/qwen-code-core';
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  assertTrustedForIntent,
  detectBinary,
  enforceReadBytesSize,
  enforceReadSize,
  enforceWriteSize,
  shouldIgnore,
} from './policy.js';
import { canonicalizeWorkspace, resolveWithinWorkspace } from './paths.js';
import { isFsError } from './errors.js';

describe('shouldIgnore', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fsp.mkdtemp(
      path.join(os.tmpdir(), `qwen-policy-${randomBytes(4).toString('hex')}-`),
    );
    const wsDir = path.join(scratch, 'ws');
    await fsp.mkdir(wsDir, { recursive: true });
    workspace = canonicalizeWorkspace(wsDir);
  });

  afterEach(async () => {
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it('flags files matching .gitignore-style patterns', async () => {
    const ignore = new Ignore().add(['*.log', 'dist/']);
    const target = path.join(workspace, 'app.log');
    await fsp.writeFile(target, '');
    const resolved = await resolveWithinWorkspace('app.log', workspace, 'read');
    expect(shouldIgnore(resolved, workspace, ignore)).toEqual({
      ignored: true,
      category: 'file',
    });
  });

  it('flags directory patterns', async () => {
    const ignore = new Ignore().add(['build/']);
    const dir = path.join(workspace, 'build');
    await fsp.mkdir(dir);
    const resolved = await resolveWithinWorkspace('build', workspace, 'list');
    expect(shouldIgnore(resolved, workspace, ignore, 'directory')).toEqual({
      ignored: true,
      category: 'directory',
    });
  });

  it('flags non-trailing-slash directory patterns like node_modules', async () => {
    const ignore = new Ignore().add(['node_modules']);
    const dir = path.join(workspace, 'node_modules');
    await fsp.mkdir(dir);
    const resolved = await resolveWithinWorkspace(
      'node_modules',
      workspace,
      'list',
    );
    // No-trailing-slash patterns get registered in both ignorers; either
    // shows up as an ignore hit. We accept whichever category fires.
    const verdict = shouldIgnore(resolved, workspace, ignore, 'directory');
    expect(verdict.ignored).toBe(true);
  });

  it('returns false when no rule matches', async () => {
    const ignore = new Ignore().add(['*.log']);
    const target = path.join(workspace, 'src.ts');
    await fsp.writeFile(target, '');
    const resolved = await resolveWithinWorkspace('src.ts', workspace, 'read');
    expect(shouldIgnore(resolved, workspace, ignore)).toEqual({
      ignored: false,
    });
  });

  it('never ignores the workspace root itself', async () => {
    const ignore = new Ignore().add(['*']);
    const resolved = await resolveWithinWorkspace('.', workspace, 'list');
    expect(shouldIgnore(resolved, workspace, ignore)).toEqual({
      ignored: false,
    });
  });
});

describe('assertTrustedForIntent', () => {
  it('passes when trusted regardless of intent', () => {
    expect(() => assertTrustedForIntent(true, 'read')).not.toThrow();
    expect(() => assertTrustedForIntent(true, 'write')).not.toThrow();
    expect(() => assertTrustedForIntent(true, 'list')).not.toThrow();
  });

  it('passes for read-style intents when untrusted', () => {
    expect(() => assertTrustedForIntent(false, 'read')).not.toThrow();
    expect(() => assertTrustedForIntent(false, 'list')).not.toThrow();
    expect(() => assertTrustedForIntent(false, 'glob')).not.toThrow();
    expect(() => assertTrustedForIntent(false, 'stat')).not.toThrow();
  });

  it('throws untrusted_workspace for write intent when untrusted', () => {
    const err = (() => {
      try {
        assertTrustedForIntent(false, 'write');
      } catch (e) {
        return e;
      }
      throw new Error('expected throw');
    })();
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string; status: number }).kind).toBe(
      'untrusted_workspace',
    );
    expect((err as { kind: string; status: number }).status).toBe(403);
  });

  it('throws untrusted_workspace for edit intent when untrusted', () => {
    expect(() => assertTrustedForIntent(false, 'edit')).toThrowError(
      /edit operations are forbidden/,
    );
  });
});

describe('enforceReadSize', () => {
  it('returns full size when under the cap', () => {
    expect(enforceReadSize(1024)).toEqual({
      bytesToRead: 1024,
      truncated: false,
    });
  });

  it('returns the cap and truncated=true when over', () => {
    expect(enforceReadSize(MAX_READ_BYTES + 1)).toEqual({
      bytesToRead: MAX_READ_BYTES,
      truncated: true,
    });
  });

  it('honors a per-call max override', () => {
    expect(enforceReadSize(2048, 1024)).toEqual({
      bytesToRead: 1024,
      truncated: true,
    });
    expect(enforceReadSize(512, 1024)).toEqual({
      bytesToRead: 512,
      truncated: false,
    });
  });
});

describe('enforceWriteSize', () => {
  it('passes when under the write cap', () => {
    expect(() => enforceWriteSize(1024)).not.toThrow();
    expect(() => enforceWriteSize(MAX_WRITE_BYTES)).not.toThrow();
  });

  it('throws file_too_large when over the cap', () => {
    const err = (() => {
      try {
        enforceWriteSize(MAX_WRITE_BYTES + 1);
      } catch (e) {
        return e;
      }
      throw new Error('expected throw');
    })();
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string; status: number }).kind).toBe(
      'file_too_large',
    );
    expect((err as { kind: string; status: number }).status).toBe(413);
  });
});

describe('enforceReadBytesSize', () => {
  it('passes when under the cap', () => {
    expect(() => enforceReadBytesSize(1024)).not.toThrow();
  });

  it('throws file_too_large when over', () => {
    const err = (() => {
      try {
        enforceReadBytesSize(MAX_READ_BYTES + 1);
      } catch (e) {
        return e;
      }
      throw new Error('expected throw');
    })();
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });
});

describe('detectBinary', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fsp.mkdtemp(
      path.join(os.tmpdir(), `qwen-binary-${randomBytes(4).toString('hex')}-`),
    );
    const wsDir = path.join(scratch, 'ws');
    await fsp.mkdir(wsDir, { recursive: true });
    workspace = canonicalizeWorkspace(wsDir);
  });

  afterEach(async () => {
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it('reports text files as non-binary', async () => {
    const target = path.join(workspace, 'plain.txt');
    await fsp.writeFile(target, 'hello world\nsecond line\n');
    const resolved = await resolveWithinWorkspace(
      'plain.txt',
      workspace,
      'read',
    );
    expect(await detectBinary(resolved)).toBe(false);
  });

  it('reports buffers with null bytes as binary', async () => {
    const target = path.join(workspace, 'bin.dat');
    const buf = Buffer.alloc(64);
    buf[10] = 0; // null byte triggers binary detection
    await fsp.writeFile(target, buf);
    const resolved = await resolveWithinWorkspace('bin.dat', workspace, 'read');
    expect(await detectBinary(resolved)).toBe(true);
  });
});
