/**
 * Session Tools Core - Validation Utilities
 *
 * Shared validation logic for session-scoped tools.
 * Provides portable validation that works in both in-process and subprocess contexts.
 */

import { z } from 'zod';
import matter from 'gray-matter';
import { existsSync, readFileSync } from 'node:fs';
import type { ValidationResult, ValidationIssue } from './types.ts';

/** Strip UTF-8 BOM that breaks JSON.parse */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// ============================================================
// Validation Result Helpers
// ============================================================

/**
 * Create an empty valid result
 */
export function validResult(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

/**
 * Create an invalid result with a single error
 */
export function invalidResult(path: string, message: string, suggestion?: string): ValidationResult {
  return {
    valid: false,
    errors: [{ path, message, suggestion }],
    warnings: [],
  };
}

/**
 * Merge multiple validation results into one
 */
export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const result of results) {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Validation Result Formatting
// ============================================================

/**
 * Format validation result as human-readable text for tool responses.
 * This is the simplified version used by session tools.
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push('✓ Validation passed');
  } else {
    lines.push('✗ Validation failed');
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
      if (error.suggestion) {
        lines.push(`    → ${error.suggestion}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning.path}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// JSON Validation
// ============================================================

/**
 * Validate JSON file existence and parse it
 */
export function readJsonFile(filePath: string): { success: true; data: unknown } | { success: false; error: string } {
  if (!existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(stripBom(content));
    return { success: true, data };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: `Invalid JSON: ${message}` };
  }
}

/**
 * Validate a JSON file has required fields
 */
export function validateJsonFileHasFields(
  filePath: string,
  requiredFields: string[]
): ValidationResult {
  const result = readJsonFile(filePath);

  if (!result.success) {
    return invalidResult(filePath, result.error, 'Check file exists and contains valid JSON');
  }

  const errors: ValidationIssue[] = [];
  const data = result.data as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push({
        path: field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Convert Zod error to ValidationIssues
 */
export function zodErrorToIssues(error: z.ZodError, filePath: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || filePath,
    message: issue.message,
  }));
}

// ============================================================
// Slug Validation
// ============================================================

/**
 * Regex for valid slugs: lowercase alphanumeric with hyphens
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a slug format
 */
export function validateSlug(slug: string): ValidationResult {
  if (!SLUG_REGEX.test(slug)) {
    const suggestedSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');

    return invalidResult(
      'slug',
      'Slug must be lowercase alphanumeric with hyphens',
      `Suggested: '${suggestedSlug || 'valid-slug-name'}'`
    );
  }

  return validResult();
}

// ============================================================
// Skill Validation
// ============================================================

/**
 * Zod schema for skill metadata (SKILL.md frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Add a 'name' field with a human-readable title"),
  description: z.string().min(1, "Add a 'description' field explaining what this skill does"),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  icon: z.string().optional(),
  requiredSources: z.array(z.string()).optional(),
}).passthrough();

/**
 * Validate skill SKILL.md content (without filesystem access).
 * Used by both in-process and subprocess implementations.
 *
 * @param markdownContent - The full SKILL.md file content
 * @param slug - The skill slug (folder name), used for slug format validation
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Validate slug format
  const slugResult = validateSlug(slug);
  errors.push(...slugResult.errors);

  // 2. Parse frontmatter
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = matter(markdownContent);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (e) {
    return invalidResult(
      'frontmatter',
      `Invalid YAML frontmatter: ${e instanceof Error ? e.message : 'Unknown error'}`,
      'Check YAML syntax in frontmatter section'
    );
  }

  // 3. Validate frontmatter schema
  const metaResult = SkillMetadataSchema.safeParse(frontmatter);
  if (!metaResult.success) {
    errors.push(...zodErrorToIssues(metaResult.error, 'SKILL.md'));
  }

  // 4. Check content is not empty
  if (!body || body.trim().length === 0) {
    errors.push({
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Mermaid Validation (Basic Syntax Check)
// ============================================================

/**
 * Valid mermaid diagram types
 */
export const MERMAID_DIAGRAM_TYPES = [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
  'stateDiagram', 'erDiagram', 'gantt', 'pie', 'mindmap',
  'timeline', 'gitGraph', 'C4Context', 'sankey',
] as const;

/**
 * Basic mermaid syntax validation (no rendering).
 * Checks for common syntax errors without requiring a browser.
 */
export function validateMermaidSyntax(code: string): ValidationResult {
  const lines = code.trim().split('\n');
  const firstLine = lines[0]?.trim() ?? '';

  // Check diagram type declaration
  const hasValidType = MERMAID_DIAGRAM_TYPES.some(type =>
    firstLine.startsWith(type) || firstLine.startsWith(`${type}-v2`)
  );

  if (!hasValidType) {
    return invalidResult(
      'diagram',
      `Unknown diagram type. First line should start with one of: ${MERMAID_DIAGRAM_TYPES.join(', ')}`,
      'Check the diagram type declaration'
    );
  }

  // Check for unbalanced brackets
  const brackets = { '[': 0, '{': 0, '(': 0 };
  for (const char of code) {
    if (char === '[') brackets['[']++;
    if (char === ']') brackets['[']--;
    if (char === '{') brackets['{']++;
    if (char === '}') brackets['{']--;
    if (char === '(') brackets['(']++;
    if (char === ')') brackets['(']--;
  }

  const unbalanced = Object.entries(brackets).filter(([, count]) => count !== 0);
  if (unbalanced.length > 0) {
    const issues = unbalanced.map(([b, c]) =>
      `${b}: ${c > 0 ? 'missing closing' : 'extra closing'}`
    ).join(', ');

    return invalidResult(
      'syntax',
      `Unbalanced brackets: ${issues}`,
      'Check bracket matching in the diagram'
    );
  }

  return validResult();
}

// ============================================================
// Source Config Validation (Basic)
// ============================================================

/**
 * Required fields for source config.json
 */
export const SOURCE_CONFIG_REQUIRED_FIELDS = ['slug', 'name', 'type'];

/**
 * Valid source types
 */
export const SOURCE_TYPES = ['mcp', 'api', 'local'] as const;

/**
 * Basic source config validation (schema-level).
 * For full validation with Zod schemas, use the validators from packages/shared.
 */
export function validateSourceConfigBasic(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return invalidResult('config', 'Config must be an object');
  }

  const errors: ValidationIssue[] = [];
  const data = config as Record<string, unknown>;

  // Check required fields
  for (const field of SOURCE_CONFIG_REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push({
        path: field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // Validate type if present
  if ('type' in data && !SOURCE_TYPES.includes(data.type as typeof SOURCE_TYPES[number])) {
    errors.push({
      path: 'type',
      message: `Invalid type: ${data.type}. Must be one of: ${SOURCE_TYPES.join(', ')}`,
    });
  }

  // Validate slug format if present
  if ('slug' in data && typeof data.slug === 'string') {
    const slugResult = validateSlug(data.slug);
    errors.push(...slugResult.errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}
