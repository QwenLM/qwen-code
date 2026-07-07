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
      'printf "ARGS:%s\\n" "$*" >> "${QWEN_OSSUTIL_LOG}"',
      'if [ "$1" = "cp" ] && { [[ "$4" == *deploy-qwen.sh ]] || [[ "$4" == *upgrade-qwen.sh ]]; }; then',
      '  printf "SCRIPT_DEST:%s\\n" "$4" >> "${QWEN_OSSUTIL_LOG}"',
      '  grep "EMBEDDED_QWEN_OSS_BASE_URL=" "$3" >> "${QWEN_OSSUTIL_LOG}" || true',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(ossutil, 0o755);
  writeFile(logFile, '');
}

function makeFakeStsResolver(tmpDir) {
  const resolver = path.join(tmpDir, 'resolve-oss-sts.sh');
  writeFile(
    resolver,
    [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  public)',
      "    cat <<'EOF'",
      "OSS_TARGET='public'",
      "OSS_ENDPOINT='https://oss-cn-shanghai.aliyuncs.com'",
      "OSS_BUCKET='dataworks-notebook-cn-shanghai'",
      "OSS_ACCESS_KEY_ID='public-ak'",
      "OSS_ACCESS_KEY_SECRET='public-secret'",
      "OSS_SECURITY_TOKEN='public-token'",
      'EOF',
      '    ;;',
      '  finance)',
      "    cat <<'EOF'",
      "OSS_TARGET='finance'",
      "OSS_ENDPOINT='https://oss-cn-shanghai-finance-1.aliyuncs.com'",
      "OSS_BUCKET='dataworks-notebook-cn-shanghai-finance-1'",
      "OSS_ACCESS_KEY_ID='finance-ak'",
      "OSS_ACCESS_KEY_SECRET='finance-secret'",
      "OSS_SECURITY_TOKEN='finance-token'",
      'EOF',
      '    ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  return resolver;
}

function runUploadOss(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-oss-upload-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const artifactDir = path.join(tmpDir, 'artifact');
  const binDir = path.join(tmpDir, 'bin');
  const logFile = path.join(tmpDir, 'ossutil.log');
  const stsResolver = makeFakeStsResolver(tmpDir);
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
          BOOTSTRAP_TOKEN: 'header.payload.signature',
          OSS_STS_RESOLVER: stsResolver,
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
  it('uploads requested channel metadata pointers to public and finance with zero-trust STS', () => {
    const ossutilLog = runUploadOss({
      OSS_RELEASE_CHANNELS: 'beta dataworks',
    });

    expect(ossutilLog).toContain(
      'ARGS:config -e https://oss-cn-shanghai.aliyuncs.com -i public-ak -k public-secret -t public-token',
    );
    expect(ossutilLog).toContain(
      'ARGS:config -e https://oss-cn-shanghai-finance-1.aliyuncs.com -i finance-ak -k finance-secret -t finance-token',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/beta/metadata.json',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/dataworks/metadata.json',
    );
    expect(ossutilLog).not.toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/latest/metadata.json',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai-finance-1/public-datasets/aone-release/alishu/qwen-code/beta/metadata.json',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai-finance-1/public-datasets/aone-release/alishu/qwen-code/dataworks/metadata.json',
    );
    expect(ossutilLog).not.toContain(
      'oss://dataworks-notebook-cn-shanghai-finance-1/public-datasets/aone-release/alishu/qwen-code/latest/metadata.json',
    );
    expect(ossutilLog).toContain(
      'EMBEDDED_QWEN_OSS_BASE_URL="https://dataworks-notebook-cn-shanghai-finance-1.oss-cn-shanghai-finance-1.aliyuncs.com/public-datasets/aone-release/alishu/qwen-code"',
    );
  });

  it('updates latest metadata pointers on both targets when latest is not skipped', () => {
    const ossutilLog = runUploadOss({
      SKIP_LATEST_POINTER: '',
    });

    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai/public-datasets/aone-release/alishu/qwen-code/latest/metadata.json',
    );
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai-finance-1/public-datasets/aone-release/alishu/qwen-code/latest/metadata.json',
    );
  });

  it('keeps legacy AK/SK as an explicit fallback mode', () => {
    const ossutilLog = runUploadOss({
      OSS_CREDENTIAL_MODE: 'aksk',
      OSS_UPLOAD_TARGETS: 'finance',
      OSS_ACCESS_KEY_ID: 'legacy-ak',
      OSS_ACCESS_KEY_SECRET: 'legacy-secret',
    });

    expect(ossutilLog).toContain(
      'ARGS:config -e https://oss-cn-shanghai-finance-1.aliyuncs.com -i legacy-ak -k legacy-secret',
    );
    expect(ossutilLog).not.toContain('-t finance-token');
    expect(ossutilLog).toContain(
      'oss://dataworks-notebook-cn-shanghai-finance-1/public-datasets/aone-release/alishu/qwen-code/0.15.10-beta.2/qwen-code-0.15.10-beta.2-linux-amd64.tar.gz',
    );
  });

  it('leaves bootstrap token validation to the zero-trust provider', () => {
    const resolver = fs.readFileSync(
      path.join(rootDir, '.aoneci/scripts/resolve-oss-sts.sh'),
      'utf-8',
    );

    expect(resolver).toContain('BOOTSTRAP_TOKEN is required');
    expect(resolver).not.toContain('decode_jwt_payload');
    expect(resolver).not.toContain('invalid bootstrap token payload');
    expect(resolver).not.toContain('BOOTSTRAP_TOKEN expired');
  });

  it('wires npm beta publish to the OSS beta metadata channel', () => {
    const workflow = fs.readFileSync(
      path.join(rootDir, '.aoneci/npm-publish.yml'),
      'utf-8',
    );

    expect(workflow).toContain('OSS_RELEASE_CHANNELS="beta"');
    expect(workflow).toContain('SKIP_LATEST_POINTER="1"');
    expect(workflow).toContain(
      'OSS_RELEASE_CHANNELS="${OSS_RELEASE_CHANNELS:-}"',
    );
    expect(workflow).toContain('BOOTSTRAP_TOKEN: ${{secrets.BOOTSTRAP_TOKEN}}');
    expect(workflow).toContain('OSS_UPLOAD_TARGETS: "public finance"');
    expect(workflow).not.toContain('DW_NOTEBOOK_OSS_ACCESS_KEY_ID');
    expect(workflow).not.toContain('DW_NOTEBOOK_OSS_ACCESS_KEY_SECRET');
  });

  it('wires rollback OSS pointer updates through the zero-trust dual-target helpers', () => {
    const workflow = fs.readFileSync(
      path.join(rootDir, '.aoneci/release-rollback.yml'),
      'utf-8',
    );

    expect(workflow).toContain('BOOTSTRAP_TOKEN: ${{secrets.BOOTSTRAP_TOKEN}}');
    expect(workflow).toContain('OSS_UPLOAD_TARGETS: "public finance"');
    expect(workflow).toContain('. "${SCRIPT_DIR}/oss-targets.sh"');
    expect(workflow).toContain('oss_configure_target "${TARGET}"');
    expect(workflow).not.toContain('DW_NOTEBOOK_OSS_ACCESS_KEY_ID');
    expect(workflow).not.toContain('DW_NOTEBOOK_OSS_ACCESS_KEY_SECRET');
  });
});
