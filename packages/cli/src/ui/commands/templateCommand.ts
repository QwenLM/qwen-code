/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  ModeTemplateManager,
  toPascalCase,
  toCamelCase,
} from '@qwen-code/qwen-code-core';

/**
 * Parse argument string into key-value pairs.
 * Supports --key value and --key=value formats.
 */
function parseArgs(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = args.match(/--(\w+)(?:=(\S+)|\s+(\S+))?/g) || [];

  for (const part of parts) {
    const match = part.match(/--(\w+)(?:=(\S+)|\s+(\S+))?/);
    if (match) {
      const key = match[1];
      const value = match[2] ?? match[3] ?? '';
      result[key] = value;
    }
  }

  return result;
}

/**
 * Format a list of templates for display.
 */
function formatTemplateList(
  templates: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
  }>,
): string {
  const lines = templates.map(
    (t) => `- ${t.icon} **${t.id}** (${t.category})\n  ${t.description}`,
  );
  return `**Available Templates:**\n\n${lines.join('\n\n')}`;
}

/**
 * Format a single template's details for display.
 */
function formatTemplateDetails(template: {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  variables: Array<{ name: string; default: string; description: string }>;
  files: Array<{ path: string; description: string }>;
}): string {
  const lines = [
    `${template.icon} **${template.name}** (\`${template.id}\`)`,
    '',
    template.description,
    '',
    `**Category:** ${template.category}`,
    '',
    '**Variables:**',
    ...template.variables.map(
      (v) => `  - \`${v.name}\` (default: \`${v.default}\`) - ${v.description}`,
    ),
    '',
    '**Files:**',
    ...template.files.map((f) => `  - \`${f.path}\` - ${f.description}`),
  ];
  return lines.join('\n');
}

/**
 * Singleton template manager instance.
 */
let templateManager: ModeTemplateManager | null = null;

function getTemplateManager(): ModeTemplateManager {
  if (!templateManager) {
    templateManager = new ModeTemplateManager();
    templateManager.addBuiltInTemplates();
  }
  return templateManager;
}

export const templateCommand: SlashCommand = {
  name: 'template',
  altNames: ['tpl'],
  get description() {
    return t('generate files from mode templates');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();

    // No args — show help and list templates
    if (!trimmedArgs) {
      const manager = getTemplateManager();
      const templates = manager.getAllTemplates();

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `**Mode Templates**

Generate files from predefined templates for common patterns.

${formatTemplateList(
  templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    category: t.category,
  })),
)}

**Usage:**

\`/template\` — Show this help
\`/template list\` — List all available templates
\`/template show <id>\` — Show template details
\`/template generate <id> --name Value --dir path\` — Generate files from template`,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /template list — list all templates
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      const manager = getTemplateManager();
      const templates = manager.getAllTemplates();

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatTemplateList(
          templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            icon: t.icon,
            category: t.category,
          })),
        ),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /template show <id> — show template details
    if (trimmedArgs.startsWith('show ')) {
      const templateId = trimmedArgs.replace(/^show\s+/, '').trim();
      const manager = getTemplateManager();
      const template = manager.getTemplate(templateId);

      if (!template) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Template not found: \`${templateId}\`\n\nUse \`/template list\` to see available templates.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: formatTemplateDetails({
          id: template.id,
          name: template.name,
          description: template.description,
          icon: template.icon,
          category: template.category,
          variables: template.variables,
          files: template.files.map((f) => ({
            path: f.path,
            description: f.description,
          })),
        }),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /template generate <id> [--name Value] [--dir path]
    if (trimmedArgs.startsWith('generate ') || trimmedArgs.startsWith('gen ')) {
      const generateArgs = trimmedArgs.replace(/^(generate|gen)\s+/, '').trim();
      const parts = generateArgs.split(/\s+/);
      const templateId = parts[0];

      if (!templateId) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/template generate <template-id> [--name Value] [--dir path]`\n\nExample: `/template generate react-component --name Button --dir src/components`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const manager = getTemplateManager();
      const template = manager.getTemplate(templateId);

      if (!template) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Template not found: \`${templateId}\`\n\nUse \`/template list\` to see available templates.`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      // Parse variables from args
      const parsedArgs = parseArgs(generateArgs);

      // Handle --name variable: convert to PascalCase for component names
      if (parsedArgs.name) {
        parsedArgs.name = toPascalCase(parsedArgs.name);
        // Also provide camelCase version
        parsedArgs.Name = toCamelCase(parsedArgs.name);
      }

      // Set default dir if not provided
      if (!parsedArgs.dir) {
        for (const v of template.variables) {
          if (v.name === 'dir') {
            parsedArgs.dir = v.default;
          }
        }
      }

      // Generate files
      try {
        const files = manager.generateFiles(templateId, parsedArgs);

        // Build output showing what would be generated
        const lines = [
          `${template.icon} **Generated files from \`${templateId}\` template:**`,
          '',
        ];

        // Determine base directory for file operations
        const config = context.services.config;
        const baseDir = config ? config.getTargetDir() : process.cwd();
        let allFilesExist = true;

        for (const file of files) {
          const fullPath = path.isAbsolute(file.path)
            ? file.path
            : path.join(baseDir, file.path);
          const exists = fs.existsSync(fullPath);
          if (exists) {
            allFilesExist = false;
          }
          const statusIcon = exists ? '⚠️' : '📄';
          lines.push(
            `${statusIcon} \`${file.path}\`${exists ? ' (already exists)' : ''}`,
          );
        }

        lines.push('');

        if (allFilesExist) {
          // All files are new - show a preview of the first file
          lines.push('**Preview of first file:**');
          lines.push('');
          lines.push('```');
          const previewContent = files[0].content;
          const previewLines = previewContent.split('\n').slice(0, 20);
          lines.push(previewLines.join('\n'));
          if (previewContent.split('\n').length > 20) {
            lines.push('...');
          }
          lines.push('```');
        }

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: lines.join('\n'),
        };
        context.ui.addItem(historyItem, Date.now());

        // Actually write the files to disk
        const writtenFiles: string[] = [];
        const skippedFiles: string[] = [];

        for (const file of files) {
          const fullPath = path.isAbsolute(file.path)
            ? file.path
            : path.join(baseDir, file.path);

          // Create directory if it doesn't exist
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          // Skip if file already exists
          if (fs.existsSync(fullPath)) {
            skippedFiles.push(file.path);
            continue;
          }

          fs.writeFileSync(fullPath, file.content, 'utf8');
          writtenFiles.push(file.path);
        }

        // Report results
        if (writtenFiles.length > 0) {
          const resultItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `**Generated ${writtenFiles.length} file(s):**\n\n${writtenFiles.map((f) => `- ✅ \`${f}\``).join('\n')}${skippedFiles.length > 0 ? `\n\n**Skipped ${skippedFiles.length} existing file(s):**\n\n${skippedFiles.map((f) => `- ⚠️ \`${f}\``).join('\n')}` : ''}`,
          };
          context.ui.addItem(resultItem, Date.now());
        } else if (skippedFiles.length > 0) {
          const resultItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `All ${skippedFiles.length} file(s) already exist. Skipped to avoid overwriting.`,
          };
          context.ui.addItem(resultItem, Date.now());
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Failed to generate template: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // Try to match as a template ID directly
    {
      const manager = getTemplateManager();
      const template = manager.getTemplate(trimmedArgs);

      if (template) {
        // Show template details when ID is used directly
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text:
            formatTemplateDetails({
              id: template.id,
              name: template.name,
              description: template.description,
              icon: template.icon,
              category: template.category,
              variables: template.variables,
              files: template.files.map((f) => ({
                path: f.path,
                description: f.description,
              })),
            }) +
            '\n\n**To generate files, use:** `/template generate ' +
            template.id +
            ' --name <Name> --dir <path>`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown command: \`/template ${trimmedArgs}\`

Available subcommands:
- \`list\` — List all available templates
- \`show <id>\` — Show template details
- \`generate <id> [--name Value] [--dir path]\` — Generate files

Use \`/template\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
  subCommands: [
    {
      name: 'list',
      altNames: ['ls'],
      get description() {
        return t('list all available mode templates');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const manager = getTemplateManager();
        const templates = manager.getAllTemplates();

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: formatTemplateList(
            templates.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              icon: t.icon,
              category: t.category,
            })),
          ),
        };
        context.ui.addItem(historyItem, Date.now());
      },
    },
    {
      name: 'show',
      get description() {
        return t('show template details');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        const templateId = args.trim();
        if (!templateId) {
          const historyItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: 'Usage: `/template show <template-id>`',
          };
          context.ui.addItem(historyItem, Date.now());
          return;
        }

        const manager = getTemplateManager();
        const template = manager.getTemplate(templateId);

        if (!template) {
          const historyItem: Omit<HistoryItemText, 'id'> = {
            type: MessageType.TEXT,
            text: `Template not found: \`${templateId}\``,
          };
          context.ui.addItem(historyItem, Date.now());
          return;
        }

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: formatTemplateDetails({
            id: template.id,
            name: template.name,
            description: template.description,
            icon: template.icon,
            category: template.category,
            variables: template.variables,
            files: template.files.map((f) => ({
              path: f.path,
              description: f.description,
            })),
          }),
        };
        context.ui.addItem(historyItem, Date.now());
      },
    },
    {
      name: 'generate',
      altNames: ['gen'],
      get description() {
        return t('generate files from a mode template');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        // Delegate to main action which handles generate
        const fullArgs = `generate ${args}`;
        if (templateCommand.action) {
          return templateCommand.action(context, fullArgs);
        }
      },
    },
  ],
};
