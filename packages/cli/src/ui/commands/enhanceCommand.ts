/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Slash command for enhancing prompts to team-lead quality
 */
export const enhanceCommand: SlashCommand = {
  name: 'enhance',
  altNames: ['improve', 'refine'],
  get description() {
    return t(
      'Transform a basic prompt into a professional team-lead level prompt',
    );
  },
  kind: CommandKind.BUILT_IN,
  hidden: false,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    // If no args, show help
    if (!args || args.trim().length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content:
          t(`Prompt Enhancer - Transform basic prompts into professional prompts

Usage:
  /enhance <your prompt>     - Enhance a prompt to team-lead quality
  /enhance --preview <text>  - Show preview of enhancement
  /enhance --help            - Show this help message

Examples:
  /enhance Fix the login bug
  /enhance Add authentication to the API
  /enhance Create a user profile component

The enhancer will:
  • Detect your intent (code creation, bug fix, review, etc.)
  • Add structured sections (Context, Requirements, Constraints)
  • Include acceptance criteria and implementation plan
  • Enrich with project-specific context
`),
      };
    }

    // Handle help flag
    if (args === '--help' || args === '-h') {
      return {
        type: 'message',
        messageType: 'info',
        content: t(`Prompt Enhancer Help

Usage:
  /enhance <your prompt>     - Enhance a prompt to team-lead quality
  /enhance --preview <text>  - Show preview without full enhancement
  /enhance --level <level>   - Set enhancement level (minimal|standard|maximal)

Enhancement Levels:
  minimal   - Quick cleanup and basic structure
  standard  - Full enhancement with all sections (default)
  maximal   - Comprehensive with examples and edge cases

Examples:
  /enhance Fix the bug in auth.ts
  /enhance --level minimal Add tests
  /enhance --level maximal Create user dashboard
`),
      };
    }

    try {
      // Parse arguments
      let promptText = args;
      let previewMode = false;

      // Check for --preview flag
      if (args.startsWith('--preview')) {
        previewMode = true;
        promptText = args.replace('--preview', '').trim();
      }

      // Remove any remaining flags
      promptText = promptText.replace(/--help|-h/g, '').trim();

      if (!promptText || promptText.length === 0) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Error: Please provide a prompt to enhance. Use /enhance --help for usage.',
          ),
        };
      }

      // Dynamically import the prompt enhancer
      // Note: Using dist path because TypeScript requires compiled modules
      const { PromptEnhancer } = await import('@qwen-code/prompt-enhancer');

      // Create enhancer with project context
      const projectRoot =
        context.services.config?.getProjectRoot() || process.cwd();

      // Get settings from context if available
      const settings = (
        context.services as unknown as {
          settings?: { merged?: { promptEnhancer?: { level?: string } } };
        }
      ).settings?.merged?.promptEnhancer;
      const level = (args.match(/--level\s+(minimal|standard|maximal)/)?.[1] ||
        settings?.level ||
        'standard') as 'minimal' | 'standard' | 'maximal';

      const enhancer = new PromptEnhancer({
        level,
        projectRoot,
      });

      // Show pending message
      context.ui.setPendingItem({
        type: 'info',
        text: t('Enhancing your prompt...'),
      });

      if (previewMode) {
        // Preview mode
        const preview = await enhancer.preview(promptText);
        context.ui.setPendingItem(null);

        return {
          type: 'message',
          messageType: 'info',
          content:
            t(`Preview Enhancement (estimated improvement: ${preview.estimatedImprovement.toFixed(0)}%):

${preview.enhancedPreview}

To apply full enhancement, run:
  /enhance ${promptText}`),
        };
      }

      // Full enhancement
      const result = await enhancer.enhance(promptText);

      context.ui.setPendingItem(null);

      // Format the enhanced prompt
      const improvement = (
        result.scores.after.overall - result.scores.before.overall
      ).toFixed(1);

      const enhancementsList = result.appliedEnhancements
        .map((e: { description: string }) => `  • ${e.description}`)
        .join('\n');

      const formattedOutput =
        t(`✨ Prompt Enhanced (Quality improvement: +${improvement} points)

Original (${result.scores.before.overall.toFixed(1)}/10):
${result.original}

---

Enhanced (${result.scores.after.overall.toFixed(1)}/10):
${result.enhanced}

---

Applied Enhancements:
${enhancementsList || '  • Basic structure and formatting'}

Suggestions for better prompts:
${result.suggestions.map((s: string) => `  • ${s}`).join('\n') || '  • None - great prompt!'}

---

To use this enhanced prompt, simply copy it or continue the conversation.`);

      return {
        type: 'message',
        messageType: 'info',
        content: formattedOutput,
      };
    } catch (error) {
      context.ui.setPendingItem(null);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        type: 'message',
        messageType: 'error',
        content: t(`Error enhancing prompt: ${errorMessage}

Please try again or use a different prompt.`),
      };
    }
  },
  completion: async (_context, _partialArg) => 
    // Provide completion suggestions for flags
     [
      { value: '--help', label: '--help', description: 'Show help message' },
      {
        value: '--preview',
        label: '--preview',
        description: 'Preview enhancement',
      },
      {
        value: '--level minimal',
        label: '--level minimal',
        description: 'Minimal enhancement',
      },
      {
        value: '--level standard',
        label: '--level standard',
        description: 'Standard enhancement',
      },
      {
        value: '--level maximal',
        label: '--level maximal',
        description: 'Maximal enhancement',
      },
    ]
  ,
};
