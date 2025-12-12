/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'fs';

export interface CliPathDetectionResult {
  path: string | null;
  error?: string;
}

/**
 * Determine the correct Node.js executable path for a given CLI installation
 * Handles various Node.js version managers (nvm, n, manual installations)
 *
 * @param cliPath - Path to the CLI executable
 * @returns Path to the Node.js executable, or null if not found
 */
export function determineNodePathForCli(
  cliPath: string,
): CliPathDetectionResult {
  // Common patterns for Node.js installations
  const nodePathPatterns = [
    // NVM pattern: /Users/user/.nvm/versions/node/vXX.XX.X/bin/qwen -> /Users/user/.nvm/versions/node/vXX.XX.X/bin/node
    cliPath.replace(/\/bin\/qwen$/, '/bin/node'),

    // N pattern: /Users/user/n/bin/qwen -> /Users/user/n/bin/node
    cliPath.replace(/\/bin\/qwen$/, '/bin/node'),

    // Manual installation pattern: /usr/local/bin/qwen -> /usr/local/bin/node
    cliPath.replace(/\/qwen$/, '/node'),

    // Alternative pattern: /opt/nodejs/bin/qwen -> /opt/nodejs/bin/node
    cliPath.replace(/\/bin\/qwen$/, '/bin/node'),
  ];

  // Check each pattern
  for (const nodePath of nodePathPatterns) {
    try {
      const stats = statSync(nodePath);
      if (stats.isFile()) {
        // Verify it's executable
        if (stats.mode & 0o111) {
          console.log(`[CLI] Found Node.js executable for CLI at: ${nodePath}`);
          return { path: nodePath };
        } else {
          console.log(`[CLI] Node.js found at ${nodePath} but not executable`);
          return {
            path: null,
            error: `Node.js found at ${nodePath} but not executable. You may need to fix file permissions or reinstall the CLI.`,
          };
        }
      }
    } catch (error) {
      // Differentiate between error types
      if (error instanceof Error) {
        if ('code' in error && error.code === 'EACCES') {
          console.log(`[CLI] Permission denied accessing ${nodePath}`);
          return {
            path: null,
            error: `Permission denied accessing ${nodePath}. The CLI may have been installed with sudo privileges. Try reinstalling without sudo or adjusting file permissions.`,
          };
        } else if ('code' in error && error.code === 'ENOENT') {
          // File not found, continue to next pattern
          continue;
        } else {
          console.log(`[CLI] Error accessing ${nodePath}: ${error.message}`);
          return {
            path: null,
            error: `Error accessing Node.js at ${nodePath}: ${error.message}`,
          };
        }
      }
    }
  }

  // Try to find node in the same directory as the CLI
  const cliDir = cliPath.substring(0, cliPath.lastIndexOf('/'));
  const potentialNodePaths = [`${cliDir}/node`, `${cliDir}/bin/node`];

  for (const nodePath of potentialNodePaths) {
    try {
      const stats = statSync(nodePath);
      if (stats.isFile()) {
        if (stats.mode & 0o111) {
          console.log(
            `[CLI] Found Node.js executable in CLI directory at: ${nodePath}`,
          );
          return { path: nodePath };
        } else {
          console.log(`[CLI] Node.js found at ${nodePath} but not executable`);
          return {
            path: null,
            error: `Node.js found at ${nodePath} but not executable. You may need to fix file permissions or reinstall the CLI.`,
          };
        }
      }
    } catch (error) {
      // Differentiate between error types
      if (error instanceof Error) {
        if ('code' in error && error.code === 'EACCES') {
          console.log(`[CLI] Permission denied accessing ${nodePath}`);
          return {
            path: null,
            error: `Permission denied accessing ${nodePath}. The CLI may have been installed with sudo privileges. Try reinstalling without sudo or adjusting file permissions.`,
          };
        } else if ('code' in error && error.code === 'ENOENT') {
          // File not found, continue
          continue;
        } else {
          console.log(`[CLI] Error accessing ${nodePath}: ${error.message}`);
          return {
            path: null,
            error: `Error accessing Node.js at ${nodePath}: ${error.message}`,
          };
        }
      }
    }
  }

  console.log(`[CLI] Could not determine Node.js path for CLI: ${cliPath}`);
  return {
    path: null,
    error: `Could not find Node.js executable for CLI at ${cliPath}. Please verify the CLI installation.`,
  };
}
