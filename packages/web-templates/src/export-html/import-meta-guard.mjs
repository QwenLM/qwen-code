/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The export-document build inlines its renderer into a standalone HTML file,
// so it must run as format:'iife' — under which esbuild lowers import.meta
// to {}. Any import.meta read in the graph then breaks every exported
// document at evaluation time (import.meta.env.X becomes ({}).env.X and
// throws; import.meta.url becomes ({}).url). Exactly one read is deliberate:
// DaemonWorkspaceProvider.tsx's guarded module-copy id, which arrives via the
// prebuilt web-shell transcript bundle.

const TOLERATED_BUNDLE = /web-shell[/\\]dist[/\\]transcript\.js$/;

// The deliberate read is one ternary
// (`typeof import.meta.url === 'string' && import.meta.url ? … : …`), and
// esbuild emits one empty-import-meta warning per import.meta occurrence —
// three for that ternary. Re-measure this constant in the same change as any
// refactor of that expression.
export const TOLERATED_TRANSCRIPT_IMPORT_META_READS = 3;

function formatLocation(warning) {
  const location = warning.location;
  if (!location) return '<unknown>';
  return `${location.file}:${location.line}:${location.column}`;
}

/**
 * Returns the empty-import-meta warnings the build must not tolerate: any
 * read outside the prebuilt transcript bundle, or reads from it beyond the
 * one deliberate site (a file-level allowlist alone cannot see a fourth read
 * landing in the same bundle).
 */
export function findUnexpectedImportMeta(warnings) {
  const unexpected = [];
  let tolerated = 0;
  for (const warning of warnings) {
    if (warning.id !== 'empty-import-meta') continue;
    const file = warning.location?.file ?? '';
    if (!TOLERATED_BUNDLE.test(file)) {
      unexpected.push(`${formatLocation(warning)}`);
      continue;
    }
    tolerated += 1;
    if (tolerated > TOLERATED_TRANSCRIPT_IMPORT_META_READS) {
      unexpected.push(
        `${formatLocation(warning)} (beyond the tolerated reads)`,
      );
    }
  }
  return unexpected;
}
