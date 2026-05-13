/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(import.meta.dirname, '../..');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeFakeOssutil(binDir, logFile) {
  const ossutil = path.join(binDir, 'ossutil');
  writeFile(
    ossutil,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "${QWEN_OSSUTIL_LOG}"',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(ossutil, 0o755);
  writeFile(logFile, '');
}

function runUploadOss(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-oss-upload-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const artifactDir = path.join(tmpDir, 'artifact');
  const binDir = path.join(tmpDir, 'bin');
  const logFile = path.join(tmpDir, 'ossutil.log');
  const version = '0.15.10-beta.2';
  const tarball = `qwen-code-${version}-linux-amd64.tar.gz`;

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(artifactDir, { recursive: true });
    makeFakeOssutil(binDir, logFile);
    writeFile(path.join(workspaceDir, '.resolved_version'), `${version}\n`);
    writeFile(path.join(artifactDir, tarball), 'fake tarball');
    writeFile(path.join(artifactDir, 'SHA256SUMS'), `sha256  ${tarball}\n`);
    writeFile(
      path.join(artifactDir, 'metadata.json'),
      JSON.stringify({ version }, null, 2),
    );

    execFileSync(
      'bash',
      [path.join(rootDir, '.aoneci/scripts/upload-oss.sh')],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          QWEN_OSSUTIL_LOG: logFile,
          ARTIFACT_DIR: artifactDir,
          ARCH: 'amd64',
          SOURCE_DIR: path.join(tmpDir, 'source'),
          WORKSPACE_DIR: workspaceDir,
          OSS_GROUP: 'alishu',
          OSS_PROJECT: 'qwen-code',
          OSS_ACCESS_KEY_ID: 'test-ak',
          OSS_ACCESS_KEY_SECRET: 'test-secret',
          SKIP_LATEST_POINTER: '1',
          SKIP_ROOT_SCRIPTS: '1',
          ...extraEnv,
        },
      },
    );

    return fs.readFileSync(logFile, 'utf-8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('DataWorks OSS upload', () => {
  it('updates requested channel metadata pointers without updating latest', () => {
    const ossutilLog = runUploadOss({
      OSS_RELEASE_CHANNELS: 'beta dataworks',
    });

    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/beta/metadata.json',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/dataworks/metadata.json',
    );
    expect(ossutilLog).not.toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/latest/metadata.json',
    );
  });

  it('wires npm beta publish to the OSS beta metadata channel', () => {
    const workflow = fs.readFileSync(
      path.join(rootDir, '.aoneci/npm-publish.yml'),
      'utf-8',
    );

    expect(workflow).toContain('OSS_RELEASE_CHANNELS="beta"');
    expect(workflow).toContain('OSS_LATEST_POINTER="skip"');
    expect(workflow).toContain(
      'OSS_RELEASE_CHANNELS="${OSS_RELEASE_CHANNELS}"',
    );
  });
});
