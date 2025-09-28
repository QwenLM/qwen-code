import fs from 'node:fs/promises';
import path from 'node:path';
import { MessageType } from '../types.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

/**
 * Copies the contents of the spec directory to the user's project.
 */
export const addSpecCommand: SlashCommand = {
  name: 'add-spec',
  kind: CommandKind.USER,
  description: 'Add spec-driven development (SDD) files to your project',
  usage: '/add-spec',
  handler: async (context) => {
    try {
      // Get the path to the sdd directory in the CLI package
      const cliRoot = context.services.config?.getProjectRoot();
      if (!cliRoot) {
        return {
          content: 'Unable to determine CLI root directory.',
          messageType: MessageType.ERROR,
        };
      }

      const sddSourcePath = path.join(cliRoot, 'src', 'ui', 'commands', 'spec');
      
      // Get the user's project root
      const projectRoot = process.cwd();
      const sddDestPath = path.join(projectRoot, 'spec');

      // Check if sdd directory exists in CLI
      try {
        await fs.access(sddSourcePath);
      } catch {
        return {
          content: `Spec directory not found at ${sddSourcePath}.`,
          messageType: MessageType.ERROR,
        };
      }

      // Copy the spec directory to the user's project
      await fs.cp(sddSourcePath, sddDestPath, { recursive: true });

      return {
        content: `Successfully added spec files to your project at ${sddDestPath}`,
        messageType: MessageType.INFO,
      };
    } catch (error) {
      return {
        content: `Failed to add spec files: ${(error as Error).message}`,
        messageType: MessageType.ERROR,
      };
    }
  },
};