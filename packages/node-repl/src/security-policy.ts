/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

function canonicalizeFuturePath(filePath: string): string {
  let existingPrefix = filePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(existingPrefix), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingPrefix);
      if (parent === existingPrefix) throw error;
      missingSegments.unshift(path.basename(existingPrefix));
      existingPrefix = parent;
    }
  }
}

/**
 * Host-side policy for the node_repl runtime.
 *
 * This runtime deliberately has NO trusted-package / capability layer — imported
 * packages and builtins run with ordinary Node.js authority. The only decision
 * made here is validating and canonicalizing module-root directories supplied
 * via node_repl_add_node_module_dir, which merely widen the bare-package
 * resolution search path.
 */
export class NodeReplSecurityPolicy {
  static default(): NodeReplSecurityPolicy {
    return new NodeReplSecurityPolicy();
  }

  /**
   * Validate a module root path supplied via node_repl_add_node_module_dir.
   * Existing roots are canonicalized; a not-yet-created node_modules path is
   * retained so package installation can happen after registration.
   */
  validateModuleRoot(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`path must be absolute, got: ${rawPath}`);
    }
    const normalized = path.resolve(rawPath);
    if (path.basename(normalized).toLowerCase() !== 'node_modules') {
      throw new Error(
        `path must identify a node_modules directory: ${rawPath}`,
      );
    }
    let real: string;
    try {
      real = fs.realpathSync(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return canonicalizeFuturePath(normalized);
      }
      throw new Error(`cannot resolve directory: ${rawPath}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new Error(`directory does not exist: ${rawPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`path is not a directory: ${rawPath}`);
    }
    return real;
  }
}
