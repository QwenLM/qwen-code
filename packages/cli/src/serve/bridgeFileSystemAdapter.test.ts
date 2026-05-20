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

    it('drops non-positive limit (negative / zero) instead of forwarding', async () => {
      // wenshao #4334 review: pre-PR inline `BridgeClient.readTextFile`
      // returned `{ content: '' }` for `limit <= 0`. PR 18's `readText`
      // applies `slice(0, limit)` which for `limit: -1` returns "all
      // lines except the last" — wrong content. The adapter drops
      // non-positive `limit` and `line` so PR 18 falls back to no-
      // windowing defaults (closest approximation to the pre-PR empty-
      // content posture without smuggling `parse_error` to agents).
      const target = path.join(tmpDir, 'neg-limit.txt');
      await fsp.writeFile(target, 'a\nb\nc\n', 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        limit: -1 as number,
      });
      // With `limit: -1` dropped, no windowing → full file content.
      // Notably NOT 'a\nb\n' (which would be the broken slice(0,-1) result).
      expect(response.content).toBe('a\nb\nc\n');
    });

    it('propagates file_too_large from wfs.readText through the adapter', async () => {
      // DeepSeek #4334 review: read-side error propagation through the
      // adapter is otherwise untested. Pin that PR 18's file-size cap
      // surfaces to ACP callers as an `FsError({kind:'file_too_large'})`
      // without being silently swallowed or wrapped.
      const { MAX_READ_BYTES } = await import('./fs/policy.js');
      const target = path.join(tmpDir, 'too-large.txt');
      await fsp.writeFile(target, 'x'.repeat(MAX_READ_BYTES + 1024), 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const err = await adapter
        .readText({ path: target, sessionId: 'sess:test' })
        .catch((e: unknown) => e);
      expect((err as { kind?: string }).kind).toBe('file_too_large');
    });

    it('propagates binary_file from wfs.readText through the adapter', async () => {
      const target = path.join(tmpDir, 'image.bin');
      const buf = Buffer.alloc(128);
      buf[5] = 0; // null byte → looksBinary()
      await fsp.writeFile(target, buf);
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const err = await adapter
        .readText({ path: target, sessionId: 'sess:test' })
        .catch((e: unknown) => e);
      expect((err as { kind?: string }).kind).toBe('binary_file');
    });

    it('propagates symlink_escape from wfs.resolve when target is a symlink to outside', async () => {
      // Symmetric with the boundary-enforcement read test above, but
      // covers the symlink-specific rejection path rather than the
      // raw "/etc/passwd"-style outside path. PR 18 + HTTP /file
      // posture: reads through a symlink resolving outside the
      // workspace get `symlink_escape`.
      if (process.platform === 'win32') return;
      const outsideTarget = path.join(tmpDir, '..', 'outside-link-target.txt');
      await fsp.writeFile(outsideTarget, 'outside').catch(() => undefined);
      try {
        const link = path.join(tmpDir, 'link-out.txt');
        await fsp.symlink(outsideTarget, link, 'file');
        const adapter = createBridgeFileSystemAdapter(
          buildFactory({ trusted: true }),
        );
        const err = await adapter
          .readText({ path: link, sessionId: 'sess:test' })
          .catch((e: unknown) => e);
        // resolve() collapses symlinks → outside the workspace surfaces
        // either `symlink_escape` or `path_outside_workspace` depending
        // on whether resolve sees the link-collapse. Both are valid
        // security signals; pin "not silently succeeded".
        expect(['symlink_escape', 'path_outside_workspace']).toContain(
          (err as { kind?: string }).kind,
        );
      } finally {
        await fsp.unlink(outsideTarget).catch(() => undefined);
      }
    });

    it('drops non-positive line (zero) instead of forwarding parse_error', async () => {
      const target = path.join(tmpDir, 'zero-line.txt');
      await fsp.writeFile(target, 'x\ny\n', 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      // Pre-fix the adapter would forward `line: 0` and PR 18 would
      // reject with `parse_error` ("line must be a positive integer").
      // Post-fix it's dropped and the read returns the full content.
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        line: 0 as number,
      });
      expect(response.content).toBe('x\ny\n');
    });
  });

  describe('boundary enforcement', () => {
    it('rejects writes outside the bound workspace with path_outside_workspace', async () => {
      // wenshao #4334 review (DWrbl): bare `.rejects.toThrow()` would
      // also pass on an incidental OS-level EACCES (e.g. CI container
      // refusing /etc/passwd) or any future refactor that throws a
      // different error class before the boundary check runs. Pin the
      // specific FsError.kind so the test verifies boundary
      // enforcement is what rejects, not an accident.
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const err = await adapter
        .writeText({
          path: '/etc/passwd',
          content: 'pwned',
          sessionId: 'sess:test',
        })
        .catch((e: unknown) => e);
      expect((err as { kind?: string }).kind).toBe('path_outside_workspace');
    });

    it('rejects reads outside the bound workspace with path_outside_workspace', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const err = await adapter
        .readText({
          path: '/etc/passwd',
          sessionId: 'sess:test',
        })
        .catch((e: unknown) => e);
      expect((err as { kind?: string }).kind).toBe('path_outside_workspace');
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
