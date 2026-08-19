/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Parser from 'web-tree-sitter';

export interface PreparedNodeReplCell {
  source: string;
  bindingExports: ReadonlyArray<{
    bindingName: string;
    exportName: string;
  }>;
  snapshotExportName: string;
  resultExportName?: string;
}

export interface PrepareNodeReplCellOptions {
  previousBindingNames: readonly string[];
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
const VAR_SCOPE_BOUNDARY_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'class_declaration',
  'class',
  'method_definition',
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
        [
          new URL('./runtime/tree-sitter-javascript.wasm', import.meta.url),
          new URL(
            './node-repl-runtime/tree-sitter-javascript.wasm',
            import.meta.url,
          ),
          new URL(
            '../node-repl-runtime/tree-sitter-javascript.wasm',
            import.meta.url,
          ),
        ],
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

function collectImportNames(node: Parser.SyntaxNode, names: Set<string>): void {
  const clause = node.namedChildren.find(
    (child) => child.type === 'import_clause',
  );
  if (!clause) return;

  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      names.add(decodeIdentifierName(child.text));
      continue;
    }
    if (child.type === 'namespace_import') {
      const identifier = child.namedChildren.find(
        (candidate) => candidate.type === 'identifier',
      );
      if (identifier) names.add(decodeIdentifierName(identifier.text));
      continue;
    }
    if (child.type !== 'named_imports') continue;
    for (const specifier of child.namedChildren) {
      if (specifier.type !== 'import_specifier') continue;
      const alias = specifier.childForFieldName('alias');
      const name = specifier.childForFieldName('name');
      if (alias) names.add(decodeIdentifierName(alias.text));
      else if (name) names.add(decodeIdentifierName(name.text));
    }
  }
}

function collectDeclarationNames(
  node: Parser.SyntaxNode,
  names: Set<string>,
): void {
  switch (node.type) {
    case 'lexical_declaration':
    case 'variable_declaration':
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name) collectPatternNames(name, names);
      }
      return;
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'class_declaration': {
      const name = node.childForFieldName('name');
      if (name) names.add(decodeIdentifierName(name.text));
      return;
    }
    case 'import_statement':
      collectImportNames(node, names);
      return;
    case 'export_statement':
      for (const child of node.namedChildren) {
        collectDeclarationNames(child, names);
      }
      return;
    default:
      return;
  }
}

function collectHoistedVarNames(
  node: Parser.SyntaxNode,
  names: Set<string>,
): void {
  if (VAR_SCOPE_BOUNDARY_TYPES.has(node.type)) return;
  if (node.type === 'variable_declaration') {
    collectDeclarationNames(node, names);
    return;
  }
  for (const child of node.namedChildren) {
    collectHoistedVarNames(child, names);
  }
}

function generatedPrefix(
  root: Parser.SyntaxNode,
  cellId: string,
  previousBindingNames: readonly string[],
): string {
  const suffix = cellId.replace(/[^A-Za-z0-9_$]/g, '').slice(-24) || 'cell';
  const stem = `__qwen_repl_${suffix}_`;
  const forbidden = new Set<string>();
  const maxDiscriminatorLength = (
    root.endIndex + previousBindingNames.length
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
  for (const name of previousBindingNames) inspectName(name);

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
  bindingNames: Iterable<string>,
  maxChars: number,
): string {
  const assignments: string[] = [];
  let length = 0;
  for (const name of bindingNames) {
    const assignment = `${snapshotName}[${JSON.stringify(name)}] = ${name};`;
    length += assignment.length + 1;
    if (length > maxChars) {
      throw new Error('Transformed JavaScript cell exceeds the sanity limit');
    }
    assignments.push(assignment);
  }
  return assignments.length > 0 ? `\n${assignments.join('\n')}` : '';
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
    const currentNames = new Set<string>();
    for (const item of sourceItems) {
      collectDeclarationNames(item, currentNames);
      collectHoistedVarNames(item, currentNames);
    }

    const previousNames = [...new Set(options.previousBindingNames)].sort();
    const carriedNames = previousNames.filter(
      (name) => !currentNames.has(name),
    );
    const allNames = [...new Set([...previousNames, ...currentNames])].sort();
    if (allNames.length > MAX_CELL_BINDINGS) {
      throw new Error(
        `JavaScript cell exceeds the ${MAX_CELL_BINDINGS}-binding sanity limit`,
      );
    }
    if (
      allNames.reduce((total, name) => total + name.length, 0) >
      MAX_BINDING_NAME_CHARS
    ) {
      throw new Error(
        'JavaScript cell exceeds the cumulative binding-name sanity limit',
      );
    }
    if (
      sourceItems.length * Math.max(1, allNames.length) >
      MAX_SNAPSHOT_ASSIGNMENTS
    ) {
      throw new Error(
        'JavaScript cell has too many statement-boundary binding snapshots',
      );
    }
    const prefix = generatedPrefix(root, options.cellId, previousNames);
    const previousNamespace = `${prefix}_previous`;
    const snapshotName = `${prefix}_snapshot`;
    const resultName = `${prefix}_result`;
    const snapshotExportName = `${prefix}_snapshot_export`;
    const resultExportName = `${prefix}_result_export`;

    const prelude = [
      `import * as ${previousNamespace} from '@prev';`,
      `const ${snapshotName} = { __proto__: null };`,
      ...previousNames.map(
        (name) =>
          `${snapshotName}[${JSON.stringify(name)}] = ${previousNamespace}[${JSON.stringify(name)}];`,
      ),
      ...carriedNames.map(
        (name) =>
          `let ${name} = ${previousNamespace}[${JSON.stringify(name)}];`,
      ),
    ].join('\n');

    const edits: Edit[] = [];
    const activeNames = new Set(carriedNames);
    const lastItem = sourceItems.at(-1);
    let hasResult = false;
    let generatedCommitChars = 0;

    for (const item of sourceItems) {
      const declaredHere = new Set<string>();
      collectDeclarationNames(item, declaredHere);
      collectHoistedVarNames(item, declaredHere);
      for (const name of declaredHere) activeNames.add(name);
      const commit = snapshotAssignments(
        snapshotName,
        activeNames,
        MAX_TRANSFORMED_SOURCE_CHARS -
          code.length -
          prelude.length -
          generatedCommitChars,
      );
      generatedCommitChars += commit.length;

      if (item === lastItem && item.type === 'expression_statement') {
        const expression = item.namedChildren[0];
        if (expression) {
          edits.push({
            start: item.startIndex,
            end: item.endIndex,
            text: `const ${resultName} = (${expression.text});${commit}`,
          });
          hasResult = true;
          continue;
        }
      }

      if (commit) {
        edits.push({
          start: item.endIndex,
          end: item.endIndex,
          text: commit,
        });
      }
    }

    const rewritten = applyEdits(code, edits);
    const bindingExports = allNames.map((bindingName, index) => ({
      bindingName,
      exportName: `${prefix}_binding_${index}`,
    }));
    const exports = [
      ...bindingExports.map(
        ({ bindingName, exportName }) => `${bindingName} as ${exportName}`,
      ),
      `${snapshotName} as ${snapshotExportName}`,
      ...(hasResult ? [`${resultName} as ${resultExportName}`] : []),
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
      resultExportName: hasResult ? resultExportName : undefined,
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
