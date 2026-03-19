/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP Response Normalizer
 *
 * Converts raw LSP protocol responses to normalized internal types.
 * Handles various response formats from different language servers.
 */

import type {
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspCodeAction,
  LspCodeActionKind,
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspFileDiagnostics,
  LspHoverResult,
  LspLocation,
  LspRange,
  LspReference,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from './types.js';
import {
  CODE_ACTION_KIND_LABELS,
  DIAGNOSTIC_SEVERITY_LABELS,
  SYMBOL_KIND_LABELS,
} from './constants.js';

/**
 * Normalizes LSP protocol responses to internal types.
 */
export class LspResponseNormalizer {
  // ============================================================================
  // Diagnostic Normalization
  // ============================================================================

  /**
   * Normalize diagnostic result from LSP response
   */
  normalizeDiagnostic(item: unknown, serverName: string): LspDiagnostic | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;
    const range = this.normalizeRange(itemObj['range']);
    if (!range) {
      return null;
    }

    const message =
      typeof itemObj['message'] === 'string'
        ? (itemObj['message'] as string)
        : '';
    if (!message) {
      return null;
    }

    const severityNum =
      typeof itemObj['severity'] === 'number'
        ? (itemObj['severity'] as number)
        : undefined;
    const severity = severityNum
      ? DIAGNOSTIC_SEVERITY_LABELS[severityNum]
      : undefined;

    const code = itemObj['code'];
    const codeValue =
      typeof code === 'string' || typeof code === 'number' ? code : undefined;

    const source =
      typeof itemObj['source'] === 'string'
        ? (itemObj['source'] as string)
        : undefined;

    const tags = this.normalizeDiagnosticTags(itemObj['tags']);
    const relatedInfo = this.normalizeDiagnosticRelatedInfo(
      itemObj['relatedInformation'],
    );

    return {
      range,
      severity,
      code: codeValue,
      source,
      message,
      tags: tags.length > 0 ? tags : undefined,
      relatedInformation: relatedInfo.length > 0 ? relatedInfo : undefined,
      serverName,
    };
  }

  /**
   * Convert diagnostic back to LSP format for requests
   */
  denormalizeDiagnostic(diagnostic: LspDiagnostic): Record<string, unknown> {
    const severityMap: Record<LspDiagnosticSeverity, number> = {
      error: 1,
      warning: 2,
      information: 3,
      hint: 4,
    };

    return {
      range: diagnostic.range,
      message: diagnostic.message,
      severity: diagnostic.severity
        ? severityMap[diagnostic.severity]
        : undefined,
      code: diagnostic.code,
      source: diagnostic.source,
    };
  }

  /**
   * Normalize diagnostic tags
   */
  normalizeDiagnosticTags(tags: unknown): Array<'unnecessary' | 'deprecated'> {
    if (!Array.isArray(tags)) {
      return [];
    }

    const result: Array<'unnecessary' | 'deprecated'> = [];
    for (const tag of tags) {
      if (tag === 1) {
        result.push('unnecessary');
      } else if (tag === 2) {
        result.push('deprecated');
      }
    }
    return result;
  }

  /**
   * Normalize diagnostic related information
   */
  normalizeDiagnosticRelatedInfo(
    info: unknown,
  ): Array<{ location: LspLocation; message: string }> {
    if (!Array.isArray(info)) {
      return [];
    }

    const result: Array<{ location: LspLocation; message: string }> = [];
    for (const item of info) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      const location = itemObj['location'];
      if (!location || typeof location !== 'object') {
        continue;
      }
      const locObj = location as Record<string, unknown>;
      const uri = locObj['uri'];
      const range = this.normalizeRange(locObj['range']);
      const message = itemObj['message'];

      if (typeof uri === 'string' && range && typeof message === 'string') {
        result.push({
          location: { uri, range },
          message,
        });
      }
    }
    return result;
  }

  /**
   * Normalize file diagnostics result
   */
  normalizeFileDiagnostics(
    item: unknown,
    serverName: string,
  ): LspFileDiagnostics | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;
    const uri =
      typeof itemObj['uri'] === 'string' ? (itemObj['uri'] as string) : '';
    if (!uri) {
      return null;
    }

    const items = itemObj['items'];
    if (!Array.isArray(items)) {
      return null;
    }

    const diagnostics: LspDiagnostic[] = [];
    for (const diagItem of items) {
      const normalized = this.normalizeDiagnostic(diagItem, serverName);
      if (normalized) {
        diagnostics.push(normalized);
      }
    }

    return {
      uri,
      diagnostics,
      serverName,
    };
  }

  // ============================================================================
  // Code Action Normalization
  // ============================================================================

  /**
   * Normalize code action result
   */
  normalizeCodeAction(item: unknown, serverName: string): LspCodeAction | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;

    // Check if this is a Command instead of CodeAction
    if (
      itemObj['command'] &&
      typeof itemObj['title'] === 'string' &&
      !itemObj['kind']
    ) {
      // This is a raw Command, wrap it
      return {
        title: itemObj['title'] as string,
        command: {
          title: itemObj['title'] as string,
          command: (itemObj['command'] as string) ?? '',
          arguments: itemObj['arguments'] as unknown[] | undefined,
        },
        serverName,
      };
    }

    const title =
      typeof itemObj['title'] === 'string' ? (itemObj['title'] as string) : '';
    if (!title) {
      return null;
    }

    const kind =
      typeof itemObj['kind'] === 'string'
        ? (CODE_ACTION_KIND_LABELS[itemObj['kind'] as string] ??
          (itemObj['kind'] as LspCodeActionKind))
        : undefined;

    const isPreferred =
      typeof itemObj['isPreferred'] === 'boolean'
        ? (itemObj['isPreferred'] as boolean)
        : undefined;

    const edit = this.normalizeWorkspaceEdit(itemObj['edit']);
    const command = this.normalizeCommand(itemObj['command']);

    const diagnostics: LspDiagnostic[] = [];
    if (Array.isArray(itemObj['diagnostics'])) {
      for (const diag of itemObj['diagnostics']) {
        const normalized = this.normalizeDiagnostic(diag, serverName);
        if (normalized) {
          diagnostics.push(normalized);
        }
      }
    }

    return {
      title,
      kind,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      isPreferred,
      edit: edit ?? undefined,
      command: command ?? undefined,
      data: itemObj['data'],
      serverName,
    };
  }

  // ============================================================================
  // Workspace Edit Normalization
  // ============================================================================

  /**
   * Normalize workspace edit
   */
  normalizeWorkspaceEdit(edit: unknown): LspWorkspaceEdit | null {
    if (!edit || typeof edit !== 'object') {
      return null;
    }

    const editObj = edit as Record<string, unknown>;
    const result: LspWorkspaceEdit = {};

    // Handle changes (map of URI to TextEdit[])
    if (editObj['changes'] && typeof editObj['changes'] === 'object') {
      const changes = editObj['changes'] as Record<string, unknown>;
      result.changes = {};
      for (const [uri, edits] of Object.entries(changes)) {
        if (Array.isArray(edits)) {
          const normalizedEdits: LspTextEdit[] = [];
          for (const e of edits) {
            const normalized = this.normalizeTextEdit(e);
            if (normalized) {
              normalizedEdits.push(normalized);
            }
          }
          if (normalizedEdits.length > 0) {
            result.changes[uri] = normalizedEdits;
          }
        }
      }
    }

    // Handle documentChanges
    if (Array.isArray(editObj['documentChanges'])) {
      result.documentChanges = [];
      for (const docChange of editObj['documentChanges']) {
        const normalized = this.normalizeTextDocumentEdit(docChange);
        if (normalized) {
          result.documentChanges.push(normalized);
        }
      }
    }

    if (
      (!result.changes || Object.keys(result.changes).length === 0) &&
      (!result.documentChanges || result.documentChanges.length === 0)
    ) {
      return null;
    }

    return result;
  }

  /**
   * Normalize text edit
   */
  normalizeTextEdit(edit: unknown): LspTextEdit | null {
    if (!edit || typeof edit !== 'object') {
      return null;
    }

    const editObj = edit as Record<string, unknown>;
    const range = this.normalizeRange(editObj['range']);
    if (!range) {
      return null;
    }

    const newText =
      typeof editObj['newText'] === 'string'
        ? (editObj['newText'] as string)
        : '';

    return { range, newText };
  }

  /**
   * Normalize text document edit
   */
  normalizeTextDocumentEdit(docEdit: unknown): {
    textDocument: { uri: string; version?: number | null };
    edits: LspTextEdit[];
  } | null {
    if (!docEdit || typeof docEdit !== 'object') {
      return null;
    }

    const docEditObj = docEdit as Record<string, unknown>;
    const textDocument = docEditObj['textDocument'];
    if (!textDocument || typeof textDocument !== 'object') {
      return null;
    }

    const textDocObj = textDocument as Record<string, unknown>;
    const uri =
      typeof textDocObj['uri'] === 'string'
        ? (textDocObj['uri'] as string)
        : '';
    if (!uri) {
      return null;
    }

    const version =
      typeof textDocObj['version'] === 'number'
        ? (textDocObj['version'] as number)
        : null;

    const edits = docEditObj['edits'];
    if (!Array.isArray(edits)) {
      return null;
    }

    const normalizedEdits: LspTextEdit[] = [];
    for (const e of edits) {
      const normalized = this.normalizeTextEdit(e);
      if (normalized) {
        normalizedEdits.push(normalized);
      }
    }

    if (normalizedEdits.length === 0) {
      return null;
    }

    return {
      textDocument: { uri, version },
      edits: normalizedEdits,
    };
  }

  /**
   * Normalize command
   */
  normalizeCommand(
    cmd: unknown,
  ): { title: string; command: string; arguments?: unknown[] } | null {
    if (!cmd || typeof cmd !== 'object') {
      return null;
    }

    const cmdObj = cmd as Record<string, unknown>;
    const title =
      typeof cmdObj['title'] === 'string' ? (cmdObj['title'] as string) : '';
    const command =
      typeof cmdObj['command'] === 'string'
        ? (cmdObj['command'] as string)
        : '';

    if (!command) {
      return null;
    }

    const args = Array.isArray(cmdObj['arguments'])
      ? (cmdObj['arguments'] as unknown[])
      : undefined;

    return { title, command, arguments: args };
  }

  // ============================================================================
  // Location and Symbol Normalization
  // ============================================================================

  /**
   * Normalize location result (definitions, references, implementations)
   */
  normalizeLocationResult(
    item: unknown,
    serverName: string,
  ): LspReference | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;
    const uri = (itemObj['uri'] ??
      itemObj['targetUri'] ??
      (itemObj['target'] as Record<string, unknown>)?.['uri']) as
      | string
      | undefined;

    const range = (itemObj['range'] ??
      itemObj['targetSelectionRange'] ??
      itemObj['targetRange'] ??
      (itemObj['target'] as Record<string, unknown>)?.['range']) as
      | { start?: unknown; end?: unknown }
      | undefined;

    if (!uri || !range?.start || !range?.end) {
      return null;
    }

    const start = range.start as { line?: number; character?: number };
    const end = range.end as { line?: number; character?: number };

    return {
      uri,
      range: {
        start: {
          line: Number(start?.line ?? 0),
          character: Number(start?.character ?? 0),
        },
        end: {
          line: Number(end?.line ?? 0),
          character: Number(end?.character ?? 0),
        },
      },
      serverName,
    };
  }

  /**
   * Normalize symbol result (workspace symbols, document symbols)
   */
  normalizeSymbolResult(
    item: unknown,
    serverName: string,
  ): LspSymbolInformation | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;
    const location = itemObj['location'] ?? itemObj['target'] ?? item;
    if (!location || typeof location !== 'object') {
      return null;
    }

    const locationObj = location as Record<string, unknown>;
    const range = (locationObj['range'] ??
      locationObj['targetRange'] ??
      itemObj['range'] ??
      undefined) as { start?: unknown; end?: unknown } | undefined;

    if (!locationObj['uri'] || !range?.start || !range?.end) {
      return null;
    }

    const start = range.start as { line?: number; character?: number };
    const end = range.end as { line?: number; character?: number };

    return {
      name: (itemObj['name'] ?? itemObj['label'] ?? 'symbol') as string,
      kind: this.normalizeSymbolKind(itemObj['kind']),
      containerName: (itemObj['containerName'] ?? itemObj['container']) as
        | string
        | undefined,
      location: {
        uri: locationObj['uri'] as string,
        range: {
          start: {
            line: Number(start?.line ?? 0),
            character: Number(start?.character ?? 0),
          },
          end: {
            line: Number(end?.line ?? 0),
            character: Number(end?.character ?? 0),
          },
        },
      },
      serverName,
    };
  }

  // ============================================================================
  // Range Normalization
  // ============================================================================

  /**
   * Normalize a single range
   */
  normalizeRange(range: unknown): LspRange | null {
    if (!range || typeof range !== 'object') {
      return null;
    }

    const rangeObj = range as Record<string, unknown>;
    const start = rangeObj['start'];
    const end = rangeObj['end'];

    if (
      !start ||
      typeof start !== 'object' ||
      !end ||
      typeof end !== 'object'
    ) {
      return null;
    }

    const startObj = start as Record<string, unknown>;
    const endObj = end as Record<string, unknown>;

    return {
      start: {
        line: Number(startObj['line'] ?? 0),
        character: Number(startObj['character'] ?? 0),
      },
      end: {
        line: Number(endObj['line'] ?? 0),
        character: Number(endObj['character'] ?? 0),
      },
    };
  }

  /**
   * Normalize an array of ranges
   */
  normalizeRanges(ranges: unknown): LspRange[] {
    if (!Array.isArray(ranges)) {
      return [];
    }

    const results: LspRange[] = [];
    for (const range of ranges) {
      const normalized = this.normalizeRange(range);
      if (normalized) {
        results.push(normalized);
      }
    }

    return results;
  }

  /**
   * Normalize symbol kind from number to string label
   */
  normalizeSymbolKind(kind: unknown): string | undefined {
    if (typeof kind === 'number') {
      return SYMBOL_KIND_LABELS[kind] ?? String(kind);
    }
    if (typeof kind === 'string') {
      const trimmed = kind.trim();
      if (trimmed === '') {
        return undefined;
      }
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && SYMBOL_KIND_LABELS[numeric]) {
        return SYMBOL_KIND_LABELS[numeric];
      }
      return trimmed;
    }
    return undefined;
  }

  // ============================================================================
  // Hover Normalization
  // ============================================================================

  /**
   * Normalize hover contents to string
   */
  normalizeHoverContents(contents: unknown): string {
    if (!contents) {
      return '';
    }
    if (typeof contents === 'string') {
      return contents;
    }
    if (Array.isArray(contents)) {
      const parts = contents
        .map((item) => this.normalizeHoverContents(item))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return parts.join('\n');
    }
    if (typeof contents === 'object') {
      const contentsObj = contents as Record<string, unknown>;
      const value = contentsObj['value'];
      if (typeof value === 'string') {
        const language = contentsObj['language'];
        if (typeof language === 'string' && language.trim() !== '') {
          return `\`\`\`${language}\n${value}\n\`\`\``;
        }
        return value;
      }
    }
    return '';
  }

  /**
   * Normalize hover result
   */
  normalizeHoverResult(
    response: unknown,
    serverName: string,
  ): LspHoverResult | null {
    if (!response) {
      return null;
    }
    if (typeof response !== 'object') {
      const contents = this.normalizeHoverContents(response);
      if (!contents.trim()) {
        return null;
      }
      return {
        contents,
        serverName,
      };
    }

    const responseObj = response as Record<string, unknown>;
    const contents = this.normalizeHoverContents(responseObj['contents']);
    if (!contents.trim()) {
      return null;
    }

    const range = this.normalizeRange(responseObj['range']);
    return {
      contents,
      range: range ?? undefined,
      serverName,
    };
  }

  // ============================================================================
  // Call Hierarchy Normalization
  // ============================================================================

  /**
   * Normalize call hierarchy item
   */
  normalizeCallHierarchyItem(
    item: unknown,
    serverName: string,
  ): LspCallHierarchyItem | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const itemObj = item as Record<string, unknown>;
    const nameValue = itemObj['name'] ?? itemObj['label'] ?? 'symbol';
    const name =
      typeof nameValue === 'string' ? nameValue : String(nameValue ?? '');
    const uri = itemObj['uri'];

    if (!name || typeof uri !== 'string') {
      return null;
    }

    const range = this.normalizeRange(itemObj['range']);
    const selectionRange =
      this.normalizeRange(itemObj['selectionRange']) ?? range;

    if (!range || !selectionRange) {
      return null;
    }

    const serverOverride =
      typeof itemObj['serverName'] === 'string'
        ? (itemObj['serverName'] as string)
        : undefined;

    // Preserve raw numeric kind for server communication
    let rawKind: number | undefined;
    if (typeof itemObj['rawKind'] === 'number') {
      rawKind = itemObj['rawKind'];
    } else if (typeof itemObj['kind'] === 'number') {
      rawKind = itemObj['kind'];
    } else if (typeof itemObj['kind'] === 'string') {
      const parsed = Number(itemObj['kind']);
      if (Number.isFinite(parsed)) {
        rawKind = parsed;
      }
    }

    return {
      name,
      kind: this.normalizeSymbolKind(itemObj['kind']),
      rawKind,
      detail:
        typeof itemObj['detail'] === 'string'
          ? (itemObj['detail'] as string)
          : undefined,
      uri,
      range,
      selectionRange,
      data: itemObj['data'],
      serverName: serverOverride ?? serverName,
    };
  }

  /**
   * Normalize incoming call
   */
  normalizeIncomingCall(
    item: unknown,
    serverName: string,
  ): LspCallHierarchyIncomingCall | null {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const itemObj = item as Record<string, unknown>;
    const from = this.normalizeCallHierarchyItem(itemObj['from'], serverName);
    if (!from) {
      return null;
    }
    return {
      from,
      fromRanges: this.normalizeRanges(itemObj['fromRanges']),
    };
  }

  /**
   * Normalize outgoing call
   */
  normalizeOutgoingCall(
    item: unknown,
    serverName: string,
  ): LspCallHierarchyOutgoingCall | null {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const itemObj = item as Record<string, unknown>;
    const to = this.normalizeCallHierarchyItem(itemObj['to'], serverName);
    if (!to) {
      return null;
    }
    return {
      to,
      fromRanges: this.normalizeRanges(itemObj['fromRanges']),
    };
  }

  /**
   * Convert call hierarchy item back to LSP params format
   */
  toCallHierarchyItemParams(
    item: LspCallHierarchyItem,
  ): Record<string, unknown> {
    // Use rawKind (numeric) for server communication
    let numericKind: number | undefined = item.rawKind;
    if (numericKind === undefined && item.kind !== undefined) {
      const parsed = Number(item.kind);
      if (Number.isFinite(parsed)) {
        numericKind = parsed;
      }
    }

    return {
      name: item.name,
      kind: numericKind,
      detail: item.detail,
      uri: item.uri,
      range: item.range,
      selectionRange: item.selectionRange,
      data: item.data,
    };
  }

  // ============================================================================
  // Document Symbol Helpers
  // ============================================================================

  /**
   * Check if item is a DocumentSymbol (has range and selectionRange)
   */
  isDocumentSymbol(item: Record<string, unknown>): boolean {
    const range = item['range'];
    const selectionRange = item['selectionRange'];
    return (
      typeof range === 'object' &&
      range !== null &&
      typeof selectionRange === 'object' &&
      selectionRange !== null
    );
  }

  /**
   * Recursively collect document symbols from a tree structure
   */
  collectDocumentSymbol(
    item: Record<string, unknown>,
    uri: string,
    serverName: string,
    results: LspSymbolInformation[],
    limit: number,
    containerName?: string,
  ): void {
    if (results.length >= limit) {
      return;
    }

    const nameValue = item['name'] ?? item['label'] ?? 'symbol';
    const name = typeof nameValue === 'string' ? nameValue : String(nameValue);
    const selectionRange =
      this.normalizeRange(item['selectionRange']) ??
      this.normalizeRange(item['range']);

    if (!selectionRange) {
      return;
    }

    results.push({
      name,
      kind: this.normalizeSymbolKind(item['kind']),
      containerName,
      location: {
        uri,
        range: selectionRange,
      },
      serverName,
    });

    if (results.length >= limit) {
      return;
    }

    const children = item['children'];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (results.length >= limit) {
          break;
        }
        if (child && typeof child === 'object') {
          this.collectDocumentSymbol(
            child as Record<string, unknown>,
            uri,
            serverName,
            results,
            limit,
            name,
          );
        }
      }
    }
  }
}
