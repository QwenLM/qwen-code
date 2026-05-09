import { spawn } from 'bun';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const desktopRoot = join(import.meta.dir, '..');
const repoRoot = join(desktopRoot, '..', '..');
const electronDir = join(desktopRoot, 'apps', 'electron');
const vendorDir = join(electronDir, 'vendor', 'qwen-code');
const localDistDir = join(repoRoot, 'dist');

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = spawn({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed with exit code ${exitCode}`);
  }
}

function verifyVendoredCli(): void {
  const hasRootCli = existsSync(join(vendorDir, 'cli.js'));
  const hasDistCli = existsSync(join(vendorDir, 'dist', 'cli.js'));
  if (!hasRootCli && !hasDistCli) {
    throw new Error(
      `Qwen Code CLI not found in ${vendorDir}. Expected cli.js or dist/cli.js.`,
    );
  }
}

async function vendorLocalCheckout(): Promise<void> {
  console.log('Building Qwen Code CLI from the current checkout...');

  const npm = npmCommand();
  await run([npm, 'run', 'build'], repoRoot);
  await run([npm, 'run', 'bundle'], repoRoot);
  await run([npm, 'run', 'prepare:package'], repoRoot);

  if (!existsSync(join(localDistDir, 'cli.js'))) {
    throw new Error(
      `Local Qwen Code bundle not found at ${join(localDistDir, 'cli.js')}.`,
    );
  }

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  cpSync(localDistDir, vendorDir, { recursive: true, force: true });
  verifyVendoredCli();
  console.log(`Vendored local Qwen Code CLI into ${vendorDir}`);
}

async function vendorNpmVersion(version: string): Promise<void> {
  console.log(`Downloading Qwen Code ${version} from npm...`);

  const tempDir = mkdtempSync(join(tmpdir(), 'qwen-code-vendor-'));
  const tarballPath = join(tempDir, `qwen-code-${version}.tgz`);
  const url = `https://registry.npmjs.org/@qwen-code/qwen-code/-/qwen-code-${version}.tgz`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }
    await Bun.write(tarballPath, await response.arrayBuffer());

    rmSync(vendorDir, { recursive: true, force: true });
    mkdirSync(vendorDir, { recursive: true });

    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await run(
      [tar, '-xzf', tarballPath, '-C', vendorDir, '--strip-components=1'],
      desktopRoot,
    );

    verifyVendoredCli();
    console.log(`Vendored @qwen-code/qwen-code@${version} into ${vendorDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const npmVersion = process.env.QWEN_CODE_VERSION?.trim();
  if (npmVersion) {
    await vendorNpmVersion(npmVersion);
    return;
  }

  await vendorLocalCheckout();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
