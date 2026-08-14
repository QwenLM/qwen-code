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
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ReadTextFileRequest,
  WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import {
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from './fs/workspace-file-system.js';

describe('createBridgeFileSystemAdapter', () => {
  let tmpDir: string;
  let outsideDir: string;
  let auditEmits: Array<{ data: unknown }>;

  beforeEach(async () => {
    // realpath here so macOS `/var` → `/private/var` resolution doesn't
    // make the bound-workspace canonical form diverge from the path the
    // test passes into the adapter (PR 18 boundary check would reject
    // otherwise as "path escapes workspace").
    tmpDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-fs-adapter-')),
    );
    outsideDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-fs-outside-')),
    );
    auditEmits = [];
  });
  afterEach(async () => {
    await Promise.all([
      fsp.rm(tmpDir, { recursive: true, force: true }),
      fsp.rm(outsideDir, { recursive: true, force: true }),
    ]);
  });

  function buildFactory(opts: {
    trusted: boolean;
  }): WorkspaceFileSystemFactory {
    return createWorkspaceFileSystemFactory({
      boundWorkspaces: [tmpDir],
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
    // `workspace-file-system.test.ts > writeTextOverwrite rejects symlink
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

    it('reads a bounded ACP line window from text above MAX_READ_BYTES', async () => {
      const { MAX_READ_BYTES } = await import('./fs/policy.js');
      const target = path.join(tmpDir, 'large-window.txt');
      const lines = Array.from(
        { length: 4_000 },
        (_, index) => `line${index + 1} ${'x'.repeat(80)}`,
      );
      const content = lines.join('\n');
      expect(Buffer.byteLength(content)).toBeGreaterThan(MAX_READ_BYTES);
      await fsp.writeFile(target, content, 'utf8');

      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );
      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        line: 3,
        limit: 20,
      });

      expect(response.content).toBe(lines.slice(2, 22).join('\n'));
    });

    it('serves an oversized ACP line-only read as a bounded window', async () => {
      const { MAX_READ_BYTES } = await import('./fs/policy.js');
      const target = path.join(tmpDir, 'large-line-only.txt');
      await fsp.writeFile(target, 'x'.repeat(MAX_READ_BYTES + 1), 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );

      const response = await adapter.readText({
        path: target,
        sessionId: 'sess:test',
        line: 2,
      });

      expect(response.content).toBe('');
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

    it('readText surfaces workspace-file-system parse_error for fractional positive limits', async () => {
      const target = path.join(tmpDir, 'fractional-limit.txt');
      await fsp.writeFile(target, 'x\ny\nz\n', 'utf8');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
      );

      const err = await adapter
        .readText({
          path: target,
          sessionId: 'sess:test',
          line: 1,
          limit: 1.5,
        })
        .catch((e: unknown) => e);

      expect((err as { kind?: string }).kind).toBe('parse_error');
      expect((err as Error).message).toContain(
        'limit must be a positive integer',
      );
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

  describe('same-host built-in tool writes', () => {
    const marker = {
      'qwen-code/tool-write-origin': {
        version: 1,
        source: 'write_file',
      },
    };

    it('writes an external file only when the adapter opts in and provenance is valid', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'created.txt');

      await adapter.writeText({
        path: target,
        content: 'external-content',
        sessionId: 'sess:external',
        _meta: marker,
      });

      expect(await fsp.readFile(target, 'utf8')).toBe('external-content');
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.access',
        intent: 'write',
        route: 'ACP writeTextFile',
        sessionId: 'sess:external',
      });
      if (process.platform !== 'win32') {
        expect((await fsp.stat(target)).mode & 0o7777).toBe(0o600);
      }
    });

    it('keeps a marked workspace write on the existing WFS path', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(tmpDir, 'marked-workspace.txt');

      await adapter.writeText({
        path: target,
        content: 'workspace-content',
        sessionId: 'sess:marked-workspace',
        _meta: marker,
      });

      expect(await fsp.readFile(target, 'utf8')).toBe('workspace-content');
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.access',
        route: 'ACP writeTextFile',
      });
    });

    it('preserves the mode of an existing external file', async () => {
      if (process.platform === 'win32') return;
      const target = path.join(outsideDir, 'existing.txt');
      await fsp.writeFile(target, 'before', { mode: 0o640 });
      await fsp.chmod(target, 0o640);
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );

      await adapter.writeText({
        path: target,
        content: 'after',
        sessionId: 'sess:external-mode',
        _meta: marker,
      });

      expect(await fsp.readFile(target, 'utf8')).toBe('after');
      expect((await fsp.stat(target)).mode & 0o7777).toBe(0o640);
    });

    it.each([
      ['adapter default', undefined, marker],
      ['missing provenance', true, undefined],
      [
        'malformed provenance',
        true,
        {
          'qwen-code/tool-write-origin': {
            version: 1,
            source: 'write_file',
            extra: true,
          },
        },
      ],
    ])('keeps external writes fail-closed for %s', async (_, enabled, meta) => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        enabled === undefined
          ? undefined
          : { allowSameHostToolWritesOutsideWorkspace: enabled },
      );
      const target = path.join(outsideDir, 'rejected.txt');

      const err = await adapter
        .writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:rejected',
          ...(meta !== undefined ? { _meta: meta } : {}),
        })
        .catch((error: unknown) => error);

      expect((err as { kind?: string }).kind).toBe('path_outside_workspace');
      await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects valid provenance when the factory does not expose the host writer', async () => {
      const completeFactory = buildFactory({ trusted: true });
      const compatibleFactory: WorkspaceFileSystemFactory = {
        assertCanWrite: completeFactory.assertCanWrite,
        forRequest: completeFactory.forRequest,
      };
      const adapter = createBridgeFileSystemAdapter(compatibleFactory, {
        allowSameHostToolWritesOutsideWorkspace: true,
      });
      const target = path.join(outsideDir, 'no-factory-capability.txt');

      await expect(
        adapter.writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:no-factory-capability',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
    });

    it('rejects external writes from an untrusted runtime with one denied audit', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: false }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'untrusted.txt');

      await expect(
        adapter.writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:untrusted',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'untrusted_workspace' });

      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.denied',
        errorKind: 'untrusted_workspace',
      });
    });

    it('rejects external leaf symlinks with one denied audit', async () => {
      const realTarget = path.join(outsideDir, 'real.txt');
      const linkTarget = path.join(outsideDir, 'link.txt');
      await fsp.writeFile(realTarget, 'original');
      await fsp.symlink(realTarget, linkTarget);
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );

      await expect(
        adapter.writeText({
          path: linkTarget,
          content: 'rejected',
          sessionId: 'sess:symlink',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'symlink_escape' });

      expect(await fsp.readFile(realTarget, 'utf8')).toBe('original');
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.denied',
        errorKind: 'symlink_escape',
      });
    });

    it('rejects dangling external leaf symlinks', async () => {
      const linkTarget = path.join(outsideDir, 'dangling.txt');
      await fsp.symlink(path.join(outsideDir, 'missing.txt'), linkTarget);
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );

      await expect(
        adapter.writeText({
          path: linkTarget,
          content: 'rejected',
          sessionId: 'sess:dangling-symlink',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'symlink_escape' });
      expect(auditEmits).toHaveLength(1);
    });

    it.each([
      ['relative escape', () => path.join('..', 'outside.txt')],
      ['suspicious path', () => path.join(outsideDir, 'trailing-dot.')],
    ])('rejects an external %s', async (_, buildTarget) => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = buildTarget();

      await expect(
        adapter.writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:invalid-path',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
      expect(auditEmits).toHaveLength(1);
    });

    it('rejects a Unix socket as an external text target', async () => {
      if (process.platform === 'win32') return;
      const socketDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'bridge-fs-socket-'),
      );
      const socketPath = path.join(socketDir, 'target.sock');
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, resolve);
        });
        const adapter = createBridgeFileSystemAdapter(
          buildFactory({ trusted: true }),
          { allowSameHostToolWritesOutsideWorkspace: true },
        );
        await expect(
          adapter.writeText({
            path: socketPath,
            content: 'rejected',
            sessionId: 'sess:socket',
            _meta: marker,
          }),
        ).rejects.toMatchObject({ kind: 'parse_error' });
        expect(auditEmits).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fsp.rm(socketDir, { recursive: true, force: true });
      }
    });

    it('canonicalizes a symlinked parent for a new external file', async () => {
      const alias = path.join(
        path.dirname(outsideDir),
        `${path.basename(outsideDir)}-alias`,
      );
      await fsp.symlink(outsideDir, alias, 'dir');
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      try {
        await adapter.writeText({
          path: path.join(alias, 'through-alias.txt'),
          content: 'through-alias',
          sessionId: 'sess:parent-alias',
          _meta: marker,
        });
        expect(
          await fsp.readFile(
            path.join(outsideDir, 'through-alias.txt'),
            'utf8',
          ),
        ).toBe('through-alias');
      } finally {
        await fsp.unlink(alias).catch(() => undefined);
      }
    });

    it('strips the ACP BOM marker before re-encoding non-UTF-8 content', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'utf16.txt');

      await adapter.writeText({
        path: target,
        content: '\uFEFFhello',
        sessionId: 'sess:utf16',
        _meta: {
          ...marker,
          bom: true,
          encoding: 'utf-16le',
          lineEnding: 'crlf',
        },
      });

      const bytes = await fsp.readFile(target);
      expect(bytes.subarray(0, 4)).toEqual(
        Buffer.from([0xff, 0xfe, 0x68, 0x00]),
      );
      expect(bytes.subarray(2).includes(Buffer.from([0xff, 0xfe]))).toBe(false);
    });

    it('preserves CRLF and writes exactly one UTF-8 BOM', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'utf8-bom-crlf.txt');

      await adapter.writeText({
        path: target,
        content: '\uFEFFfirst\nsecond\n',
        sessionId: 'sess:utf8-bom-crlf',
        _meta: {
          ...marker,
          bom: true,
          encoding: 'utf-8',
          lineEnding: 'crlf',
        },
      });

      expect(await fsp.readFile(target)).toEqual(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('first\r\nsecond\r\n'),
        ]),
      );
    });

    it('rejects content that exceeds the cap only after non-UTF-8 encoding', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'too-large-utf16.txt');

      await expect(
        adapter.writeText({
          path: target,
          content: 'a'.repeat(3 * 1024 * 1024),
          sessionId: 'sess:encoded-cap',
          _meta: {
            ...marker,
            encoding: 'utf-16le',
          },
        }),
      ).rejects.toMatchObject({ kind: 'file_too_large' });
      await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.denied',
        errorKind: 'file_too_large',
      });
    });

    it('rejects directories as external text targets', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );

      await expect(
        adapter.writeText({
          path: outsideDir,
          content: 'rejected',
          sessionId: 'sess:directory',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'parse_error' });
      expect(auditEmits).toHaveLength(1);
    });

    it('records a missing external parent failure once', async () => {
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      const target = path.join(outsideDir, 'missing-parent', 'file.txt');

      await expect(
        adapter.writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:missing-parent',
          _meta: marker,
        }),
      ).rejects.toMatchObject({ kind: 'path_not_found' });
      await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.denied',
        errorKind: 'path_not_found',
      });
    });

    it('detects replacement of an existing leaf during canonicalization', async () => {
      const target = path.join(outsideDir, 'raced.txt');
      const displaced = path.join(outsideDir, 'raced-original.txt');
      await fsp.writeFile(target, 'original');
      const realpath = fsp.realpath.bind(fsp);
      let targetRealpathCalls = 0;
      const realpathSpy = vi
        .spyOn(fsp, 'realpath')
        .mockImplementation(async (candidate) => {
          if (String(candidate) === target) {
            targetRealpathCalls++;
            if (targetRealpathCalls === 2) {
              await fsp.rename(target, displaced);
              await fsp.writeFile(target, 'replacement');
            }
          }
          return realpath(candidate);
        });
      const adapter = createBridgeFileSystemAdapter(
        buildFactory({ trusted: true }),
        { allowSameHostToolWritesOutsideWorkspace: true },
      );
      try {
        await expect(
          adapter.writeText({
            path: target,
            content: 'must-not-write',
            sessionId: 'sess:inode-race',
            _meta: marker,
          }),
        ).rejects.toMatchObject({ kind: 'symlink_escape' });
        expect(await fsp.readFile(target, 'utf8')).toBe('replacement');
        expect(await fsp.readFile(displaced, 'utf8')).toBe('original');
        expect(auditEmits).toHaveLength(1);
      } finally {
        realpathSpy.mockRestore();
      }
    });

    it('records a closed runtime generation once without writing', async () => {
      const generationError = Object.assign(new Error('generation closed'), {
        code: 'workspace_generation_closed',
      });
      const factory = createWorkspaceFileSystemFactory({
        boundWorkspaces: [tmpDir],
        trusted: true,
        emit: (event) => auditEmits.push(event),
        generationGuard: {
          assertOpen() {
            throw generationError;
          },
        },
      });
      const adapter = createBridgeFileSystemAdapter(factory, {
        allowSameHostToolWritesOutsideWorkspace: true,
      });
      const target = path.join(outsideDir, 'closed-generation.txt');

      await expect(
        adapter.writeText({
          path: target,
          content: 'rejected',
          sessionId: 'sess:closed-generation',
          _meta: marker,
        }),
      ).rejects.toBe(generationError);
      await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(auditEmits).toHaveLength(1);
      expect(auditEmits[0]?.data).toMatchObject({
        kind: 'fs.denied',
        errorKind: 'internal_error',
      });
    });
  });

  describe('factory.forRequest wiring', () => {
    it('passes sessionId into the audit context for both read and write', async () => {
      const calls: Array<{ route: string; sessionId?: string }> = [];
      const fakeFactory: WorkspaceFileSystemFactory = {
        assertCanWrite: () => {},
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
            writeBytesAtomic: vi.fn(),
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
        assertCanWrite: () => {},
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
            writeBytesAtomic: vi.fn(),
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
