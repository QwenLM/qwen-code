/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData } from '../types.js';
import { randomBytes } from 'node:crypto';
import {
  EXPORT_TRANSCRIPT_HTML_TEMPLATE,
  EXPORT_TRANSCRIPT_RENDERER_LIMITS,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
} from '@qwen-code/web-templates';
import {
  assertExportTranscriptDocumentV1,
  createExportTranscriptDocumentV1,
  EXPORT_TRANSCRIPT_LIMITS_V1,
  type ExportTranscriptDocumentV1,
} from '../export-transcript-document.js';
import { escapeJsonForHtmlScriptData } from '../html-script-data.js';

export function injectDocumentIntoHtmlTemplate(
  template: string,
  document: unknown,
): string {
  return injectJsonScript(template, 'transcript-document', document);
}

export function renderExportTranscriptDocumentToHtml(
  document: ExportTranscriptDocumentV1,
): string {
  assertExportTranscriptDocumentV1(document);
  if (document.rendererVersion !== EXPORT_TRANSCRIPT_RENDERER_VERSION) {
    throw new Error('Export transcript renderer version mismatch.');
  }
  if (
    EXPORT_TRANSCRIPT_RENDERER_LIMITS.maxBlocks !==
      EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks ||
    EXPORT_TRANSCRIPT_RENDERER_LIMITS.maxEnvelopeBytes !==
      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
  ) {
    throw new Error('Export transcript renderer limits mismatch.');
  }
  const nonce = randomBytes(16).toString('base64url');
  const template = injectDocumentNonce(EXPORT_TRANSCRIPT_HTML_TEMPLATE, nonce);
  return injectDocumentIntoHtmlTemplate(template, document);
}

function injectDocumentNonce(template: string, nonce: string): string {
  if (!template.includes('__EXPORT_NONCE__')) {
    throw new Error('Export HTML template is missing its CSP nonce slot.');
  }
  return template.replaceAll('__EXPORT_NONCE__', nonce);
}

function injectJsonScript(
  template: string,
  elementId: string,
  data: unknown,
): string {
  const jsonData = JSON.stringify(data);
  const escapedJsonData = escapeJsonForHtmlScriptData(jsonData);
  const idAttribute = `id="${elementId}"`;
  const idIndex = template.indexOf(idAttribute);
  if (idIndex === -1) {
    throw new Error(`Export HTML template is missing ${elementId}.`);
  }
  const openTagEnd = template.indexOf('>', idIndex);
  if (openTagEnd === -1) {
    throw new Error(`Export HTML template has an invalid ${elementId} tag.`);
  }
  const closeTagStart = template.indexOf('</script>', openTagEnd);
  if (closeTagStart === -1) {
    throw new Error(`Export HTML template has an unclosed ${elementId} tag.`);
  }
  return `${template.slice(0, openTagEnd + 1)}${escapedJsonData}${template.slice(closeTagStart)}`;
}

/**
 * Converts ExportSessionData to HTML format.
 */
export function toHtml(
  sessionData: ExportSessionData,
  originalRecords: readonly unknown[],
): string {
  const document = createExportTranscriptDocumentV1(
    originalRecords,
    sessionData,
    {
      rendererVersion: EXPORT_TRANSCRIPT_RENDERER_VERSION,
      exportedAt: sessionData.metadata?.exportTime ?? new Date().toISOString(),
    },
  );
  return renderExportTranscriptDocumentToHtml(document);
}
