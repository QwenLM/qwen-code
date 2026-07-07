/**
 * ConfigValidator - Pre-Write Configuration Validation
 *
 * Provides validation utilities for configuration files before writing.
 * Backend agents can use this to validate Write/Edit tool
 * inputs before they modify config files.
 *
 * Key responsibilities:
 * - Validate JSON syntax before writing
 * - Detect config file types by path/extension
 * - Provide helpful error messages for malformed configs
 */

import type { ConfigValidationResult, ConfigFileType, ConfigValidatorConfig } from './types.ts';

/**
 * Patterns for detecting known config file types.
 */
const CONFIG_FILE_PATTERNS: { pattern: RegExp; type: ConfigFileType }[] = [
  // JSON configs
  { pattern: /\.json$/i, type: 'json' },
  { pattern: /\.jsonc$/i, type: 'json' },
  // TOML configs
  { pattern: /\.toml$/i, type: 'toml' },
  // YAML configs
  { pattern: /\.ya?ml$/i, type: 'yaml' },
];

/**
 * Qwen Code specific config files that have known schemas.
 */
const CRAFT_AGENT_CONFIG_PATTERNS = [
  // Main config
  /\.craft-agent\/config\.json$/,
  // Preferences
  /\.craft-agent\/preferences\.json$/,
  // Source configs
  /\.craft-agent\/workspaces\/[^/]+\/sources\/[^/]+\/config\.json$/,
  // Permissions
  /\.craft-agent\/workspaces\/[^/]+\/permissions\.json$/,
  /\.craft-agent\/permissions\/[^/]+\.json$/,
  // Theme
  /\.craft-agent\/workspaces\/[^/]+\/theme\.json$/,
  // Statuses
  /\.craft-agent\/workspaces\/[^/]+\/statuses\/config\.json$/,
  // Labels
  /\.craft-agent\/workspaces\/[^/]+\/labels\.json$/,
  // Tool icons
  /\.craft-agent\/tool-icons\/tool-icons\.json$/,
];

/**
 * ConfigValidator provides pre-write validation for config files.
 *
 * Usage:
 * ```typescript
 * const validator = new ConfigValidator();
 *
 * // Check file type before writing
 * const fileType = validator.getConfigType('/path/to/config.json');
 *
 * // Validate content before writing
 * const result = validator.validateContent('/path/to/config.json', newContent);
 * if (!result.valid) {
 *   // Show errors to user/agent
 * }
 * ```
 */
export class ConfigValidator {
  private config: ConfigValidatorConfig;

  constructor(config: ConfigValidatorConfig = {}) {
    this.config = config;
  }

  // ============================================================
  // Config Type Detection
  // ============================================================

  /**
   * Detect the config file type based on path/extension.
   *
   * @param filePath - Path to the file
   * @returns Config type or null if not a known config format
   */
  getConfigType(filePath: string): ConfigFileType {
    const normalizedPath = process.platform === 'win32'
      ? filePath.replace(/\\/g, '/').toLowerCase()
      : filePath.replace(/\\/g, '/');

    for (const { pattern, type } of CONFIG_FILE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return type;
      }
    }

    return null;
  }

  /**
   * Check if a file path is a Qwen Code config file.
   *
   * @param filePath - Path to check
   * @returns true if this is a Qwen Code config
   */
  isCraftAgentConfig(filePath: string): boolean {
    const normalizedPath = process.platform === 'win32'
      ? filePath.replace(/\\/g, '/').toLowerCase()
      : filePath.replace(/\\/g, '/');
    return CRAFT_AGENT_CONFIG_PATTERNS.some((pattern) => pattern.test(normalizedPath));
  }

  // ============================================================
  // Content Validation
  // ============================================================

  /**
   * Validate content before writing to a config file.
   * Detects the file type from the path and validates accordingly.
   *
   * @param filePath - Path to the file being written
   * @param content - Content to validate
   * @returns Validation result with errors/warnings
   */
  validateContent(filePath: string, content: string): ConfigValidationResult {
    const fileType = this.getConfigType(filePath);

    switch (fileType) {
      case 'json':
        return this.validateJson(content);
      case 'toml':
        return this.validateToml(content);
      case 'yaml':
        return this.validateYaml(content);
      default:
        // Unknown file type - no validation
        return { valid: true };
    }
  }

  /**
   * Validate JSON content.
   *
   * @param content - JSON string to validate
   * @returns Validation result
   */
  validateJson(content: string): ConfigValidationResult {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown JSON parse error';

      // Try to extract line/column info from error message
      const lineMatch = error.match(/line (\d+)/i);
      const colMatch = error.match(/column (\d+)/i);
      const posMatch = error.match(/position (\d+)/i);

      let detailedError = error;
      if (posMatch?.[1]) {
        const pos = parseInt(posMatch[1], 10);
        const { line, column } = this.getLineColumn(content, pos);
        detailedError = `${error} (line ${line}, column ${column})`;
      } else if (lineMatch?.[1]) {
        detailedError = `${error}`;
      }

      return {
        valid: false,
        errors: [detailedError],
      };
    }
  }

  /**
   * Validate TOML content (basic syntax check).
   * Note: Full TOML validation would require a TOML parser.
   *
   * @param content - TOML string to validate
   * @returns Validation result
   */
  validateToml(content: string): ConfigValidationResult {
    const warnings: string[] = [];

    // Basic checks for common TOML issues
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      // Skip comments and empty lines
      if (line.startsWith('#') || line === '') continue;

      // Check for unclosed brackets in section headers
      if (line.startsWith('[') && !line.match(/^\[+[^\]]+\]+$/)) {
        warnings.push(`Line ${i + 1}: Possibly malformed section header: ${line}`);
      }

      // Check for missing equals in key-value pairs (not sections or arrays)
      if (!line.startsWith('[') && !line.includes('=') && !line.startsWith(']')) {
        warnings.push(`Line ${i + 1}: Missing '=' in key-value pair: ${line}`);
      }
    }

    return {
      valid: warnings.length === 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Validate YAML content (basic syntax check).
   * Note: Full YAML validation would require a YAML parser.
   *
   * @param content - YAML string to validate
   * @returns Validation result
   */
  validateYaml(content: string): ConfigValidationResult {
    const warnings: string[] = [];

    // Basic checks for common YAML issues
    const lines = content.split('\n');
    let indentStack: number[] = [0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Skip empty lines and comments
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      // Check indentation consistency (should be spaces, not tabs)
      if (line.match(/^\t/)) {
        warnings.push(`Line ${i + 1}: Uses tab indentation (YAML prefers spaces)`);
      }

      // Check for trailing colons without values on same or next line
      if (line.trim().endsWith(':') && !line.includes(': ')) {
        // This is a mapping key - check next line exists and is indented
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith(' ') && !nextLine.startsWith('\t') && nextLine.trim() !== '') {
          warnings.push(`Line ${i + 1}: Mapping key '${line.trim()}' has no nested content`);
        }
      }
    }

    return {
      valid: true, // YAML warnings are advisory, not errors
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  /**
   * Get line and column number from a character position.
   */
  private getLineColumn(content: string, position: number): { line: number; column: number } {
    const lines = content.slice(0, position).split('\n');
    const line = lines.length;
    const column = (lines[lines.length - 1]?.length ?? 0) + 1;
    return { line, column };
  }

  /**
   * Format validation errors for display.
   *
   * @param result - Validation result
   * @param filePath - Path to the file (for context)
   * @returns Formatted error string
   */
  formatErrors(result: ConfigValidationResult, filePath?: string): string {
    if (result.valid && !result.warnings?.length) {
      return '';
    }

    const parts: string[] = [];

    if (filePath) {
      parts.push(`Validation issues in ${filePath}:`);
    }

    if (result.errors?.length) {
      parts.push('Errors:');
      for (const error of result.errors) {
        parts.push(`  - ${error}`);
      }
    }

    if (result.warnings?.length) {
      parts.push('Warnings:');
      for (const warning of result.warnings) {
        parts.push(`  - ${warning}`);
      }
    }

    return parts.join('\n');
  }
}
