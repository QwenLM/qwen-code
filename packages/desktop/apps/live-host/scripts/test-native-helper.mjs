import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const productionBuild = spawnSync(
  process.execPath,
  [join(appDir, 'scripts', 'build-native-helper.mjs')],
  { stdio: 'inherit' },
);
if (productionBuild.status !== 0) {
  process.exit(productionBuild.status ?? 1);
}
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'qwen-live-native-test-'),
);
const executable = join(temporaryDirectory, 'CommandTapRecognizerTests');

try {
  const compile = spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-parse-as-library',
      join(appDir, 'native', 'CommandTapRecognizer.swift'),
      join(appDir, 'native', 'CommandTapRecognizerTests.swift'),
      '-o',
      executable,
    ],
    { stdio: 'inherit' },
  );
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  await new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      ['-c', 'exec "$1"', 'qwen-live-native-test', executable],
      { stdio: 'inherit' },
    );
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CommandTapRecognizerTests timed out'));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(`CommandTapRecognizerTests failed: ${code ?? signal}`),
        );
    });
  });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
