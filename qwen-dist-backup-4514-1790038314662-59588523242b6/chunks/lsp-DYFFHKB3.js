// Force strict mode and setup for ESM
"use strict";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/lsp.ts
init_esbuild_shims();
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var LOCATION_REQUIRED_OPERATIONS = /* @__PURE__ */ new Set([
  "goToDefinition",
  "findReferences",
  "hover",
  "goToImplementation",
  "prepareCallHierarchy"
]);
var FILE_REQUIRED_OPERATIONS = /* @__PURE__ */ new Set([
  "documentSymbol",
  "diagnostics"
]);
var QUERY_REQUIRED_OPERATIONS = /* @__PURE__ */ new Set(["workspaceSymbol"]);
var ITEM_REQUIRED_OPERATIONS = /* @__PURE__ */ new Set([
  "incomingCalls",
  "outgoingCalls"
]);
var RANGE_REQUIRED_OPERATIONS = /* @__PURE__ */ new Set(["codeActions"]);
var LspToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "LspToolInvocation");
  }
  getDescription() {
    const operationLabel = this.getOperationLabel();
    if (this.params.operation === "workspaceSymbol") {
      return `LSP ${operationLabel} for "${this.params.query ?? ""}"`;
    }
    if (this.params.operation === "documentSymbol") {
      return this.params.filePath ? `LSP ${operationLabel} for ${this.params.filePath}` : `LSP ${operationLabel}`;
    }
    if (this.params.operation === "incomingCalls" || this.params.operation === "outgoingCalls") {
      return `LSP ${operationLabel} for ${this.describeCallHierarchyItemShort()}`;
    }
    if (this.params.filePath && this.params.line !== void 0) {
      return `LSP ${operationLabel} at ${this.params.filePath}:${this.params.line}:${this.params.character ?? 1}`;
    }
    if (this.params.filePath) {
      return `LSP ${operationLabel} for ${this.params.filePath}`;
    }
    return `LSP ${operationLabel}`;
  }
  async execute(_signal) {
    const client = this.config.getLspClient();
    if (!client || !this.config.isLspEnabled()) {
      const message = `LSP ${this.getOperationLabel()} is unavailable (LSP disabled or not initialized).`;
      return { llmContent: message, returnDisplay: message };
    }
    switch (this.params.operation) {
      case "goToDefinition":
        return this.executeDefinitions(client);
      case "findReferences":
        return this.executeReferences(client);
      case "hover":
        return this.executeHover(client);
      case "documentSymbol":
        return this.executeDocumentSymbols(client);
      case "workspaceSymbol":
        return this.executeWorkspaceSymbols(client);
      case "goToImplementation":
        return this.executeImplementations(client);
      case "prepareCallHierarchy":
        return this.executePrepareCallHierarchy(client);
      case "incomingCalls":
        return this.executeIncomingCalls(client);
      case "outgoingCalls":
        return this.executeOutgoingCalls(client);
      case "diagnostics":
        return this.executeDiagnostics(client);
      case "workspaceDiagnostics":
        return this.executeWorkspaceDiagnostics(client);
      case "codeActions":
        return this.executeCodeActions(client);
      default: {
        const message = `Unsupported LSP operation: ${this.params.operation}`;
        return { llmContent: message, returnDisplay: message };
      }
    }
  }
  async executeDefinitions(client) {
    const target = this.resolveLocationTarget();
    if ("error" in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }
    const limit = this.params.limit ?? 20;
    let definitions = [];
    try {
      definitions = await client.definitions(
        target.location,
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP go-to-definition failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!definitions.length) {
      const message = `No definitions found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const lines = definitions.slice(0, limit).map(
      (definition, index) => `${index + 1}. ${this.formatLocationWithServer(definition, workspaceRoot)}`
    );
    const heading = `Definitions for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeImplementations(client) {
    const target = this.resolveLocationTarget();
    if ("error" in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }
    const limit = this.params.limit ?? 20;
    let implementations = [];
    try {
      implementations = await client.implementations(
        target.location,
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP go-to-implementation failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!implementations.length) {
      const message = `No implementations found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const lines = implementations.slice(0, limit).map(
      (implementation, index) => `${index + 1}. ${this.formatLocationWithServer(implementation, workspaceRoot)}`
    );
    const heading = `Implementations for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeReferences(client) {
    const target = this.resolveLocationTarget();
    if ("error" in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }
    const limit = this.params.limit ?? 50;
    let references = [];
    try {
      references = await client.references(
        target.location,
        this.params.serverName,
        this.params.includeDeclaration ?? false,
        limit
      );
    } catch (error) {
      const message = `LSP find-references failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!references.length) {
      const message = `No references found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const lines = references.slice(0, limit).map(
      (reference, index) => `${index + 1}. ${this.formatLocationWithServer(reference, workspaceRoot)}`
    );
    const heading = `References for ${target.description}:`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeHover(client) {
    const target = this.resolveLocationTarget();
    if ("error" in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }
    let hoverText = "";
    try {
      const result = await client.hover(
        target.location,
        this.params.serverName
      );
      if (result) {
        hoverText = result.contents ?? "";
      }
    } catch (error) {
      const message = `LSP hover failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!hoverText || hoverText.trim().length === 0) {
      const message = `No hover information found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const heading = `Hover for ${target.description}:`;
    const content = hoverText.trim();
    return {
      llmContent: `${heading}
${content}`,
      returnDisplay: content
    };
  }
  async executeDocumentSymbols(client) {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? "";
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = "A valid filePath is required for document symbols.";
      return { llmContent: message, returnDisplay: message };
    }
    const limit = this.params.limit ?? 50;
    let symbols = [];
    try {
      symbols = await client.documentSymbols(
        uri,
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP document symbols failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!symbols.length) {
      const fileLabel2 = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No document symbols found for ${fileLabel2}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const lines = symbols.slice(0, limit).map((symbol, index) => {
      const location = this.formatLocationWithoutServer(
        symbol.location,
        workspaceRoot
      );
      const serverSuffix = symbol.serverName ? ` [${symbol.serverName}]` : "";
      const kind = symbol.kind ? ` (${symbol.kind})` : "";
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      return `${index + 1}. ${symbol.name}${kind}${container} - ${location}${serverSuffix}`;
    });
    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Document symbols for ${fileLabel}:`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeWorkspaceSymbols(client) {
    const limit = this.params.limit ?? 20;
    const query = this.params.query ?? "";
    let symbols = [];
    try {
      symbols = await client.workspaceSymbols(query, limit);
    } catch (error) {
      const message = `LSP workspace symbol search failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!symbols.length) {
      const message = `No symbols found for query "${query}".`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const lines = symbols.slice(0, limit).map((symbol, index) => {
      const location = this.formatLocationWithoutServer(
        symbol.location,
        workspaceRoot
      );
      const serverSuffix = symbol.serverName ? ` [${symbol.serverName}]` : "";
      const kind = symbol.kind ? ` (${symbol.kind})` : "";
      const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
      return `${index + 1}. ${symbol.name}${kind}${container} - ${location}${serverSuffix}`;
    });
    const heading = `Found ${Math.min(symbols.length, limit)} of ${symbols.length} symbols for query "${query}":`;
    let referenceSection = "";
    const topSymbol = symbols[0];
    if (topSymbol) {
      try {
        const referenceLimit = Math.min(20, Math.max(limit, 5));
        const references = await client.references(
          topSymbol.location,
          topSymbol.serverName,
          false,
          referenceLimit
        );
        if (references.length > 0) {
          const refLines = references.map((ref, index) => {
            const location = this.formatLocationWithoutServer(
              ref,
              workspaceRoot
            );
            const serverSuffix = ref.serverName ? ` [${ref.serverName}]` : "";
            return `${index + 1}. ${location}${serverSuffix}`;
          });
          referenceSection = [
            "",
            `References for top match (${topSymbol.name}):`,
            ...refLines
          ].join("\n");
        }
      } catch (error) {
        referenceSection = `
References lookup failed: ${error?.message || String(error)}`;
      }
    }
    const llmParts = referenceSection ? [heading, ...lines, referenceSection] : [heading, ...lines];
    const displayParts = referenceSection ? [...lines, referenceSection] : [...lines];
    return {
      llmContent: llmParts.join("\n"),
      returnDisplay: displayParts.join("\n")
    };
  }
  async executePrepareCallHierarchy(client) {
    const target = this.resolveLocationTarget();
    if ("error" in target) {
      return { llmContent: target.error, returnDisplay: target.error };
    }
    const limit = this.params.limit ?? 20;
    let items = [];
    try {
      items = await client.prepareCallHierarchy(
        target.location,
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP call hierarchy prepare failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!items.length) {
      const message = `No call hierarchy items found for ${target.description}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const slicedItems = items.slice(0, limit);
    const lines = slicedItems.map(
      (item, index) => this.formatCallHierarchyItemLine(item, index, workspaceRoot)
    );
    const heading = `Call hierarchy items for ${target.description}:`;
    const jsonSection = this.formatJsonSection(
      "Call hierarchy items (JSON)",
      slicedItems
    );
    return {
      llmContent: [heading, ...lines].join("\n") + jsonSection,
      returnDisplay: lines.join("\n")
    };
  }
  async executeIncomingCalls(client) {
    const item = this.params.callHierarchyItem;
    if (!item) {
      const message = "callHierarchyItem is required for incomingCalls.";
      return { llmContent: message, returnDisplay: message };
    }
    const limit = this.params.limit ?? 20;
    const serverName = this.params.serverName ?? item.serverName;
    let calls = [];
    try {
      calls = await client.incomingCalls(item, serverName, limit);
    } catch (error) {
      const message = `LSP incoming calls failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!calls.length) {
      const message = `No incoming calls found for ${this.describeCallHierarchyItemFull(
        item
      )}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const slicedCalls = calls.slice(0, limit);
    const lines = slicedCalls.map((call, index) => {
      const targetItem = call.from;
      const location = this.formatLocationWithServer(
        {
          uri: targetItem.uri,
          range: targetItem.selectionRange,
          serverName: targetItem.serverName
        },
        workspaceRoot
      );
      const kind = targetItem.kind ? ` (${targetItem.kind})` : "";
      const detail = targetItem.detail ? ` ${targetItem.detail}` : "";
      const rangeSuffix = this.formatCallRanges(call.fromRanges);
      return `${index + 1}. ${targetItem.name}${kind}${detail} - ${location}${rangeSuffix}`;
    });
    const heading = `Incoming calls for ${this.describeCallHierarchyItemFull(
      item
    )}:`;
    const jsonSection = this.formatJsonSection(
      "Incoming calls (JSON)",
      slicedCalls
    );
    return {
      llmContent: [heading, ...lines].join("\n") + jsonSection,
      returnDisplay: lines.join("\n")
    };
  }
  async executeOutgoingCalls(client) {
    const item = this.params.callHierarchyItem;
    if (!item) {
      const message = "callHierarchyItem is required for outgoingCalls.";
      return { llmContent: message, returnDisplay: message };
    }
    const limit = this.params.limit ?? 20;
    const serverName = this.params.serverName ?? item.serverName;
    let calls = [];
    try {
      calls = await client.outgoingCalls(item, serverName, limit);
    } catch (error) {
      const message = `LSP outgoing calls failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!calls.length) {
      const message = `No outgoing calls found for ${this.describeCallHierarchyItemFull(
        item
      )}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const slicedCalls = calls.slice(0, limit);
    const lines = slicedCalls.map((call, index) => {
      const targetItem = call.to;
      const location = this.formatLocationWithServer(
        {
          uri: targetItem.uri,
          range: targetItem.selectionRange,
          serverName: targetItem.serverName
        },
        workspaceRoot
      );
      const kind = targetItem.kind ? ` (${targetItem.kind})` : "";
      const detail = targetItem.detail ? ` ${targetItem.detail}` : "";
      const rangeSuffix = this.formatCallRanges(call.fromRanges);
      return `${index + 1}. ${targetItem.name}${kind}${detail} - ${location}${rangeSuffix}`;
    });
    const heading = `Outgoing calls for ${this.describeCallHierarchyItemFull(
      item
    )}:`;
    const jsonSection = this.formatJsonSection(
      "Outgoing calls (JSON)",
      slicedCalls
    );
    return {
      llmContent: [heading, ...lines].join("\n") + jsonSection,
      returnDisplay: lines.join("\n")
    };
  }
  async executeDiagnostics(client) {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? "";
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = "A valid filePath is required for diagnostics.";
      return { llmContent: message, returnDisplay: message };
    }
    let diagnostics = [];
    try {
      diagnostics = await client.diagnostics(uri, this.params.serverName);
    } catch (error) {
      const message = `LSP diagnostics failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!diagnostics.length) {
      const fileLabel2 = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No diagnostics found for ${fileLabel2}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const lines = diagnostics.map((diag, index) => {
      const severity = diag.severity ? `[${diag.severity.toUpperCase()}]` : "";
      const position = `${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
      const code = diag.code ? ` (${diag.code})` : "";
      const source = diag.source ? ` [${diag.source}]` : "";
      return `${index + 1}. ${severity} ${position}${code}${source}: ${diag.message}`;
    });
    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Diagnostics for ${fileLabel} (${diagnostics.length} issues):`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeWorkspaceDiagnostics(client) {
    const limit = this.params.limit ?? 50;
    let fileDiagnostics = [];
    try {
      fileDiagnostics = await client.workspaceDiagnostics(
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP workspace diagnostics failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!fileDiagnostics.length) {
      const message = "No diagnostics found in the workspace.";
      return { llmContent: message, returnDisplay: message };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const lines = [];
    let totalIssues = 0;
    for (const fileDiag of fileDiagnostics) {
      const fileLabel = this.formatUriForDisplay(fileDiag.uri, workspaceRoot);
      const serverSuffix = fileDiag.serverName ? ` [${fileDiag.serverName}]` : "";
      lines.push(`
${fileLabel}${serverSuffix}:`);
      for (const diag of fileDiag.diagnostics) {
        const severity = diag.severity ? `[${diag.severity.toUpperCase()}]` : "";
        const position = `${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
        const code = diag.code ? ` (${diag.code})` : "";
        lines.push(`  ${severity} ${position}${code}: ${diag.message}`);
        totalIssues++;
      }
    }
    const heading = `Workspace diagnostics (${totalIssues} issues in ${fileDiagnostics.length} files):`;
    return {
      llmContent: [heading, ...lines].join("\n"),
      returnDisplay: lines.join("\n")
    };
  }
  async executeCodeActions(client) {
    const workspaceRoot = this.config.getProjectRoot();
    const filePath = this.params.filePath ?? "";
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      const message = "A valid filePath is required for code actions.";
      return { llmContent: message, returnDisplay: message };
    }
    const startLine = Math.max(0, (this.params.line ?? 1) - 1);
    const startChar = Math.max(0, (this.params.character ?? 1) - 1);
    const endLine = Math.max(
      0,
      (this.params.endLine ?? this.params.line ?? 1) - 1
    );
    const endChar = Math.max(
      0,
      (this.params.endCharacter ?? this.params.character ?? 1) - 1
    );
    const range = {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    };
    const context = {
      diagnostics: this.params.diagnostics ?? [],
      only: this.params.codeActionKinds,
      triggerKind: "invoked"
    };
    const limit = this.params.limit ?? 20;
    let actions = [];
    try {
      actions = await client.codeActions(
        uri,
        range,
        context,
        this.params.serverName,
        limit
      );
    } catch (error) {
      const message = `LSP code actions failed: ${error?.message || String(error)}`;
      return { llmContent: message, returnDisplay: message };
    }
    if (!actions.length) {
      const fileLabel2 = this.formatUriForDisplay(uri, workspaceRoot);
      const message = `No code actions available at ${fileLabel2}:${startLine + 1}:${startChar + 1}.`;
      return { llmContent: message, returnDisplay: message };
    }
    const lines = actions.slice(0, limit).map((action, index) => {
      const kind = action.kind ? ` [${action.kind}]` : "";
      const preferred = action.isPreferred ? " \u2605" : "";
      const hasEdit = action.edit ? " (has edit)" : "";
      const hasCommand = action.command ? " (has command)" : "";
      const serverSuffix = action.serverName ? ` [${action.serverName}]` : "";
      return `${index + 1}. ${action.title}${kind}${preferred}${hasEdit}${hasCommand}${serverSuffix}`;
    });
    const fileLabel = this.formatUriForDisplay(uri, workspaceRoot);
    const heading = `Code actions at ${fileLabel}:${startLine + 1}:${startChar + 1}:`;
    const jsonSection = this.formatJsonSection(
      "Code actions (JSON)",
      actions.slice(0, limit)
    );
    return {
      llmContent: [heading, ...lines].join("\n") + jsonSection,
      returnDisplay: lines.join("\n")
    };
  }
  resolveLocationTarget() {
    const filePath = this.params.filePath;
    if (!filePath) {
      return {
        error: "filePath is required for this operation."
      };
    }
    if (typeof this.params.line !== "number") {
      return {
        error: "line is required for this operation."
      };
    }
    const workspaceRoot = this.config.getProjectRoot();
    const uri = this.resolveUri(filePath, workspaceRoot);
    if (!uri) {
      return {
        error: "A valid filePath is required when specifying a line/character."
      };
    }
    const position = {
      line: Math.max(0, Math.floor(this.params.line - 1)),
      character: Math.max(0, Math.floor((this.params.character ?? 1) - 1))
    };
    const location = {
      uri,
      range: { start: position, end: position }
    };
    const description = this.formatLocationWithServer(
      { ...location, serverName: this.params.serverName },
      workspaceRoot
    );
    return {
      location,
      description
    };
  }
  resolveUri(filePath, workspaceRoot) {
    if (!filePath) {
      return null;
    }
    if (filePath.startsWith("file://") || filePath.includes("://")) {
      return filePath;
    }
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
    return pathToFileURL(absolutePath).toString();
  }
  formatLocationWithServer(location, workspaceRoot) {
    const start = location.range.start;
    let filePath = location.uri;
    if (filePath.startsWith("file://")) {
      filePath = fileURLToPath(filePath);
      filePath = path.relative(workspaceRoot, filePath) || ".";
    }
    const serverSuffix = location.serverName && location.serverName !== "" ? ` [${location.serverName}]` : "";
    return `${filePath}:${(start.line ?? 0) + 1}:${(start.character ?? 0) + 1}${serverSuffix}`;
  }
  formatLocationWithoutServer(location, workspaceRoot) {
    const { uri, range } = location;
    let filePath = uri;
    if (uri.startsWith("file://")) {
      filePath = fileURLToPath(uri);
      filePath = path.relative(workspaceRoot, filePath) || ".";
    }
    const line = (range.start.line ?? 0) + 1;
    const character = (range.start.character ?? 0) + 1;
    return `${filePath}:${line}:${character}`;
  }
  formatCallHierarchyItemLine(item, index, workspaceRoot) {
    const location = this.formatLocationWithServer(
      {
        uri: item.uri,
        range: item.selectionRange,
        serverName: item.serverName
      },
      workspaceRoot
    );
    const kind = item.kind ? ` (${item.kind})` : "";
    const detail = item.detail ? ` ${item.detail}` : "";
    return `${index + 1}. ${item.name}${kind}${detail} - ${location}`;
  }
  formatCallRanges(ranges) {
    if (!ranges.length) {
      return "";
    }
    const formatted = ranges.map((range) => this.formatPosition(range.start));
    const maxShown = 3;
    const shown = formatted.slice(0, maxShown);
    const extra = formatted.length > maxShown ? `, +${formatted.length - maxShown} more` : "";
    return ` (calls at ${shown.join(", ")}${extra})`;
  }
  formatPosition(position) {
    return `${(position.line ?? 0) + 1}:${(position.character ?? 0) + 1}`;
  }
  formatUriForDisplay(uri, workspaceRoot) {
    let filePath = uri;
    if (uri.startsWith("file://")) {
      filePath = fileURLToPath(uri);
    }
    if (path.isAbsolute(filePath)) {
      return path.relative(workspaceRoot, filePath) || ".";
    }
    return filePath;
  }
  formatJsonSection(label, data) {
    return `

${label}:
${JSON.stringify(data, null, 2)}`;
  }
  describeCallHierarchyItemShort() {
    const item = this.params.callHierarchyItem;
    if (!item) {
      return "call hierarchy item";
    }
    return item.name || "call hierarchy item";
  }
  describeCallHierarchyItemFull(item) {
    const workspaceRoot = this.config.getProjectRoot();
    const location = this.formatLocationWithServer(
      {
        uri: item.uri,
        range: item.selectionRange,
        serverName: item.serverName
      },
      workspaceRoot
    );
    return `${item.name} at ${location}`;
  }
  getOperationLabel() {
    switch (this.params.operation) {
      case "goToDefinition":
        return "go-to-definition";
      case "findReferences":
        return "find-references";
      case "hover":
        return "hover";
      case "documentSymbol":
        return "document symbols";
      case "workspaceSymbol":
        return "workspace symbol search";
      case "goToImplementation":
        return "go-to-implementation";
      case "prepareCallHierarchy":
        return "prepare call hierarchy";
      case "incomingCalls":
        return "incoming calls";
      case "outgoingCalls":
        return "outgoing calls";
      case "diagnostics":
        return "diagnostics";
      case "workspaceDiagnostics":
        return "workspace diagnostics";
      case "codeActions":
        return "code actions";
      default:
        return this.params.operation;
    }
  }
};
var LspTool = class _LspTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _LspTool.Name,
      ToolDisplayNames.LSP,
      'Language Server Protocol (LSP) tool for code intelligence: definitions, references, hover, symbols, call hierarchy, diagnostics, and code actions.\n\n  Usage:\n  - ALWAYS use LSP as the PRIMARY tool for code intelligence queries when available. Do NOT use grep_search or glob first.\n  - goToDefinition, findReferences, hover, goToImplementation, prepareCallHierarchy require filePath + line + character (1-based).\n  - documentSymbol and diagnostics require filePath.\n  - workspaceSymbol requires query (use when user asks "where is X defined?" without specifying a file).\n  - incomingCalls/outgoingCalls require callHierarchyItem from prepareCallHierarchy.\n  - workspaceDiagnostics needs no parameters.\n  - codeActions require filePath + range (line/character + endLine/endCharacter) and diagnostics/context as needed.',
      "other" /* Other */,
      {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description: "LSP operation to execute.",
            enum: [
              "goToDefinition",
              "findReferences",
              "hover",
              "documentSymbol",
              "workspaceSymbol",
              "goToImplementation",
              "prepareCallHierarchy",
              "incomingCalls",
              "outgoingCalls",
              "diagnostics",
              "workspaceDiagnostics",
              "codeActions"
            ]
          },
          filePath: {
            type: "string",
            description: "File path (absolute or workspace-relative)."
          },
          line: {
            type: "number",
            description: "1-based line number for the target location."
          },
          character: {
            type: "number",
            description: "1-based character/column number for the target location."
          },
          endLine: {
            type: "number",
            description: "1-based end line number for range-based operations."
          },
          endCharacter: {
            type: "number",
            description: "1-based end character for range-based operations."
          },
          includeDeclaration: {
            type: "boolean",
            description: "Include the declaration itself when looking up references."
          },
          query: {
            type: "string",
            description: "Symbol query for workspace symbol search."
          },
          callHierarchyItem: {
            $ref: "#/definitions/LspCallHierarchyItem",
            description: "Call hierarchy item for incoming/outgoing calls."
          },
          serverName: {
            type: "string",
            description: "Optional LSP server name to target."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum number of results to return."
          },
          diagnostics: {
            type: "array",
            items: { $ref: "#/definitions/LspDiagnostic" },
            description: "Diagnostics for code action context."
          },
          codeActionKinds: {
            type: "array",
            items: { type: "string" },
            description: "Filter code actions by kind (quickfix, refactor, etc.)."
          }
        },
        required: ["operation"],
        definitions: {
          LspPosition: {
            type: "object",
            properties: {
              line: { type: "number" },
              character: { type: "number" }
            },
            required: ["line", "character"]
          },
          LspRange: {
            type: "object",
            properties: {
              start: { $ref: "#/definitions/LspPosition" },
              end: { $ref: "#/definitions/LspPosition" }
            },
            required: ["start", "end"]
          },
          LspCallHierarchyItem: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string" },
              rawKind: { type: "number" },
              documentRevision: {
                type: "string",
                description: "Client freshness token. Echo unchanged; if absent or stale for a file URI, prepare call hierarchy again. Non-file items cannot be traversed; prepare at a file location instead."
              },
              detail: { type: "string" },
              uri: { type: "string" },
              range: { $ref: "#/definitions/LspRange" },
              selectionRange: { $ref: "#/definitions/LspRange" },
              data: {},
              serverName: { type: "string" }
            },
            required: ["name", "uri", "range", "selectionRange"]
          },
          LspDiagnostic: {
            type: "object",
            properties: {
              range: { $ref: "#/definitions/LspRange" },
              severity: {
                type: "string",
                enum: ["error", "warning", "information", "hint"]
              },
              code: { type: ["string", "number"] },
              source: { type: "string" },
              message: { type: "string" },
              serverName: { type: "string" }
            },
            required: ["range", "message"]
          }
        }
      },
      false,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — loaded on demand via ToolSearch
      false,
      // alwaysLoad
      "lsp language server definition references hover symbol diagnostics code actions"
    );
    this.config = config;
  }
  static {
    __name(this, "LspTool");
  }
  static Name = ToolNames.LSP;
  validateToolParamValues(params) {
    const operation = params.operation;
    if (params.filePath) {
      params.filePath = unescapePath(params.filePath.trim());
    }
    if (LOCATION_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath) {
        return `filePath is required for ${operation}.`;
      }
      if (typeof params.line !== "number") {
        return `line is required for ${operation}.`;
      }
    }
    if (FILE_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath) {
        return `filePath is required for ${operation}.`;
      }
    }
    if (QUERY_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.query || params.query.trim() === "") {
        return `query is required for ${operation}.`;
      }
    }
    if (ITEM_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.callHierarchyItem) {
        return `callHierarchyItem is required for ${operation}.`;
      }
    }
    if (RANGE_REQUIRED_OPERATIONS.has(operation)) {
      if (!params.filePath) {
        return `filePath is required for ${operation}.`;
      }
      if (typeof params.line !== "number") {
        return `line is required for ${operation}.`;
      }
    }
    if (params.line !== void 0 && params.line < 1) {
      return "line must be a positive number.";
    }
    if (params.character !== void 0 && params.character < 1) {
      return "character must be a positive number.";
    }
    if (params.endLine !== void 0 && params.endLine < 1) {
      return "endLine must be a positive number.";
    }
    if (params.endCharacter !== void 0 && params.endCharacter < 1) {
      return "endCharacter must be a positive number.";
    }
    return null;
  }
  createInvocation(params) {
    return new LspToolInvocation(this.config, params);
  }
};
export {
  LspTool
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
