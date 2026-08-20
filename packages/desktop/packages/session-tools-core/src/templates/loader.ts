/**
 * Template Loader
 *
 * Discovers and loads HTML templates from source directories.
 * Parses self-describing header comments for metadata and validation.
 *
 * Template header format:
 * <!--
 *   @template issue-detail
 *   @name Issue Detail
 *   @description Renders a single Linear issue
 *   @required identifier, title, status
 *   @optional priority, assignee, team
 * -->
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// ============================================================
// Types
// ============================================================

export interface TemplateMeta {
  /** Template identifier (from @template) */
  id: string;
  /** Human-readable name (from @name) */
  name: string;
  /** Description of what the template renders (from @description) */
  description: string;
  /** Required data fields (from @required) */
  required: string[];
  /** Optional data fields (from @optional) */
  optional: string[];
}

export interface LoadedTemplate {
  /** Parsed metadata from the header comment */
  meta: TemplateMeta;
  /** Raw HTML template content (including header comment) */
  content: string;
  /** Absolute path to the template file */
  filePath: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

// ============================================================
// Header Parsing
// ============================================================

/**
 * Parse the HTML comment header to extract template metadata.
 * Returns null if no valid header is found.
 */
export function parseTemplateHeader(content: string): TemplateMeta | null {
  // Match the first HTML comment at the start of the file (with optional leading whitespace)
  const commentMatch = content.match(/^\s*<!--([\s\S]*?)-->/);
  if (!commentMatch) return null;

  const comment = commentMatch[1] ?? '';

  // Extract @tags
  const getTag = (tag: string): string => {
    const match = comment.match(new RegExp(`@${tag}\\s+(.+?)\\s*$`, 'm'));
    return match?.[1]?.trim() ?? '';
  };

  const getTagList = (tag: string): string[] => {
    const value = getTag(tag);
    if (!value) return [];
    return value.split(',').map(s => s.trim()).filter(Boolean);
  };

  const id = getTag('template');
  if (!id) return null; // @template is required

  return {
    id,
    name: getTag('name') || id,
    description: getTag('description') || '',
    required: getTagList('required'),
    optional: getTagList('optional'),
  };
}

// ============================================================
// Template Loading
// ============================================================

/**
 * Load a specific template from a source's templates directory.
 *
 * @param sourcePath - Absolute path to the source directory (e.g., ~/.craft-agent/workspaces/ws/sources/linear)
 * @param templateId - The template identifier (e.g., "issue-detail")
 * @returns The loaded template, or null if not found
 */
export function loadTemplate(sourcePath: string, templateId: string): LoadedTemplate | null {
  const templatesDir = join(sourcePath, 'templates');

  // Try exact filename match: {templateId}.html
  const filePath = join(templatesDir, `${templateId}.html`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const meta = parseTemplateHeader(content);

    if (!meta) {
      // Still load it — just with minimal metadata
      return {
        meta: {
          id: templateId,
          name: templateId,
          description: '',
          required: [],
          optional: [],
        },
        content,
        filePath,
      };
    }

    return { meta, content, filePath };
  } catch {
    return null;
  }
}

/**
 * List all available templates for a source.
 *
 * @param sourcePath - Absolute path to the source directory
 * @returns Array of template metadata (without content, for efficiency)
 */
export function listTemplates(sourcePath: string): TemplateMeta[] {
  const templatesDir = join(sourcePath, 'templates');

  if (!existsSync(templatesDir)) {
    return [];
  }

  const templates: TemplateMeta[] = [];

  try {
    const files = readdirSync(templatesDir).filter(f => f.endsWith('.html'));

    for (const file of files) {
      const filePath = join(templatesDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const meta = parseTemplateHeader(content);
        if (meta) {
          templates.push(meta);
        } else {
          // File without header — use filename as ID
          const id = file.replace(/\.html$/, '');
          templates.push({
            id,
            name: id,
            description: '',
            required: [],
            optional: [],
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Templates dir not readable
  }

  return templates;
}

// ============================================================
// Soft Validation
// ============================================================

/**
 * Validate data against a template's @required fields.
 * Returns warnings for missing required fields.
 * Always non-blocking — the template should still be rendered.
 */
export function validateTemplateData(
  meta: TemplateMeta,
  data: Record<string, unknown>
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  for (const field of meta.required) {
    if (!(field in data) || data[field] == null) {
      warnings.push({
        field,
        message: `Missing required field: "${field}"`,
      });
    }
  }

  return warnings;
}
