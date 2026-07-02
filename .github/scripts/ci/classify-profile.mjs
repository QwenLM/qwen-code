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
  return (
    /\.(?:md|mdx)$/i.test(file) ||
    /^(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|LICENSE|NOTICE)(?:\..*)?$/i.test(
      file,
    )
  );
}

export function classifyChangedFiles(files) {
  const changedFiles = files.filter(Boolean);
  if (changedFiles.length === 0) return CI_PROFILES.FULL;

  if (changedFiles.every(isDocsOnlyFile)) {
    return CI_PROFILES.DOCS_ONLY;
  }

  if (changedFiles.every((file) => GITHUB_CI_ONLY_FILES.has(file))) {
    return CI_PROFILES.GITHUB_CI_ONLY;
  }

  return CI_PROFILES.FULL;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(CI_PROFILES.FULL);
    return;
  }

  try {
    const files = readFileSync(filePath, 'utf8').split(/\r?\n/);
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
