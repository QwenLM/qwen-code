#!/usr/bin/env node
// .fork/generate-patches.js
//
// Regenerates the ordered fork patch stack from .fork/manifest.json.
// The diff base is the fork/upstream merge-base by default, not upstream HEAD.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const forkDir = path.join(repoRoot, '.fork');
const manifestPath = path.join(forkDir, 'manifest.json');
const args = new Set(process.argv.slice(2));
const action = args.has('--check') ? 'check' : 'write';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitOutput(gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyRef(ref, label) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    fail(`ERROR: ${label} ref is not available: ${ref}`, 2);
  }
}

function shortRef(ref) {
  return git(['rev-parse', '--short=9', ref]);
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) {
    fail(`ERROR: manifest not found: ${manifestPath}`, 2);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function resolveBase({ forkRef, upstreamRef }) {
  if (process.env.PATCH_BASE_REF) {
    verifyRef(process.env.PATCH_BASE_REF, 'PATCH_BASE_REF');
    return git(['rev-parse', process.env.PATCH_BASE_REF]);
  }
  return git(['merge-base', forkRef, upstreamRef]);
}

function renderHeader(definition, context) {
  const lines = [
    `Subject: ${definition.title ?? definition.file}`,
    `Reason: ${definition.reason ?? 'Long-lived fork customization.'}`,
    `Owner: ${definition.owner ?? 'DataWorks Qwen Code maintainers'}`,
    `Patch-Base: ${context.patchBaseSha}`,
    `Fork-Ref: ${context.forkRef} (${context.forkSha})`,
    `Upstream-Ref: ${context.upstreamRef}`,
    'Paths:',
    ...definition.paths.map((filePath) => `  - ${filePath}`),
  ];

  if (Array.isArray(definition.tests) && definition.tests.length > 0) {
    lines.push('Tests:', ...definition.tests.map((test) => `  - ${test}`));
  }

  // Blank line separates header from diff body (standard patch format)
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function normalizeContent(content) {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function buildPatch(definition, context) {
  const diff = gitOutput([
    'diff',
    '--binary',
    '--no-color',
    context.patchBaseSha,
    context.forkRef,
    '--',
    ...definition.paths,
  ]);

  if (diff.trim().length === 0) {
    return '';
  }
  return `${renderHeader(definition, context)}${normalizeContent(diff)}`;
}

function validateDefinitions(definitions) {
  const seen = new Set();
  for (const definition of definitions) {
    if (!definition.file || typeof definition.file !== 'string') {
      fail('ERROR: every patch definition requires a string "file"', 2);
    }
    if (seen.has(definition.file)) {
      fail(`ERROR: duplicate patch file in manifest: ${definition.file}`, 2);
    }
    seen.add(definition.file);
    if (!Array.isArray(definition.paths) || definition.paths.length === 0) {
      fail(`ERROR: ${definition.file} requires a non-empty paths array`, 2);
    }
  }
}

const manifest = readManifest();
const patchConfig = manifest.patches ?? {};
const definitions = patchConfig.definitions ?? [];

if (!Array.isArray(definitions) || definitions.length === 0) {
  fail('ERROR: .fork/manifest.json has no patches.definitions entries', 2);
}

validateDefinitions(definitions);

const upstreamRef = process.env.UPSTREAM_REF ?? 'upstream/main';
const forkRef = process.env.FORK_REF ?? 'origin/main';
verifyRef(upstreamRef, 'UPSTREAM_REF');
verifyRef(forkRef, 'FORK_REF');

const patchBaseSha = resolveBase({ forkRef, upstreamRef });
const context = {
  upstreamRef,
  upstreamSha: git(['rev-parse', upstreamRef]),
  forkRef,
  forkSha: git(['rev-parse', forkRef]),
  patchBaseSha,
};

const patchDirRel = patchConfig.directory ?? 'patches/';
const seriesRel = patchConfig.seriesFile ?? path.join(patchDirRel, 'series');
const patchDir = path.join(forkDir, patchDirRel);
const seriesPath = path.join(forkDir, seriesRel);
const generated = [];
const retired = [];
const empty = [];

for (const definition of definitions) {
  const status = definition.status ?? 'active';
  if (status === 'retired') {
    retired.push(definition.file);
    continue;
  }
  if (status !== 'active') {
    fail(`ERROR: ${definition.file} has unsupported status: ${status}`, 2);
  }

  const content = buildPatch(definition, context);
  if (!content) {
    empty.push(definition.file);
    continue;
  }

  if (definition.file.includes('..')) {
    fail(`ERROR: ${definition.file} contains path traversal sequence (..)`, 2);
  }
  const resolvedPath = path.resolve(patchDir, definition.file);
  if (
    !resolvedPath.startsWith(patchDir + path.sep) &&
    resolvedPath !== patchDir
  ) {
    fail(`ERROR: ${definition.file} escapes patch directory`, 2);
  }

  generated.push({
    file: definition.file,
    path: resolvedPath,
    content,
  });
}

if (empty.length > 0) {
  fail(
    [
      'ERROR: active patch definitions produced empty diffs.',
      'Retire them explicitly in .fork/manifest.json if upstream now covers them:',
      ...empty.map((file) => `  - ${file}`),
    ].join('\n'),
  );
}

const seriesContent = `${generated.map((entry) => entry.file).join('\n')}\n`;
const mismatches = [];

function currentFileContent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

if (action === 'check') {
  for (const entry of generated) {
    if (currentFileContent(entry.path) !== entry.content) {
      mismatches.push(entry.file);
    }
  }
  if (currentFileContent(seriesPath) !== seriesContent) {
    mismatches.push(path.relative(forkDir, seriesPath));
  }
  for (const file of retired) {
    const retiredPath = path.join(patchDir, file);
    if (fs.existsSync(retiredPath)) {
      mismatches.push(file);
    }
  }

  if (mismatches.length > 0) {
    fail(
      [
        'ERROR: generated fork patches are out of date:',
        ...mismatches.map((file) => `  - ${file}`),
        'Run: node .fork/generate-patches.js --write',
      ].join('\n'),
    );
  }
} else {
  fs.mkdirSync(patchDir, { recursive: true });
  for (const entry of generated) {
    fs.writeFileSync(entry.path, entry.content);
  }
  fs.writeFileSync(seriesPath, seriesContent);
  for (const file of retired) {
    const retiredPath = path.join(patchDir, file);
    if (fs.existsSync(retiredPath)) {
      fs.rmSync(retiredPath);
    }
  }
}

console.log(`patch_base: ${shortRef(patchBaseSha)}`);
console.log(`fork_ref: ${forkRef} (${shortRef(context.forkSha)})`);
console.log(`upstream_ref: ${upstreamRef} (${shortRef(context.upstreamSha)})`);
console.log(
  `${action === 'check' ? 'checked' : 'wrote'} ${generated.length} patch(es)`,
);
for (const entry of generated) {
  console.log(`  - ${entry.file}`);
}
for (const file of retired) {
  console.log(`retired: ${file}`);
}
