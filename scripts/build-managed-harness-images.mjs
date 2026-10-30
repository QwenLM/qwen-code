/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const directory = 'packages/managed-agent-server/distribution/kubernetes';
const root = fileURLToPath(new URL('../', import.meta.url));

export function imageBuildPlan(sourceSha, prefix) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new Error('source-sha must be a full immutable commit');
  if (
    !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+$/u.test(
      prefix,
    )
  )
    throw new Error('image-prefix must be a registry repository prefix');
  const images = Object.fromEntries(
    ['harness', 'java', 'worker'].map((name) => [
      name,
      `${prefix}-${name}:sha-${sourceSha}`,
    ]),
  );
  const common = [
    'build',
    '--platform',
    'linux/amd64',
    '--label',
    `org.opencontainers.image.revision=${sourceSha}`,
  ];
  return {
    sourceSha,
    platform: 'linux/amd64',
    images,
    commands: [
      [
        ...common,
        '--pull',
        '-f',
        `${directory}/Dockerfile`,
        '-t',
        images.harness,
        '.',
      ],
      [
        ...common,
        '--pull',
        '-f',
        'packages/managed-agent-server/Dockerfile',
        '-t',
        images.java,
        '.',
      ],
      [
        ...common,
        '-f',
        `${directory}/qualification/Dockerfile`,
        '--build-arg',
        `SERVER_IMAGE=${images.java}`,
        '--build-arg',
        `HARNESS_IMAGE=${images.harness}`,
        '-t',
        images.worker,
        '.',
      ],
    ],
    publishedDigests: {},
    buildStatus: 'PLANNED_NOT_EXECUTED',
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      'source-sha': { type: 'string' },
      'image-prefix': { type: 'string' },
      output: { type: 'string' },
      execute: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/build-managed-harness-images.mjs --source-sha SHA --image-prefix REGISTRY/PREFIX --output images.json [--execute] [--push]',
    );
    return;
  }
  if (!values.output || (values.push && !values.execute))
    throw new Error('output is required; push additionally requires execute');
  const plan = imageBuildPlan(values['source-sha'], values['image-prefix']);
  mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  const save = () =>
    writeFileSync(values.output, JSON.stringify(plan, null, 2) + '\n', {
      mode: 0o600,
    });
  writeFileSync(values.output, JSON.stringify(plan, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  if (!values.execute) {
    console.log(
      JSON.stringify({ buildStatus: plan.buildStatus, report: values.output }),
    );
    return;
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'qwen-harness-images-'));
  try {
    execFileSync(
      'git',
      [
        'cat-file',
        '-e',
        `${plan.sourceSha}:${directory}/qualification/Dockerfile`,
      ],
      { cwd: root, stdio: 'pipe' },
    );
    const archive = path.join(temporary, 'source.tar');
    const source = path.join(temporary, 'source');
    mkdirSync(source);
    execFileSync(
      'git',
      ['archive', '--format=tar', '--output', archive, plan.sourceSha],
      { cwd: root },
    );
    execFileSync('tar', ['-xf', archive, '-C', source]);
    for (const args of plan.commands)
      execFileSync('docker', args, { cwd: source, stdio: 'inherit' });
    plan.buildStatus = 'BUILT_NOT_PUBLISHED';
    if (values.push) {
      for (const name of ['harness', 'worker']) {
        const image = plan.images[name];
        execFileSync('docker', ['push', image], { stdio: 'inherit' });
        const [metadata] = JSON.parse(
          execFileSync('docker', ['image', 'inspect', image], {
            encoding: 'utf8',
          }),
        );
        const repository = image.slice(0, image.lastIndexOf(':'));
        const digest = metadata.RepoDigests?.find((entry) =>
          entry.startsWith(`${repository}@sha256:`),
        );
        if (
          !digest ||
          metadata.Config?.Labels?.['org.opencontainers.image.revision'] !==
            plan.sourceSha
        )
          throw new Error('Published image provenance could not be verified');
        plan.publishedDigests[name] = digest;
        save();
      }
      plan.buildStatus = 'PUBLISHED';
    }
  } catch (error) {
    plan.buildStatus = 'FAILED';
    throw error;
  } finally {
    save();
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch {
    console.error(
      'Image build failed; inspect the build log and report. No local image ID is accepted as a published digest.',
    );
    process.exitCode = 1;
  }
}
