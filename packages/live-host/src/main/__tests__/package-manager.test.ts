import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  determinePackageManagerEnv,
  PM,
} from 'app-builder-lib/out/node-module-collector/index.js';

it('packages Live Host with its standalone npm dependency tree', async () => {
  const packageRoot = resolve(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const environment = await determinePackageManagerEnv({
    projectDir: packageRoot,
    appDir: packageRoot,
    workspaceRoot: undefined,
  }).value;

  assert.equal(environment.pm, PM.NPM);
  assert.equal(await environment.workspaceRoot, packageRoot);
});
