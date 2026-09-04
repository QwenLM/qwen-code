/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared `writeStderrLine` helper for `bridge.ts` + `bridgeClient.ts`.
 *
 * Originally inlined per-file to keep the
 * modules free of any reverse import on `cli/src/utils/stdioHelpers.ts`.
 * Both consumers now live in the
 * **same** `@qwen-code/acp-bridge` package — the cross-package
 * justification no longer applies, and a future behavior change
 * (timestamp prefix, log level, structured field) would require
 * touching two identical copies. Extracted here so both `bridge.ts`
 * and `bridgeClient.ts` import from a single source of truth.
 *
 * Not part of the package's public API — `internal/` subpath is
 * excluded from `exports` in `package.json`. `spawnChannel.ts`
 * deliberately does NOT consume this (its stderr writes carry their
 * own `[serve pid=… cwd=…]` line prefix and use raw
 * `process.stderr.write` for that reason).
 *
 * Byte-identical to the original `cli/src/utils/stdioHelpers.ts`
 * implementation.
 */
export function writeStderrLine(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}
