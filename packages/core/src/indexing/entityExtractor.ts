/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { GraphEntity, GraphRelation, EntityType } from './types.js';
import {
  createParser,
  detectTreeSitterLanguage,
  type SupportedLanguage,
  type SyntaxNode,
  type Parser,
  type Tree,
  type ParseResult,
} from './treeSitterParser.js';

/**
 * Result of entity extraction from a source file.
 */
export interface ExtractionResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/**
 * Node type mappings for different languages.
 */
const NODE_TYPE_MAPPINGS: Record<string, Record<string, EntityType>> = {
  typescript: {
    function_declaration: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
  },
  tsx: {
    function_declaration: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
  },
  javascript: {
    function_declaration: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
  },
  jsx: {
    function_declaration: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
};

/**
 * AST-based entity and relation extractor.
 * Extracts functions, classes, imports, and their relationships.
 */
export class EntityExtractor {
  private parserCache = new Map<SupportedLanguage, Parser>();

  /**
   * Extract entities and relations from a source file.
   *
   * @param filePath - The file path (relative to project root)
   * @param content - The file content
   * @param chunkId - Optional chunk ID to associate with entities
   * @param preParseResult - Optional pre-parsed AST to avoid duplicate parsing
   * @returns Extracted entities and relations
   */
  async extract(
    filePath: string,
    content: string,
    chunkId?: string,
    preParseResult?: ParseResult | null,
  ): Promise<ExtractionResult> {
    // Use pre-parsed AST if provided
    if (preParseResult) {
      return this.extractFromTree(
        filePath,
        content,
        preParseResult.tree,
        preParseResult.language,
        chunkId,
      );
    }

    const language = detectTreeSitterLanguage(filePath);

    // If language not supported, return just the module entity
    if (!language) {
      return this.createModuleOnlyResult(filePath, content);
    }

    try {
      const parser = await this.getParser(language);
      const tree = parser.parse(content);

      if (!tree) {
        return this.createModuleOnlyResult(filePath, content);
      }

      // Check if tree has content
      if (!tree.rootNode || tree.rootNode.childCount === 0) {
        return this.createModuleOnlyResult(filePath, content);
      }

      return this.extractFromTree(filePath, content, tree, language, chunkId);
    } catch (error) {
      console.warn(`Entity extraction failed for ${filePath}: ${error}`);
      return this.createModuleOnlyResult(filePath, content);
    }
  }

  /**
   * Extract entities and relations from a pre-parsed AST tree.
   */
  private extractFromTree(
    filePath: string,
    content: string,
    tree: Tree,
    language: SupportedLanguage,
    chunkId?: string,
  ): ExtractionResult {
    const entities: GraphEntity[] = [];
    const relations: GraphRelation[] = [];

    // Create module entity (the file itself)
    const moduleId = filePath;
    const lineCount = content.split('\n').length;
    entities.push({
      id: moduleId,
      name: path.basename(filePath),
      type: 'module',
      filePath,
      startLine: 1,
      endLine: lineCount,
      chunkId,
    });

    // Traverse AST and extract entities/relations
    this.traverse(tree.rootNode, (node) => {
      this.processNode(
        node,
        filePath,
        moduleId,
        language,
        entities,
        relations,
        content,
        chunkId,
      );
    });

    return { entities, relations };
  }

  /**
   * Creates a result with only the module entity.
   */
  private createModuleOnlyResult(
    filePath: string,
    content: string,
  ): ExtractionResult {
    const lineCount = content.split('\n').length;
    return {
      entities: [
        {
          id: filePath,
          name: path.basename(filePath),
          type: 'module',
          filePath,
          startLine: 1,
          endLine: lineCount,
        },
      ],
      relations: [],
    };
  }

  /**
   * Process a single AST node.
   */
  private processNode(
    node: SyntaxNode,
    filePath: string,
    moduleId: string,
    language: SupportedLanguage,
    entities: GraphEntity[],
    relations: GraphRelation[],
    content: string,
    chunkId?: string,
  ): void {
    // Handle import statements
    if (
      node.type === 'import_statement' ||
      node.type === 'import_from_statement'
    ) {
      const importInfo = this.parseImport(node, filePath, content);
      if (importInfo) {
        // Create external module entity if it doesn't exist in current file scope
        // This ensures the target node exists before creating the edge
        const targetModuleId = importInfo.targetModule;
        const isExternalModule =
          !targetModuleId.startsWith('.') && !targetModuleId.startsWith('/');

        if (isExternalModule) {
          // Add external module as entity (if not already added)
          const existingEntity = entities.find((e) => e.id === targetModuleId);
          if (!existingEntity) {
            entities.push({
              id: targetModuleId,
              name: path.basename(targetModuleId),
              type: 'module',
              filePath: targetModuleId,
              startLine: 0,
              endLine: 0,
              chunkId,
            });
          }
        }

        relations.push({
          sourceId: moduleId,
          targetId: targetModuleId,
          type: 'IMPORTS',
          metadata: { line: node.startPosition.row + 1 },
        });
      }
    }

    // Handle function declarations
    const typeMapping = NODE_TYPE_MAPPINGS[language] || {};
    const entityType = typeMapping[node.type];

    if (entityType === 'function') {
      const funcEntity = this.parseFunction(node, filePath, content, chunkId);
      if (funcEntity) {
        entities.push(funcEntity);
        relations.push({
          sourceId: moduleId,
          targetId: funcEntity.id,
          type: 'CONTAINS',
        });

        // Extract function calls within this function
        this.extractCalls(node, funcEntity.id, relations, content);
      }
    }

    // Handle class declarations
    if (entityType === 'class') {
      const classEntity = this.parseClass(node, filePath, content, chunkId);
      if (classEntity) {
        entities.push(classEntity);
        relations.push({
          sourceId: moduleId,
          targetId: classEntity.id,
          type: 'CONTAINS',
        });

        // Extract inheritance relations
        this.extractInheritance(
          node,
          classEntity.id,
          filePath,
          relations,
          content,
        );

        // Extract implements relations
        this.extractImplements(
          node,
          classEntity.id,
          filePath,
          relations,
          content,
        );

        // Extract methods
        this.extractMethods(
          node,
          classEntity.id,
          filePath,
          entities,
          relations,
          content,
          chunkId,
        );
      }
    }

    // Handle interface declarations
    if (entityType === 'interface') {
      const interfaceEntity = this.parseInterface(
        node,
        filePath,
        content,
        chunkId,
      );
      if (interfaceEntity) {
        entities.push(interfaceEntity);
        relations.push({
          sourceId: moduleId,
          targetId: interfaceEntity.id,
          type: 'CONTAINS',
        });

        // Extract extends relations for interfaces
        this.extractInterfaceExtends(
          node,
          interfaceEntity.id,
          filePath,
          relations,
          content,
        );
      }
    }

    // Handle export statements
    if (node.type === 'export_statement') {
      const exportedName = this.parseExport(node, content);
      if (exportedName) {
        relations.push({
          sourceId: moduleId,
          targetId: `${filePath}#${exportedName}`,
          type: 'EXPORTS',
        });
      }
    }
  }

  /**
   * Traverse the AST tree.
   */
  private traverse(
    node: SyntaxNode,
    callback: (node: SyntaxNode) => void,
  ): void {
    callback(node);
    for (const child of node.children) {
      if (child) {
        this.traverse(child, callback);
      }
    }
  }

  /**
   * Parse an import statement.
   */
  private parseImport(
    node: SyntaxNode,
    filePath: string,
    content: string,
  ): { targetModule: string } | null {
    // Find the source/module string
    let sourceNode: SyntaxNode | null = null;

    // Try different node types for the import source
    for (const child of node.children) {
      if (
        child &&
        (child.type === 'string' || child.type === 'string_literal')
      ) {
        sourceNode = child;
        break;
      }
    }

    // Also try childForFieldName
    if (!sourceNode) {
      sourceNode = node.childForFieldName('source');
    }

    if (!sourceNode) return null;

    // Get the import path, removing quotes
    let importPath = content.slice(sourceNode.startIndex, sourceNode.endIndex);
    importPath = importPath.replace(/['"]/g, '');

    // Resolve relative imports
    if (importPath.startsWith('.')) {
      const dir = path.dirname(filePath);
      importPath = path.normalize(path.join(dir, importPath));
    }

    return { targetModule: importPath };
  }

  /**
   * Parse a function declaration.
   */
  private parseFunction(
    node: SyntaxNode,
    filePath: string,
    content: string,
    chunkId?: string,
  ): GraphEntity | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      // For arrow functions, try to get the variable name
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = parent.childForFieldName('name');
        if (varName) {
          const name = content.slice(varName.startIndex, varName.endIndex);
          return {
            id: `${filePath}#${name}`,
            name,
            type: 'function',
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: this.extractSignature(node, content),
            chunkId,
          };
        }
      }
      return null;
    }

    const name = content.slice(nameNode.startIndex, nameNode.endIndex);
    return {
      id: `${filePath}#${name}`,
      name,
      type: 'function',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: this.extractSignature(node, content),
      chunkId,
    };
  }

  /**
   * Parse a class declaration.
   */
  private parseClass(
    node: SyntaxNode,
    filePath: string,
    content: string,
    chunkId?: string,
  ): GraphEntity | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = content.slice(nameNode.startIndex, nameNode.endIndex);
    return {
      id: `${filePath}#${name}`,
      name,
      type: 'class',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkId,
    };
  }

  /**
   * Parse an interface declaration.
   */
  private parseInterface(
    node: SyntaxNode,
    filePath: string,
    content: string,
    chunkId?: string,
  ): GraphEntity | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = content.slice(nameNode.startIndex, nameNode.endIndex);
    return {
      id: `${filePath}#${name}`,
      name,
      type: 'interface',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkId,
    };
  }

  /**
   * Extract function calls within a function body.
   */
  private extractCalls(
    funcNode: SyntaxNode,
    funcId: string,
    relations: GraphRelation[],
    content: string,
  ): void {
    this.traverse(funcNode, (node) => {
      if (node.type === 'call_expression') {
        const calleeNode = node.childForFieldName('function');
        if (calleeNode) {
          const calleeName = content.slice(
            calleeNode.startIndex,
            calleeNode.endIndex,
          );
          // Skip built-in methods and property accesses for now
          if (!calleeName.includes('.') && !calleeName.startsWith('console')) {
            relations.push({
              sourceId: funcId,
              targetId: calleeName, // Note: May need resolution to full ID
              type: 'CALLS',
              metadata: { line: node.startPosition.row + 1 },
            });
          }
        }
      }
    });
  }

  /**
   * Extract inheritance relations from a class.
   */
  private extractInheritance(
    classNode: SyntaxNode,
    classId: string,
    filePath: string,
    relations: GraphRelation[],
    content: string,
  ): void {
    // Look for extends clause
    for (const child of classNode.children) {
      if (!child) continue;

      // TypeScript/JavaScript: class_heritage or extends clause
      if (child.type === 'class_heritage' || child.type === 'extends_clause') {
        const typeNode =
          child.childForFieldName('type') || child.namedChildren[0];
        if (typeNode) {
          const superClass = content.slice(
            typeNode.startIndex,
            typeNode.endIndex,
          );
          relations.push({
            sourceId: classId,
            targetId: superClass, // May need resolution
            type: 'EXTENDS',
          });
        }
      }

      // Python: argument_list after class name
      if (child.type === 'argument_list') {
        for (const arg of child.namedChildren) {
          if (arg) {
            const baseName = content.slice(arg.startIndex, arg.endIndex);
            relations.push({
              sourceId: classId,
              targetId: baseName,
              type: 'EXTENDS',
            });
          }
        }
      }
    }
  }

  /**
   * Extract interface extends relations.
   */
  private extractInterfaceExtends(
    interfaceNode: SyntaxNode,
    interfaceId: string,
    filePath: string,
    relations: GraphRelation[],
    content: string,
  ): void {
    for (const child of interfaceNode.children) {
      if (!child) continue;

      if (
        child.type === 'extends_type_clause' ||
        child.type === 'extends_clause'
      ) {
        for (const typeRef of child.namedChildren) {
          if (typeRef) {
            const extendedName = content.slice(
              typeRef.startIndex,
              typeRef.endIndex,
            );
            relations.push({
              sourceId: interfaceId,
              targetId: extendedName,
              type: 'EXTENDS',
            });
          }
        }
      }
    }
  }

  /**
   * Extract implements relations from a class.
   * Handles TypeScript/JavaScript `implements` clauses.
   */
  private extractImplements(
    classNode: SyntaxNode,
    classId: string,
    filePath: string,
    relations: GraphRelation[],
    content: string,
  ): void {
    for (const child of classNode.children) {
      if (!child) continue;

      // TypeScript: implements_clause is inside class_heritage
      if (child.type === 'class_heritage') {
        for (const heritageChild of child.children) {
          if (heritageChild && heritageChild.type === 'implements_clause') {
            this.extractImplementsFromClause(
              heritageChild,
              classId,
              relations,
              content,
            );
          }
        }
      }

      // Direct implements_clause (some parsers might have it directly)
      if (child.type === 'implements_clause') {
        this.extractImplementsFromClause(child, classId, relations, content);
      }
    }
  }

  /**
   * Extract interface names from an implements clause.
   */
  private extractImplementsFromClause(
    clause: SyntaxNode,
    classId: string,
    relations: GraphRelation[],
    content: string,
  ): void {
    for (const typeRef of clause.namedChildren) {
      if (typeRef) {
        // Handle type_identifier or generic types
        let interfaceName: string;
        if (
          typeRef.type === 'type_identifier' ||
          typeRef.type === 'identifier'
        ) {
          interfaceName = content.slice(typeRef.startIndex, typeRef.endIndex);
        } else if (typeRef.type === 'generic_type') {
          // For generic types like Interface<T>, get the base name
          const baseType =
            typeRef.childForFieldName('name') || typeRef.namedChildren[0];
          if (baseType) {
            interfaceName = content.slice(
              baseType.startIndex,
              baseType.endIndex,
            );
          } else {
            continue;
          }
        } else {
          // Fallback: use the full text
          interfaceName = content.slice(typeRef.startIndex, typeRef.endIndex);
        }

        relations.push({
          sourceId: classId,
          targetId: interfaceName,
          type: 'IMPLEMENTS',
        });
      }
    }
  }

  /**
   * Extract methods from a class.
   */
  private extractMethods(
    classNode: SyntaxNode,
    classId: string,
    filePath: string,
    entities: GraphEntity[],
    relations: GraphRelation[],
    content: string,
    chunkId?: string,
  ): void {
    // Find class body
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return;

    for (const child of bodyNode.children) {
      if (!child) continue;

      if (
        child.type === 'method_definition' ||
        child.type === 'function_definition'
      ) {
        const methodEntity = this.parseMethod(
          child,
          classId,
          filePath,
          content,
          chunkId,
        );
        if (methodEntity) {
          entities.push(methodEntity);
          relations.push({
            sourceId: classId,
            targetId: methodEntity.id,
            type: 'CONTAINS',
          });

          // Extract calls within method
          this.extractCalls(child, methodEntity.id, relations, content);
        }
      }
    }
  }

  /**
   * Parse a method definition.
   */
  private parseMethod(
    node: SyntaxNode,
    classId: string,
    filePath: string,
    content: string,
    chunkId?: string,
  ): GraphEntity | null {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const name = content.slice(nameNode.startIndex, nameNode.endIndex);
    // Extract class name from classId
    const className = classId.split('#').pop() || '';

    return {
      id: `${filePath}#${className}.${name}`,
      name: `${className}.${name}`,
      type: 'method',
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: this.extractSignature(node, content),
      chunkId,
    };
  }

  /**
   * Parse an export statement.
   */
  private parseExport(node: SyntaxNode, content: string): string | null {
    // Look for exported declaration
    for (const child of node.children) {
      if (!child) continue;

      // Direct export: export function foo()
      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration'
      ) {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          return content.slice(nameNode.startIndex, nameNode.endIndex);
        }
      }

      // Variable export: export const foo = ...
      if (child.type === 'lexical_declaration') {
        const declarator = child.namedChildren[0];
        if (declarator) {
          const nameNode = declarator.childForFieldName('name');
          if (nameNode) {
            return content.slice(nameNode.startIndex, nameNode.endIndex);
          }
        }
      }

      // Named export: export { foo, bar }
      if (child.type === 'export_clause') {
        // Return first exported name for simplicity
        const firstSpec = child.namedChildren[0];
        if (firstSpec) {
          const nameNode =
            firstSpec.childForFieldName('name') || firstSpec.namedChildren[0];
          if (nameNode) {
            return content.slice(nameNode.startIndex, nameNode.endIndex);
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract function/method signature.
   */
  private extractSignature(node: SyntaxNode, content: string): string {
    // Get the first line as signature
    const nodeContent = content.slice(node.startIndex, node.endIndex);
    const firstLine = nodeContent.split('\n')[0];
    return firstLine.trim();
  }

  /**
   * Get or create parser for a language.
   */
  private async getParser(language: SupportedLanguage): Promise<Parser> {
    let parser = this.parserCache.get(language);
    if (!parser) {
      parser = await createParser(language);
      this.parserCache.set(language, parser);
    }
    return parser;
  }
}
