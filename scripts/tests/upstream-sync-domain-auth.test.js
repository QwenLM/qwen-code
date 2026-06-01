/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.unmock('fs');
vi.unmock('node:fs');

const {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = await import('node:fs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const scriptSource = join(
  repoRoot,
  '.aoneci',
  'scripts',
  'upstream-sync-domain-auth.sh',
);

const tempDirs = [];

function writeFile(filePath, content = '') {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('upstream-sync-domain-auth.sh', () => {
  it('prepares a copy-only workspace by initializing git and checking out the source branch', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });
    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  if [ -d .git ]; then
    echo ".git"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "init" ]; then
  mkdir -p .git
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  echo "deadbeef\trefs/heads/$4"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    execFileSync('bash', [scriptPath, 'prepare'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        DOMAIN_USER: 'tester',
        DOMAIN_PASSWORD: 'token-123',
        REPO_PATH: 'alishu/qwen-code',
        SOURCE_BRANCH: 'feat/upstream-sync-automation',
        GIT_USER_NAME: 'ci-bot',
        GIT_USER_EMAIL: 'ci@example.com',
      },
    });

    const commands = readFileSync(gitLog, 'utf8');
    expect(existsSync(join(tempRoot, '.git'))).toBe(true);
    expect(commands).toContain('init');
    expect(commands).toContain(
      'remote add origin https://tester:token-123@code.alibaba-inc.com/alishu/qwen-code.git',
    );
    expect(commands).toContain('fetch origin feat/upstream-sync-automation');
    expect(commands).toContain(
      'checkout -B feat/upstream-sync-automation origin/feat/upstream-sync-automation',
    );
  }, 15000);

  it('accepts token-only auth without requiring a separate username', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });
    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  if [ -d .git ]; then
    echo ".git"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "init" ]; then
  mkdir -p .git
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    execFileSync('bash', [scriptPath, 'prepare'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        DOMAIN_PASSWORD: 'token-only-123',
        REPO_PATH: 'alishu/qwen-code',
        SOURCE_BRANCH: 'feat/upstream-sync-automation',
      },
    });

    const commands = readFileSync(gitLog, 'utf8');
    expect(commands).toContain(
      'remote add origin https://oauth2:token-only-123@code.alibaba-inc.com/alishu/qwen-code.git',
    );
    expect(commands).toContain('checkout -B feat/upstream-sync-automation');
  }, 15000);

  it('does not require auth during prepare when checkout already has a git repo', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });
    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "git@gitlab.alibaba-inc.com:alishu/qwen-code.git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    execFileSync('bash', [scriptPath, 'prepare'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
      },
    });

    const commands = readFileSync(gitLog, 'utf8');
    expect(commands).toContain('config user.name aone-ci-bot');
    expect(commands).not.toContain('init');
    expect(commands).not.toContain('remote add origin');
  }, 15000);

  it('derives repo path from origin when publishing without REPO_PATH', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const curlLog = join(tempRoot, 'curl.log');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });

    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "git@gitlab.alibaba-inc.com:alishu/qwen-code.git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    writeFile(
      join(mockBin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
cat <<'EOF'
{"web_url":"https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/43"}
201
EOF
`,
    );
    chmodSync(join(mockBin, 'curl'), 0o755);

    execFileSync('bash', [scriptPath, 'publish'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_CURL_LOG: curlLog,
        PRIVATE_TOKEN: 'token-only-123',
        SOURCE_BRANCH: 'sync/upstream-20260418',
        TARGET_BRANCH: 'staging/upstream-sync',
        MR_TITLE: 'chore: upstream sync 2026-04-18',
      },
    });

    const curlCommands = readFileSync(curlLog, 'utf8');
    expect(curlCommands).toContain(
      'https://code.alibaba-inc.com/api/v4/projects/alishu%2Fqwen-code/merge_requests',
    );
  }, 15000);

  it('can reuse an existing remote sync branch without pushing again', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const curlLog = join(tempRoot, 'curl.log');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });

    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "git@gitlab.alibaba-inc.com:alishu/qwen-code.git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    writeFile(
      join(mockBin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
cat <<'EOF'
{"web_url":"https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/99"}
201
EOF
`,
    );
    chmodSync(join(mockBin, 'curl'), 0o755);

    execFileSync('bash', [scriptPath, 'publish'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_CURL_LOG: curlLog,
        PRIVATE_TOKEN: 'token-only-123',
        SOURCE_BRANCH: 'sync/upstream-20260418',
        TARGET_BRANCH: 'main',
        MR_TITLE: 'chore: upstream sync 2026-04-18',
        SKIP_PUSH: '1',
      },
    });

    const gitCommands = readFileSync(gitLog, 'utf8');
    expect(gitCommands).not.toContain('push --no-verify');
  }, 15000);

  it('reuses an existing merge request when the exact target lookup is empty', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const curlLog = join(tempRoot, 'curl.log');
    const curlCount = join(tempRoot, 'curl-count');
    const outputPath = join(tempRoot, 'mr-url.txt');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });
    writeFile(curlCount, '0');

    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "git@gitlab.alibaba-inc.com:alishu/qwen-code.git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    writeFile(
      join(mockBin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
count=$(cat "$FAKE_CURL_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$FAKE_CURL_COUNT"
case "$count" in
  1)
    cat <<'EOF'
{"message":["Another open merge request already exists for this source branch: !88"]}
409
EOF
    ;;
  2)
    printf '[]'
    ;;
  3)
    cat <<'EOF'
[{"web_url":"https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/88"}]
EOF
    ;;
esac
`,
    );
    chmodSync(join(mockBin, 'curl'), 0o755);

    execFileSync('bash', [scriptPath, 'publish'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_CURL_LOG: curlLog,
        FAKE_CURL_COUNT: curlCount,
        PRIVATE_TOKEN: 'token-only-123',
        SOURCE_BRANCH: 'sync/upstream-20260418',
        TARGET_BRANCH: 'main',
        MR_TITLE: 'chore: upstream sync 2026-04-18',
        MR_URL_OUTPUT_PATH: outputPath,
        SKIP_PUSH: '1',
      },
    });

    const curlCommands = readFileSync(curlLog, 'utf8');
    expect(curlCommands).toContain('target_branch=main');
    expect(curlCommands).toContain('source_branch=sync/upstream-20260418');
    expect(readFileSync(outputPath, 'utf8').trim()).toBe(
      'https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/88',
    );
  }, 15000);

  it('derives a code review URL when an existing merge request has only an id', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const curlLog = join(tempRoot, 'curl.log');
    const outputPath = join(tempRoot, 'mr-url.txt');
    const conflictFilesPath = join(tempRoot, 'conflict-files.txt');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });

    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "git@gitlab.alibaba-inc.com:alishu/qwen-code.git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    writeFile(
      join(mockBin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
if [[ "$*" == *"/api/v5/code_review/search"* ]]; then
  cat <<'EOF'
{"data":{"amount":1,"list":[{"id":27556859,"web_url":"","detail_url":"","source_branch":"sync/upstream-20260522","target_branch":"main","description":"## Upstream Sync 2026-05-22\\n\\n### ⚠️ 未解决的冲突\\n\\n以下文件包含冲突标记，需要人工解决：\\n\\n- \`package-lock.json\`\\n- \`packages/core/package.json\`\\n\\n> **注意**: 验证步骤已跳过"}]}}
EOF
  exit 0
fi
is_post=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "-X" ] && [ "$arg" = "POST" ]; then
    is_post=1
  fi
  prev="$arg"
done
if [ "$is_post" = "1" ]; then
  cat <<'EOF'
{"message":["Another open merge request already exists for this source branch"]}
409
EOF
  exit 0
fi
printf '[]'
`,
    );
    chmodSync(join(mockBin, 'curl'), 0o755);

    execFileSync('bash', [scriptPath, 'publish'], {
      cwd: tempRoot,
      stdio: 'pipe',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_CURL_LOG: curlLog,
        PRIVATE_TOKEN: 'token-only-123',
        REPO_PATH: 'alishu/qwen-code',
        SOURCE_BRANCH: 'sync/upstream-20260522',
        TARGET_BRANCH: 'main',
        MR_TITLE: 'chore: upstream sync 2026-05-22',
        MR_URL_OUTPUT_PATH: outputPath,
        MR_CONFLICT_FILES_OUTPUT_PATH: conflictFilesPath,
        SKIP_PUSH: '1',
      },
    });

    expect(readFileSync(outputPath, 'utf8').trim()).toBe(
      'https://code.alibaba-inc.com/alishu/qwen-code/codereview/27556859',
    );
    expect(readFileSync(conflictFilesPath, 'utf8').trim()).toBe(
      ['package-lock.json', 'packages/core/package.json'].join('\n'),
    );
  }, 15000);

  it('pushes the sync branch and creates a merge request via domain auth', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'upstream-sync-auth-'));
    tempDirs.push(tempRoot);

    const scriptPath = join(
      tempRoot,
      '.aoneci',
      'scripts',
      'upstream-sync-domain-auth.sh',
    );
    writeFile(scriptPath, readFileSync(scriptSource));
    chmodSync(scriptPath, 0o755);

    const gitLog = join(tempRoot, 'git.log');
    const curlLog = join(tempRoot, 'curl.log');
    const outputPath = join(tempRoot, 'mr-url.txt');
    const mockBin = join(tempRoot, 'mock-bin');
    mkdirSync(mockBin, { recursive: true });

    writeFile(
      join(mockBin, 'git'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then
  echo ".git"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(mockBin, 'git'), 0o755);

    writeFile(
      join(mockBin, 'curl'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
cat <<'EOF'
{"web_url":"https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/42"}
201
EOF
`,
    );
    chmodSync(join(mockBin, 'curl'), 0o755);

    execFileSync('bash', [scriptPath, 'publish'], {
      cwd: tempRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        FAKE_GIT_LOG: gitLog,
        FAKE_CURL_LOG: curlLog,
        DOMAIN_USER: 'tester',
        DOMAIN_PASSWORD: 'token-123',
        REPO_PATH: 'alishu/qwen-code',
        SOURCE_BRANCH: 'sync/upstream-20260418',
        TARGET_BRANCH: 'staging/upstream-sync',
        MR_TITLE: 'chore: upstream sync 2026-04-18',
        MR_DESCRIPTION: 'Automated MR body',
        MR_URL_OUTPUT_PATH: outputPath,
      },
    });

    const gitCommands = readFileSync(gitLog, 'utf8');
    const curlCommands = readFileSync(curlLog, 'utf8');

    expect(gitCommands.split('\n')).toContain(
      'push --no-verify origin sync/upstream-20260418 --force',
    );
    expect(curlCommands).toContain(
      'https://code.alibaba-inc.com/api/v4/projects/alishu%2Fqwen-code/merge_requests',
    );
    expect(curlCommands).toContain('source_branch=sync/upstream-20260418');
    expect(curlCommands).toContain('target_branch=staging/upstream-sync');
    expect(readFileSync(outputPath, 'utf8').trim()).toBe(
      'https://code.alibaba-inc.com/alishu/qwen-code/-/merge_requests/42',
    );
  }, 15000);
});
