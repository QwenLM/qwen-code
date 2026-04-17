/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Path-based context rule injection.
//
// Discovers .qwen/rules/ files (recursively) with optional YAML frontmatter.
// Rules declare applicable file paths via glob patterns in `paths:`.
//
// - Rules WITHOUT `paths:` always load at session start (baseline rules).
// - Rules WITH `paths:` are deferred and injected on-demand when the model
//   reads or edits a matching file (turn-level lazy loading).
// - HTML comments are stripped to save tokens.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import picomatch from 'picomatch';
import { parse as parseYaml } from './yaml-parser.js';
import { normalizeContent } from './textUtils.js';
import { QWEN_DIR } from './paths.js';
import { createDebugLogger } from './debugLogger.js';

const logger = createDebugLogger('RULES_DISCOVERY');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleFile {
  filePath: string;
  description?: string;
  paths?: string[];
  content: string;
}

export interface LoadRulesResponse {
  /** Formatted baseline rules (no `paths:`) for the system prompt. */
  content: string;
  /** Number of baseline rules injected at session start. */
  ruleCount: number;
  /** Conditional rules (with `paths:`) for turn-level lazy injection. */
  conditionalRules: RuleFile[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

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
    }
    body = rawBody;
  } else {
    body = normalized;
  }

  const content = stripHtmlComments(body).trim();
  if (!content) return null;

  return { filePath, description, paths, content };
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory scanning (recursive)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively collect all .md file paths under a directory.
 * Returns sorted absolute paths for deterministic ordering.
 */
async function collectMdFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMdFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Discover and load rule files from a single `.qwen/rules/` directory.
 * Scans recursively; files are sorted alphabetically for deterministic ordering.
 *
 * @param excludes - Glob patterns to skip (matched against absolute paths).
 */
async function loadRulesFromDir(
  rulesDir: string,
  excludes: string[],
): Promise<RuleFile[]> {
  const allPaths = await collectMdFiles(rulesDir);
  if (allPaths.length === 0) return [];

  // Sort for deterministic ordering
  allPaths.sort((a, b) => a.localeCompare(b));

  // Compile exclude matchers once
  const excludeMatchers =
    excludes.length > 0 ? excludes.map((p) => picomatch(p, { dot: true })) : [];

  const ruleFiles: RuleFile[] = [];

  for (const filePath of allPaths) {
    // Gap 2: check excludes
    if (excludeMatchers.some((m) => m(filePath))) {
      logger.debug(`Excluding rule by setting: ${filePath}`);
      continue;
    }

    try {
      const rawContent = await fs.readFile(filePath, 'utf-8');
      const rule = parseRuleFile(rawContent, filePath);
      if (rule) {
        ruleFiles.push(rule);
      }
    } catch (error) {
      logger.warn(`Failed to load rule file ${filePath}: ${error}`);
    }
  }

  return ruleFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format loaded rules into a single string with source markers,
 * consistent with the `--- Context from: ... ---` format used for QWEN.md.
 */
export function formatRules(rules: RuleFile[], projectRoot: string): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// ConditionalRulesRegistry (Gap 3: turn-level lazy loading)
// ─────────────────────────────────────────────────────────────────────────────

interface CompiledRule {
  rule: RuleFile;
  matchers: picomatch.Matcher[];
}

/**
 * Registry that holds conditional rules and injects them on-demand when
 * the model accesses a file matching a rule's `paths:` patterns.
 *
 * Each rule is injected at most once per session. Patterns are pre-compiled
 * with picomatch for efficient repeated matching.
 */
export class ConditionalRulesRegistry {
  private readonly compiledRules: CompiledRule[];
  private readonly injected = new Set<string>();
  private readonly projectRoot: string;

  constructor(rules: RuleFile[], projectRoot: string) {
    this.projectRoot = projectRoot;
    this.compiledRules = rules.map((rule) => ({
      rule,
      matchers: (rule.paths ?? []).map((p) => picomatch(p, { dot: false })),
    }));
    logger.debug(
      `ConditionalRulesRegistry created with ${rules.length} rule(s)`,
    );
  }

  /**
   * Check if a file path matches any conditional rules that haven't been
   * injected yet. Matched rules are marked as consumed and their formatted
   * content is returned for injection into the conversation context.
   *
   * @param filePath - Absolute path of the file being accessed.
   * @returns Formatted rule content, or undefined if no new rules match.
   */
  matchAndConsume(filePath: string): string | undefined {
    if (this.compiledRules.length === 0) return undefined;

    // Resolve first to handle both absolute and relative input paths,
    // then compute the path relative to projectRoot for pattern matching.
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);
    const relativePath = path
      .relative(this.projectRoot, absolutePath)
      .replace(/\\/g, '/');

    // Paths outside the project root produce `../` prefixes — don't inject
    // rules for files outside the project.
    if (relativePath.startsWith('../')) return undefined;

    const newMatches = this.compiledRules.filter(({ rule, matchers }) => {
      if (this.injected.has(rule.filePath)) return false;
      return matchers.some((m) => m(relativePath));
    });

    if (newMatches.length === 0) return undefined;

    for (const { rule } of newMatches) {
      this.injected.add(rule.filePath);
      logger.debug(`Injecting conditional rule: ${rule.filePath}`);
    }

    return formatRules(
      newMatches.map((m) => m.rule),
      this.projectRoot,
    );
  }

  get totalCount(): number {
    return this.compiledRules.length;
  }

  get injectedCount(): number {
    return this.injected.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load rules from both global (`~/.qwen/rules/`) and project-level
 * (`.qwen/rules/`) directories.
 *
 * Baseline rules (no `paths:`) are returned in `content` for immediate
 * injection into the system prompt. Conditional rules (with `paths:`) are
 * returned separately in `conditionalRules` for turn-level lazy loading.
 *
 * @param projectRoot - Absolute path to the project root (git root or CWD).
 * @param folderTrust - Whether the project folder is trusted.
 * @param excludes - Glob patterns to skip (matched against absolute paths).
 */
export async function loadRules(
  projectRoot: string,
  folderTrust: boolean,
  excludes: string[] = [],
): Promise<LoadRulesResponse> {
  logger.debug(`Loading rules for project: ${projectRoot}`);

  const allRules: RuleFile[] = [];

  // 1. Global rules: ~/.qwen/rules/
  const globalRulesDir = path.join(homedir(), QWEN_DIR, 'rules');
  const globalRules = await loadRulesFromDir(globalRulesDir, excludes);
  allRules.push(...globalRules);
  logger.debug(`Loaded ${globalRules.length} global rule(s)`);

  // 2. Project-level rules: <projectRoot>/.qwen/rules/  (trusted only)
  //    Skip if it resolves to the same directory as global rules.
  if (folderTrust) {
    const projectRulesDir = path.join(projectRoot, QWEN_DIR, 'rules');
    if (path.resolve(projectRulesDir) !== path.resolve(globalRulesDir)) {
      const projectRules = await loadRulesFromDir(projectRulesDir, excludes);
      allRules.push(...projectRules);
      logger.debug(`Loaded ${projectRules.length} project rule(s)`);
    } else {
      logger.debug(
        'Project rules dir same as global — skipping to avoid duplicates',
      );
    }
  }

  // Split into baseline (no paths) and conditional (has paths)
  const baselineRules: RuleFile[] = [];
  const conditionalRules: RuleFile[] = [];
  for (const rule of allRules) {
    if (rule.paths) {
      conditionalRules.push(rule);
    } else {
      baselineRules.push(rule);
    }
  }

  logger.debug(
    `Split: ${baselineRules.length} baseline, ${conditionalRules.length} conditional`,
  );

  const content =
    baselineRules.length > 0 ? formatRules(baselineRules, projectRoot) : '';

  return { content, ruleCount: baselineRules.length, conditionalRules };
}
