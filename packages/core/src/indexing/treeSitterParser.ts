/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Parser, Language, type Node, type Tree } from 'web-tree-sitter';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Re-export types for convenience
export type SyntaxNode = Node;
export type { Language, Parser, Tree } from 'web-tree-sitter';

/**
 * Supported languages for AST parsing.
 */
export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python';

/**
 * Language configuration for tree-sitter.
 */
interface LanguageConfig {
  wasmPackage: string;
  wasmFile: string;
}

/**
 * Mapping from language to wasm configuration.
 */
const LANGUAGE_CONFIG: Record<SupportedLanguage, LanguageConfig> = {
  typescript: {
    wasmPackage: 'tree-sitter-typescript',
    wasmFile: 'tree-sitter-typescript.wasm',
  },
  tsx: {
    wasmPackage: 'tree-sitter-typescript',
    wasmFile: 'tree-sitter-tsx.wasm',
  },
  javascript: {
    wasmPackage: 'tree-sitter-javascript',
    wasmFile: 'tree-sitter-javascript.wasm',
  },
  jsx: {
    wasmPackage: 'tree-sitter-javascript',
    wasmFile: 'tree-sitter-javascript.wasm',
  },
  python: {
    wasmPackage: 'tree-sitter-python',
    wasmFile: 'tree-sitter-python.wasm',
  },
};

/**
 * Cache for loaded language parsers.
 */
const languageCache = new Map<SupportedLanguage, Language>();

/**
 * Whether tree-sitter has been initialized.
 */
let initialized = false;

/**
 * Initializes the tree-sitter WebAssembly runtime.
 * This must be called before any parsing operations.
 */
export async function initTreeSitter(): Promise<void> {
  if (initialized) return;

  await Parser.init();
  initialized = true;
}

/**
 * Resolves the path to a language wasm file.
 *
 * Walks up from the current file's directory looking for
 * `node_modules/<package>/<file>.wasm`. This works regardless of how the
 * code is loaded (main CLI bundle, worker bundle, transpiled, or source).
 */
function resolveWasmPath(config: LanguageConfig): string {
  const relTarget = path.join(
    'node_modules',
    config.wasmPackage,
    config.wasmFile,
  );

  let dir = __dirname;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, relTarget);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }

  // Fallback — return a best-guess path for a clear error message
  return path.join(__dirname, relTarget);
}

/**
 * Loads a language for tree-sitter parsing.
 *
 * @param language - The language to load
 * @returns The loaded language
 */
export async function loadLanguage(
  language: SupportedLanguage,
): Promise<Language> {
  // Check cache first
  const cached = languageCache.get(language);
  if (cached) return cached;

  // Ensure initialized
  await initTreeSitter();

  // Get configuration
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    throw new Error(`Unsupported language: ${language}`);
  }

  // Load the language
  const wasmPath = resolveWasmPath(config);
  const lang = await Language.load(wasmPath);

  // Cache it
  languageCache.set(language, lang);

  return lang;
}

/**
 * Creates a parser for the specified language.
 *
 * @param language - The language to parse
 * @returns A configured parser
 */
export async function createParser(
  language: SupportedLanguage,
): Promise<Parser> {
  await initTreeSitter();

  const parser = new Parser();
  const lang = await loadLanguage(language);
  parser.setLanguage(lang);

  return parser;
}

/**
 * Detects the tree-sitter language from a file path.
 *
 * @param filepath - The file path
 * @returns The detected language or null if unsupported
 */
export function detectTreeSitterLanguage(
  filepath: string,
): SupportedLanguage | null {
  const ext = path.extname(filepath).toLowerCase();

  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.py':
    case '.pyi':
    case '.pyw':
      return 'python';
    default:
      return null;
  }
}

/**
 * Checks if a language is supported for AST parsing.
 */
export function isLanguageSupported(language: string): boolean {
  return language in LANGUAGE_CONFIG;
}

/**
 * Gets all supported languages.
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return Object.keys(LANGUAGE_CONFIG) as SupportedLanguage[];
}

/**
 * Result of parsing a file.
 */
export interface ParseResult {
  /** The parsed AST tree. */
  tree: Tree;
  /** The detected language. */
  language: SupportedLanguage;
}

/**
 * Parses file content and returns the AST tree.
 * This is the shared entry point for AST parsing to avoid duplicate parsing.
 *
 * @param filepath - The file path (used for language detection)
 * @param content - The file content to parse
 * @returns ParseResult with tree and language, or null if language not supported or parsing failed
 */
export async function parseFile(
  filepath: string,
  content: string,
): Promise<ParseResult | null> {
  const language = detectTreeSitterLanguage(filepath);
  if (!language) {
    return null;
  }

  try {
    const parser = await createParser(language);
    const tree = parser.parse(content);

    if (!tree || !tree.rootNode || tree.rootNode.childCount === 0) {
      return null;
    }

    return { tree, language };
  } catch (error) {
    console.warn(`AST parsing failed for ${filepath}: ${error}`);
    return null;
  }
}
