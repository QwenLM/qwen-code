/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bundled Skills Manager with Embedded Files Support
 *
 * In bundled mode, skill files are embedded in the binary.
 * In source mode, files are read from filesystem.
 */

import { isInBundledMode, getEmbeddedFile } from '../utils/bundledMode.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const debugLogger = createDebugLogger('BUNDLED_SKILL_MANAGER');

/**
 * Manager for bundled skills that ship with the CLI.
 * Handles skill content retrieval and file extraction.
 */
export class BundledSkillManager {
  private readonly skillsDir: string;
  private extractedFiles: Map<string, string> = new Map();
  private extractionPromises: Map<string, Promise<void>> = new Map();

  constructor() {
    this.skillsDir = isInBundledMode()
      ? 'bundled://skills' // Virtual path for embedded files
      : path.join(__dirname, 'bundled');
  }

  /**
   * Get skill content - from embedded files or filesystem.
   */
  async getSkillContent(skillName: string): Promise<string> {
    const skillPath = `bundled/skills/${skillName}/SKILL.md`;

    if (isInBundledMode()) {
      // Access embedded file directly
      const content = await getEmbeddedFile(skillPath);
      if (content) return content;
    }

    // Fallback to filesystem
    const fullPath = path.join(this.skillsDir, skillName, 'SKILL.md');
    return await fs.readFile(fullPath, 'utf-8');
  }

  /**
   * Get all skill files for a given skill.
   */
  async getSkillFiles(skillName: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();

    if (isInBundledMode() && typeof Bun !== 'undefined') {
      // From embedded files
      for (const file of Bun.embeddedFiles) {
        const embeddedFile = file as { name: string; text(): Promise<string> };
        if (embeddedFile.name.startsWith(`bundled/skills/${skillName}/`)) {
          const relativePath = embeddedFile.name.replace(
            `bundled/skills/${skillName}/`,
            '',
          );
          files.set(relativePath, await embeddedFile.text());
        }
      }
    } else {
      // From filesystem - use fs.readdir with { withFileTypes: true } for type safety
      const skillDir = path.join(this.skillsDir, skillName);
      try {
        const entries = await fs.readdir(skillDir, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          // Dirent objects provide proper type safety for file operations
          if (entry.isFile() && !entry.name.startsWith('.')) {
            const fullPath = path.join(entry.parentPath, entry.name);
            try {
              files.set(entry.name, await fs.readFile(fullPath, 'utf-8'));
            } catch {
              // Skip files that can't be read
            }
          }
        }
      } catch {
        // Skill directory not found
      }
    }

    return files;
  }

  /**
   * Extract embedded files to disk for model to Read/Grep.
   * Called lazily on first skill invocation.
   */
  async extractSkillFiles(skillName: string): Promise<string | null> {
    if (!isInBundledMode()) {
      return this.skillsDir;
    }

    // Memoize extraction
    const existingPromise = this.extractionPromises.get(skillName);
    if (existingPromise) {
      await existingPromise;
      return this.extractedFiles.get(skillName) ?? null;
    }

    const promise = this.doExtract(skillName);
    this.extractionPromises.set(skillName, promise);
    await promise;
    return this.extractedFiles.get(skillName) ?? null;
  }

  private async doExtract(skillName: string): Promise<void> {
    const extractDir = this.getExtractDir(skillName);

    try {
      // Find all embedded files for this skill
      if (typeof Bun !== 'undefined') {
        const skillFiles = Bun.embeddedFiles.filter((f: { name: string }) =>
          f.name.startsWith(`bundled/skills/${skillName}/`),
        );

        // Write each file to disk
        for (const file of skillFiles) {
          const embeddedFile = file as {
            name: string;
            text(): Promise<string>;
          };
          const relativePath = embeddedFile.name.replace(
            `bundled/skills/${skillName}/`,
            '',
          );
          const targetPath = path.join(extractDir, relativePath);

          // Ensure directory exists
          await fs.mkdir(path.dirname(targetPath), {
            recursive: true,
            mode: 0o700,
          });

          // Write file with secure permissions
          await this.safeWriteFile(targetPath, await embeddedFile.text());
        }
      }

      this.extractedFiles.set(skillName, extractDir);
    } catch (e) {
      debugLogger.error(`Failed to extract skill ${skillName}:`, e);
    }
  }

  private getExtractDir(skillName: string): string {
    // Use process-specific nonce for security
    const nonce = process.pid.toString(36);
    const cacheDir =
      process.env['XDG_CACHE_HOME'] ||
      (process.env['HOME'] ? path.join(process.env['HOME'], '.cache') : '/tmp');
    return path.join(cacheDir, 'qwen-code', 'skills', nonce, skillName);
  }

  private async safeWriteFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    // Platform-specific secure file opening flags
    // O_EXCL ensures file doesn't exist (prevents symlink attacks)
    // O_NOFOLLOW prevents following symbolic links (Unix only)
    const flags =
      process.platform === 'win32'
        ? 'wx' // Windows: fails if file exists
        : fsSync.constants.O_WRONLY |
          fsSync.constants.O_CREAT |
          fsSync.constants.O_EXCL |
          (fsSync.constants.O_NOFOLLOW ?? 0); // O_NOFOLLOW for Unix, fallback to 0 if unavailable

    const fh = await fs.open(filePath, flags, 0o600);
    try {
      await fh.writeFile(content, 'utf-8');
    } finally {
      await fh.close();
    }
  }

  /**
   * Get the skills directory path.
   */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  /**
   * Check if a skill is available.
   */
  async isSkillAvailable(skillName: string): Promise<boolean> {
    try {
      const content = await this.getSkillContent(skillName);
      return content.length > 0;
    } catch {
      return false;
    }
  }
}
