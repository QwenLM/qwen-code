/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData } from '../types.js';
import { HTML_TEMPLATE } from './htmlTemplate.js';

/**
 * Escapes JSON for safe embedding in HTML.
 */
function escapeJsonForHtml(json: string): string {
  return json
    .replace(/<\/script/gi, '<\\/script')
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Loads the HTML template built from assets.
 */
export function loadHtmlTemplate(): string {
  return HTML_TEMPLATE;
}

/**
 * Injects JSON data into the HTML template.
 */
export function injectDataIntoHtmlTemplate(
  template: string,
  data: {
    sessionId: string;
    startTime: string;
    messages: unknown[];
  },
): string {
  const jsonData = JSON.stringify(data, null, 2);
  const escapedJsonData = escapeJsonForHtml(jsonData);
  const idAttribute = 'id="chat-data"';
  const idIndex = template.indexOf(idAttribute);
  if (idIndex === -1) {
    return template;
  }

  const openTagStart = template.lastIndexOf('<script', idIndex);
  if (openTagStart === -1) {
    return template;
  }

  const openTagEnd = template.indexOf('>', idIndex);
  if (openTagEnd === -1) {
    return template;
  }

  const closeTagStart = template.indexOf('</script>', openTagEnd);
  if (closeTagStart === -1) {
    return template;
  }

  const lineStart = template.lastIndexOf('\n', openTagStart);
  const lineIndent =
    lineStart === -1 ? '' : template.slice(lineStart + 1, openTagStart);
  const indentedJson = escapedJsonData
    .split('\n')
    .map((line) => `${lineIndent}${line}`)
    .join('\n');

  const before = template.slice(0, openTagEnd + 1);
  const after = template.slice(closeTagStart);
  return `${before}\n${indentedJson}\n${after}`;
}

/**
 * Converts ExportSessionData to HTML format.
 */
export function toHtml(sessionData: ExportSessionData): string {
  const template = loadHtmlTemplate();
  return injectDataIntoHtmlTemplate(template, sessionData);
}
