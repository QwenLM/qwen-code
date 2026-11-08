/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which test FILES a runner named as failing, out of one command's output.
//
// Lives here, not in `test-delta`, because both sides of the delta need it and
// they parse at different moments: the base rerun parses its own raw output,
// and `build-test` must parse the PR side's output BEFORE `trimOutput` bounds
// the report (measured on a live review of PR #9113: a `packages/core` suite
// whose summary said `Test Files 11 failed` reached `test-delta` with exactly
// one FAIL line surviving the trim, so ten failing files could be neither
// measured as pre-existing nor attributed to the PR).

// eslint-disable-next-line no-control-regex -- ESC is the character under test
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Test files a runner named as failing, out of one command's output.
 *
 * Two shapes cover vitest and jest, the runners build-test drives:
 * `FAIL  src/x.test.ts > name` (both, in the failure section) and vitest's
 * per-file `❯ src/x.test.ts (12 tests | 3 failed)` progress line. Matching is
 * on the path token, so a `FAIL` line whose path was truncated mid-token by
 * output trimming simply does not match — an unparsed failure surfaces as a
 * count mismatch in the caller's disclosure, never as an invented path.
 */
export function failingFilesOf(output: string, root = ''): string[] {
  const text = output.replace(ANSI_SGR_RE, '');
  const files = new Set<string>();
  const re =
    // `\\` and `:` in the path class: a Windows runner prints
    // `FAIL  C:\\repo\\src\\x.test.ts`, which the POSIX-only class missed —
    // and a missed parse is an unattributed failure, not a loud error.
    /(?:^|\s)(?:FAIL\s+|❯\s+)(?:\|([^|]+)\|\s+)?([\w@.:\\/-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b([^\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // The `❯` progress line lists every file; only a failing one counts.
    if (m[0].trimStart().startsWith('❯') && !/failed/.test(m[3] ?? ''))
      continue;
    // ROOT-RELATIVE, and keyed by project. The two sides run in DIFFERENT
    // roots (the PR worktree and the base tree), so comparing absolute paths
    // verbatim made every pre-existing failure a fabricated netNew. The vitest
    // project token is part of the identity too: dropping it collapsed
    // same-named files across workspaces, suppressing a real Critical as a
    // "measurement" — the worse of the two failure directions.
    files.add(`${m[1] ? `${m[1].trim()}::` : ''}${relativeToRoot(m[2], root)}`);
  }
  return [...files].sort();
}

/** Strip the run's own root (and any leading `./`) so the two sides compare. */
export function relativeToRoot(file: string, root: string): string {
  const norm = (v: string) => v.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  const r = root ? norm(root) : '';
  const rel = r && f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
  return rel.replace(/^\.\//, '');
}
