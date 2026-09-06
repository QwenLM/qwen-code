import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(appDirectory, 'release');
const packageJson = JSON.parse(
  readFileSync(join(appDirectory, 'package.json'), 'utf8'),
);
const protocolSource = readFileSync(
  join(appDirectory, 'src', 'shared', 'protocol.ts'),
  'utf8',
);
const protocolMatch = protocolSource.match(
  /export const LIVE_PROTOCOL_VERSION = (\d+);/,
);
if (!protocolMatch) {
  throw new Error('Unable to resolve the Live Host protocol version.');
}

function asset(architecture) {
  const name = `Qwen-Live-Host-${architecture}.zip`;
  const filePath = join(releaseDirectory, name);
  const bytes = readFileSync(filePath);
  return {
    name,
    size: statSync(filePath).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const manifest = {
  schemaVersion: 1,
  version: packageJson.version,
  protocolVersion: Number(protocolMatch[1]),
  bundleId: 'com.alibaba.qwen-code.live-host',
  assets: {
    arm64: asset('arm64'),
    x64: asset('x64'),
  },
};

writeFileSync(
  join(releaseDirectory, 'Qwen-Live-Host-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
