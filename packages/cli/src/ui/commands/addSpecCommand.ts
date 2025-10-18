/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_TEMPLATE_DIR = path.resolve(__dirname, 'spec');
const fsp = fs.promises;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copySpecDirectory(
  sourceDir: string,
  destinationDir: string,
  targetRoot: string,
  copied: string[],
  skipped: string[],
): Promise<void> {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await fsp.mkdir(destinationPath, { recursive: true });
      await copySpecDirectory(
        sourcePath,
        destinationPath,
        targetRoot,
        copied,
        skipped,
      );
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

      if (await pathExists(destinationPath)) {
        skipped.push(path.relative(targetRoot, destinationPath));
        continue;
      }

      await fsp.copyFile(sourcePath, destinationPath);
      copied.push(path.relative(targetRoot, destinationPath));
    }
  }
}

export const addSpecCommand: SlashCommand = {
  name: 'add-spec',
  description: 'Copy spec scaffolding into the current project.',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    }

    const targetDir = config.getTargetDir();
    try {
      if (!(await pathExists(SPEC_TEMPLATE_DIR))) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Spec templates were not found in the CLI bundle.',
        };
      }

      const copied: string[] = [];
      const skipped: string[] = [];

      await copySpecDirectory(
        SPEC_TEMPLATE_DIR,
        targetDir,
        targetDir,
        copied,
        skipped,
      );

      copied.sort();
      skipped.sort();

      let content = `Spec scaffolding prepared in ${targetDir}.`;

      if (copied.length > 0) {
        const copiedList = copied
          .map((relative) => `- ${relative}`)
          .join('\n');
        content += `\n\nCreated:\n${copiedList}`;
      }

      if (skipped.length > 0) {
        const skippedList = skipped
          .map((relative) => `- ${relative}`)
          .join('\n');
        content += `\n\nSkipped existing files:\n${skippedList}`;
      }

      if (copied.length === 0 && skipped.length === 0) {
        content += '\n\nNo files were copied. Templates may be empty.';
      }

      return {
        type: 'message',
        messageType: 'info',
        content,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to add spec scaffolding: ${message}`,
      };
    }
  },
};

