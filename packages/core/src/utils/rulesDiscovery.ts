/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Path-based context rule injection.
//
// Discovers .qwen/rules/*.md files with optional YAML frontmatter.
// Rules declare applicable file paths via glob patterns in the
// `paths:` frontmatter field.
//
// - Rules WITH `paths:` load only when matching files exist in the project.
// - Rules WITHOUT `paths:` always load (baseline rules).
// - HTML comments are stripped to save tokens.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { globIterate } from 'glob';
import { parse as parseYaml } from './yaml-parser.js';
import { normalizeContent } from './textUtils.js';
import { QWEN_DIR } from './paths.js';
import { createDebugLogger } from './debugLogger.js';

const logger = createDebugLogger('RULES_DISCOVERY');

export interface RuleFile {
  filePath: string;
  description?: string;
  paths?: string[];
  content: string;
}

export interface LoadRulesResponse {
  content: string;
  ruleCount: number;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

/**
 * Strip HTML comments from content to save tokens.
 */
function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Parse a rule file's YAML frontmatter and body content.
 * Returns null if the file has no usable content after processing.
 */
export function parseRuleFile(
  rawContent: string,
  filePath: string,
): RuleFile | null {
  const normalized = normalizeContent(rawContent);
  const match = normalized.match(FRONTMATTER_REGEX);

  let body: string;
  let paths: string[] | undefined;
  let description: string | undefined;

  if (match) {
    const [, frontmatterYaml, rawBody] = match;
    try {
      const frontmatter = parseYaml(frontmatterYaml);

      const pathsRaw = frontmatter['paths'];
      if (Array.isArray(pathsRaw)) {
        paths = pathsRaw.map(String).filter(Boolean);
        if (paths.length === 0) paths = undefined;
      } else if (typeof pathsRaw === 'string' && pathsRaw) {
        paths = [pathsRaw];
      }

      if (frontmatter['description'] != null) {
        description = String(frontmatter['description']);
      }
    } catch (error) {
      logger.warn(`Failed to parse frontmatter in ${filePath}: ${error}`);
      // Treat as no-frontmatter baseline rule
    }
    body = rawBody;
  } else {
    body = normalized;
  }

  const content = stripHtmlComments(body).trim();
  if (!content) return null;

  return { filePath, description, paths, content };
}

/**
 * Check if any files in the project match the given glob patterns.
 * Uses globIterate to return as soon as the first match is found,
 * avoiding a full tree scan in large repos.
 */
export async function hasMatchingFiles(
  patterns: string[],
  projectRoot: string,
): Promise<boolean> {
  try {
    for await (const _match of globIterate(patterns, {
      cwd: projectRoot,
      nodir: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })) {
      return true;
    }
    return false;
  } catch (error) {
    logger.warn(`Glob matching failed for patterns ${patterns}: ${error}`);
    return false;
  }
}

/**
 * Discover and load rule files from a single `.qwen/rules/` directory.
 * Files are sorted alphabetically for deterministic ordering.
 */
async function loadRulesFromDir(
  rulesDir: string,
  projectRoot: string,
): Promise<RuleFile[]> {
  let entries;
  try {
    entries = await fs.readdir(rulesDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist — not an error
    return [];
  }

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const ruleFiles: RuleFile[] = [];

  for (const entry of mdFiles) {
    const filePath = path.join(rulesDir, entry.name);
    try {
      const rawContent = await fs.readFile(filePath, 'utf-8');
      const rule = parseRuleFile(rawContent, filePath);
      if (!rule) continue;

      // Baseline rule (no paths) — always include
      if (!rule.paths) {
        logger.debug(`Including baseline rule: ${filePath}`);
        ruleFiles.push(rule);
        continue;
      }

      // Conditional rule — check if matching files exist in the project
      const matches = await hasMatchingFiles(rule.paths, projectRoot);
      if (matches) {
        logger.debug(`Including conditional rule (matched): ${filePath}`);
        ruleFiles.push(rule);
      } else {
        logger.debug(`Skipping conditional rule (no match): ${filePath}`);
      }
    } catch (error) {
      logger.warn(`Failed to load rule file ${filePath}: ${error}`);
    }
  }

  return ruleFiles;
}

/**
 * Format loaded rules into a single string with source markers,
 * consistent with the `--- Context from: ... ---` format used for QWEN.md.
 */
function formatRules(rules: RuleFile[], projectRoot: string): string {
  return rules
    .map((rule) => {
      const displayPath = path.isAbsolute(rule.filePath)
        ? path.relative(projectRoot, rule.filePath)
        : rule.filePath;
      return (
        `--- Rule from: ${displayPath} ---\n` +
        `${rule.content}\n` +
        `--- End of Rule from: ${displayPath} ---`
      );
    })
    .join('\n\n');
}

/**
 * Load rules from both global (`~/.qwen/rules/`) and project-level
 * (`.qwen/rules/`) directories.
 *
 * @param projectRoot - Absolute path to the project root (git root or CWD).
 * @param folderTrust - Whether the project folder is trusted.
 *   Untrusted projects only get global rules.
 */
export async function loadRules(
  projectRoot: string,
  folderTrust: boolean,
): Promise<LoadRulesResponse> {
  logger.debug(`Loading rules for project: ${projectRoot}`);

  const rules: RuleFile[] = [];

  // 1. Global rules: ~/.qwen/rules/
  const globalRulesDir = path.join(homedir(), QWEN_DIR, 'rules');
  const globalRules = await loadRulesFromDir(globalRulesDir, projectRoot);
  rules.push(...globalRules);
  logger.debug(`Loaded ${globalRules.length} global rule(s)`);

  // 2. Project-level rules: <projectRoot>/.qwen/rules/  (trusted only)
  //    Skip if it resolves to the same directory as global rules.
  if (folderTrust) {
    const projectRulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
    if (path.resolve(projectRulesDir) !== path.resolve(globalRulesDir)) {
      const projectRules = await loadRulesFromDir(projectRulesDir, projectRoot);
      rules.push(...projectRules);
      logger.debug(`Loaded ${projectRules.length} project rule(s)`);
    } else {
      logger.debug(
        'Project rules dir same as global — skipping to avoid duplicates',
      );
    }
  }

  if (rules.length === 0) {
    return { content: '', ruleCount: 0 };
  }

  const content = formatRules(rules, projectRoot);
  logger.debug(
    `Total: ${rules.length} rule(s), content length: ${content.length}`,
  );

  return { content, ruleCount: rules.length };
}
