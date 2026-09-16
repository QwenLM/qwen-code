#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Does this change need the macOS and Windows lanes?
//
// Those lanes are the only signal this repository has about a host that is not
// Linux with a GNU userland, and they are expensive, so they run on the diffs
// whose behaviour the HOST decides rather than the code: shell scripts and the
// CI definitions that embed shell (a GNU-only flag, a BSD `sed`, a path
// separator), the script layer and its tests, the test-runner configuration
// that says which suites run where, and the handful of source subtrees named
// after a platform-coupled subsystem.
//
// This list is deliberately a NET, not a proof. It cannot see a platform
// assumption inside an ordinary source file — one that resolves a path, spawns
// a process, or compares two spellings of the same directory — and no
// path-based rule ever will. That gap is what the scheduled run on `main`
// exists for: this classifier buys an early signal on the diffs that carry the
// known failure class, and the nightly catches the rest a day later. Widening
// the list until it matches everything would just restore the cost the lanes
// were moved off pull requests to avoid.
//
// Fail-safe in every direction: an unreadable list, an unparsable entry, or no
// entries at all classifies as sensitive. A missed lane is a defect that ships;
// a needless lane is twenty minutes.

export const PLATFORM_SENSITIVE = 'true';
export const PLATFORM_INSENSITIVE = 'false';

// Anything a shell interprets. `.ps1`/`.bat`/`.cmd` are here for the same
// reason as `.sh`: they are the Windows lane's subject, not an exception to it.
const SHELL_SCRIPT = /\.(?:sh|bash|zsh|ps1|bat|cmd)$/i;

// Workflow and composite-action YAML embeds shell in `run:` blocks, and the
// scripts those blocks call are part of the same program.
const CI_DEFINITION = /^\.github\/(?:workflows|actions|scripts)\//;

// The script layer and its tests: this repository's build, release and CI
// helpers, the suites that drive them, and the fixtures those suites build out
// of real filesystem paths.
const SCRIPT_LAYER = /^scripts\//;

// Which suites run on which lane is itself platform-deciding: an exclusion list
// keyed on `process.platform` is exactly how a suite ends up unrun on one host
// and red on another.
const RUNNER_CONFIG = /(?:^|\/)vitest(?:\.[^/]*)?\.config\.[cm]?[jt]s$/i;

// The dependency and script manifests: a changed `test:ci`, a native module, or
// an optional per-platform dependency changes what each lane executes.
const MANIFEST = new Set(['package.json', 'package-lock.json']);

// Source subtrees whose subject IS the host.
//
// A keyword counts when it NAMES the thing: a whole path segment
// (`src/sandbox/index.ts`, `src/platform/paths.ts`) or the head of a file's
// stem (`pty-host.ts`, `win32.ts`, `shell.ts`). It does not count inside a
// compound that names something else — `packages/web-shell/**` is a browser
// UI, not a shell, and matching it there summoned both expensive lanes on
// every change to one of this repository's largest packages. Nor inside a
// longer word: `Shellfish.tsx`, `plateauDetector.ts`, `cryptic.ts`.
const SUBSYSTEMS =
  'pty|tty|sandbox|seatbelt|shell|terminal|clipboard|platform|posix|darwin|macos|windows|win32|linux|keychain|codesign|installer|filesystem|audio';
// A directory or file segment that IS the keyword (optionally with an
// extension): `sandbox/`, `shell.ts`, `win32.test.ts`.
const SUBSYSTEM_SEGMENT = new RegExp(
  `(?:^|/)(?:${SUBSYSTEMS})(?:\\.[^/]*)?(?:/|$)`,
  'i',
);
// Or the keyword as the head of a hyphen/underscore-separated stem:
// `pty-host.ts`, `shell_exec.ts`. The head only — a trailing part belongs to
// whatever the leading word names.
const SUBSYSTEM_STEM_HEAD = new RegExp(
  `(?:^|/)(?:${SUBSYSTEMS})[-_][^/]*(?:/|$)`,
  'i',
);

function isSensitivePath(file) {
  const p = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return true;
  return (
    SHELL_SCRIPT.test(p) ||
    CI_DEFINITION.test(p) ||
    SCRIPT_LAYER.test(p) ||
    RUNNER_CONFIG.test(p) ||
    MANIFEST.has(p) ||
    SUBSYSTEM_SEGMENT.test(p) ||
    SUBSYSTEM_STEM_HEAD.test(p)
  );
}

/**
 * Every name an entry touches. A rename moves a file between two paths, and
 * either side can be the sensitive one — a script moved out of `scripts/` is
 * still a script change on the lane that ran it.
 */
function namesOf(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  return [entry.filename, entry.previous_filename].filter(
    (n) => typeof n === 'string' && n.length > 0,
  );
}

export function classifyChangedFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    return PLATFORM_SENSITIVE;
  for (const entry of entries) {
    const names = namesOf(entry);
    // An entry that carries no usable name is an unknown change, and an
    // unknown change is sensitive.
    if (names.length === 0) return PLATFORM_SENSITIVE;
    if (names.some(isSensitivePath)) return PLATFORM_SENSITIVE;
  }
  return PLATFORM_INSENSITIVE;
}

/** The JSONL contract of classify-pr-profile.sh: one projected entry per line. */
export function parseChangedFiles(text) {
  return (
    String(text)
      // `\r?\n`, matching the sibling classifier's reader: a CRLF listing would
      // otherwise leave a trailing `\r` on every filename and defeat the
      // end-anchored suffix rules above.
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // Not JSON: treat the raw line as a filename rather than dropping it.
          return line;
        }
      })
  );
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(PLATFORM_SENSITIVE);
    return;
  }
  try {
    console.log(
      classifyChangedFiles(parseChangedFiles(readFileSync(filePath, 'utf8'))),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`::warning::Failed to read changed files: ${message}`);
    console.log(PLATFORM_SENSITIVE);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
