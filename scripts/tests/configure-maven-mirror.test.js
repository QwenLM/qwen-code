/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../.github/scripts/configure-maven-mirror.sh', import.meta.url),
);

function render(env, probeExit) {
  const root = mkdtempSync(join(tmpdir(), 'mirror-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const curl = join(bin, 'curl');
    writeFileSync(curl, `#!/bin/sh\nexit ${probeExit}\n`);
    chmodSync(curl, 0o755);
    const runnerTemp = join(root, 'runner-temp');
    mkdirSync(runnerTemp);
    spawnSync('bash', [script], {
      env: {
        ...process.env,
        ...env,
        RUNNER_TEMP: runnerTemp,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });
    return readFileSync(
      join(runnerTemp, 'setup-java-m2', 'settings.xml'),
      'utf8',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('configure-maven-mirror', () => {
  it('prefers the intranet mirror the pool hosts can read without public bandwidth', () => {
    expect(render({}, 0)).toContain(
      'http://mirrors.cloud.aliyuncs.com/maven/repository/public',
    );
  });

  it('falls back to the public mirror when the probe fails', () => {
    const xml = render({}, 22);
    expect(xml).toContain('https://maven.aliyun.com/repository/public');
    expect(xml).not.toContain('mirrors.cloud.aliyuncs.com');
  });

  it('honours an explicit MAVEN_MIRROR_URL', () => {
    expect(
      render({ MAVEN_MIRROR_URL: 'https://example.test/m2' }, 22),
    ).toContain('https://example.test/m2');
  });

  it('keeps the github server entry the Maven steps expect', () => {
    const xml = render({}, 0);
    expect(xml).toContain('<id>github</id>');
    expect(xml).toContain('${env.GITHUB_ACTOR}');
  });
});
