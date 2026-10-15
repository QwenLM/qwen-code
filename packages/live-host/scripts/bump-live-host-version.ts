import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { valid } from 'semver';

const packagePath = join(import.meta.dirname, '..', 'package.json');
const input = process.argv[2];

if (!input || process.argv.length !== 3) {
  console.error('Usage: npm run bump-version -- <version>');
  process.exit(1);
}

try {
  const candidate = input.startsWith('v') ? input.slice(1) : input;
  const version = valid(candidate);
  if (!version || candidate.includes('+')) {
    throw new Error(`Invalid Live Host release version "${input}".`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version?: unknown;
  };
  const currentVersion = packageJson.version;
  if (typeof currentVersion !== 'string') {
    throw new Error('Live Host package does not define a version.');
  }
  if (currentVersion !== version) {
    packageJson.version = version;
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  console.log(`Live Host version: ${currentVersion} -> ${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
