/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { tmpdir } from 'os';

/**
 * Creates a temporary directory for testing purposes.
 * @returns The path to the created temporary directory
 */
export function createTmpDir(): string {
  const testDir = path.join(
    tmpdir(),
    `qwen-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  );
  fs.ensureDirSync(testDir);
  return testDir;
}

/**
 * Cleans up a temporary directory created for testing.
 * @param testDir The path to the temporary directory to clean up
 */
export async function cleanupTmpDir(testDir: string): Promise<void> {
  if (testDir && testDir.startsWith(tmpdir())) {
    await fs.remove(testDir);
  }
}

/**
 * Synchronously cleans up a temporary directory created for testing.
 * @param testDir The path to the temporary directory to clean up
 */
export function cleanupTmpDirSync(testDir: string): void {
  if (testDir && testDir.startsWith(tmpdir())) {
    fs.removeSync(testDir);
  }
}

/**
 * Creates a test file with specified content in the given directory
 * @param dir The directory where to create the file
 * @param fileName The name of the file to create
 * @param content The content to write to the file
 * @returns The full path to the created file
 */
export function createTestFile(
  dir: string,
  fileName: string,
  content: string,
): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Creates a nested directory structure for testing
 * @param baseDir The base directory
 * @param structure An array of relative paths to create as nested directories/files
 * @returns An array of full paths to the created directories/files
 */
export function createNestedStructure(
  baseDir: string,
  structure: string[],
): string[] {
  const createdPaths: string[] = [];
  for (const relativePath of structure) {
    const fullPath = path.join(baseDir, relativePath);
    const dirPath = path.dirname(fullPath);

    // Ensure the directory exists
    fs.ensureDirSync(dirPath);

    if (relativePath.endsWith('/')) {
      // This is meant to be a directory
      fs.ensureDirSync(fullPath);
    } else {
      // This is a file, create with empty content or basic content
      fs.writeFileSync(
        fullPath,
        relativePath.includes('.') ? 'test content' : '',
        'utf8',
      );
    }

    createdPaths.push(fullPath);
  }
  return createdPaths;
}

// Define the Config type interface for testing
interface MockConfig {
  getToolRegistry: () => {
    registerTool: () => void;
    getFunctionDeclarations: () => unknown[];
    getFunctionDeclarationsFiltered: (names: string[]) => unknown[];
  };
  getGeminiClient: () => unknown;
  getModel: () => string;
  getWorkspaceContext: () => Record<string, unknown>;
  getSessionId: () => string;
  getSkipStartupContext: () => boolean;
  getDebugMode: () => boolean;
  getApprovalMode: () => string;
  setApprovalMode: (mode: string) => void;
  getMcpServers: () => unknown[];
  getMcpServerCommand: () => string | null;
  getPromptRegistry: () => {
    getPrompts: () => unknown[];
  };
  getWebSearchConfig: () => Record<string, unknown>;
  getProxy: () => string | null;
  getToolDiscoveryCommand: () => unknown[];
  getToolCallCommand: () => unknown[];
  getProjectRoot: () => string;
  getTelemetryEnabled: () => boolean;
  getUsageStatisticsEnabled: () => boolean;
  getTrustedFolderStatus: () => string;
  setTrustedFolderStatus: (status: string) => void;
  getScreenReader: () => boolean;
  getTerminalWidth: () => number;
  getTruncateToolOutputLines: () => number;
  getTruncateToolOutputThreshold: () => number;
  getTargetDir: () => string;
  getBaseUrl: () => string;
}

/**
 * A mock implementation of configuration for testing
 */
export function createMockConfig(): MockConfig {
  return {
    getToolRegistry: () => ({
      registerTool: () => {},
      getFunctionDeclarations: () => [],
      getFunctionDeclarationsFiltered: (names: string[]) =>
        names.map((n) => ({ name: n, description: 'Mock tool' })),
    }),
    getGeminiClient: () => {},
    getModel: () => 'mock-model',
    getWorkspaceContext: () => ({}),
    getSessionId: () => 'test-session-' + Date.now(),
    getSkipStartupContext: () => false,
    getDebugMode: () => false,
    getApprovalMode: () => 'auto',
    setApprovalMode: () => {},
    getMcpServers: () => [],
    getMcpServerCommand: () => null,
    getPromptRegistry: () => ({ getPrompts: () => [] }),
    getWebSearchConfig: () => ({}),
    getProxy: () => null,
    getToolDiscoveryCommand: () => [],
    getToolCallCommand: () => [],
    getProjectRoot: () => '/tmp',
    getTelemetryEnabled: () => false,
    getUsageStatisticsEnabled: () => false,
    getTrustedFolderStatus: () => 'full-access',
    setTrustedFolderStatus: () => {},
    getScreenReader: () => false,
    getTerminalWidth: () => 80,
    getTruncateToolOutputLines: () => 50,
    getTruncateToolOutputThreshold: () => 1000,
    getTargetDir: () => '/tmp',
    getBaseUrl: () => 'https://api.example.com',
  };
}

export default {
  createTmpDir,
  cleanupTmpDir,
  cleanupTmpDirSync,
  createTestFile,
  createNestedStructure,
  createMockConfig,
};
