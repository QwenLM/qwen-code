#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--output-dir');
if (index < 0 || !process.argv[index + 1])
  throw new Error('missing --output-dir');
const output = resolve(process.argv[index + 1]);
mkdirSync(output, { recursive: true });
function run(args, capture = false) {
  const result = spawnSync('npm', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `npm exited ${result.status}`);
  return result.stdout;
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [packed] = JSON.parse(
  run(['pack', '.', '--pack-destination', output, '--json'], true),
);
if (
  packed.name !== '@qwen-code/browser-use' ||
  packed.version !== manifest.version
)
  throw new Error('browser package identity mismatch');
const files = new Set(packed.files.map((file) => file.path));
for (const name of [
  'LICENSE',
  'NOTICE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/core/primitives.d.ts',
  'dist/sdk/types.d.ts',
  'dist/native-host.js',
  'dist/scripts/native-host-setup.js',
]) {
  if (!files.has(name)) throw new Error(`browser package missing ${name}`);
}
run([
  'publish',
  join(output, packed.filename),
  '--dry-run',
  '--access',
  'public',
  '--registry=https://registry.npmjs.org',
]);
process.stdout.write(
  JSON.stringify({
    name: packed.name,
    version: packed.version,
    tarball: join(output, packed.filename),
    integrity: packed.integrity,
  }) + '\n',
);
