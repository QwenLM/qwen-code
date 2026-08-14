/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Folder browser (owner/control-plane): lets the phone list the
 * subdirectories of a given absolute path so a "New conversation" flow can
 * pick which directory a new workspace runs in.
 *
 *   GET /rc/fs?path=<abs> — 200 { path, parent, entries: [{ name, isDir }] }
 *     - `path` absent → `opts.defaultPath ?? os.homedir()`.
 *     - `path` not absolute → 400 invalid_path.
 *     - `path` exists but is not a directory (or doesn't exist) → 404
 *       not_a_directory.
 *     - `readdir`/`stat` failure (EACCES or any other read error) → 403
 *       fs_denied.
 *     - `entries` lists ONLY subdirectories (files are filtered out).
 *     - `parent` is `dirname(path)`, or `null` at the filesystem root.
 */

import type { RequestHandler } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface FsBrowseRouteOptions {
  /** Path used when the `path` query param is absent. Defaults to `$HOME`. */
  defaultPath?: string;
}

export function createFsBrowseRoute(
  opts?: FsBrowseRouteOptions,
): RequestHandler {
  return async (req, res) => {
    const rawPath = req.query['path'];
    const targetPath =
      typeof rawPath === 'string' && rawPath.length > 0
        ? rawPath
        : (opts?.defaultPath ?? homedir());

    if (!isAbsolute(targetPath)) {
      res
        .status(400)
        .json({ error: 'path must be absolute', code: 'invalid_path' });
      return;
    }

    // Normalize BEFORE stat/readdir (and before computing `parent`) so a
    // trailing slash (or `.`/`//`) never causes a distinct-looking path to
    // be returned to the client than what was actually browsed — the
    // browse-derived `path`/`parent` must be canonical, matching what
    // `DaemonPool.getOrSpawn`/`createOrAttachSession` will key on if this
    // path is later handed back as a create's `cwd`.
    const resolvedPath = resolve(targetPath);

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isDirectory()) {
        res
          .status(404)
          .json({ error: 'Not a directory', code: 'not_a_directory' });
        return;
      }

      const dirents = await readdir(resolvedPath, { withFileTypes: true });
      const entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, isDir: true }));

      const parent =
        resolvedPath === dirname(resolvedPath) ? null : dirname(resolvedPath);

      res.status(200).json({ path: resolvedPath, parent, entries });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        res
          .status(404)
          .json({ error: 'Not a directory', code: 'not_a_directory' });
        return;
      }
      if (code === 'EACCES' || code === 'EPERM') {
        res.status(403).json({ error: 'Permission denied', code: 'fs_denied' });
        return;
      }
      // Any other read error (e.g. ELOOP, EIO): treat as access denial rather
      // than leaking filesystem details to the client.
      res.status(403).json({ error: 'Permission denied', code: 'fs_denied' });
    }
  };
}
