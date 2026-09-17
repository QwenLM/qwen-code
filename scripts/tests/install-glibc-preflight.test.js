/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const itOnUnix = process.platform === 'win32' ? it.skip : it;
const installerPath = path.resolve(
  'scripts/installation/install-qwen-standalone.sh',
);

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function runInstaller({
  glibcVersion,
  useLddFallback = false,
  useUnknownLibc = false,
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-glibc-preflight-'));
  const binDir = path.join(root, 'bin');
  const homeDir = path.join(root, 'home');
  const curlMarker = path.join(root, 'curl-invoked');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  writeExecutable(
    path.join(binDir, 'uname'),
    `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) echo Linux ;;
esac
`,
  );

  if (useLddFallback) {
    writeExecutable(path.join(binDir, 'getconf'), '#!/bin/sh\nexit 1\n');
    writeExecutable(
      path.join(binDir, 'ldd'),
      useUnknownLibc
        ? `#!/bin/sh
echo "musl libc (x86_64)"
echo "Version 1.2.5"
`
        : `#!/bin/sh
echo "ldd (GNU libc) ${glibcVersion}"
`,
    );
  } else {
    writeExecutable(
      path.join(binDir, 'getconf'),
      `#!/bin/sh
if [ "$1" = "GNU_LIBC_VERSION" ]; then
  echo "glibc ${glibcVersion}"
  exit 0
fi
exit 1
`,
    );
  }

  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/bin/sh
: > "${curlMarker}"
exit 91
`,
  );

  const result = spawnSync(
    'bash',
    [
      installerPath,
      '--method',
      'standalone',
      '--mirror',
      'github',
      '--version',
      '0.24.0',
      '--no-modify-path',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        QWEN_INSTALL_ROOT: path.join(root, 'install'),
      },
    },
  );

  return {
    root,
    curlMarker,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function cleanup(result) {
  rmSync(result.root, { recursive: true, force: true });
}

describe('standalone installer glibc preflight', () => {
  itOnUnix('rejects glibc 2.17 before any release download', () => {
    const result = runInstaller({ glibcVersion: '2.17' });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'requires glibc 2.28 or newer; this system has glibc 2.17',
      );
      expect(result.stderr).toContain(
        'Use --method npm with a Node.js 22+ build compatible with this system',
      );
      expect(existsSync(result.curlMarker)).toBe(false);
    } finally {
      cleanup(result);
    }
  });

  itOnUnix('falls back to ldd when getconf cannot report glibc', () => {
    const result = runInstaller({
      glibcVersion: '2.17',
      useLddFallback: true,
    });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('this system has glibc 2.17');
      expect(existsSync(result.curlMarker)).toBe(false);
    } finally {
      cleanup(result);
    }
  });

  itOnUnix('leaves unknown libc implementations on the existing path', () => {
    const result = runInstaller({
      glibcVersion: '1.2',
      useLddFallback: true,
      useUnknownLibc: true,
    });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('requires glibc 2.28 or newer');
      expect(existsSync(result.curlMarker)).toBe(true);
    } finally {
      cleanup(result);
    }
  });

  itOnUnix('allows glibc 2.28 to continue to the release download', () => {
    const result = runInstaller({ glibcVersion: '2.28' });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('requires glibc 2.28 or newer');
      expect(existsSync(result.curlMarker)).toBe(true);
    } finally {
      cleanup(result);
    }
  });

  it(
    'keeps the preflight scoped to downloaded Linux standalone archives',
    () => {
      const script = readFileSync(installerPath, 'utf8');
      const archiveBranch = script.indexOf(
        'if [[ -n "${ARCHIVE_PATH}" ]]; then',
      );
      const downloadBranch = script.indexOf(
        '    else\n        if ! target=$(detect_target); then',
        archiveBranch,
      );
      const compatibilityCheck = script.indexOf(
        'check_standalone_runtime_compatibility "${target}"',
        downloadBranch,
      );

      expect(archiveBranch).toBeGreaterThanOrEqual(0);
      expect(downloadBranch).toBeGreaterThan(archiveBranch);
      expect(compatibilityCheck).toBeGreaterThan(downloadBranch);
    },
  );
});
