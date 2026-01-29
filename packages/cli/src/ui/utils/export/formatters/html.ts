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
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
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
  const html = template.replace(
    /<script id="chat-data" type="application\/json">\s*\/\/ DATA_PLACEHOLDER:.*?\s*<\/script>/s,
    `<script id="chat-data" type="application/json">\n${escapedJsonData}\n    </script>`,
  );
  return html;
}

/**
 * Converts ExportSessionData to HTML format.
 */
export function toHtml(sessionData: ExportSessionData): string {
  const template = loadHtmlTemplate();
  return injectDataIntoHtmlTemplate(template, sessionData);
}
