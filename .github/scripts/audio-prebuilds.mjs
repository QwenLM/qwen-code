/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIO_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
];

export function audioPrebuildKey(root, ref, workflowRoot) {
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const paths = git(
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    ref,
    '--',
    'packages/audio-capture',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.mjs',
    '.npmrc',
    'package.json',
  )
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();
  // Older release refs have no frozen native dependency graph to reuse.
  if (!paths.includes('pnpm-lock.yaml')) return '';
  const hash = createHash('sha256');
  const add = (name, data) =>
    hash.update(JSON.stringify([name, Buffer.from(data).toString('base64')]));
  for (const path of paths) {
    // Tree entries include the content ID and mode without buffering large headers.
    let data = git('ls-tree', ref, '--', path);
    if (path === 'packages/audio-capture/package.json') {
      const manifest = JSON.parse(git('show', `${ref}:${path}`));
      delete manifest.version;
      data = JSON.stringify(manifest);
    } else if (path === 'package.json') {
      data = JSON.stringify({
        packageManager: JSON.parse(git('show', `${ref}:${path}`))
          .packageManager,
      });
    }
    add(path, data);
  }
  for (const path of [
    '.github/workflows/audio-capture-prebuilds.yml',
    '.github/scripts/audio-prebuilds.mjs',
  ])
    add(path, readFileSync(join(workflowRoot, path)));
  return hash.digest('hex');
}

export function validateAudioPrebuilds(directory) {
  if (!lstatSync(directory).isDirectory())
    throw new Error('Invalid prebuild directory');
  const targets = readdirSync(directory).sort();
  if (JSON.stringify(targets) !== JSON.stringify([...AUDIO_TARGETS].sort())) {
    throw new Error(
      'Audio prebuilds must contain exactly the five release targets',
    );
  }
  for (const target of targets) {
    const targetPath = join(directory, target);
    if (!lstatSync(targetPath).isDirectory())
      throw new Error(`Invalid target: ${target}`);
    const files = readdirSync(targetPath);
    if (!files.length) throw new Error(`Missing native binary: ${target}`);
    for (const file of files) {
      const stat = lstatSync(join(targetPath, file));
      if (!file.endsWith('.node') || !stat.isFile() || stat.size === 0) {
        throw new Error(`Invalid native binary: ${target}/${file}`);
      }
    }
  }
}

// Selection demands enough retention to outlive the rest of the release;
// consumption only demands that the bytes are still there. Re-applying the
// margin downstream would reject an artifact that prepare already committed
// to, after the fresh-build job was skipped and with no fallback left.
export const AUDIO_SELECTION_MARGIN_MS = 48 * 60 * 60 * 1000;

export async function verifyAudioArtifact(
  github,
  repo,
  artifact,
  key,
  now = Date.now(),
  marginMs = 0,
) {
  if (
    !key ||
    artifact.name !== `audio-capture-prebuilds-${key}` ||
    artifact.expired ||
    !(Date.parse(artifact.expires_at) >= now + marginMs) ||
    artifact.workflow_run?.head_branch !== 'main' ||
    artifact.workflow_run.repository_id !==
      artifact.workflow_run.head_repository_id
  ) {
    throw new Error(
      'Audio artifact has an invalid identity, source, or retention',
    );
  }
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repo,
    run_id: artifact.workflow_run.id,
  });
  const repository = `${repo.owner}/${repo.repo}`;
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.path !== '.github/workflows/release.yml' ||
    !['workflow_dispatch', 'schedule'].includes(run.event) ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  ) {
    throw new Error(
      'Audio artifact must come from a successful official main release',
    );
  }
  return { artifact_id: artifact.id, run_id: run.id };
}

export async function findAudioArtifact(github, repo, key, warn) {
  if (!key) return undefined;
  try {
    const { data } = await github.rest.actions.listArtifactsForRepo({
      ...repo,
      name: `audio-capture-prebuilds-${key}`,
      per_page: 100,
    });
    for (const artifact of data.artifacts) {
      try {
        return await verifyAudioArtifact(
          github,
          repo,
          artifact,
          key,
          Date.now(),
          AUDIO_SELECTION_MARGIN_MS,
        );
      } catch (error) {
        warn(`Skipping audio artifact ${artifact.id}: ${error.message}`);
      }
    }
  } catch (error) {
    warn(`Audio reuse lookup failed; rebuilding: ${error.message}`);
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'key') {
    console.log(
      `cache_key=${audioPrebuildKey(process.cwd(), args[0], args[1])}`,
    );
  } else if (command === 'validate') {
    validateAudioPrebuilds(args[0]);
  } else {
    throw new Error(`Unknown audio prebuild command: ${command}`);
  }
}
