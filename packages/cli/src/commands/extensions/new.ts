/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { CommandModule } from 'yargs';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { readPackageUp } from 'read-package-up';

interface NewArgs {
  path: string;
  template?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the examples directory path.
 *
 * After esbuild bundles everything into dist/cli.js, __dirname points to
 * the dist/ folder and the original source-relative path no longer works.
 * We first try the source-relative path (for development), then fall back
 * to locating the package root via readPackageUp and using the path that
 * npm publishes (packages/cli/src/commands/extensions/examples).
 */
async function resolveExamplesPath(): Promise<string> {
  // Development: source-relative path
  const devPath = join(__dirname, 'examples');
  if (await pathExists(devPath)) {
    return devPath;
  }

  // Production: find package root and use the published examples path
  const result = await readPackageUp({ cwd: __dirname });
  if (result) {
    const pkgRoot = dirname(result.path);
    const prodPath = join(
      pkgRoot,
      'packages',
      'cli',
      'src',
      'commands',
      'extensions',
      'examples',
    );
    if (await pathExists(prodPath)) {
      return prodPath;
    }
  }

  // Fallback to original path (will fail with a clear ENOENT)
  return devPath;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (_e) {
    return false;
  }
}

async function createDirectory(path: string) {
  if (await pathExists(path)) {
    throw new Error(`Path already exists: ${path}`);
  }
  await mkdir(path, { recursive: true });
}

async function copyDirectory(template: string, path: string) {
  await createDirectory(path);

  const examplesPath = await resolveExamplesPath();
  const examplePath = join(examplesPath, template);
  const entries = await readdir(examplePath, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(examplePath, entry.name);
    const destPath = join(path, entry.name);
    await cp(srcPath, destPath, { recursive: true });
  }
}

async function handleNew(args: NewArgs) {
  try {
    if (args.template) {
      await copyDirectory(args.template, args.path);
      writeStdoutLine(
        `Successfully created new extension from template "${args.template}" at ${args.path}.`,
      );
    } else {
      await createDirectory(args.path);
      const extensionName = basename(args.path);
      const manifest = {
        name: extensionName,
        version: '1.0.0',
      };
      await writeFile(
        join(args.path, 'qwen-extension.json'),
        JSON.stringify(manifest, null, 2),
      );
      writeStdoutLine(`Successfully created new extension at ${args.path}.`);
    }
    writeStdoutLine(
      `You can install this using "qwen extensions link ${args.path}" to test it out.`,
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    throw error;
  }
}

async function getBoilerplateChoices() {
  const examplesPath = await resolveExamplesPath();
  const entries = await readdir(examplesPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export const newCommand: CommandModule = {
  command: 'new <path> [template]',
  describe: 'Create a new extension from a boilerplate example.',
  builder: async (yargs) => {
    const choices = await getBoilerplateChoices();
    return yargs
      .positional('path', {
        describe: 'The path to create the extension in.',
        type: 'string',
      })
      .positional('template', {
        describe: 'The boilerplate template to use.',
        type: 'string',
        choices,
      });
  },
  handler: async (args) => {
    await handleNew({
      path: args['path'] as string,
      template: args['template'] as string | undefined,
    });
  },
};
