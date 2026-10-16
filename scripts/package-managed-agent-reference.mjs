#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';

import {
  CONTRACT_DOCUMENT,
  documentVersion,
} from './contract-version-utils.js';
import {
  LOCATIONS,
  migrationFiles,
  migrationVersion,
} from './flyway-migration-utils.js';

const DISTRIBUTION_NAME = 'qwen-managed-agent-reference';
const PRERELEASE_IDENTIFIER =
  '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION_PATTERN = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*$`,
);
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function match(text, pattern, label) {
  const result = text.match(pattern);
  if (!result) throw new Error(`Cannot read ${label}.`);
  return result[1];
}

function uniqueMatch(text, pattern, label) {
  const results = [...text.matchAll(pattern)];
  if (results.length !== 1) {
    throw new Error(`Cannot uniquely read ${label}.`);
  }
  return results[0][1];
}

function withoutComments(text) {
  let output = '';
  let block = false;
  for (let index = 0; index < text.length; index += 1) {
    if (block) {
      if (text.startsWith('*/', index)) {
        block = false;
        index += 1;
      } else if (text[index] === '\n') {
        output += '\n';
      }
    } else if (text.startsWith('/*', index)) {
      block = true;
      index += 1;
    } else if (text.startsWith('//', index)) {
      index = text.indexOf('\n', index) - 1;
      if (index < -1) break;
    } else {
      output += text[index];
    }
  }
  return output;
}

async function pomVersion(file, artifactId) {
  const text = await readFile(file, 'utf8');
  return match(
    text,
    new RegExp(
      `<artifactId>${artifactId}</artifactId>\\s*<version>([^<]+)</version>`,
    ),
    `${artifactId} version`,
  );
}

function compareMigrationVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function migrationRange(root) {
  const versions = LOCATIONS.flatMap(({ dir, suffix }) =>
    migrationFiles(
      path.join(root, 'packages/managed-agent-server', ...dir),
      suffix,
    ).map((file) => migrationVersion(path.basename(file))),
  );
  if (versions.length === 0) throw new Error('No Flyway migrations found.');
  versions.sort(compareMigrationVersions);
  return { minimum: versions[0], latest: versions.at(-1) };
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      );
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

async function writeChecksums(directory, files, destination) {
  const lines = [];
  for (const relative of files) {
    lines.push(`${await sha256(path.join(directory, relative))}  ${relative}`);
  }
  await writeFile(destination, `${lines.join('\n')}\n`);
}

async function verifyChecksums(directory, checksumFile) {
  const lines = (await readFile(checksumFile, 'utf8')).trim().split('\n');
  for (const line of lines) {
    const found = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!found) throw new Error(`Invalid checksum line: ${line}`);
    const actual = await sha256(path.join(directory, found[2]));
    if (actual !== found[1]) {
      throw new Error(`Checksum mismatch for ${found[2]}.`);
    }
  }
}

async function copy(root, stage, source, destination) {
  const target = path.join(stage, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
  return target;
}

function launcher(jar) {
  return `#!/usr/bin/env sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec java -jar "$base/lib/${jar}" "$@"
`;
}

async function createDeterministicArchive(output, rootName, stage, archive) {
  const files = await listFiles(stage);
  const timestamp = new Date(0);
  for (const relative of files) {
    const file = path.join(stage, relative);
    await chmod(file, relative.startsWith('bin/') ? 0o755 : 0o644);
    await utimes(file, timestamp, timestamp);
  }

  const tarVersion = execFileSync('tar', ['--version'], { encoding: 'utf8' });
  const ownershipArguments = tarVersion.toLowerCase().includes('bsdtar')
    ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
    : ['--owner=0', '--group=0'];
  const tarFile = `${archive}.tmp`;
  try {
    execFileSync(
      'tar',
      [
        '-c',
        '--format=ustar',
        ...ownershipArguments,
        '-f',
        tarFile,
        '-C',
        output,
        ...files.map((file) => path.posix.join(rootName, file)),
      ],
      { stdio: 'inherit' },
    );
    await pipeline(
      createReadStream(tarFile),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(archive),
    );
  } finally {
    await rm(tarFile, { force: true });
  }
}

export async function createReferenceDistribution({
  repoRoot,
  outputDirectory,
  version,
  sourceRevision,
}) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      'Version must be an experimental SemVer with a prerelease.',
    );
  }
  if (!REVISION_PATTERN.test(sourceRevision)) {
    throw new Error(
      'Source revision must be a lowercase 40-character Git SHA.',
    );
  }

  const root = path.resolve(repoRoot);
  const output = path.resolve(outputDirectory);
  const rootName = `${DISTRIBUTION_NAME}-${version}`;
  const stage = path.join(output, rootName);
  const archive = path.join(output, `${rootName}.tar.gz`);
  const detachedManifest = path.join(output, `${rootName}.manifest.json`);
  const detachedChecksums = path.join(output, 'SHA256SUMS.txt');

  await mkdir(output, { recursive: true });
  await Promise.all([
    rm(stage, { recursive: true, force: true }),
    rm(archive, { force: true }),
    rm(detachedManifest, { force: true }),
    rm(detachedChecksums, { force: true }),
  ]);
  await mkdir(stage, { recursive: true });

  const serverPom = path.join(root, 'packages/managed-agent-server/pom.xml');
  const serverVersion = await pomVersion(
    serverPom,
    'qwen-managed-agent-server',
  );
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json')),
  );
  const publicApi = documentVersion(
    await readFile(path.join(root, CONTRACT_DOCUMENT), 'utf8'),
  );
  if (publicApi.error) {
    throw new Error(`${CONTRACT_DOCUMENT} ${publicApi.error}.`);
  }
  const capabilities = await readFile(
    path.join(root, 'packages/cli/src/serve/capabilities.ts'),
    'utf8',
  );
  const brokerProvider = await readFile(
    path.join(
      root,
      'packages/cli/src/serve/broker-managed-runtime-provider.ts',
    ),
    'utf8',
  );
  const applicationConfiguration = await readFile(
    path.join(
      root,
      'packages/managed-agent-server/src/main/resources/application.yml',
    ),
    'utf8',
  );
  const hostedHarnessContract = await readFile(
    path.join(root, 'packages/cli/src/serve/hosted-harness-contract.ts'),
    'utf8',
  );
  const serverPomText = await readFile(serverPom, 'utf8');
  const schema = migrationRange(root);
  const publicShellDefault = uniqueMatch(
    applicationConfiguration,
    /^[ \t]*workspace-shell-enabled:[ \t]*'\$\{QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:([^}\r\n]+)\}'[ \t]*$/gm,
    'public Shell default',
  );
  if (publicShellDefault !== 'false') {
    throw new Error('Public Shell must default to false.');
  }
  const lifecycleV2ProfilesDefault = uniqueMatch(
    withoutComments(hostedHarnessContract),
    /^[ \t]*process\.env\[HOSTED_LIFECYCLE_V2_PROFILES_ENV\][ \t]*\?\?[ \t]*'([^'\r\n]*)'[ \t]*$/gm,
    'Hosted lifecycle v2 profile default',
  );
  if (lifecycleV2ProfilesDefault !== '') {
    throw new Error('Hosted lifecycle v2 profiles must default to empty.');
  }

  const serverJar = `qwen-managed-agent-server-${serverVersion}.jar`;
  const recoveryJar = `qwen-managed-agent-server-${serverVersion}-operator-recovery.jar`;
  const componentSources = [
    {
      name: 'qwen-managed-agent-server',
      version: serverVersion,
      source: `packages/managed-agent-server/target/${serverJar}`,
      destination: `lib/${serverJar}`,
      role: 'control-plane',
    },
    {
      name: 'qwen-managed-agent-operator-recovery',
      version: serverVersion,
      source: `packages/managed-agent-server/target/${recoveryJar}`,
      destination: `lib/${recoveryJar}`,
      role: 'operator-recovery',
    },
  ];

  for (const component of componentSources) {
    await copy(root, stage, component.source, component.destination);
  }
  const documentation = [
    ['docs/users/managed-agent-reference-deployment.md', 'docs/deployment.md'],
    [
      'docs/users/managed-agent-reference-deployment.zh-CN.md',
      'docs/deployment.zh-CN.md',
    ],
    ['packages/managed-agent-server/README.md', 'docs/server-reference.md'],
    [
      'docs/users/hosted-workspace-recovery.md',
      'docs/hosted-workspace-recovery.md',
    ],
    [
      'docs/users/hosted-workspace-recovery.zh-CN.md',
      'docs/hosted-workspace-recovery.zh-CN.md',
    ],
    ['LICENSE', 'LICENSE'],
  ];
  for (const [source, destination] of documentation) {
    await copy(root, stage, source, destination);
  }

  const serverLauncher = path.join(stage, 'bin/qwen-managed-agent-server');
  const recoveryLauncher = path.join(
    stage,
    'bin/qwen-managed-agent-operator-recovery',
  );
  await mkdir(path.dirname(serverLauncher), { recursive: true });
  await Promise.all([
    writeFile(serverLauncher, launcher(serverJar)),
    writeFile(recoveryLauncher, launcher(recoveryJar)),
  ]);
  await Promise.all([
    chmod(serverLauncher, 0o755),
    chmod(recoveryLauncher, 0o755),
  ]);

  const components = [];
  for (const component of componentSources) {
    const file = path.join(stage, component.destination);
    components.push({
      name: component.name,
      version: component.version,
      role: component.role,
      path: component.destination,
      size: (await stat(file)).size,
      sha256: await sha256(file),
    });
  }

  const manifest = {
    schemaVersion: 1,
    name: DISTRIBUTION_NAME,
    version,
    status: 'experimental',
    source: {
      repository: 'https://github.com/QwenLM/qwen-code',
      revision: sourceRevision,
    },
    components,
    compatibility: {
      qwenCodeVersion: packageJson.version,
      hostedHarnessProfile: 'hosted-harness',
      serveProtocolVersion: match(
        capabilities,
        /SERVE_PROTOCOL_VERSION = '([^']+)'/,
        'Serve protocol version',
      ),
      managedRuntimeBrokerProtocolVersion: Number(
        match(
          brokerProvider,
          /MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION = (\d+)/,
          'Runtime Broker protocol version',
        ),
      ),
      managedAgentPublicApiVersion: publicApi.version,
      java: `>=${match(
        serverPomText,
        /<java\.version>([^<]+)<\/java\.version>/,
        'Java version',
      )}`,
      node: packageJson.engines.node,
      databaseSchema: {
        migrationTool: 'Flyway',
        minimumMigrationVersion: schema.minimum,
        latestMigrationVersion: schema.latest,
      },
    },
    referenceTopology: {
      operatingSystem: 'Linux',
      javaControlPlanes: 1,
      hostTrust: 'trusted-single-host',
      runtimeBroker: 'embedded',
      database: 'MySQL 8',
    },
    defaults: {
      publicShellEnabled: publicShellDefault === 'true',
      v2CapabilityAdvertisementEnabled: lifecycleV2ProfilesDefault !== '',
    },
    documentation: {
      deployment: 'docs/deployment.md',
      deploymentChinese: 'docs/deployment.zh-CN.md',
      serverReference: 'docs/server-reference.md',
      operatorRecovery: 'docs/hosted-workspace-recovery.md',
    },
  };
  const manifestFile = path.join(stage, 'manifest.json');
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const payload = await listFiles(stage);
  await writeChecksums(stage, payload, path.join(stage, 'SHA256SUMS'));
  await verifyChecksums(stage, path.join(stage, 'SHA256SUMS'));
  await copyFile(manifestFile, detachedManifest);

  await createDeterministicArchive(output, rootName, stage, archive);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  for (const required of [
    `${rootName}/manifest.json`,
    `${rootName}/SHA256SUMS`,
    `${rootName}/bin/qwen-managed-agent-server`,
    `${rootName}/bin/qwen-managed-agent-operator-recovery`,
  ]) {
    if (!entries.split('\n').includes(required)) {
      throw new Error(`Archive is missing ${required}.`);
    }
  }

  await writeChecksums(
    output,
    [path.basename(archive), path.basename(detachedManifest)],
    detachedChecksums,
  );
  await verifyChecksums(output, detachedChecksums);
  await rm(stage, { recursive: true, force: true });

  return { archive, detachedManifest, detachedChecksums, manifest };
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      'source-revision': { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.version || !values['source-revision'] || !values.output) {
    throw new Error(
      'Usage: package-managed-agent-reference.mjs --version <experimental-semver> --source-revision <sha> --output <directory>',
    );
  }
  const result = await createReferenceDistribution({
    repoRoot: process.cwd(),
    outputDirectory: values.output,
    version: values.version,
    sourceRevision: values['source-revision'],
  });
  console.log(result.archive);
  console.log(result.detachedManifest);
  console.log(result.detachedChecksums);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
