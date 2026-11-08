#!/usr/bin/env node

// Prepares the body handed to `gh release create`. GitHub rejects release
// bodies over 125000 characters, and that rejection lands *after* the npm
// packages have been published, so an oversized or empty changelog has to
// degrade the notes rather than the release.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GitHub's limit is 125000; the margin absorbs the finalize step's rewrite and
// any counting difference between code points and UTF-16 units.
export const MAX_BODY_CHARS = 120000;

const TRUNCATION_NOTE = '_Release notes were truncated._';

/**
 * @returns {{body: string, truncated: boolean, fallback: boolean}} a body that
 * is non-empty and at most `maxChars` code points long.
 */
export function prepareReleaseNotes({
  body = '',
  tag,
  previousTag = '',
  repo = '',
  serverUrl = 'https://github.com',
  maxChars = MAX_BODY_CHARS,
}) {
  if (!tag) {
    throw new Error('prepareReleaseNotes requires a tag');
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return { body: `Release ${tag}`, truncated: false, fallback: true };
  }

  // Split on code points so a cut never lands inside a surrogate pair and
  // leaves the body invalid.
  const chars = Array.from(trimmed);
  if (chars.length <= maxChars) {
    return { body: trimmed, truncated: false, fallback: false };
  }

  const compare =
    previousTag && repo
      ? ` Full changelog: ${serverUrl}/${repo}/compare/${previousTag}...${tag}`
      : '';
  const footer = `\n\n${TRUNCATION_NOTE}${compare}`;
  const keep = maxChars - Array.from(footer).length;
  if (keep <= 0) {
    return { body: `Release ${tag}`, truncated: true, fallback: true };
  }

  return {
    body: `${chars.slice(0, keep).join('')}${footer}`,
    truncated: true,
    fallback: false,
  };
}

function parseArgs(argv) {
  const args = {
    file: '',
    tag: '',
    previousTag: '',
    repo: '',
    serverUrl: 'https://github.com',
    maxChars: MAX_BODY_CHARS,
  };
  const options = {
    '--file': 'file',
    '--tag': 'tag',
    '--previous-tag': 'previousTag',
    '--repo': 'repo',
    '--server-url': 'serverUrl',
    '--max-chars': 'maxChars',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = options[argv[index]];
    if (!key) {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argv[index]}`);
    }
    args[key] = key === 'maxChars' ? Number(value) : value;
    index += 1;
  }

  if (!args.file || !args.tag) {
    throw new Error('--file and --tag are required');
  }
  if (!Number.isInteger(args.maxChars) || args.maxChars <= 0) {
    throw new Error(`--max-chars must be a positive integer`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  let body = '';
  try {
    body = readFileSync(args.file, 'utf8');
  } catch {
    // A failed generate-notes call leaves no file; the fallback body covers it.
  }

  const result = prepareReleaseNotes({ ...args, body });
  writeFileSync(args.file, `${result.body}\n`);

  if (result.truncated) {
    process.stdout.write(
      `::warning::Release notes exceeded ${args.maxChars} characters; truncated\n`,
    );
  }
  if (result.fallback) {
    process.stdout.write(
      `::warning::No release notes were generated; using a minimal body\n`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
