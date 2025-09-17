/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'child_process';
import { CommandKind, SlashCommand } from './types.js';
import { MessageType, HistoryItemInfo } from '../types.js';
import * as fs from 'fs';
import {
  getReviewPrompt,
  isGitRepository,
  Config,
} from '@qwen-code/qwen-code-core';

interface ModifiedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export const codeReviewCommand: SlashCommand = {
  name: 'code-review',
  description: 'Submit code for AI review',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const { ui, services } = context;

    // Parse arguments
    const argsArray = args.trim() ? args.trim().split(/\s+/) : [];
    const goals = argsArray.join(' ');

    // Check if we're in a git repository
    if (!isGitRepository('.')) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'This command must be run from a git repository.',
        },
        Date.now(),
      );
      return;
    }

    try {
      // Check for uncommitted changes
      const uncommittedChanges = execSync('git status --porcelain', {
        encoding: 'utf-8',
      }).trim();

      if (uncommittedChanges.length === 0) {
        ui.addItem(
          {
            type: MessageType.INFO,
            text: 'No uncommitted changes found. Please make some changes before requesting a code review.',
          },
          Date.now(),
        );
        return;
      }

      // Get modified files
      const modifiedFiles = getModifiedFiles();

      if (modifiedFiles.length === 0) {
        ui.addItem(
          {
            type: MessageType.INFO,
            text: 'No modified files found for review.',
          },
          Date.now(),
        );
        return;
      }

      // Show initial feedback to user
      ui.addItem(
        {
          type: MessageType.INFO,
          text: `Found ${modifiedFiles.length} file${modifiedFiles.length !== 1 ? 's' : ''} to review${goals ? ` with goals: "${goals}"` : ''}`,
        },
        Date.now(),
      );

      // Set pending item to show loading state
      const pendingItem: HistoryItemInfo = {
        type: 'info',
        text: `Analyzing ${modifiedFiles.length} file${modifiedFiles.length !== 1 ? 's' : ''}... This may take a moment.`,
      };
      ui.setPendingItem(pendingItem);

      // Perform AI code review
      const reviewResult = await performCodeReview(
        services.config,
        modifiedFiles,
        goals,
      );

      // Clear pending item
      ui.setPendingItem(null);

      // Add a completion message
      ui.addItem(
        {
          type: MessageType.INFO,
          text: `Code review completed for ${modifiedFiles.length} file${modifiedFiles.length !== 1 ? 's' : ''}.`,
        },
        Date.now(),
      );

      ui.addItem(
        {
          type: MessageType.INFO,
          text: reviewResult,
        },
        Date.now(),
      );
    } catch (error) {
      // Clear pending item on error
      ui.setPendingItem(null);

      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to perform code review: ${error instanceof Error ? error.message : String(error)}`,
        },
        Date.now(),
      );
    }
  },
};

function getModifiedFiles(): ModifiedFile[] {
  const statusOutput = execSync('git status --porcelain', {
    encoding: 'utf-8',
  }).trim();

  if (!statusOutput) {
    return [];
  }

  const lines = statusOutput.split('\n');
  const files: ModifiedFile[] = [];

  for (const line of lines) {
    const status = line.substring(0, 2).trim();
    const filePath = line.substring(3).trim();

    switch (status) {
      case 'A': // Added
        files.push({ path: filePath, status: 'added' });
        break;
      case 'M': // Modified
        files.push({ path: filePath, status: 'modified' });
        break;
      case 'D': // Deleted
        files.push({ path: filePath, status: 'deleted' });
        break;
      case 'R': // Renamed
        {
          // For renamed files, we get something like "R  old_name -> new_name"
          const parts = filePath.split(' -> ');
          if (parts.length === 2) {
            files.push({ path: parts[1], status: 'added' }); // Treat as new file
          }
        }
        break;
      default:
        // Handle any other status codes if needed
        break;
    }
  }

  return files;
}

async function performCodeReview(
  config: Config | null,
  files: ModifiedFile[],
  goals: string,
): Promise<string> {
  // Prepare file contents for review
  let reviewContent = `# Code Review Request

Please provide a detailed code review with specific feedback. Do not just respond with "LGTM". Instead, analyze the code for:
1. Code Quality: Is the code readable, maintainable, and well-structured?
2. Best Practices: Does the code follow language-specific conventions and patterns?
3. Security: Are there any potential security vulnerabilities?
4. Performance: Are there any performance concerns or inefficiencies?
5. Bug Prevention: Are there any potential bugs or edge cases that aren't handled?

`;

  if (goals) {
    reviewContent += `## User Goals
${goals}

`;
  }

  reviewContent += `## Files to Review

`;

  for (const file of files) {
    reviewContent += `### File: ${file.path}
`;
    reviewContent += `Status: ${file.status}

`;

    if (file.status !== 'deleted') {
      try {
        // Try to get the current content
        const currentContent = fs.readFileSync(file.path, 'utf-8');
        const fileExtension = getFileExtension(file.path);
        reviewContent += `Current Content:
\`\`\`${fileExtension}
${currentContent}
\`\`\`

`;

        // Try to get the previous content if it's a modification
        if (file.status === 'modified') {
          try {
            const previousContent = execSync(`git show HEAD:${file.path}`, {
              encoding: 'utf-8',
            });
            const fileExtension = getFileExtension(file.path);
            reviewContent += `Previous Content:
\`\`\`${fileExtension}
${previousContent}
\`\`\`

`;
          } catch (_error) {
            // If we can't get the previous content, just note that
            reviewContent += `Previous Content: Could not retrieve

`;
          }
        }
      } catch (_error) {
        reviewContent += `Error reading file: ${_error instanceof Error ? _error.message : String(_error)}

`;
      }
    }

    reviewContent += `---

`;
  }

  // Get the AI client and perform the review
  if (!config) {
    return 'AI review is not available. Configuration is missing.';
  }

  const geminiClient = config.getGeminiClient();
  if (!geminiClient || !geminiClient.isInitialized()) {
    return 'AI review is not available. Please ensure you have configured your AI provider.';
  }

  try {
    const response = await geminiClient.generateContent(
      [
        {
          role: 'user',
          parts: [{ text: reviewContent }],
        },
      ],
      {
        systemInstruction: { text: getReviewPrompt() },
      },
      new AbortController().signal,
    );

    const reviewText =
      response.candidates?.[0]?.content?.parts?.[0]?.text ||
      'No review feedback received.';

    // Format the review results as a proper report
    return `# Code Review Report

${reviewText}`;
  } catch (_error) {
    return `Failed to get AI review: ${_error instanceof Error ? _error.message : String(_error)}`;
  }
}

// Helper function to get file extension for syntax highlighting
function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  if (parts.length > 1) {
    return parts[parts.length - 1];
  }
  return '';
}
