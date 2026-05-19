/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { CommandModule } from 'yargs';
import { resolveBundleDir } from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

interface NewArgs {
  path: string;
  template?: string;
}

// Anchor the bundled extension-examples directory at the on-disk sibling of
// `cli.js` (i.e. `dist/examples/`, populated by `prepare-package.js`). Today
// this module is bundled into `cli.js` itself, so the `chunks/` strip in
// `resolveBundleDir` is a no-op — but using the same helper as the other
// asset-anchor sites means this code stays correct if esbuild later hoists
// this module into a shared chunk.
const EXAMPLES_PATH = join(resolveBundleDir(import.meta.url), 'examples');

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

  const examplePath = join(EXAMPLES_PATH, template);
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
  const entries = await readdir(EXAMPLES_PATH, { withFileTypes: true });
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
