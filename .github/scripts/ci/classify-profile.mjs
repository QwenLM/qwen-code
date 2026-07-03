#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export const CI_PROFILES = {
  DOCS_ONLY: 'docs_only',
  GITHUB_CI_ONLY: 'github_ci_only',
  FULL: 'full',
};

export const GITHUB_CI_ONLY_FILES = new Set([
  '.github/scripts/pr-safety-precheck.mjs',
  '.github/scripts/pr-safety-precheck.test.mjs',
  '.github/workflows/qwen-pr-safety-precheck.yml',
]);

function isDocsOnlyFile(file) {
  const normalized = file.replace(/\\/g, '/');
  return (
    /^docs\/.+\.(?:md|mdx)$/i.test(normalized) ||
    /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|LICENSE|NOTICE)(?:\.[^/]*)?$/i.test(
      normalized,
    )
  );
}

function classifyPath(file) {
  if (isDocsOnlyFile(file)) return CI_PROFILES.DOCS_ONLY;
  if (GITHUB_CI_ONLY_FILES.has(file)) return CI_PROFILES.GITHUB_CI_ONLY;
  return CI_PROFILES.FULL;
}

function classifyFileEntry(entry) {
  if (typeof entry === 'string') return classifyPath(entry);

  const filename = entry?.filename;
  if (!filename) return CI_PROFILES.FULL;

  const profile = classifyPath(filename);
  if (entry.status !== 'renamed') return profile;

  const previousProfile = entry.previous_filename
    ? classifyPath(entry.previous_filename)
    : CI_PROFILES.FULL;
  return previousProfile === profile ? profile : CI_PROFILES.FULL;
}

export function classifyChangedFiles(files) {
  const changedFiles = files.filter(Boolean);
  if (changedFiles.length === 0) return CI_PROFILES.FULL;

  if (
    changedFiles.every(
      (entry) => classifyFileEntry(entry) === CI_PROFILES.DOCS_ONLY,
    )
  ) {
    return CI_PROFILES.DOCS_ONLY;
  }

  if (
    changedFiles.every(
      (entry) => classifyFileEntry(entry) === CI_PROFILES.GITHUB_CI_ONLY,
    )
  ) {
    return CI_PROFILES.GITHUB_CI_ONLY;
  }

  return CI_PROFILES.FULL;
}

function parseChangedFiles(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(CI_PROFILES.FULL);
    return;
  }

  try {
    const files = parseChangedFiles(readFileSync(filePath, 'utf8'));
    console.log(classifyChangedFiles(files));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`::warning::Failed to read changed files: ${message}`);
    console.log(CI_PROFILES.FULL);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
