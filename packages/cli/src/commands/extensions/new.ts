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
  marketplace?: boolean;
}

// Anchor the bundled extension-examples directory at the on-disk sibling of
// `cli.js` (i.e. `dist/examples/`, populated by `prepare-package.js`). Today
// this module is bundled into `cli.js` itself, so the `chunks/` strip in
// `resolveBundleDir` is a no-op — but using the same helper as the other
// asset-anchor sites means this code stays correct if esbuild later hoists
// this module into a shared chunk.
const EXAMPLES_PATH = join(resolveBundleDir(import.meta.url), 'examples');
// Marketplace boilerplates live under a dedicated subdirectory so they don't
// show up in the single-extension template list (and vice versa).
const MARKETPLACE_EXAMPLES_DIR = 'marketplaces';
const MARKETPLACE_EXAMPLES_PATH = join(EXAMPLES_PATH, MARKETPLACE_EXAMPLES_DIR);

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

async function copyDirectory(baseDir: string, template: string, path: string) {
  await createDirectory(path);

  const examplePath = join(baseDir, template);
  const entries = await readdir(examplePath, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(examplePath, entry.name);
    const destPath = join(path, entry.name);
    await cp(srcPath, destPath, { recursive: true });
  }
}

async function createMinimalExtension(path: string) {
  await createDirectory(path);
  const manifest = {
    name: basename(path),
    version: '1.0.0',
  };
  await writeFile(
    join(path, 'qwen-extension.json'),
    JSON.stringify(manifest, null, 2),
  );
}

async function createMinimalMarketplace(path: string) {
  await createDirectory(path);
  const manifest = {
    name: basename(path),
    metadata: { extensionRoot: 'extensions' },
    extensions: [] as unknown[],
  };
  await writeFile(
    join(path, 'qwen-marketplace.json'),
    JSON.stringify(manifest, null, 2),
  );
}

async function handleNew(args: NewArgs) {
  try {
    if (args.marketplace) {
      if (args.template) {
        await copyDirectory(
          MARKETPLACE_EXAMPLES_PATH,
          args.template,
          args.path,
        );
        writeStdoutLine(
          `Successfully created new marketplace from template "${args.template}" at ${args.path}.`,
        );
      } else {
        await createMinimalMarketplace(args.path);
        writeStdoutLine(
          `Successfully created new Qwen marketplace at ${args.path}.`,
        );
      }
      writeStdoutLine(
        `You can add this using "qwen extensions sources add ${args.path}" to test it out.`,
      );
      return;
    }

    if (args.template) {
      await copyDirectory(EXAMPLES_PATH, args.template, args.path);
      writeStdoutLine(
        `Successfully created new extension from template "${args.template}" at ${args.path}.`,
      );
    } else {
      await createMinimalExtension(args.path);
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

async function listTemplateDirs(baseDir: string): Promise<string[]> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Missing/unreadable template directory — surface no choices rather than
    // failing command registration.
    return [];
  }
}

async function getBoilerplateChoices() {
  // Single-extension templates are the top-level example dirs, minus the
  // marketplace boilerplate container.
  const dirs = await listTemplateDirs(EXAMPLES_PATH);
  return dirs.filter((name) => name !== MARKETPLACE_EXAMPLES_DIR);
}

async function getMarketplaceChoices() {
  return listTemplateDirs(MARKETPLACE_EXAMPLES_PATH);
}

export const newCommand: CommandModule = {
  command: 'new <path> [template]',
  describe:
    'Create a new extension (or, with --marketplace, a Qwen marketplace) from a boilerplate example.',
  builder: async (yargs) => {
    const [extensionChoices, marketplaceChoices] = await Promise.all([
      getBoilerplateChoices(),
      getMarketplaceChoices(),
    ]);
    // Accept either template set; `handleNew` routes by --marketplace and a
    // mismatched name fails clearly when its source dir can't be read.
    const choices = [...new Set([...extensionChoices, ...marketplaceChoices])];
    return yargs
      .positional('path', {
        describe: 'The path to create the extension or marketplace in.',
        type: 'string',
      })
      .positional('template', {
        describe: 'The boilerplate template to use.',
        type: 'string',
        choices,
      })
      .option('marketplace', {
        alias: 'm',
        type: 'boolean',
        default: false,
        describe:
          'Create a Qwen marketplace source (qwen-marketplace.json) instead of a single extension.',
      });
  },
  handler: async (args) => {
    await handleNew({
      path: args['path'] as string,
      template: args['template'] as string | undefined,
      marketplace: args['marketplace'] as boolean | undefined,
    });
  },
};
