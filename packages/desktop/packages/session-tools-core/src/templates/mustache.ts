/**
 * Minimal Mustache Template Renderer
 *
 * A zero-dependency Mustache implementation covering the core spec:
 * - {{var}}           Variable interpolation (HTML-escaped)
 * - {{{var}}}         Unescaped variable interpolation
 * - {{#section}}...{{/section}}  Sections (conditionals + loops)
 * - {{^section}}...{{/section}}  Inverted sections (if falsy/empty)
 * - Nested context resolution (dot-notation: {{issue.title}})
 *
 * Designed for rendering source HTML templates with data from APIs.
 * Logic-less by design — templates cannot execute arbitrary code.
 */

/**
 * HTML-escape a string to prevent XSS in rendered templates.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve a dotted key path against a context stack.
 * Walks up the stack to find the first matching value.
 *
 * Examples:
 *   resolve('title', [{title: 'Hello'}]) => 'Hello'
 *   resolve('issue.title', [{issue: {title: 'Hello'}}]) => 'Hello'
 *   resolve('.', [{name: 'x'}]) => {name: 'x'} (current context)
 */
function resolve(key: string, contextStack: unknown[]): unknown {
  // "." refers to the current (top-of-stack) context
  if (key === '.') {
    return contextStack[contextStack.length - 1];
  }

  const parts = key.split('.');

  // Walk the context stack from top (most specific) to bottom (least specific)
  for (let i = contextStack.length - 1; i >= 0; i--) {
    const ctx = contextStack[i];
    if (ctx == null || typeof ctx !== 'object') continue;

    // Try to resolve the full dotted path from this context level
    let value: unknown = ctx;
    let found = true;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') {
        found = false;
        break;
      }
      value = (value as Record<string, unknown>)[part];
      if (value === undefined) {
        found = false;
        break;
      }
    }
    if (found) return value;
  }

  return undefined;
}

/**
 * Check if a value is "truthy" in Mustache semantics.
 * Empty arrays are falsy (don't render sections).
 */
function isTruthy(value: unknown): boolean {
  if (value == null) return false;
  if (value === false) return false;
  if (value === 0) return false;
  if (value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Render a Mustache template string with the given data.
 *
 * @param template - The Mustache template string
 * @param data - The data object to render with
 * @returns The rendered string
 */
export function renderMustache(template: string, data: Record<string, unknown>): string {
  return renderWithStack(template, [data]);
}

/**
 * Internal recursive renderer that maintains a context stack.
 */
function renderWithStack(template: string, contextStack: unknown[]): string {
  let result = '';
  let pos = 0;

  while (pos < template.length) {
    // Find the next tag opening
    const openIdx = template.indexOf('{{', pos);
    if (openIdx === -1) {
      // No more tags — append the rest as literal text
      result += template.slice(pos);
      break;
    }

    // Append literal text before the tag
    result += template.slice(pos, openIdx);

    // Check for triple-mustache (unescaped)
    if (template[openIdx + 2] === '{') {
      const closeIdx = template.indexOf('}}}', openIdx + 3);
      if (closeIdx === -1) {
        // Malformed — treat as literal
        result += '{{{';
        pos = openIdx + 3;
        continue;
      }
      const key = template.slice(openIdx + 3, closeIdx).trim();
      const value = resolve(key, contextStack);
      result += value != null ? String(value) : '';
      pos = closeIdx + 3;
      continue;
    }

    const closeIdx = template.indexOf('}}', openIdx + 2);
    if (closeIdx === -1) {
      // Malformed — treat as literal
      result += '{{';
      pos = openIdx + 2;
      continue;
    }

    const tag = template.slice(openIdx + 2, closeIdx).trim();
    pos = closeIdx + 2;

    if (tag.startsWith('#')) {
      // Section start: {{#key}}
      const key = tag.slice(1).trim();
      const endTag = `{{/${key}}}`;
      const endIdx = findMatchingEnd(template, pos, key);
      if (endIdx === -1) {
        // No matching end tag — skip
        continue;
      }
      const innerTemplate = template.slice(pos, endIdx);
      pos = endIdx + endTag.length;

      const value = resolve(key, contextStack);
      if (Array.isArray(value)) {
        // Iterate over array
        for (const item of value) {
          result += renderWithStack(innerTemplate, [...contextStack, item]);
        }
      } else if (isTruthy(value)) {
        // Truthy non-array: render once, push value as context if it's an object
        if (typeof value === 'object' && value !== null) {
          result += renderWithStack(innerTemplate, [...contextStack, value]);
        } else {
          result += renderWithStack(innerTemplate, contextStack);
        }
      }
      // Falsy: skip entirely
    } else if (tag.startsWith('^')) {
      // Inverted section: {{^key}}
      const key = tag.slice(1).trim();
      const endTag = `{{/${key}}}`;
      const endIdx = findMatchingEnd(template, pos, key);
      if (endIdx === -1) {
        continue;
      }
      const innerTemplate = template.slice(pos, endIdx);
      pos = endIdx + endTag.length;

      const value = resolve(key, contextStack);
      if (!isTruthy(value)) {
        result += renderWithStack(innerTemplate, contextStack);
      }
    } else if (tag.startsWith('/')) {
      // End tag encountered outside of section processing — ignore
      // (shouldn't happen in well-formed templates)
      continue;
    } else if (tag.startsWith('!')) {
      // Comment: {{! comment }} — skip entirely
      continue;
    } else {
      // Variable interpolation: {{key}}
      const value = resolve(tag, contextStack);
      if (value != null) {
        result += escapeHtml(String(value));
      }
    }
  }

  return result;
}

/**
 * Find the matching {{/key}} end tag, handling nested sections with the same key.
 * Returns the index of the start of the matching end tag, or -1 if not found.
 */
function findMatchingEnd(template: string, startPos: number, key: string): number {
  const openPattern = `{{#${key}}}`;
  const closePattern = `{{/${key}}}`;
  let depth = 1;
  let pos = startPos;

  while (pos < template.length && depth > 0) {
    const nextOpen = template.indexOf(openPattern, pos);
    const nextClose = template.indexOf(closePattern, pos);

    if (nextClose === -1) {
      // No more close tags — unbalanced
      return -1;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Found a nested open before the next close
      depth++;
      pos = nextOpen + openPattern.length;
    } else {
      // Found a close
      depth--;
      if (depth === 0) {
        return nextClose;
      }
      pos = nextClose + closePattern.length;
    }
  }

  return -1;
}
