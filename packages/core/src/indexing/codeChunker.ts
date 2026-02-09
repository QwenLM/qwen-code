/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This implementation is adapted from Continue's code chunker.
 * Original source: https://github.com/continuedev/continue/blob/main/core/indexing/chunk/code.ts
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * Chunk without ID (ID is assigned later).
 */
export interface ChunkWithoutID {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Simple token counter (rough estimate: 1 token ≈ 4 characters).
 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Gets the collapsed replacement string for a node type.
 */
function collapsedReplacement(node: SyntaxNode): string {
  if (node.type === 'statement_block') {
    return '{ ... }';
  }
  return '...';
}

/**
 * Finds the first child of a node with the given grammar name.
 */
function firstChild(
  node: SyntaxNode,
  grammarName: string | string[],
): SyntaxNode | null {
  if (Array.isArray(grammarName)) {
    return (
      node.children.find(
        (child): child is SyntaxNode =>
          child !== null && grammarName.includes(child.type),
      ) || null
    );
  }
  return (
    node.children.find(
      (child): child is SyntaxNode =>
        child !== null && child.type === grammarName,
    ) || null
  );
}

/**
 * Collapses children of a node to fit within maxChunkSize.
 */
async function collapseChildren(
  node: SyntaxNode,
  code: string,
  blockTypes: string[],
  collapseTypes: string[],
  collapseBlockTypes: string[],
  maxChunkSize: number,
): Promise<string> {
  code = code.slice(0, node.endIndex);
  const block = firstChild(node, blockTypes);
  const collapsedChildren: string[] = [];

  if (block) {
    const childrenToCollapse = block.children.filter(
      (child): child is SyntaxNode =>
        child !== null && collapseTypes.includes(child.type),
    );
    for (const child of childrenToCollapse.reverse()) {
      const grandChild = firstChild(child, collapseBlockTypes);
      if (grandChild) {
        const start = grandChild.startIndex;
        const end = grandChild.endIndex;
        const collapsedChild =
          code.slice(child.startIndex, start) +
          collapsedReplacement(grandChild);
        code =
          code.slice(0, start) +
          collapsedReplacement(grandChild) +
          code.slice(end);

        collapsedChildren.unshift(collapsedChild);
      }
    }
  }
  code = code.slice(node.startIndex);
  let removedChild = false;
  while (
    countTokens(code.trim()) > maxChunkSize &&
    collapsedChildren.length > 0
  ) {
    removedChild = true;
    // Remove children starting at the end
    const childCode = collapsedChildren.pop()!;
    const index = code.lastIndexOf(childCode);
    if (index > 0) {
      code = code.slice(0, index) + code.slice(index + childCode.length);
    }
  }

  if (removedChild) {
    // Remove the extra blank lines
    let lines = code.split('\n');
    let firstWhiteSpaceInGroup = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === '') {
        if (firstWhiteSpaceInGroup < 0) {
          firstWhiteSpaceInGroup = i;
        }
      } else {
        if (firstWhiteSpaceInGroup - i > 1) {
          // Remove the lines
          lines = [
            ...lines.slice(0, i + 1),
            ...lines.slice(firstWhiteSpaceInGroup + 1),
          ];
        }
        firstWhiteSpaceInGroup = -1;
      }
    }

    code = lines.join('\n');
  }

  return code;
}

/**
 * Block node types for functions.
 */
export const FUNCTION_BLOCK_NODE_TYPES = ['block', 'statement_block'];

/**
 * Function declaration node types.
 */
export const FUNCTION_DECLARATION_NODE_TYPES = [
  'method_definition',
  'function_definition',
  'function_item',
  'function_declaration',
  'method_declaration',
];

/**
 * Constructs a collapsed class definition chunk.
 */
async function constructClassDefinitionChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
): Promise<string> {
  return collapseChildren(
    node,
    code,
    ['block', 'class_body', 'declaration_list'],
    FUNCTION_DECLARATION_NODE_TYPES,
    FUNCTION_BLOCK_NODE_TYPES,
    maxChunkSize,
  );
}

/**
 * Constructs a collapsed function definition chunk.
 */
async function constructFunctionDefinitionChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
): Promise<string> {
  const bodyNode = node.children[node.children.length - 1];
  if (!bodyNode) {
    return node.text;
  }

  const collapsedBody = collapsedReplacement(bodyNode);
  const signature = code.slice(node.startIndex, bodyNode.startIndex);
  const funcText = signature + collapsedBody;

  const isInClass =
    node.parent &&
    ['block', 'declaration_list'].includes(node.parent.type) &&
    node.parent.parent &&
    ['class_definition', 'impl_item'].includes(node.parent.parent.type);

  if (isInClass) {
    const classNode = node.parent!.parent!;
    const classBlock = node.parent!;
    const classHeader = code.slice(classNode.startIndex, classBlock.startIndex);
    const indent = ' '.repeat(node.startPosition.column);
    const combined = `${classHeader}...\n\n${indent}${funcText}`;

    if (countTokens(combined) <= maxChunkSize) {
      return combined;
    }
    if (countTokens(funcText) <= maxChunkSize) {
      return funcText;
    }
    const firstLine = signature.split('\n')[0] ?? '';
    const minimal = `${firstLine} ${collapsedBody}`;
    if (countTokens(minimal) <= maxChunkSize) {
      return minimal;
    }
    return collapsedBody;
  }

  if (countTokens(funcText) <= maxChunkSize) {
    return funcText;
  }
  const firstLine = signature.split('\n')[0] ?? '';
  const minimal = `${firstLine} ${collapsedBody}`;
  if (countTokens(minimal) <= maxChunkSize) {
    return minimal;
  }
  return collapsedBody;
}

/**
 * Maximum lines to show before collapsing a comment.
 */
const MAX_COMMENT_LINES = 5;

/**
 * Collapses long comments within content.
 * Processes block comments and consecutive line comments.
 */
function collapseCommentsInContent(content: string): string {
  // Collapse long block comments
  content = content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const lines = match.split('\n');
    if (lines.length <= MAX_COMMENT_LINES) {
      return match;
    }
    const firstLines = lines.slice(0, MAX_COMMENT_LINES - 1);
    return firstLines.join('\n') + '\n * ...\n */';
  });

  // Collapse consecutive line comments (// ...)
  content = content.replace(/(^|\n)([ \t]*\/\/[^\n]*\n){6,}/g, (match) => {
    const lines = match.split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_COMMENT_LINES) {
      return match;
    }
    const firstLines = lines.slice(0, MAX_COMMENT_LINES - 1);
    const indent = lines[0].match(/^(\s*)/)?.[1] || '';
    return '\n' + firstLines.join('\n') + `\n${indent}// ...\n`;
  });

  // Collapse consecutive Python-style comments (# ...)
  content = content.replace(/(^|\n)([ \t]*#[^\n]*\n){6,}/g, (match) => {
    const lines = match.split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_COMMENT_LINES) {
      return match;
    }
    const firstLines = lines.slice(0, MAX_COMMENT_LINES - 1);
    const indent = lines[0].match(/^(\s*)/)?.[1] || '';
    return '\n' + firstLines.join('\n') + `\n${indent}# ...\n`;
  });

  return content;
}

/**
 * Map of node types to their collapsed chunk constructors.
 */
const collapsedNodeConstructors: {
  [key: string]: (
    node: SyntaxNode,
    code: string,
    maxChunkSize: number,
  ) => Promise<string>;
} = {
  // Classes, structs, etc
  class_definition: constructClassDefinitionChunk,
  class_declaration: constructClassDefinitionChunk,
  impl_item: constructClassDefinitionChunk,
  // Functions
  function_definition: constructFunctionDefinitionChunk,
  function_declaration: constructFunctionDefinitionChunk,
  function_item: constructFunctionDefinitionChunk,
  // Methods
  method_declaration: constructFunctionDefinitionChunk,
  method_definition: constructFunctionDefinitionChunk,
};

/**
 * Attempts to yield a chunk if the node fits within maxChunkSize.
 * Applies comment collapsing to reduce chunk size.
 */
async function maybeYieldChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
  root: boolean = true,
): Promise<ChunkWithoutID | undefined> {
  // Keep entire text if not over size
  if (root || node.type in collapsedNodeConstructors) {
    // First try with collapsed comments
    const collapsedContent = collapseCommentsInContent(node.text);
    const tokenCount = countTokens(collapsedContent);
    if (tokenCount < maxChunkSize) {
      return {
        content: collapsedContent,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      };
    }
  }
  return undefined;
}

/**
 * Generates smart collapsed chunks from an AST node.
 *
 * Strategy:
 * 1. If node fits within maxChunkSize, yield it as-is (with collapsed comments)
 * 2. If node has a collapsed form defined, yield the collapsed version
 * 3. Recurse into children to show them in full
 */
async function* getSmartCollapsedChunks(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
  root: boolean = true,
): AsyncGenerator<ChunkWithoutID> {
  const chunk = await maybeYieldChunk(node, code, maxChunkSize, root);
  if (chunk) {
    yield chunk;
    return;
  }

  // If a collapsed form is defined, use that
  if (node.type in collapsedNodeConstructors) {
    const collapsedContent = await collapsedNodeConstructors[node.type](
      node,
      code,
      maxChunkSize,
    );
    yield {
      content: collapseCommentsInContent(collapsedContent),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    };
  }

  // Recurse (because even if collapsed version was shown, want to show the children in full somewhere)
  const generators = node.children
    .filter((child): child is SyntaxNode => child !== null)
    .map((child) => getSmartCollapsedChunks(child, code, maxChunkSize, false));
  for (const generator of generators) {
    yield* generator;
  }
}

/**
 * Main code chunker function.
 *
 * Chunks code using AST-aware smart collapse strategy:
 * - Small nodes are kept intact
 * - Large classes are collapsed with method signatures preserved
 * - Large functions are collapsed to signature + "{ ... }"
 * - Children are recursively processed to ensure nothing is missed
 *
 * @param tree - The parsed AST tree root node
 * @param contents - The full source code
 * @param maxChunkSize - Maximum tokens per chunk
 * @yields ChunkWithoutID objects
 */
export async function* codeChunker(
  tree: SyntaxNode,
  contents: string,
  maxChunkSize: number,
): AsyncGenerator<ChunkWithoutID> {
  if (contents.trim().length === 0) {
    return;
  }

  yield* getSmartCollapsedChunks(tree, contents, maxChunkSize);
}

/**
 * Synchronous version of the code chunker for simpler use cases.
 */
export async function chunkCode(
  tree: SyntaxNode,
  contents: string,
  maxChunkSize: number,
): Promise<ChunkWithoutID[]> {
  const chunks: ChunkWithoutID[] = [];
  for await (const chunk of codeChunker(tree, contents, maxChunkSize)) {
    chunks.push(chunk);
  }
  return chunks;
}
