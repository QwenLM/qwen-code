/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Symbol Extractor — tree-sitter `.scm` based symbol and reference extraction.
 *
 * Replaces the old EntityExtractor with a declarative, .scm-query-driven approach:
 * 1. Uses tree-sitter `.scm` tag query files to extract definitions and references
 * 2. Analyzes import statements via AST traversal for cross-file resolution
 * 3. Resolves references to their target definitions using import mappings
 * 4. Outputs: SymbolDefinition[], SymbolEdge[], ImportMapping[]
 *
 * Inspired by:
 * - Aider RepoMap (tree-sitter tags.scm → def/ref → graph)
 * - RepoGraph (ICLR 2025) (tag_to_graph → one-hop expansion)
 * - Continue CodeSnippetsIndex (tree-sitter .scm → SQLite)
 * - GitHub Stack Graphs (per-file incremental, tree-sitter DSL)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Tree } from 'web-tree-sitter';
import { Query } from 'web-tree-sitter';
import {
  detectTreeSitterLanguage,
  loadLanguage,
  type SupportedLanguage,
  type SyntaxNode,
  type ParseResult,
  parseFile,
} from './treeSitterParser.js';
import type {
  SymbolDefinition,
  SymbolEdge,
  ImportMapping,
  SymbolType,
  EdgeType,
} from './types.js';
import { TAG_QUERIES } from './tag-queries/index.js';

/** Maximum length of signature extracted from a definition. */
const MAX_SIGNATURE_LENGTH = 200;

/**
 * Helper: find first child node of a given type.
 */
function child_by_type(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.children.find((c) => c?.type === type) ?? undefined;
}

/** Built-in names to skip during symbol extraction. */
const BUILTINS = new Set([
  // JS/TS built-ins
  'undefined',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Error',
  'TypeError',
  'RangeError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'require',
  // Python built-ins
  'print',
  'len',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'sorted',
  'list',
  'dict',
  'set',
  'tuple',
  'str',
  'int',
  'float',
  'bool',
  'type',
  'isinstance',
  'hasattr',
  'getattr',
  'setattr',
  'super',
  'property',
  'staticmethod',
  'classmethod',
  'open',
  'input',
  'abs',
  'max',
  'min',
  'sum',
  'any',
  'all',
  'iter',
  'next',
  'repr',
  'vars',
  'dir',
]);

// ===== Types =====

/**
 * Raw tag extracted from .scm query captures.
 */
interface RawTag {
  /** Symbol name. */
  name: string;
  /** Whether this is a definition or reference. */
  kind: 'def' | 'ref';
  /** Category: function, method, class, interface, type, call, variable. */
  category: string;
  /** Line of the name identifier (1-based). */
  line: number;
  /** Start line of the full definition node (1-based), only meaningful for defs. */
  startLine: number;
  /** End line of the full definition node (1-based), only meaningful for defs. */
  endLine: number;
  /**
   * For member-access references (e.g. `obj.method()`), the object name.
   * - `'this'` / `'super'` — same-file lookup only
   * - Any other identifier — will be checked against imports in `buildEdges`
   * - `undefined` — direct call like `foo()`, or complex expression (dropped)
   */
  memberObject?: string;
}

/**
 * Result of symbol extraction from a single file.
 */
export interface SymbolExtractionResult {
  symbols: SymbolDefinition[];
  edges: SymbolEdge[];
  imports: ImportMapping[];
}

// ===== SymbolExtractor =====

/**
 * Extracts symbols, edges, and imports from source code using
 * tree-sitter `.scm` tag queries for declarative pattern matching.
 */
export class SymbolExtractor {
  /** Cache of loaded .scm query strings by language. */
  private queryStringCache = new Map<SupportedLanguage, string>();
  /** Cache of compiled Query objects by language. */
  private queryObjectCache = new Map<
    SupportedLanguage,
    InstanceType<typeof Query>
  >();

  /**
   * @param projectRoot - Absolute path to the project root (for import resolution).
   */
  constructor(private readonly projectRoot: string) {}

  /**
   * Extract symbols, edges, and imports from a source file.
   *
   * @param filePath - Relative file path from project root.
   * @param content - File content.
   * @param preParseResult - Optional pre-parsed AST (avoids duplicate parsing).
   * @returns Extracted symbols, edges, and imports.
   */
  async extract(
    filePath: string,
    content: string,
    preParseResult?: ParseResult | null,
  ): Promise<SymbolExtractionResult> {
    const language = detectTreeSitterLanguage(filePath);
    if (!language) {
      return { symbols: [], edges: [], imports: [] };
    }

    const parseResult = preParseResult ?? (await parseFile(filePath, content));
    if (!parseResult) {
      return { symbols: [], edges: [], imports: [] };
    }

    const { tree } = parseResult;

    // Step 1: Load and execute .scm query to get raw tags
    const rawTags = await this.extractRawTags(tree, language);

    // Step 2: Extract imports via AST traversal
    const imports = this.extractImports(tree.rootNode, filePath, language);

    // Step 3: Separate definitions and references
    const defTags = rawTags.filter((t) => t.kind === 'def');
    const refTags = rawTags.filter((t) => t.kind === 'ref');

    // Step 4: Build SymbolDefinition[] from definition tags
    const symbols = this.buildSymbols(defTags, filePath, content);

    // Step 5: Detect exports
    this.markExports(tree.rootNode, symbols, language);

    // Step 6: Add CONTAINS edges (class → method) and update qualifiedName/IDs
    // This must happen BEFORE buildEdges so that method IDs are stable
    const edges: SymbolEdge[] = [];
    this.addContainsEdges(symbols, edges, filePath);

    // Step 7: Build CALLS edges from reference tags (uses stable qualifiedName/IDs)
    const callEdges = this.buildEdges(refTags, symbols, imports, filePath);
    edges.push(...callEdges);

    // Step 8: Add EXTENDS / IMPLEMENTS edges from class heritage
    this.extractHeritage(
      tree.rootNode,
      symbols,
      imports,
      edges,
      filePath,
      language,
    );

    // Step 9: Add file-level IMPORTS edges
    this.addFileImportEdges(imports, edges, filePath);

    return { symbols, edges, imports };
  }

  // ===== Step 1: Raw Tag Extraction via .scm =====

  /**
   * Execute tree-sitter .scm query to extract raw definition and reference tags.
   */
  private async extractRawTags(
    tree: Tree,
    language: SupportedLanguage,
  ): Promise<RawTag[]> {
    const query = await this.getQuery(language);
    if (!query) return [];

    const tags: RawTag[] = [];
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      let nameNode: SyntaxNode | null = null;
      let defNode: SyntaxNode | null = null;
      let kind: 'def' | 'ref' | null = null;
      let category = '';

      for (const capture of match.captures) {
        const captureName = capture.name;

        if (captureName.startsWith('name.definition.')) {
          nameNode = capture.node;
          kind = 'def';
          category = captureName.replace('name.definition.', '');
        } else if (captureName.startsWith('name.reference.')) {
          nameNode = capture.node;
          kind = 'ref';
          category = captureName.replace('name.reference.', '');
        } else if (captureName.startsWith('definition.')) {
          defNode = capture.node;
        } else if (captureName.startsWith('reference.')) {
          defNode = capture.node;
        }
      }

      if (nameNode && kind) {
        const name = nameNode.text;
        // Skip built-in / trivial names
        if (this.shouldSkipName(name)) continue;

        // Detect member expression context for references.
        // For `obj.method()`, the .scm captures `method` (property_identifier).
        // We only record the object name as a simple identifier string.
        // buildEdges will use this to look up the import table and produce
        // a module-scoped placeholder like `?sourceModule#method`.
        let memberObject: string | undefined;

        if (kind === 'ref') {
          const parent = nameNode.parent;
          // JS/TS: member_expression, Python: attribute
          // Go: selector_expression, Rust/C++: field_expression
          // Ruby: call (method field), C#: member_access_expression
          if (
            parent?.type === 'member_expression' ||
            parent?.type === 'attribute' ||
            parent?.type === 'selector_expression' ||
            parent?.type === 'field_expression' ||
            parent?.type === 'member_access_expression' ||
            parent?.type === 'member_call_expression' ||
            parent?.type === 'scoped_call_expression'
          ) {
            const objectNode =
              parent.childForFieldName('object') ??
              parent.childForFieldName('operand');
            if (objectNode) {
              if (
                objectNode.type === 'this' ||
                objectNode.type === 'super' ||
                objectNode.type === 'self'
              ) {
                // this.method() / super.method() / self.method() → marker for same-file resolution
                memberObject =
                  objectNode.type === 'self' ? 'this' : objectNode.type;
              } else if (
                objectNode.type === 'identifier' ||
                objectNode.type === 'constant' ||
                objectNode.type === 'package_identifier'
              ) {
                // Could be an import or a local variable — recorded as-is.
                // buildEdges will check the import table to decide.
                memberObject = objectNode.text;
              }
              // Chained expressions (a.b.method), call results, etc.
              // are too complex to resolve without type info — leave
              // memberObject undefined so the reference is dropped.
            }
          }
        }

        const fullNode = defNode ?? nameNode;
        tags.push({
          name,
          kind,
          category,
          line: nameNode.startPosition.row + 1,
          startLine: fullNode.startPosition.row + 1,
          endLine: fullNode.endPosition.row + 1,
          ...(memberObject !== undefined ? { memberObject } : {}),
        });
      }
    }

    return tags;
  }

  /**
   * Load and compile a .scm query for the given language.
   */
  private async getQuery(
    language: SupportedLanguage,
  ): Promise<InstanceType<typeof Query> | null> {
    // Check compiled cache
    const cached = this.queryObjectCache.get(language);
    if (cached) return cached;

    // Load query string
    const queryString = this.loadQueryString(language);
    if (!queryString) return null;

    try {
      const tsLanguage = await loadLanguage(language);
      const query = new Query(tsLanguage, queryString);
      this.queryObjectCache.set(language, query);
      return query;
    } catch (error) {
      console.warn(`Failed to compile .scm query for ${language}: ${error}`);
      return null;
    }
  }

  /**
   * Load the .scm query string for a language.
   */
  private loadQueryString(language: SupportedLanguage): string | null {
    const cached = this.queryStringCache.get(language);
    if (cached) return cached;

    if (TAG_QUERIES[language]) {
      const content = TAG_QUERIES[language];
      this.queryStringCache.set(language, content);
      return content;
    }

    console.warn(`No .scm query file found for language: ${language}`);
    return null;
  }

  /**
   * Whether to skip a symbol name (built-ins, trivial names).
   */
  private shouldSkipName(name: string): boolean {
    // Skip very short names (likely loop variables)
    if (name.length <= 1) return true;
    return BUILTINS.has(name);
  }

  // ===== Step 2: Import Extraction =====

  /**
   * Extract import mappings from AST (not via .scm, since import patterns
   * are complex and language-specific).
   */
  private extractImports(
    rootNode: SyntaxNode,
    filePath: string,
    language: SupportedLanguage,
  ): ImportMapping[] {
    const imports: ImportMapping[] = [];

    if (
      language === 'typescript' ||
      language === 'tsx' ||
      language === 'javascript' ||
      language === 'jsx'
    ) {
      this.extractJsTsImports(rootNode, filePath, imports);
    } else if (language === 'python') {
      this.extractPythonImports(rootNode, filePath, imports);
    } else if (language === 'java') {
      this.extractJavaImports(rootNode, filePath, imports);
    } else if (language === 'go') {
      this.extractGoImports(rootNode, filePath, imports);
    } else if (language === 'rust') {
      this.extractRustImports(rootNode, filePath, imports);
    } else if (language === 'ruby') {
      this.extractRubyImports(rootNode, filePath, imports);
    } else if (language === 'csharp') {
      this.extractCSharpImports(rootNode, filePath, imports);
    } else if (language === 'php') {
      this.extractPhpImports(rootNode, filePath, imports);
    }
    // C and C++ use #include which is handled by the preprocessor,
    // not meaningful for symbol-level import tracking.

    return imports;
  }

  /**
   * Extract ES module imports from JS/TS files.
   * Handles: import { Foo } from './bar'
   *          import { Foo as Bar } from './bar'
   *          import Foo from './bar'
   *          import * as Foo from './bar'
   */
  private extractJsTsImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    for (const child of rootNode.children) {
      if (!child || child.type !== 'import_statement') continue;

      // Get source module
      const sourceNode = child.childForFieldName('source');
      if (!sourceNode) continue;
      const sourceModule = sourceNode.text.replace(/['"]/g, '');

      // Resolve path
      const resolvedPath = this.resolveModulePath(sourceModule, filePath);

      // Get import clause
      const importClause = child.children.find(
        (c) =>
          c &&
          (c.type === 'import_clause' ||
            c.type === 'named_imports' ||
            c.type === 'namespace_import' ||
            c.type === 'identifier'),
      );

      if (!importClause) continue;

      this.processImportClause(
        importClause,
        filePath,
        sourceModule,
        resolvedPath,
        imports,
      );
    }
  }

  /**
   * Recursively process import clause nodes.
   */
  private processImportClause(
    node: SyntaxNode,
    filePath: string,
    sourceModule: string,
    resolvedPath: string | undefined,
    imports: ImportMapping[],
  ): void {
    switch (node.type) {
      case 'identifier': {
        // Default import: import Foo from '...'
        imports.push({
          filePath,
          localName: node.text,
          sourceModule,
          originalName: 'default',
          resolvedPath,
        });
        break;
      }
      case 'namespace_import': {
        // import * as Foo from '...'
        const nameNode =
          node.childForFieldName('name') ??
          node.children.find((c) => c?.type === 'identifier');
        if (nameNode) {
          imports.push({
            filePath,
            localName: nameNode.text,
            sourceModule,
            originalName: '*',
            resolvedPath,
          });
        }
        break;
      }
      case 'named_imports': {
        // import { Foo, Bar as Baz } from '...'
        for (const specifier of node.children) {
          if (!specifier || specifier.type !== 'import_specifier') continue;
          const nameNode = specifier.childForFieldName('name');
          const aliasNode = specifier.childForFieldName('alias');

          if (nameNode) {
            imports.push({
              filePath,
              localName: aliasNode?.text ?? nameNode.text,
              sourceModule,
              originalName: nameNode.text,
              resolvedPath,
            });
          }
        }
        break;
      }
      default:
      case 'import_clause': {
        // Recurse into children (default + named)
        for (const child of node.children) {
          if (child) {
            this.processImportClause(
              child,
              filePath,
              sourceModule,
              resolvedPath,
              imports,
            );
          }
        }
        break;
      }
    }
  }

  /**
   * Extract Python imports.
   * Handles: from foo import bar
   *          from foo import bar as baz
   *          import foo
   *          import foo as bar
   */
  private extractPythonImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    for (const child of rootNode.children) {
      if (!child) continue;

      if (child.type === 'import_from_statement') {
        // from module import name1, name2
        const moduleNode =
          child.childForFieldName('module_name') ??
          child.children.find(
            (c) => c?.type === 'dotted_name' || c?.type === 'relative_import',
          );
        if (!moduleNode) continue;
        const sourceModule = moduleNode.text;
        const resolvedPath = this.resolvePythonModule(sourceModule, filePath);

        // Get imported names
        for (const nameChild of child.children) {
          if (!nameChild) continue;
          if (nameChild.type === 'dotted_name' && nameChild !== moduleNode) {
            imports.push({
              filePath,
              localName: nameChild.text,
              sourceModule,
              originalName: nameChild.text,
              resolvedPath,
            });
          } else if (nameChild.type === 'aliased_import') {
            const name = nameChild.childForFieldName('name');
            const alias = nameChild.childForFieldName('alias');
            if (name) {
              imports.push({
                filePath,
                localName: alias?.text ?? name.text,
                sourceModule,
                originalName: name.text,
                resolvedPath,
              });
            }
          }
        }
      } else if (child.type === 'import_statement') {
        // import module
        for (const nameChild of child.children) {
          if (!nameChild) continue;
          if (nameChild.type === 'dotted_name') {
            const parts = nameChild.text.split('.');
            const lastName = parts[parts.length - 1] ?? nameChild.text;
            imports.push({
              filePath,
              localName: lastName,
              sourceModule: nameChild.text,
              originalName: '*',
            });
          } else if (nameChild.type === 'aliased_import') {
            const name = nameChild.childForFieldName('name');
            const alias = nameChild.childForFieldName('alias');
            if (name) {
              imports.push({
                filePath,
                localName: alias?.text ?? name.text,
                sourceModule: name.text,
                originalName: '*',
              });
            }
          }
        }
      }
    }
  }

  /**
   * Extract Java imports.
   * Handles: import com.example.Foo;
   *          import com.example.*;
   */
  private extractJavaImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    for (const child of rootNode.children) {
      if (!child || child.type !== 'import_declaration') continue;

      // Get the full import path text
      const scopedId = child.children.find(
        (c) => c?.type === 'scoped_identifier',
      );
      if (!scopedId) continue;

      const fullPath = scopedId.text;
      const parts = fullPath.split('.');
      const lastName = parts[parts.length - 1] ?? fullPath;

      imports.push({
        filePath,
        localName: lastName === '*' ? fullPath : lastName,
        sourceModule: fullPath,
        originalName: lastName,
      });
    }
  }

  /**
   * Extract Go imports.
   * Handles: import "fmt"
   *          import ( "fmt" )
   *          import alias "package/path"
   */
  private extractGoImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    this.traverseNode(rootNode, (node) => {
      if (node.type !== 'import_spec') return;

      const pathNode = child_by_type(node, 'interpreted_string_literal');
      if (!pathNode) return;

      const importPath = pathNode.text.replace(/"/g, '');
      const parts = importPath.split('/');
      const defaultName = parts[parts.length - 1] ?? importPath;

      // Check for alias: import alias "path"
      const nameNode = child_by_type(node, 'package_identifier');
      const localName = nameNode?.text ?? defaultName;

      imports.push({
        filePath,
        localName,
        sourceModule: importPath,
        originalName: '*',
      });
    });
  }

  /**
   * Extract Rust use imports.
   * Handles: use std::collections::HashMap;
   *          use crate::module::Type;
   *          use super::foo;
   */
  private extractRustImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    this.traverseNode(rootNode, (node) => {
      if (node.type !== 'use_declaration') return;

      // Extract use path text and get last segment as local name
      const pathText = node.text
        .replace(/^(pub\s+)?use\s+/, '')
        .replace(/;$/, '')
        .trim();

      // Handle simple path: use crate::foo::Bar;
      const parts = pathText.split('::');
      const lastName = parts[parts.length - 1] ?? pathText;

      // Handle "as" alias
      if (lastName.includes(' as ')) {
        const [original, alias] = lastName.split(' as ').map((s) => s.trim());
        if (original && alias) {
          imports.push({
            filePath,
            localName: alias,
            sourceModule: pathText.replace(/ as .*$/, ''),
            originalName: original,
          });
        }
      } else if (!lastName.includes('{') && !lastName.includes('*')) {
        // Simple use: use foo::Bar;
        imports.push({
          filePath,
          localName: lastName,
          sourceModule: pathText,
          originalName: lastName,
        });
      }
      // Grouped uses { A, B } and glob * are complex — skip for now
    });
  }

  /**
   * Extract Ruby require imports.
   * Handles: require 'foo'
   *          require_relative 'foo'
   */
  private extractRubyImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    this.traverseNode(rootNode, (node) => {
      if (node.type !== 'call') return;

      const method = child_by_type(node, 'identifier');
      if (
        !method ||
        (method.text !== 'require' && method.text !== 'require_relative')
      )
        return;

      const args = child_by_type(node, 'argument_list');
      if (!args) return;

      const strNode = args.children.find(
        (c) => c?.type === 'string' || c?.type === 'string_content',
      );
      if (!strNode) return;

      // Strip quotes and string wrappers
      const sourceModule = strNode.text.replace(/['"]/g, '');
      const parts = sourceModule.split('/');
      const localName = parts[parts.length - 1] ?? sourceModule;

      imports.push({
        filePath,
        localName,
        sourceModule,
        originalName: '*',
        resolvedPath:
          method.text === 'require_relative'
            ? this.resolveRubyRelativeRequire(sourceModule, filePath)
            : undefined,
      });
    });
  }

  /**
   * Extract C# using imports.
   * Handles: using System.Collections.Generic;
   */
  private extractCSharpImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    for (const child of rootNode.children) {
      if (!child || child.type !== 'using_directive') continue;

      const nameNode = child.children.find(
        (c) =>
          c?.type === 'qualified_name' ||
          c?.type === 'identifier' ||
          c?.type === 'name',
      );
      if (!nameNode) continue;

      const fullPath = nameNode.text;
      const parts = fullPath.split('.');
      const lastName = parts[parts.length - 1] ?? fullPath;

      imports.push({
        filePath,
        localName: lastName,
        sourceModule: fullPath,
        originalName: '*',
      });
    }
  }

  /**
   * Extract PHP use imports.
   * Handles: use App\Models\User;
   *          use App\Models\User as AppUser;
   */
  private extractPhpImports(
    rootNode: SyntaxNode,
    filePath: string,
    imports: ImportMapping[],
  ): void {
    this.traverseNode(rootNode, (node) => {
      if (node.type !== 'use_declaration') return;

      for (const clause of node.children) {
        if (!clause || clause.type !== 'use_clause') continue;

        const nameNode = clause.children.find(
          (c) => c?.type === 'qualified_name' || c?.type === 'name',
        );
        if (!nameNode) continue;

        const fullPath = nameNode.text;
        const parts = fullPath.split('\\');
        const lastName = parts[parts.length - 1] ?? fullPath;

        // Check for alias: use Foo as Bar
        const aliasNode = clause.children.find(
          (c) => c?.type === 'name' && c !== nameNode,
        );

        imports.push({
          filePath,
          localName: aliasNode?.text ?? lastName,
          sourceModule: fullPath,
          originalName: lastName,
        });
      }
    });
  }

  /**
   * Resolve a Ruby require_relative path.
   */
  private resolveRubyRelativeRequire(
    sourceModule: string,
    fromFilePath: string,
  ): string | undefined {
    const dir = path.dirname(fromFilePath);
    const basePath = path.normalize(path.join(dir, sourceModule));
    const candidate = basePath + '.rb';
    const absolutePath = path.join(this.projectRoot, candidate);
    try {
      if (fs.existsSync(absolutePath)) {
        return candidate;
      }
    } catch {
      // Ignore
    }
    return basePath + '.rb';
  }

  // ===== Step 3: Build Symbols =====

  /**
   * Build SymbolDefinition[] from definition tags.
   */
  private buildSymbols(
    defTags: RawTag[],
    filePath: string,
    content: string,
  ): SymbolDefinition[] {
    const symbols: SymbolDefinition[] = [];
    const lines = content.split('\n');
    const seen = new Set<string>();

    for (const tag of defTags) {
      const symbolType = this.categoryToSymbolType(tag.category);
      if (!symbolType) continue;

      // Build qualified name: for methods inside a class, prefix with class name
      const qualifiedName = tag.name; // Will be refined in addContainsEdges
      const id = `${filePath}#${qualifiedName}`;

      // Deduplicate (same name at same position)
      const dedupeKey = `${id}:${tag.startLine}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Extract signature (first line of the definition)
      const sigLine = lines[tag.startLine - 1];
      const signature = sigLine?.trim().substring(0, MAX_SIGNATURE_LENGTH);

      symbols.push({
        id,
        name: tag.name,
        qualifiedName,
        type: symbolType,
        filePath,
        startLine: tag.startLine,
        endLine: tag.endLine,
        signature,
        exported: false, // Will be marked in markExports step
      });
    }

    return symbols;
  }

  /**
   * Map tag category to SymbolType.
   */
  private categoryToSymbolType(category: string): SymbolType | null {
    switch (category) {
      case 'function':
        return 'function';
      case 'method':
        return 'method';
      case 'class':
        return 'class';
      case 'interface':
        return 'interface';
      case 'type':
        return 'type';
      case 'variable':
        return 'variable';
      default:
        return null;
    }
  }

  // ===== Step 4: Mark Exports =====

  /**
   * Scan for export statements and mark exported symbols.
   */
  private markExports(
    rootNode: SyntaxNode,
    symbols: SymbolDefinition[],
    language: SupportedLanguage,
  ): void {
    if (
      language === 'typescript' ||
      language === 'tsx' ||
      language === 'javascript' ||
      language === 'jsx'
    ) {
      // Build a line-to-symbol lookup
      const lineToSymbol = new Map<number, SymbolDefinition>();
      for (const sym of symbols) {
        lineToSymbol.set(sym.startLine, sym);
      }

      this.traverseNode(rootNode, (node) => {
        if (node.type === 'export_statement') {
          // export function foo / export class Foo / export default
          const declaration = node.children.find(
            (c) =>
              c &&
              (c.type === 'function_declaration' ||
                c.type === 'class_declaration' ||
                c.type === 'abstract_class_declaration' ||
                c.type === 'interface_declaration' ||
                c.type === 'type_alias_declaration' ||
                c.type === 'enum_declaration' ||
                c.type === 'lexical_declaration'),
          );

          if (declaration) {
            const declLine = declaration.startPosition.row + 1;
            const sym = lineToSymbol.get(declLine);
            if (sym) {
              sym.exported = true;
            }
          }
        }
      });
    } else if (language === 'python') {
      // In Python, top-level definitions are considered "exported"
      for (const sym of symbols) {
        // Check if the symbol's definition is at the top level (direct child of module)
        for (const child of rootNode.children) {
          if (!child) continue;
          const childLine = child.startPosition.row + 1;
          if (
            childLine === sym.startLine &&
            (child.type === 'function_definition' ||
              child.type === 'class_definition')
          ) {
            sym.exported = true;
          }
          // Also handle decorated definitions
          if (child.type === 'decorated_definition') {
            const innerDef = child.children.find(
              (c) =>
                c &&
                (c.type === 'function_definition' ||
                  c.type === 'class_definition'),
            );
            if (innerDef && innerDef.startPosition.row + 1 === sym.startLine) {
              sym.exported = true;
            }
          }
        }
      }
    } else if (language === 'go') {
      // Go: exported names start with an uppercase letter
      for (const sym of symbols) {
        if (sym.name.length > 0 && sym.name[0]! >= 'A' && sym.name[0]! <= 'Z') {
          sym.exported = true;
        }
      }
    } else if (language === 'rust') {
      // Rust: items preceded by `pub` keyword are exported
      this.traverseNode(rootNode, (node) => {
        if (
          node.type === 'visibility_modifier' &&
          node.text.startsWith('pub')
        ) {
          const parent = node.parent;
          if (parent) {
            const parentLine = parent.startPosition.row + 1;
            for (const sym of symbols) {
              if (sym.startLine === parentLine) {
                sym.exported = true;
              }
            }
          }
        }
      });
    } else if (language === 'java' || language === 'csharp') {
      // Java/C#: items with public/protected modifiers are exported
      for (const sym of symbols) {
        // Find the AST node at the symbol's start line and check modifiers
        for (const child of rootNode.children) {
          if (!child) continue;
          this.traverseNode(child, (node) => {
            const nodeLine = node.startPosition.row + 1;
            if (nodeLine !== sym.startLine) return;
            // Check for public modifier in the node text
            const text = node.text.substring(0, 100);
            if (text.startsWith('public ') || text.includes(' public ')) {
              sym.exported = true;
            }
          });
        }
      }
    } else if (
      language === 'ruby' ||
      language === 'php' ||
      language === 'c' ||
      language === 'cpp'
    ) {
      // Ruby/PHP: all top-level definitions are considered exported
      // C/C++: header declarations are effectively exported (heuristic)
      for (const sym of symbols) {
        for (const child of rootNode.children) {
          if (!child) continue;
          const childLine = child.startPosition.row + 1;
          if (childLine === sym.startLine) {
            sym.exported = true;
          }
        }
      }
    }
  }

  // ===== Step 5: Build Edges from References =====

  /**
   * Build SymbolEdge[] by resolving references to their target definitions.
   */
  private buildEdges(
    refTags: RawTag[],
    symbols: SymbolDefinition[],
    imports: ImportMapping[],
    filePath: string,
  ): SymbolEdge[] {
    const edges: SymbolEdge[] = [];
    const seen = new Set<string>();

    // Build lookup structures
    const importsByLocalName = new Map<string, ImportMapping>();
    for (const imp of imports) {
      importsByLocalName.set(imp.localName, imp);
    }

    // Build same-file symbol lookup by name
    const sameFileSymbolsByName = new Map<string, SymbolDefinition>();
    for (const sym of symbols) {
      sameFileSymbolsByName.set(sym.name, sym);
    }

    // Map each reference to its containing definition
    for (const ref of refTags) {
      const containingSymbol = this.findContainingSymbol(ref.line, symbols);

      // Source: the containing function/method, or file-level module
      const sourceId = containingSymbol?.id ?? filePath;

      // Resolve target — memberObject is passed through so resolveReference
      // can look up the import table and produce a module-scoped placeholder.
      const targetId = this.resolveReference(
        ref,
        filePath,
        importsByLocalName,
        sameFileSymbolsByName,
      );

      if (!targetId) continue;

      // Determine edge type from reference category
      const edgeType: EdgeType = ref.category === 'type' ? 'EXTENDS' : 'CALLS';

      // Deduplicate
      const edgeKey = `${sourceId}->${targetId}:${edgeType}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      edges.push({
        sourceId,
        targetId,
        type: edgeType,
        filePath,
        line: ref.line,
      });
    }

    return edges;
  }

  /**
   * Find the innermost symbol definition that contains the given line.
   */
  private findContainingSymbol(
    line: number,
    symbols: SymbolDefinition[],
  ): SymbolDefinition | null {
    let best: SymbolDefinition | null = null;
    let bestSize = Infinity;

    for (const sym of symbols) {
      if (line >= sym.startLine && line <= sym.endLine) {
        const size = sym.endLine - sym.startLine;
        if (size < bestSize) {
          best = sym;
          bestSize = size;
        }
      }
    }

    return best;
  }

  /**
   * Resolve a reference to a target symbol ID.
   *
   * Placeholder format for deferred (cross-file) resolution:
   *
   *   `?#name`              — direct call / unscoped reference.
   *                           resolveEdgesByName matches by symbol name globally.
   *
   *   `?sourceModule#name`  — member-access call where the object was imported
   *                           from `sourceModule`. resolveEdgesByName restricts
   *                           matching to symbols in files that `sourceModule`
   *                           maps to, preventing false global matches.
   *
   * This design is **language-agnostic**: every language's import statement
   * has a source string, and that string is used as-is without any module
   * resolution, filesystem probing, or language-specific path alias handling.
   */
  private resolveReference(
    ref: RawTag,
    filePath: string,
    importsByLocalName: Map<string, ImportMapping>,
    sameFileSymbolsByName: Map<string, SymbolDefinition>,
  ): string | null {
    const { name: refName, memberObject } = ref;

    // === Direct call (no member expression) ===
    if (!memberObject) {
      return this.resolveDirectName(
        refName,
        filePath,
        importsByLocalName,
        sameFileSymbolsByName,
      );
    }

    // === Member-access call (obj.method()) ===

    // this.method() / super.method() → same-file only
    if (memberObject === 'this' || memberObject === 'super') {
      const sameFileSym = sameFileSymbolsByName.get(refName);
      if (sameFileSym) return sameFileSym.id;
      return null;
    }

    // Check if the object name was imported
    const imp = importsByLocalName.get(memberObject);
    if (imp) {
      // Produce a module-scoped placeholder: `?sourceModule#method`
      // resolveEdgesByName will use sourceModule to narrow the search
      // to symbols in the imported module's file(s).
      return `?${imp.sourceModule}#${refName}`;
    }

    // Object is not imported — it's a local variable, function return value,
    // or otherwise unresolvable without type information. Drop to avoid
    // false-positive global matches on the bare method name.
    return null;
  }

  /**
   * Resolve a direct name reference (no member expression).
   * Used for both CALLS edges (direct calls) and heritage (extends/implements).
   *
   * Resolution priority:
   *   1. Same-file definition → immediate
   *   2. Imported name → deferred `?#originalName`
   *   3. Unknown name → deferred `?#refName`
   */
  private resolveDirectName(
    refName: string,
    filePath: string,
    importsByLocalName: Map<string, ImportMapping>,
    sameFileSymbolsByName: Map<string, SymbolDefinition>,
  ): string | null {
    // 1. Same-file definition
    const sameFileSym = sameFileSymbolsByName.get(refName);
    if (sameFileSym) return sameFileSym.id;

    // 2. Imported name → defer to global resolution
    const imp = importsByLocalName.get(refName);
    if (imp) {
      const targetName =
        imp.originalName === 'default' || imp.originalName === '*'
          ? refName
          : imp.originalName;
      return `?#${targetName}`;
    }

    // 3. Unresolved name → defer to global resolution
    return `?#${refName}`;
  }

  // ===== Step 6: CONTAINS Edges =====

  /**
   * Add CONTAINS edges: class → method/function contained within.
   * Also update method qualified names to "ClassName.methodName".
   */
  private addContainsEdges(
    symbols: SymbolDefinition[],
    edges: SymbolEdge[],
    filePath: string,
  ): void {
    // Find class symbols
    const classes = symbols.filter(
      (s) => s.type === 'class' || s.type === 'interface',
    );

    // Find methods/functions that are contained within a class
    for (const cls of classes) {
      for (const sym of symbols) {
        if (sym === cls || sym.type === 'class' || sym.type === 'interface')
          continue;

        // Check if sym is within the class's line range
        if (sym.startLine > cls.startLine && sym.endLine <= cls.endLine) {
          // Update qualified name and ID before any edges reference them
          sym.qualifiedName = `${cls.name}.${sym.name}`;
          sym.id = `${filePath}#${sym.qualifiedName}`;

          // Add CONTAINS edge
          edges.push({
            sourceId: cls.id,
            targetId: sym.id,
            type: 'CONTAINS',
            filePath,
          });
        }
      }
    }
  }

  // ===== Step 7: Heritage (extends / implements) =====

  /**
   * Extract EXTENDS and IMPLEMENTS edges from class declarations.
   */
  private extractHeritage(
    rootNode: SyntaxNode,
    symbols: SymbolDefinition[],
    imports: ImportMapping[],
    edges: SymbolEdge[],
    filePath: string,
    language: SupportedLanguage,
  ): void {
    const importsByLocalName = new Map<string, ImportMapping>();
    for (const imp of imports) {
      importsByLocalName.set(imp.localName, imp);
    }
    const sameFileSymbolsByName = new Map<string, SymbolDefinition>();
    for (const sym of symbols) {
      sameFileSymbolsByName.set(sym.name, sym);
    }

    this.traverseNode(rootNode, (node) => {
      // TypeScript/JavaScript: class Foo extends Bar implements Baz
      if (
        (node.type === 'class_declaration' ||
          node.type === 'abstract_class_declaration') &&
        (language === 'typescript' ||
          language === 'tsx' ||
          language === 'javascript' ||
          language === 'jsx')
      ) {
        const className = node.childForFieldName('name')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) => s.name === className && s.type === 'class',
        );
        if (!classSymbol) return;

        for (const child of node.children) {
          if (!child) continue;

          // extends clause
          if (child.type === 'class_heritage') {
            for (const heritageChild of child.children) {
              if (!heritageChild) continue;
              if (heritageChild.type === 'extends_clause') {
                // Get the type being extended
                const extendedType =
                  this.extractHeritageTypeName(heritageChild);
                if (extendedType) {
                  const targetId = this.resolveDirectName(
                    extendedType,
                    filePath,
                    importsByLocalName,
                    sameFileSymbolsByName,
                  );
                  if (targetId) {
                    edges.push({
                      sourceId: classSymbol.id,
                      targetId,
                      type: 'EXTENDS',
                      filePath,
                      line: heritageChild.startPosition.row + 1,
                    });
                  }
                }
              } else if (heritageChild.type === 'implements_clause') {
                // Get all implemented types
                for (const typeNode of heritageChild.children) {
                  if (!typeNode) continue;
                  const typeName = this.extractTypeName(typeNode);
                  if (typeName) {
                    const targetId = this.resolveDirectName(
                      typeName,
                      filePath,
                      importsByLocalName,
                      sameFileSymbolsByName,
                    );
                    if (targetId) {
                      edges.push({
                        sourceId: classSymbol.id,
                        targetId,
                        type: 'IMPLEMENTS',
                        filePath,
                        line: typeNode.startPosition.row + 1,
                      });
                    }
                  }
                }
              }
            }
          }

          // Direct extends/implements clause (some grammars)
          if (child.type === 'extends_clause') {
            const extendedType = this.extractHeritageTypeName(child);
            if (extendedType) {
              const targetId = this.resolveDirectName(
                extendedType,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: 'EXTENDS',
                  filePath,
                  line: child.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      // Python: class Foo(Bar, Baz):
      if (node.type === 'class_definition' && language === 'python') {
        const className = node.childForFieldName('name')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) => s.name === className && s.type === 'class',
        );
        if (!classSymbol) return;

        const argList =
          node.childForFieldName('superclasses') ??
          node.children.find((c) => c?.type === 'argument_list');
        if (argList) {
          for (const arg of argList.children) {
            if (
              !arg ||
              arg.type === '(' ||
              arg.type === ')' ||
              arg.type === ','
            )
              continue;
            const baseName =
              arg.type === 'identifier'
                ? arg.text
                : arg.type === 'attribute'
                  ? arg.children.find((c) => c?.type === 'identifier')?.text
                  : null;
            if (baseName) {
              const targetId = this.resolveDirectName(
                baseName,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: 'EXTENDS',
                  filePath,
                  line: arg.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      // Java: class Foo extends Bar implements Baz
      if (node.type === 'class_declaration' && language === 'java') {
        const className = node.childForFieldName('name')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) =>
            s.name === className &&
            (s.type === 'class' || s.type === 'interface'),
        );
        if (!classSymbol) return;

        // superclass: extends clause
        const superclass = child_by_type(node, 'superclass');
        if (superclass) {
          const typeName = child_by_type(superclass, 'type_identifier')?.text;
          if (typeName) {
            const targetId = this.resolveDirectName(
              typeName,
              filePath,
              importsByLocalName,
              sameFileSymbolsByName,
            );
            if (targetId) {
              edges.push({
                sourceId: classSymbol.id,
                targetId,
                type: 'EXTENDS',
                filePath,
                line: superclass.startPosition.row + 1,
              });
            }
          }
        }

        // interfaces: implements clause
        const interfaces = child_by_type(node, 'super_interfaces');
        if (interfaces) {
          const typeList = child_by_type(interfaces, 'type_list');
          if (typeList) {
            for (const typeNode of typeList.children) {
              if (!typeNode || typeNode.type !== 'type_identifier') continue;
              const targetId = this.resolveDirectName(
                typeNode.text,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: 'IMPLEMENTS',
                  filePath,
                  line: typeNode.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      // C#: class Foo : Bar, IBaz
      if (node.type === 'class_declaration' && language === 'csharp') {
        const className = node.childForFieldName('name')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) =>
            s.name === className &&
            (s.type === 'class' || s.type === 'interface'),
        );
        if (!classSymbol) return;

        const baseList = child_by_type(node, 'base_list');
        if (baseList) {
          for (const baseType of baseList.children) {
            if (!baseType) continue;
            const typeName =
              baseType.type === 'identifier'
                ? baseType.text
                : child_by_type(baseType, 'identifier')?.text;
            if (typeName) {
              const isInterface =
                typeName.startsWith('I') &&
                typeName.length > 1 &&
                typeName[1]! >= 'A' &&
                typeName[1]! <= 'Z';
              const targetId = this.resolveDirectName(
                typeName,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: isInterface ? 'IMPLEMENTS' : 'EXTENDS',
                  filePath,
                  line: baseType.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      // C++: class Foo : public Bar
      if (node.type === 'class_specifier' && language === 'cpp') {
        const className = child_by_type(node, 'type_identifier')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) => s.name === className && s.type === 'class',
        );
        if (!classSymbol) return;

        const baseList = child_by_type(node, 'base_class_clause');
        if (baseList) {
          for (const base of baseList.children) {
            if (!base) continue;
            const typeName =
              base.type === 'type_identifier'
                ? base.text
                : child_by_type(base, 'type_identifier')?.text;
            if (typeName) {
              const targetId = this.resolveDirectName(
                typeName,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: 'EXTENDS',
                  filePath,
                  line: base.startPosition.row + 1,
                });
              }
            }
          }
        }
      }

      // Ruby: class Foo < Bar
      if (node.type === 'class' && language === 'ruby') {
        const className = child_by_type(node, 'constant')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) => s.name === className && s.type === 'class',
        );
        if (!classSymbol) return;

        const superclass = child_by_type(node, 'superclass');
        if (superclass) {
          const baseName = child_by_type(superclass, 'constant')?.text;
          if (baseName) {
            const targetId = this.resolveDirectName(
              baseName,
              filePath,
              importsByLocalName,
              sameFileSymbolsByName,
            );
            if (targetId) {
              edges.push({
                sourceId: classSymbol.id,
                targetId,
                type: 'EXTENDS',
                filePath,
                line: superclass.startPosition.row + 1,
              });
            }
          }
        }
      }

      // PHP: class Foo extends Bar implements Baz
      if (node.type === 'class_declaration' && language === 'php') {
        const className = child_by_type(node, 'name')?.text;
        if (!className) return;
        const classSymbol = symbols.find(
          (s) => s.name === className && s.type === 'class',
        );
        if (!classSymbol) return;

        const baseClause = child_by_type(node, 'base_clause');
        if (baseClause) {
          const baseName =
            child_by_type(baseClause, 'name')?.text ??
            child_by_type(baseClause, 'qualified_name')?.text;
          if (baseName) {
            const parts = baseName.split('\\');
            const targetId = this.resolveDirectName(
              parts[parts.length - 1]!,
              filePath,
              importsByLocalName,
              sameFileSymbolsByName,
            );
            if (targetId) {
              edges.push({
                sourceId: classSymbol.id,
                targetId,
                type: 'EXTENDS',
                filePath,
                line: baseClause.startPosition.row + 1,
              });
            }
          }
        }

        const interfaceClause = child_by_type(node, 'class_interface_clause');
        if (interfaceClause) {
          for (const iface of interfaceClause.children) {
            if (!iface) continue;
            const ifaceName =
              iface.type === 'name' || iface.type === 'qualified_name'
                ? iface.text
                : null;
            if (ifaceName) {
              const parts = ifaceName.split('\\');
              const targetId = this.resolveDirectName(
                parts[parts.length - 1]!,
                filePath,
                importsByLocalName,
                sameFileSymbolsByName,
              );
              if (targetId) {
                edges.push({
                  sourceId: classSymbol.id,
                  targetId,
                  type: 'IMPLEMENTS',
                  filePath,
                  line: iface.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
    });
  }

  /**
   * Extract the type name from a heritage clause node.
   */
  private extractHeritageTypeName(node: SyntaxNode): string | null {
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === 'identifier' || child.type === 'type_identifier') {
        return child.text;
      }
      if (child.type === 'generic_type') {
        // Get the base type from generic: Foo<T> → Foo
        const nameNode = child.children.find(
          (c) => c && (c.type === 'identifier' || c.type === 'type_identifier'),
        );
        return nameNode?.text ?? null;
      }
    }
    return null;
  }

  /**
   * Extract a simple type name from a type node.
   */
  private extractTypeName(node: SyntaxNode): string | null {
    if (node.type === 'identifier' || node.type === 'type_identifier') {
      return node.text;
    }
    if (node.type === 'generic_type') {
      const nameNode = node.children.find(
        (c) => c && (c.type === 'identifier' || c.type === 'type_identifier'),
      );
      return nameNode?.text ?? null;
    }
    return null;
  }

  // ===== Step 8: File-level Import Edges =====

  /**
   * Add file-level IMPORTS edges for each import statement.
   */
  private addFileImportEdges(
    imports: ImportMapping[],
    edges: SymbolEdge[],
    filePath: string,
  ): void {
    const seen = new Set<string>();

    for (const imp of imports) {
      if (!imp.resolvedPath) continue;
      const edgeKey = `${filePath}->${imp.resolvedPath}:IMPORTS`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      edges.push({
        sourceId: filePath,
        targetId: imp.resolvedPath,
        type: 'IMPORTS',
        filePath,
      });
    }
  }

  // ===== Module Path Resolution =====

  /**
   * Resolve a JS/TS module path to a file path.
   * Only resolves relative paths (./foo, ../bar). Non-relative imports
   * (bare specifiers like 'lodash', '@myorg/shared') return undefined —
   * their cross-file edges are handled via the `?sourceModule#name`
   * placeholder format in resolveEdgesByName.
   */
  private resolveModulePath(
    sourceModule: string,
    fromFilePath: string,
  ): string | undefined {
    // Only resolve relative imports
    if (!sourceModule.startsWith('.')) {
      return undefined;
    }

    const dir = path.dirname(fromFilePath);
    const basePath = path.normalize(path.join(dir, sourceModule));

    // Try common extensions
    const extensions = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx',
    ];

    for (const ext of extensions) {
      const candidate = basePath + ext;
      const absolutePath = path.join(this.projectRoot, candidate);
      try {
        if (fs.existsSync(absolutePath)) {
          return candidate;
        }
      } catch {
        // Continue
      }
    }

    // If base path already has extension
    const absoluteBase = path.join(this.projectRoot, basePath);
    try {
      if (fs.existsSync(absoluteBase)) {
        return basePath;
      }
    } catch {
      // Ignore
    }

    // Return unresolved but normalized path
    return basePath;
  }

  /**
   * Resolve a Python module path.
   */
  private resolvePythonModule(
    sourceModule: string,
    fromFilePath: string,
  ): string | undefined {
    // Handle relative imports (starting with dots)
    if (sourceModule.startsWith('.')) {
      const dotCount = sourceModule.match(/^\.+/)?.[0].length ?? 0;
      let dir = path.dirname(fromFilePath);
      for (let i = 1; i < dotCount; i++) {
        dir = path.dirname(dir);
      }
      const modulePart = sourceModule.substring(dotCount);
      const modulePath = modulePart
        ? path.join(dir, modulePart.replace(/\./g, '/'))
        : dir;

      // Try .py extension and __init__.py
      const candidates = [
        modulePath + '.py',
        path.join(modulePath, '__init__.py'),
      ];

      for (const candidate of candidates) {
        const absolutePath = path.join(this.projectRoot, candidate);
        try {
          if (fs.existsSync(absolutePath)) {
            return candidate;
          }
        } catch {
          // Continue
        }
      }

      return modulePath + '.py';
    }

    // Absolute module — not resolved (external package)
    return undefined;
  }

  // ===== Utility =====

  /**
   * Traverse the AST tree depth-first.
   */
  private traverseNode(
    node: SyntaxNode,
    callback: (node: SyntaxNode) => void,
  ): void {
    callback(node);
    for (const child of node.children) {
      if (child) {
        this.traverseNode(child, callback);
      }
    }
  }
}
