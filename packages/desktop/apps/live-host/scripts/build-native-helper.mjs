import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(appDir, 'dist', 'native', 'qwen-live-command-monitor');
const arm64Output = `${output}.arm64`;
const x64Output = `${output}.x64`;
mkdirSync(dirname(output), { recursive: true });

const sources = [
  join(appDir, 'native', 'CommandTapRecognizer.swift'),
  join(appDir, 'native', 'CommandTap.swift'),
];
const compile = (target, destination) =>
  spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-whole-module-optimization',
      '-target',
      target,
      '-framework',
      'ApplicationServices',
      ...sources,
      '-o',
      destination,
    ],
    { stdio: 'inherit' },
  );

const arm64Result = compile('arm64-apple-macos12.0', arm64Output);
if (arm64Result.status !== 0) {
  process.exit(arm64Result.status ?? 1);
}
const x64Result = compile('x86_64-apple-macos12.0', x64Output);
if (x64Result.status !== 0) {
  process.exit(x64Result.status ?? 1);
}
const lipoResult = spawnSync(
  '/usr/bin/lipo',
  ['-create', arm64Output, x64Output, '-output', output],
  { stdio: 'inherit' },
);
rmSync(arm64Output, { force: true });
rmSync(x64Output, { force: true });
if (lipoResult.status !== 0) process.exit(lipoResult.status ?? 1);

chmodSync(output, 0o755);
