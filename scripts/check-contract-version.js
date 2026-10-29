/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Every pull request that changes the public Managed Agent contract bumps
// its info.version by hand, and until #13804 nothing checked that number:
// on 2026-10-09 two in-flight pull requests declared 1.34.0 while main was
// already at 1.35.0, and the stall had reached main once before — #13163
// changed the document with no version movement at all. A duplicate Flyway
// version refuses to boot within minutes, but a regressed or stalled
// contract version breaks nothing at runtime; it silently misinforms every
// consumer that keys capability detection on it. This is the PR-time check
// of #13804, run by the SDK Java workflow's fast guard lane on every pull
// request: given the base ref's copy of the document and the merge
// result's copy, it fails when a CHANGED document declares a version equal
// to or below the base ref's, naming which of the two modes it is. The
// comparison keys on the documents' contents, not a changed-paths list, so
// a merge result whose copy already advanced (another pull request landed)
// reads as regressed-or-stalled instead of passing on a stale branch
// point; the version comparison itself is numeric per segment, so 1.9.0
// ranks below 1.37.0.

import { existsSync, readFileSync } from 'node:fs';
import { compareVersions, documentVersion } from './contract-version-utils.js';
import { escapeWorkflowCommand } from './release-script-utils.js';

// The same binding check-flyway-migrations.js applies: a `::error::`
// command's data is runner-DECODED when the downloadable log is rendered,
// so nothing outside a path's real alphabet may reach it — every other
// byte becomes %XX first, with the shared helper's escape on top, so no
// decode pass can turn the text back into control bytes. A path reaching
// this script through its command line could otherwise smuggle a forged
// second `::error::` line into the log.
const boundWorkflowPath = (text) =>
  escapeWorkflowCommand(
    String(text).replace(
      /[^A-Za-z0-9._/-]/g,
      (char) =>
        `%${char.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    ),
  );

const [baseFile, headFile, extra] = process.argv.slice(2);
if (!baseFile || !headFile || extra) {
  console.error(
    'usage: node scripts/check-contract-version.js <base-document> <head-document>',
  );
  process.exit(2);
}

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const read = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
const base = read(baseFile);
const head = read(headFile);

// The head first: a renamed document empties both reads, and its message
// names what happened. A missing or empty base copy can only mean the
// fetch or the path itself rotted — answered as an error too, never a
// silent pass.
if (!head) {
  fail(
    `${boundWorkflowPath(headFile)}: the contract document is missing or ` +
      'empty; if it moved, point this check at the new location',
  );
}
if (!base) {
  fail(
    `${boundWorkflowPath(baseFile)}: could not read the base ref's copy ` +
      'of the contract document; nothing to compare against',
  );
}

// Same bytes, same version: the pull request changed nothing the version
// exists to signal, even when the changed-paths list names the document.
// This arm runs before either copy is parsed so a baseline anomaly never
// blocks a pull request that makes no claim on it.
if (head === base) {
  console.log(
    `${boundWorkflowPath(headFile)}: identical to the base ref's copy; no version check needed`,
  );
  process.exit(0);
}

const headRead = documentVersion(head);
if (!headRead.version) {
  fail(
    `${boundWorkflowPath(headFile)}: the contract document ${headRead.error}`,
  );
}
const baseRead = documentVersion(base);
if (!baseRead.version) {
  fail(`${boundWorkflowPath(baseFile)}: the base ref's copy ${baseRead.error}`);
}

const order = compareVersions(headRead.version, baseRead.version);
if (order > 0) {
  console.log(
    `${boundWorkflowPath(headFile)}: info.version ${headRead.version} advances past ` +
      `the base ref's ${baseRead.version}`,
  );
  process.exit(0);
}
if (order === 0) {
  fail(
    `${boundWorkflowPath(headFile)} declares info.version ` +
      `${headRead.version}, which does not advance past the base ref's ` +
      `${baseRead.version} while the document changed; bump the version`,
  );
}
fail(
  `${boundWorkflowPath(headFile)} declares info.version ` +
    `${headRead.version}, which regresses below the base ref's ` +
    `${baseRead.version} while the document changed; bump info.version ` +
    `past ${baseRead.version}`,
);
