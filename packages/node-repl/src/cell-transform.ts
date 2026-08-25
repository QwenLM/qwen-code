/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Parser from 'web-tree-sitter';
import type {
  NodeReplBindingDescriptor,
  NodeReplBindingKind,
} from './protocol.js';

export interface PreparedNodeReplCell {
  source: string;
  bindingExports: ReadonlyArray<{
    bindingName: string;
    bindingKind: NodeReplBindingKind;
    exportName: string;
  }>;
  snapshotExportName: string;
}

export interface PrepareNodeReplCellOptions {
  previousBindings: readonly NodeReplBindingDescriptor[];
  cellId: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const MAX_CELL_SOURCE_CHARS = 4 * 1024 * 1024;
const MAX_CELL_BINDINGS = 10_000;
const MAX_BINDING_NAME_CHARS = 4 * 1024 * 1024;
const MAX_SNAPSHOT_ASSIGNMENTS = 200_000;
const MAX_TRANSFORMED_SOURCE_CHARS = 32 * 1024 * 1024;

/**
 * The runtime surface this tool itself provides to the model. A persisted
 * top-level binding with one of these names would shadow it for every later cell
 * in the session — and because the tool description instructs the model to call
 * `nodeRepl.write`, losing it silently breaks the model↔tool contract with no
 * way to recover except a reset. Such cells are rejected up front.
 *
 * Keep in sync with the `intrinsicObjectDefineProperties` call in
 * runtime/kernel.mjs.
 *
 * DELIBERATELY NOT LISTED: the standard JS/Web globals the context also exposes
 * (Buffer, URL, fetch, crypto, TextEncoder, structuredClone, performance, ...).
 * Shadowing those is ordinary JavaScript — `const Buffer = 42` makes `Buffer` a
 * number in plain Node too — and a persistent REPL sharing one scope across
 * cells is the documented model. Rejecting them would diverge from JS semantics
 * and remove legitimate capability, so they are allowed to be shadowed.
 */
const RESERVED_GLOBAL_NAMES = new Set([
  'nodeRepl',
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
]);

let parserInstance: Parser | null = null;
let parserInitPromise: Promise<void> | null = null;
let parserInitError: Error | null = null;

async function loadWasmBinary(
  dynamicImport: () => Promise<unknown>,
  fallbackSpecifier: string,
  packagedAssetUrls: readonly URL[] = [],
): Promise<Uint8Array> {
  try {
    const mod = await dynamicImport();
    const wasmBinary = (mod as { default?: unknown }).default;
    if (wasmBinary instanceof Uint8Array && wasmBinary.byteLength > 0) {
      return wasmBinary;
    }
  } catch {
    // Plain Node execution uses packaged assets or node_modules below.
  }

  for (const assetUrl of packagedAssetUrls) {
    try {
      const bytes = fs.readFileSync(fileURLToPath(assetUrl));
      if (bytes.byteLength > 0) return new Uint8Array(bytes);
    } catch {
      // Try the next package layout or development fallback.
    }
  }

  const require = createRequire(import.meta.url);
  const filePath = require.resolve(fallbackSpecifier);
  return new Uint8Array(fs.readFileSync(filePath));
}

async function getParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  if (parserInitError) throw parserInitError;

  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      const { default: ParserClass } = (await import(
        'web-tree-sitter'
      )) as unknown as { default: typeof Parser };
      const runtimeWasm = await loadWasmBinary(
        () => import('web-tree-sitter/tree-sitter.wasm?binary' as string),
        'web-tree-sitter/tree-sitter.wasm',
      );
      await ParserClass.init({ wasmBinary: runtimeWasm });
      const languageWasm = await loadWasmBinary(
        () =>
          import(
            'tree-sitter-wasms/out/tree-sitter-javascript.wasm?binary' as string
          ),
        'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
        [new URL('./runtime/tree-sitter-javascript.wasm', import.meta.url)],
      );
      const language = await ParserClass.Language.load(languageWasm);
      const parser = new ParserClass();
      parser.setLanguage(language);
      parserInstance = parser;
    })().catch((error: unknown) => {
      parserInitPromise = null;
      parserInitError =
        error instanceof Error ? error : new Error(String(error));
      throw parserInitError;
    });
  }

  await parserInitPromise;
  return parserInstance!;
}

function decodeIdentifierName(source: string): string {
  return source.replace(
    /\\u(?:\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{4}))/g,
    (_match, braced: string | undefined, fixed: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? fixed!, 16)),
  );
}

function collectPatternNames(
  node: Parser.SyntaxNode,
  names: Set<string>,
): void {
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      names.add(decodeIdentifierName(node.text));
      return;
    case 'assignment_pattern':
    case 'object_assignment_pattern': {
      const left = node.childForFieldName('left');
      if (left) collectPatternNames(left, names);
      return;
    }
    case 'pair_pattern': {
      const value = node.childForFieldName('value');
      if (value) collectPatternNames(value, names);
      return;
    }
    case 'array_pattern':
    case 'object_pattern':
    case 'rest_pattern':
      for (const child of node.namedChildren) {
        collectPatternNames(child, names);
      }
      return;
    default:
      return;
  }
}

function addPatternBindings(
  pattern: Parser.SyntaxNode,
  kind: NodeReplBindingKind,
  bindings: Map<string, NodeReplBindingKind>,
): void {
  const names = new Set<string>();
  collectPatternNames(pattern, names);
  for (const name of names) bindings.set(name, kind);
}

function collectDeclarationNames(
  node: Parser.SyntaxNode,
  bindings: Map<string, NodeReplBindingKind>,
): void {
  switch (node.type) {
    case 'lexical_declaration': {
      const kind = node.text.trimStart().startsWith('const') ? 'const' : 'let';
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name) addPatternBindings(name, kind, bindings);
      }
      return;
    }
    case 'variable_declaration':
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name) addPatternBindings(name, 'var', bindings);
      }
      return;
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name');
      if (name) bindings.set(decodeIdentifierName(name.text), 'let');
      return;
    }
    case 'class_declaration': {
      const name = node.childForFieldName('name');
      if (name) bindings.set(decodeIdentifierName(name.text), 'let');
      return;
    }
    default:
      return;
  }
}

/**
 * Node types that introduce a new function scope. `var` declarations inside
 * these belong to that inner scope, not to the module, so the hoisting walk
 * stops here.
 */
const FUNCTION_SCOPE_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
  'class_static_block',
]);

/**
 * Collects every `var` binding that hoists to module scope from a top-level
 * statement, including ones nested in blocks, `if`/`try`/loop bodies and
 * labelled statements. Recursion stops at function boundaries.
 *
 * `const`/`let` (`lexical_declaration`) are intentionally NOT collected here:
 * they are block-scoped and only persist when declared at the top level, which
 * `collectDeclarationNames` already handles.
 */
function collectTopLevelLoopVarBindings(
  node: Parser.SyntaxNode,
  bindings: Map<string, NodeReplBindingKind>,
): void {
  if (FUNCTION_SCOPE_NODE_TYPES.has(node.type)) return;

  if (node.type === 'variable_declaration') {
    collectDeclarationNames(node, bindings);
    return;
  }

  if (node.type === 'for_statement') {
    const initializer = node.childForFieldName('initializer');
    if (initializer?.type === 'variable_declaration') {
      collectDeclarationNames(initializer, bindings);
    }
    // Fall through: the loop body may contain further hoisting `var`s.
  }

  if (node.type === 'for_in_statement') {
    const kind = node.childForFieldName('kind');
    const left = node.childForFieldName('left');
    if (kind?.text === 'var' && left) {
      addPatternBindings(left, 'var', bindings);
    }
  }

  for (const child of node.namedChildren) {
    collectTopLevelLoopVarBindings(child, bindings);
  }
}

function collectExportDeclarationBindings(
  node: Parser.SyntaxNode,
  bindings: Map<string, NodeReplBindingKind>,
): void {
  if (node.type !== 'export_statement') return;
  for (const child of node.namedChildren) {
    collectDeclarationNames(child, bindings);
  }
}

function generatedPrefix(
  root: Parser.SyntaxNode,
  cellId: string,
  previousBindings: readonly NodeReplBindingDescriptor[],
): string {
  const suffix = cellId.replace(/[^A-Za-z0-9_$]/g, '').slice(-24) || 'cell';
  const stem = `__qwen_repl_${suffix}_`;
  const forbidden = new Set<string>();
  const maxDiscriminatorLength = (
    root.endIndex + previousBindings.length
  ).toString(36).length;

  const inspectName = (name: string) => {
    if (!name.startsWith(stem)) return;
    const end = name.indexOf('_', stem.length);
    if (end <= stem.length || end - stem.length > maxDiscriminatorLength) {
      return;
    }
    const discriminator = name.slice(stem.length, end);
    if (/^[0-9a-z]+$/.test(discriminator)) forbidden.add(discriminator);
  };
  for (const { name } of previousBindings) inspectName(name);

  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.type === 'identifier' ||
      node.type === 'shorthand_property_identifier' ||
      node.type === 'shorthand_property_identifier_pattern'
    ) {
      inspectName(decodeIdentifierName(node.text));
    }
    for (const child of node.namedChildren) pending.push(child);
  }
  for (let index = 0; index <= forbidden.size; index++) {
    const discriminator = index.toString(36);
    if (!forbidden.has(discriminator)) {
      return `${stem}${discriminator}_`;
    }
  }
  throw new Error('Unable to allocate collision-free REPL identifiers');
}

function snapshotAssignments(
  snapshotName: string,
  bindings: Iterable<NodeReplBindingDescriptor>,
  maxChars: number,
): string {
  const assignments: string[] = [];
  let length = 0;
  for (const { name } of bindings) {
    const assignment = `${snapshotName}[${JSON.stringify(name)}] = ${name};`;
    length += assignment.length + 1;
    if (length > maxChars) {
      throw new Error('Transformed JavaScript cell exceeds the sanity limit');
    }
    assignments.push(assignment);
  }
  // Joined without newlines: this text is injected between the user's
  // statements, so any newline here would shift every subsequent line number in
  // reported stack traces (and the shift would grow with the binding count).
  // Each assignment already ends in ';'.
  return assignments.length > 0 ? assignments.join('') : '';
}

function snapshotDeclarator(
  helperName: string,
  snapshotName: string,
  bindings: Iterable<NodeReplBindingDescriptor>,
  maxChars: number,
): string {
  const assignments = [...bindings].map(
    ({ name }) => `${snapshotName}[${JSON.stringify(name)}] = ${name}`,
  );
  const expression =
    assignments.length > 0
      ? `${assignments.join(', ')}, undefined`
      : 'undefined';
  const text = `, ${helperName} = (${expression})`;
  if (text.length > maxChars) {
    throw new Error('Transformed JavaScript cell exceeds the sanity limit');
  }
  return text;
}

function topLevelVariableDeclaration(
  item: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  if (
    item.type === 'lexical_declaration' ||
    item.type === 'variable_declaration'
  ) {
    return item;
  }
  if (item.type === 'for_statement') {
    const initializer = item.childForFieldName('initializer');
    return initializer?.type === 'variable_declaration' ? initializer : null;
  }
  return null;
}

function declarationKind(declaration: Parser.SyntaxNode): NodeReplBindingKind {
  if (declaration.type === 'variable_declaration') return 'var';
  return declaration.text.trimStart().startsWith('const') ? 'const' : 'let';
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });
  const rewritten: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor || edit.end < edit.start) {
      throw new Error('JavaScript cell transform produced overlapping edits');
    }
    rewritten.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  rewritten.push(source.slice(cursor));
  return rewritten.join('');
}

function isSourceItem(node: Parser.SyntaxNode): boolean {
  return node.type !== 'comment' && node.type !== 'hash_bang_line';
}

export async function prepareNodeReplCell(
  code: string,
  options: PrepareNodeReplCellOptions,
): Promise<PreparedNodeReplCell> {
  if (code.length > MAX_CELL_SOURCE_CHARS) {
    throw new Error(
      `JavaScript cell exceeds the source sanity limit (${MAX_CELL_SOURCE_CHARS} characters)`,
    );
  }
  if (code.startsWith('#!')) {
    throw new Error('node_repl cells do not support hashbang lines');
  }

  const parser = await getParser();
  const tree = parser.parse(code);
  if (!tree) throw new Error('JavaScript parser returned no syntax tree');

  try {
    const root = tree.rootNode;
    if (root.hasError) {
      throw new Error('JavaScript syntax could not be parsed safely');
    }

    const sourceItems = root.namedChildren.filter(isSourceItem);
    const staticImport = sourceItems.find(
      (item) =>
        item.type === 'import_statement' ||
        (item.type === 'export_statement' &&
          item.childForFieldName('source') !== null),
    );
    if (staticImport) {
      const source = staticImport.childForFieldName('source')?.text;
      throw new Error(
        `Top-level static import${source ? ` ${source}` : ''} is not supported in node_repl. Use await import(${source ?? '...'}) instead.`,
      );
    }
    const currentBindings = new Map<string, NodeReplBindingKind>();
    for (const item of sourceItems) {
      collectDeclarationNames(item, currentBindings);
      collectTopLevelLoopVarBindings(item, currentBindings);
    }
    // A persisted top-level binding that shadows a host-injected global would
    // permanently break it for the rest of the session (e.g. declaring
    // `nodeRepl` silently disables nodeRepl.write with no way back except a
    // reset). Reject the cell with an actionable message instead.
    const shadowedGlobal = [...currentBindings.keys()].find((name) =>
      RESERVED_GLOBAL_NAMES.has(name),
    );
    if (shadowedGlobal) {
      throw new Error(
        `Cannot declare a top-level binding named '${shadowedGlobal}': it would shadow the node_repl runtime global for the rest of this session. Use a different name.`,
      );
    }

    const previousBindingsByName = new Map<string, NodeReplBindingKind>();
    for (const binding of options.previousBindings) {
      const existing = previousBindingsByName.get(binding.name);
      if (existing && existing !== binding.kind) {
        throw new Error(
          `Previous JavaScript binding '${binding.name}' has conflicting declaration kinds`,
        );
      }
      previousBindingsByName.set(binding.name, binding.kind);
    }
    const previousBindings = [...previousBindingsByName]
      .map(([name, kind]) => ({ name, kind }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    const exportedBindings = new Map<string, NodeReplBindingKind>();
    for (const item of sourceItems) {
      collectExportDeclarationBindings(item, exportedBindings);
    }
    const exportedCollision = [...exportedBindings.keys()].find((name) =>
      previousBindingsByName.has(name),
    );
    if (exportedCollision) {
      throw new Error(
        `Identifier '${exportedCollision}' has already been declared`,
      );
    }
    for (const name of exportedBindings.keys()) currentBindings.delete(name);
    const allBindingsByName = new Map(previousBindingsByName);
    for (const [name, kind] of currentBindings) {
      if (!allBindingsByName.has(name)) allBindingsByName.set(name, kind);
    }
    const allBindings = [...allBindingsByName]
      .map(([name, kind]) => ({ name, kind }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    if (allBindings.length > MAX_CELL_BINDINGS) {
      throw new Error(
        `JavaScript cell exceeds the ${MAX_CELL_BINDINGS}-binding sanity limit`,
      );
    }
    if (
      allBindings.reduce((total, binding) => total + binding.name.length, 0) >
      MAX_BINDING_NAME_CHARS
    ) {
      throw new Error(
        'JavaScript cell exceeds the cumulative binding-name sanity limit',
      );
    }
    if (
      sourceItems.length * Math.max(1, allBindings.length) >
      MAX_SNAPSHOT_ASSIGNMENTS
    ) {
      throw new Error(
        'JavaScript cell has too many statement-boundary binding snapshots',
      );
    }
    const prefix = generatedPrefix(root, options.cellId, previousBindings);
    const previousNamespace = `${prefix}_previous`;
    const snapshotName = `${prefix}_snapshot`;
    const snapshotExportName = `${prefix}_snapshot_export`;

    // Joined into a SINGLE line so the user's first line is always physical
    // line 2. The kernel compensates with lineOffset: -1 (see LINE_OFFSET) so
    // reported stack traces match the source the model actually wrote.
    const prelude = [
      `import * as ${previousNamespace} from '@prev';`,
      `const ${snapshotName} = { __proto__: null };`,
      ...previousBindings.map(
        ({ name }) =>
          `${snapshotName}[${JSON.stringify(name)}] = ${previousNamespace}[${JSON.stringify(name)}];`,
      ),
      ...previousBindings.map(
        ({ name, kind }) =>
          `${kind} ${name} = ${previousNamespace}[${JSON.stringify(name)}];`,
      ),
    ].join('');

    const edits: Edit[] = [];
    const activeBindings = new Map(previousBindingsByName);
    // `var` declarations hoist to the top of module scope and exist (as
    // undefined) before their declaring statement runs. Seed them up front so a
    // statement-boundary snapshot taken BEFORE the declaration still carries any
    // value already assigned to them — otherwise `y = 42; throw; var y;` loses
    // the 42 that plain Node keeps. `const`/`let` are deliberately NOT seeded:
    // they are in TDZ until their declaration executes.
    for (const [name, kind] of currentBindings) {
      if (kind === 'var' && !activeBindings.has(name)) {
        activeBindings.set(name, kind);
      }
    }
    let generatedCommitChars = 0;
    let commitCounter = 0;

    for (const item of sourceItems) {
      const declaration = topLevelVariableDeclaration(item);
      if (declaration) {
        const completedBindings = new Map(activeBindings);
        const kind = declarationKind(declaration);
        for (const declarator of declaration.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name');
          if (name) addPatternBindings(name, kind, completedBindings);
          const marker = snapshotDeclarator(
            `${prefix}commit_${commitCounter++}`,
            snapshotName,
            [...completedBindings]
              .map(([bindingName, bindingKind]) => ({
                name: bindingName,
                kind: bindingKind,
              }))
              .sort((left, right) =>
                left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
              ),
            MAX_TRANSFORMED_SOURCE_CHARS -
              code.length -
              prelude.length -
              generatedCommitChars,
          );
          generatedCommitChars += marker.length;
          edits.push({
            start: declarator.endIndex,
            end: declarator.endIndex,
            text: marker,
          });
        }
      }
      const declaredHere = new Map<string, NodeReplBindingKind>();
      collectDeclarationNames(item, declaredHere);
      collectTopLevelLoopVarBindings(item, declaredHere);
      for (const [name, kind] of declaredHere) {
        if (!exportedBindings.has(name) && !activeBindings.has(name)) {
          activeBindings.set(name, kind);
        }
      }
      const commit = snapshotAssignments(
        snapshotName,
        [...activeBindings]
          .map(([name, kind]) => ({ name, kind }))
          .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          ),
        MAX_TRANSFORMED_SOURCE_CHARS -
          code.length -
          prelude.length -
          generatedCommitChars,
      );
      generatedCommitChars += commit.length;

      if (commit) {
        edits.push({
          start: item.endIndex,
          end: item.endIndex,
          text: commit,
        });
      }
    }

    const rewritten = applyEdits(code, edits);
    const bindingExports = allBindings.map(({ name, kind }, index) => ({
      bindingName: name,
      bindingKind: kind,
      exportName: `${prefix}_binding_${index}`,
    }));
    const exports = [
      ...bindingExports.map(
        ({ bindingName, exportName }) => `${bindingName} as ${exportName}`,
      ),
      `${snapshotName} as ${snapshotExportName}`,
    ];
    const suffix = `\nexport {\n  ${exports.join(',\n  ')}\n};`;

    const source = `${prelude}\n${rewritten}${suffix}`;
    if (source.length > MAX_TRANSFORMED_SOURCE_CHARS) {
      throw new Error('Transformed JavaScript cell exceeds the sanity limit');
    }

    return {
      source,
      bindingExports,
      snapshotExportName,
    };
  } finally {
    tree.delete();
  }
}

export function resetNodeReplCellParserForTesting(): void {
  try {
    parserInstance?.delete();
  } catch {
    // Test cleanup is best-effort.
  }
  parserInstance = null;
  parserInitPromise = null;
  parserInitError = null;
}
