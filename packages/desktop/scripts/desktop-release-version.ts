import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { valid } from 'semver';

export interface PackageVersionSource {
  label: string;
  path: string;
}

export interface NormalizedReleaseVersion {
  tag: string;
  version: string;
}

type PackageJson = Record<string, unknown>;

const repoRoot = join(import.meta.dir, '..');

export const desktopReleasePackageSources: PackageVersionSource[] = [
  { label: 'root package', path: 'package.json' },
  { label: 'Electron app package', path: 'apps/electron/package.json' },
  { label: 'shared package', path: 'packages/shared/package.json' },
];

export function normalizeReleaseVersion(
  input: string,
): NormalizedReleaseVersion {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Release version is required.');
  }

  const refPrefix = 'refs/tags/';
  const tag = raw.startsWith(refPrefix) ? raw.slice(refPrefix.length) : raw;
  const candidate = tag.startsWith('v') ? tag.slice(1) : tag;
  const version = valid(candidate);

  if (!version) {
    throw new Error(
      `Invalid release version "${input}". Use SemVer like 0.0.2 or v0.0.2.`,
    );
  }

  if (version.includes('+')) {
    throw new Error(
      `Release version "${input}" includes build metadata, which is not supported for desktop releases.`,
    );
  }

  return {
    tag: `v${version}`,
    version,
  };
}

export function readPackageJson(path: string): PackageJson {
  const absolutePath = join(repoRoot, path);
  const parsed = JSON.parse(readFileSync(absolutePath, 'utf-8')) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a valid package.json object.`);
  }

  return parsed as PackageJson;
}

export function readPackageVersion(path: string): string {
  const packageJson = readPackageJson(path);

  if (
    typeof packageJson.version !== 'string' ||
    !packageJson.version.trim()
  ) {
    throw new Error(`${path} does not define a package version.`);
  }

  return packageJson.version.trim();
}

export function writePackageVersion(path: string, version: string): void {
  const packageJson = readPackageJson(path);
  packageJson.version = version;
  writeFileSync(
    join(repoRoot, path),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
}
