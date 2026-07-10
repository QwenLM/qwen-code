/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Owner-bootstrap code file lifecycle.
 *
 * Spec: openspec/changes/add-remote-control/specs/pairing-auth/spec.md
 * "Owner bootstrap is single-use and time-bounded":
 *   - the daemon SHALL write the bootstrap code to
 *     `~/.qwen/rc/owner-bootstrap.code` with file mode 0600;
 *   - the daemon MUST NOT write the bootstrap code to stdout or stderr; in
 *     all cases stdout SHALL carry only the file path.
 *
 * SECURITY INVARIANT: no function in this module ever returns a string
 * destined for stdout that contains the code. `displayHint` is the ONLY
 * stdout-facing helper and it carries the path alone. The spec's one
 * exception — displaying the code on an interactive terminal — is the
 * CALLER's responsibility, and only via the controlling terminal
 * (`/dev/tty`), never via stdout/stderr.
 *
 * TTL/redemption enforcement lives in the token store (the code is inserted
 * as a pairing code with `bootstrapTtlSec`); this module only owns the file.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fixed filename inside the rc directory (pairing-auth: bootstrap file). */
export const BOOTSTRAP_CODE_FILENAME = 'owner-bootstrap.code';

/**
 * Write the one-time owner bootstrap code to `<dir>/owner-bootstrap.code`.
 *
 * The directory is created (recursively) with mode 0700 when missing; the
 * file is written with mode 0600. Because `mode` only applies at creation,
 * an explicit chmod re-asserts 0600 when an earlier code file is being
 * overwritten (e.g. `qwen rc bootstrap-reset`).
 *
 * Returns only the path — never the code — so callers can hand the result
 * straight to `displayHint` for stdout.
 */
export function writeBootstrapCode(
  dir: string,
  code: string,
): { path: string } {
  // Spec: secrets dir is 0700. `mode` is ignored for pre-existing dirs.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, BOOTSTRAP_CODE_FILENAME);
  // Spec: the code file is mode 0600.
  writeFileSync(path, code, { mode: 0o600 });
  // Re-assert on overwrite: writeFileSync's mode applies only at creation.
  chmodSync(path, 0o600);
  return { path };
}

/**
 * The single line the daemon prints to stdout after writing the bootstrap
 * file (pairing-auth: "stdout SHALL carry only the file path"). Contains the
 * path and nothing else secret.
 */
export function displayHint(path: string): string {
  return `Owner bootstrap code written to ${path}`;
}
