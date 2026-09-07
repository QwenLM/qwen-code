/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { loadSettings } from '../../config/settings.js';
import { resolveWebShellBrand } from '../../services/web-shell-brand.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

export interface BrandRouteDeps {
  /**
   * Primary workspace cwd, used only to locate settings files. The response
   * never reflects workspace-scoped settings: `skipWorkspaceSettings` keeps
   * that layer off disk entirely, so a repository's `.qwen/settings.json`
   * cannot rebrand the shell for whoever opens it.
   */
  boundWorkspace: string;
}

/**
 * `GET /brand` — the Web Shell's product name and logo.
 *
 * Ownership classification: process-global. The value derives from
 * user-global configuration, so the route takes neither a workspace selector
 * nor a session id, matching the sessionless user-level language route.
 *
 * Deliberately not folded into `/capabilities`, whose documented position is
 * that clients probe by connecting rather than reading ambient settings into
 * the envelope. Deliberately not folded into `/workspace/settings` either:
 * that channel reports merged effective values, which would reintroduce the
 * workspace layer excluded above, and a settings descriptor has no place for a
 * derived data URI that is not the value the user wrote.
 *
 * Any resolution failure answers 200 with an empty body so a misconfigured
 * logo degrades to the client's built-in brand instead of failing the shell's
 * first paint.
 */
export function registerBrandRoutes(
  app: Application,
  deps: BrandRouteDeps,
): void {
  app.get('/brand', (_req, res) => {
    try {
      const loaded = loadSettings(deps.boundWorkspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: true,
      });
      const { brand, warning } = resolveWebShellBrand(loaded);
      if (warning) {
        writeStderrLine(`qwen serve: GET /brand: ${warning}`);
      }
      res.status(200).json(brand);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /brand failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(200).json({});
    }
  });
}
