/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `createBridgeFileSystemAdapter` — the F1
 * follow-up (#4319) that wires PR 18's `WorkspaceFileSystem` through
 * the `BridgeFileSystem` seam shipped in F1.
 *
 * Coverage focus:
 *   - Happy paths: ACP writeText / readText hit real disk under the
 *     workspace via PR 18's defensive layer.
 *   - Trust gate: with `trusted: false` the adapter's write call
 *     rejects with the same `FsError(untrusted_workspace)` posture
 *     HTTP `POST /file` already gives.
 *   - Boundary enforcement: ACP-provided absolute path that escapes
 *     the workspace is rejected by `WorkspaceFileSystem.resolve`
 *     (the resolve call fails before any disk touch).
 *   - Line / limit window: ACP read with `{line: 2, limit: 1}` returns
 *     just the requested slice (PR 18 windowing applied).
 *   - Audit context: the adapter routes ACP requests through
 *     `factory.forRequest({ route: 'ACP writeTextFile' | 'ACP readTextFile', ... })`
 *     so the audit stream distinguishes agent fs from HTTP fs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ReadTextFileRequest,
  WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { createBridgeFileSystemAdapter } from './bridgeFileSystemAdapter.js';
import {
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from './fs/workspaceFileSystem.js';

describe('createBridgeFileSystemAdapter', () => {
  let tmpDir: string;
  let auditEmits: Array<{ data: unknown }>;

  beforeEach(async () => {
    // realpath here so macOS `/var` → `/private/var` resolution doesn't
    // make the bound-workspace canonical form diverge from the path the
    // test passes into the adapter (PR 18 boundary check would reject
    // otherwise as "path escapes workspace").
    tmpDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-fs-adapter-')),
    );
    auditEmits = [];
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function buildFactory(opts: {
    trusted: boolean;
  }): WorkspaceFileSystemFactory {
    return createWorkspaceFileSystemFactory({
      boundWorkspace: tmpDir,
      trusted: opts.trusted,
      emit: (ev) => auditEmits.push(ev),
    });
  }

  describe('writeText (trusted workspace)', () => {
    it('writes content to disk through the PR 18 layer', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const target = path.join(tmpDir, 'out.txt');

      const params: WriteTextFileRequest = {
        path: target,
        content: 'adapter-content',
        sessionId: 'sess:test',
      };
      const response = await adapter.writeText(params);

      expect(response).toEqual({});
      const onDisk = await fsp.readFile(target, 'utf8');
      expect(onDisk).toBe('adapter-content');
    });

    it('creates new files at 0o600 (NOT umask default — BridgeFileSystem contract)', async () => {
      // BridgeFileSystem contract requires `0o600` for newly-created
      // files (NOT umask defaults — agent writes don't know the file's
      // intended audience, so default to "owner-only"). The old inline
      // BridgeClient.writeTextFile proxy did this via fs.writeFile's
      // `mode` arg; the F1 follow-up wiring delegates to PR 18's new
      // `writeTextOverwrite` primitive which opens the tmp file with
      // `0o600` and chmods to that default before rename. Pinning this
      // here prevents a future refactor that switches the adapter back
      // to `wfs.writeText` (no mode handling → umask default 0o644).
      // Skipped on Windows since POSIX permission bits are not honored.
      if (process.platform === 'win32') return;
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const target = path.join(tmpDir, 'new-secret.txt');
      await adapter.writeText({
        path: target,
        content: 'secret',
        sessionId: 'sess:test',
      });
      const st = await fsp.stat(target);
      expect(st.mode & 0o7777).toBe(0o600);
    });

    it('preserves target mode when overwriting an existing file', async () => {
      // Editing a `0o600` secret must NOT downgrade it to `0o644` via
      // umask. The PR 18 atomic write path snapshots the existing
      // target's mode and applies it to the temp file before rename.
      // Skipped on Windows for the same reason as the 0o600 test.
      if (process.platform === 'win32') return;
      const target = path.join(tmpDir, 'existing-secret.txt');
      await fsp.writeFile(target, 'before', { mode: 0o600 });
      await fsp.chmod(target, 0o600);
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      await adapter.writeText({
        path: target,
        content: 'after',
        sessionId: 'sess:test',
      });
      const st = await fsp.stat(target);
      expect(st.mode & 0o7777).toBe(0o600);
      expect(await fsp.readFile(target, 'utf8')).toBe('after');
    });

    // Symlink-rejection posture (BridgeFileSystem contract divergence
    // from the pre-F1 inline proxy) is enforced by `writeTextOverwrite`
    // and verified at the lower layer in
    // `workspaceFileSystem.test.ts > writeTextOverwrite rejects symlink
    // targets planted post-resolve (symlink_escape)`. Re-testing at the
    // adapter layer would only re-exercise the same code path; the
    // adapter contract is "delegate to writeTextOverwrite", and the
    // mode-preservation assertions above already pin THAT.

    it('emits an audit event with route="ACP writeTextFile"', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );

      await adapter.writeText({
        path: path.join(tmpDir, 'audit.txt'),
        content: 'x',
        sessionId: 'sess:audit',
      });

      // Audit emits should include at least one event whose payload
      // routes through 'ACP writeTextFile'. We don't pin the exact
      // event count because PR 18 may emit both access + denied
      // (denied if any guard fired) events — just assert the
      // route label is the ACP one, not an HTTP route name.
      const acpEvents = auditEmits.filter((ev) => {
        const data = ev.data as { route?: string } | undefined;
        return data?.route === 'ACP writeTextFile';
      });
      expect(acpEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('writeText (untrusted workspace)', () => {
    it('rejects with FsError when trust gate is closed', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: false }),
      );

      await expect(
        adapter.writeText({
          path: path.join(tmpDir, 'denied.txt'),
          content: 'x',
          sessionId: 'sess:test',
        }),
      ).rejects.toThrow(/not trusted|forbidden/i);

      // The deny should NOT have created a file.
      await expect(fsp.stat(path.join(tmpDir, 'denied.txt'))).rejects.toThrow(
        /ENOENT/,
      );
    });

    it('reads still succeed under trusted=false (read is not gated)', async () => {
      // Parity check (per wenshao review on #4334): the writeText
      // trust-gate test above covers the deny posture, but the
      // adapter must NOT extend that gate to reads — PR 18's trust
      // gate is write-only. Without this assertion, a future refactor
      // that mistakenly gates reads would only fail HTTP-fs tests, not
      // adapter ones.
      const target = path.join(tmpDir, 'readable.txt');
      await fsp.writeFile(target, 'visible-content', 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: false }),
      );
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
      });
      expect(response.content).toBe('visible-content');
    });
  });

  describe('readText', () => {
    it('reads the full file content via PR 18 readText', async () => {
      const target = path.join(tmpDir, 'src.txt');
      await fsp.writeFile(target, 'line1\nline2\nline3\n', 'utf8');

      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
      });
      expect(response.content).toBe('line1\nline2\nline3\n');
    });

    it('forwards line/limit window to PR 18', async () => {
      const target = path.join(tmpDir, 'big.txt');
      await fsp.writeFile(
        target,
        Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
        'utf8',
      );

      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        line: 3,
        limit: 2,
      });
      // PR 18's `readText` accepts 1-based line + limit and returns the
      // requested window. The exact slice format mirrors HTTP `/file`'s
      // line/limit semantics from PR 19. Allow trailing newline tolerance.
      expect(response.content).toContain('line3');
      expect(response.content).toContain('line4');
      expect(response.content).not.toContain('line5');
      expect(response.content).not.toContain('line1');
    });

    it('treats null line/limit as undefined (ACP wire compatibility)', async () => {
      const target = path.join(tmpDir, 'null-window.txt');
      await fsp.writeFile(target, 'hello\nworld\n', 'utf8');

      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      // ACP allows `null` on these fields; PR 18 wants `undefined`.
      // The adapter drops nulls so PR 18 sees a clean opts bag.
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        line: null as unknown as number,
        limit: null as unknown as number,
      } as ReadTextFileRequest);
      expect(response.content).toBe('hello\nworld\n');
    });
  });

  describe('boundary enforcement', () => {
    it('rejects writes outside the bound workspace', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      // `/etc/passwd` is outside any tmpdir-based workspace.
      await expect(
        adapter.writeText({
          path: '/etc/passwd',
          content: 'pwned',
          sessionId: 'sess:test',
        }),
      ).rejects.toThrow();
    });

    it('rejects reads outside the bound workspace', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      await expect(
        adapter.readText({
          path: '/etc/passwd',
          sessionId: 'sess:test',
        }),
      ).rejects.toThrow();
    });
  });

  describe('factory.forRequest wiring', () => {
    it('passes sessionId into the audit context for both read and write', async () => {
      const calls: Array<{ route: string; sessionId?: string }> = [];
      const fakeFactory: WorkspaceFileSystemFactory = {
        forRequest: (ctx) => {
          calls.push({
            route: ctx.route,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          });
          // Return a stub fs that no-ops the resolve + write/read.
          return {
            resolve: vi.fn(async (input) => input as never),
            stat: vi.fn(),
            readText: vi.fn(async () => ({
              content: 'stub',
              meta: { lineEnding: 'lf' as const },
            })),
            readBytes: vi.fn(),
            readBytesWindow: vi.fn(),
            list: vi.fn(),
            glob: vi.fn(),
            writeTextAtomic: vi.fn(),
            writeText: vi.fn(async () => {}),
            writeTextOverwrite: vi.fn(async () => ({
              created: true,
              sizeBytes: 0,
              hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
              meta: { lineEnding: 'lf' as const },
            })),
            edit: vi.fn(),
            editAtomic: vi.fn(),
          };
        },
      };

      const adapter = createBridgeFileSystemAdapter(fakeFactory);
      await adapter.writeText({
        path: '/tmp/x',
        content: '',
        sessionId: 'sess:write',
      });
      await adapter.readText({
        path: '/tmp/x',
        sessionId: 'sess:read',
      });

      expect(calls).toEqual([
        { route: 'ACP writeTextFile', sessionId: 'sess:write' },
        { route: 'ACP readTextFile', sessionId: 'sess:read' },
      ]);
    });

    it('omits sessionId from audit context when ACP request lacks one', async () => {
      const calls: Array<{ route: string; sessionId?: string }> = [];
      const fakeFactory: WorkspaceFileSystemFactory = {
        forRequest: (ctx) => {
          calls.push({
            route: ctx.route,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          });
          return {
            resolve: vi.fn(async (input) => input as never),
            stat: vi.fn(),
            readText: vi.fn(async () => ({
              content: 'stub',
              meta: { lineEnding: 'lf' as const },
            })),
            readBytes: vi.fn(),
            readBytesWindow: vi.fn(),
            list: vi.fn(),
            glob: vi.fn(),
            writeTextAtomic: vi.fn(),
            writeText: vi.fn(async () => {}),
            writeTextOverwrite: vi.fn(async () => ({
              created: true,
              sizeBytes: 0,
              hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
              meta: { lineEnding: 'lf' as const },
            })),
            edit: vi.fn(),
            editAtomic: vi.fn(),
          };
        },
      };

      const adapter = createBridgeFileSystemAdapter(fakeFactory);
      // Bypass the wire types — ACP guarantees sessionId in practice,
      // but the adapter's defensive omit-when-absent contract is
      // worth pinning so a future schema relaxation doesn't introduce
      // an undefined-string-keyed audit record.
      await adapter.writeText({
        path: '/tmp/y',
        content: '',
      } as unknown as WriteTextFileRequest);

      expect(calls).toEqual([{ route: 'ACP writeTextFile' }]);
    });
  });
});
