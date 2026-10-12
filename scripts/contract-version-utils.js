/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The public Managed Agent contract's version rules, shared by
// check-contract-version.js (one pull request against its base ref) and
// check-contract-open-prs.js (open pull requests against main). Consumers
// key capability detection on info.version, so a document that changed
// without moving the number, or moved it backwards, silently misinforms
// every reader (#13804): both failure modes were caught by a person on
// 2026-10-09, and the stall had already reached main once (#13163).

export const CONTRACT_DOCUMENT =
  'packages/sdk-java/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json';

// The repository's practice is numeric segments joined by dots (1.38.0).
// Anything else cannot be ordered, so it refuses the check wherever it
// appears, on either side of the comparison — and the same refusal is what
// makes a version string safe to echo into a `::error::` command's data,
// whose alphabet this admits.
const VERSION = /^\d+(?:\.\d+)*$/;

export const isVersion = (text) => VERSION.test(text);

// Numeric per segment: 1.9.0 ranks below 1.37.0, a segment missing past
// the shorter length reads as 0 (1.38 equals 1.38.0), and leading zeros
// carry no meaning.
export function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// The version a document's text declares, or a refusal describing why it
// cannot make a comparable claim. The refusal never echoes the document's
// own bytes: a JSON.parse error message can carry them, and callers print
// this where a workflow-command parser decodes.
export function documentVersion(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'is not parseable JSON' };
  }
  const version = parsed?.info?.version;
  if (typeof version !== 'string' || !isVersion(version)) {
    return { error: 'declares no numeric-segment info.version' };
  }
  return { version };
}
