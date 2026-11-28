/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'acorn';
import { SchemaValidator } from '../utils/schemaValidator.js';
import {
  WORKFLOW_MAX_SCRIPT_BYTES,
  type ParsedWorkflowScript,
  type WorkflowMeta,
  type WorkflowPhaseSeed,
} from './workflow-types.js';

type AstNode = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

const RESERVED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function field<T = unknown>(node: AstNode, key: string): T | undefined {
  return node[key] as T | undefined;
}

export function parseWorkflowScript(
  script: string,
  options: { includeSourceContext?: boolean } = {},
): ParsedWorkflowScript {
  if (Buffer.byteLength(script, 'utf8') > WORKFLOW_MAX_SCRIPT_BYTES) {
    throw new Error(`Script exceeds ${WORKFLOW_MAX_SCRIPT_BYTES} bytes`);
  }

  let program: AstNode;
  try {
    program = parse(script, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (error) {
    if (options.includeSourceContext) {
      throw new Error(formatScriptParseError(error, script), { cause: error });
    }
    throw new Error(
      `Script parse error: ${error instanceof Error ? error.message : String(error)}. Workflow scripts must be plain JavaScript; TypeScript syntax is not supported.`,
    );
  }

  const rawBody = field<unknown>(program, 'body');
  const body = Array.isArray(rawBody) ? rawBody : [];
  const first = body[0] as AstNode | undefined;
  if (!first || !isMetaExport(first)) {
    throw new Error(
      '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    );
  }

  const declaration = field<AstNode>(first, 'declaration');
  if (!declaration) {
    throw new Error('meta declaration is malformed');
  }
  const declarators = field<AstNode[]>(declaration, 'declarations') ?? [];
  const init = declarators[0]
    ? field<AstNode>(declarators[0], 'init')
    : undefined;
  if (!init) {
    throw new Error('meta declaration must initialize an object literal');
  }

  const rawMeta = literalValue(init);
  validateWorkflowStaticSafety(program);
  const meta = validateMeta(rawMeta);
  const bodyStart = first.end ?? 0;
  const scriptBody = script.slice(bodyStart).replace(/^[;\s]*\n/, '').trimStart();
  return { meta, scriptBody };
}

function validateWorkflowStaticSafety(program: AstNode): void {
  walkAst(program, (node) => {
    if (node.type === 'ImportExpression') {
      throw new Error('dynamic import() is unavailable in workflow scripts');
    }
    if (node.type === 'WithStatement') {
      throw new Error('with statements are unavailable in workflow scripts');
    }
    if (
      node.type === 'VariableDeclaration' &&
      String(field<unknown>(node, 'kind')).includes('using')
    ) {
      throw new Error('using declarations are unavailable in workflow scripts');
    }
    if (node.type === 'CallExpression') {
      const callee = unwrapChain(field<AstNode>(node, 'callee'));
      const args = field<unknown[]>(node, 'arguments') ?? [];
      if (isIdentifier(callee, 'Date') && args.length === 0) {
        throw new Error('Date() is unavailable in workflow scripts');
      }
      if (isStaticMember(callee, 'Date', 'now')) {
        throw new Error('Date.now() is unavailable in workflow scripts');
      }
      if (isStaticMember(callee, 'Math', 'random')) {
        throw new Error('Math.random() is unavailable in workflow scripts');
      }
    }
    if (node.type === 'NewExpression') {
      const callee = unwrapChain(field<AstNode>(node, 'callee'));
      const args = field<unknown[]>(node, 'arguments') ?? [];
      if (isIdentifier(callee, 'Date') && args.length === 0) {
        throw new Error('new Date() is unavailable in workflow scripts');
      }
    }
  });
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) walkAst(item, visit);
      }
    } else if (isAstNode(value)) {
      walkAst(value, visit);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string');
}

function unwrapChain(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== 'ChainExpression') return node;
  return field<AstNode>(node, 'expression');
}

function isIdentifier(node: AstNode | undefined, name: string): boolean {
  return node?.type === 'Identifier' && field<string>(node, 'name') === name;
}

function isStaticMember(
  node: AstNode | undefined,
  objectName: string,
  propertyName: string,
): boolean {
  if (node?.type !== 'MemberExpression') return false;
  if (!isIdentifier(unwrapChain(field<AstNode>(node, 'object')), objectName)) {
    return false;
  }
  const property = unwrapChain(field<AstNode>(node, 'property'));
  if (field<boolean>(node, 'computed')) {
    return property?.type === 'Literal' && field<unknown>(property, 'value') === propertyName;
  }
  return isIdentifier(property, propertyName);
}

function isMetaExport(node: AstNode): boolean {
  if (node.type !== 'ExportNamedDeclaration') return false;
  const declaration = field<AstNode>(node, 'declaration');
  if (!declaration || declaration.type !== 'VariableDeclaration') return false;
  if (field<string>(declaration, 'kind') !== 'const') return false;
  const declarators = field<unknown>(declaration, 'declarations');
  if (!Array.isArray(declarators) || declarators.length !== 1) return false;
  const declarator = declarators[0] as AstNode;
  const id = field<AstNode>(declarator, 'id');
  const init = field<AstNode>(declarator, 'init');
  return (
    id?.type === 'Identifier' &&
    field<string>(id, 'name') === 'meta' &&
    init?.type === 'ObjectExpression'
  );
}

function literalValue(node: AstNode): unknown {
  switch (node.type) {
    case 'Literal':
      return field<unknown>(node, 'value');
    case 'ArrayExpression': {
      const elements = field<unknown>(node, 'elements');
      if (!Array.isArray(elements)) return [];
      return elements.map((element) => {
        if (element == null) throw new Error('sparse arrays not allowed in meta');
        const item = element as AstNode;
        if (item.type === 'SpreadElement') {
          throw new Error('spread not allowed in meta');
        }
        return literalValue(item);
      });
    }
    case 'ObjectExpression':
      return objectLiteralValue(node);
    case 'TemplateLiteral': {
      const expressions = field<unknown>(node, 'expressions');
      if (Array.isArray(expressions) && expressions.length > 0) {
        throw new Error('template interpolation not allowed in meta');
      }
      const rawQuasis = field<unknown>(node, 'quasis');
      const quasis = Array.isArray(rawQuasis) ? rawQuasis : [];
      return quasis
        .map((quasi) => {
          const value = field<{ cooked?: unknown }>(quasi as AstNode, 'value');
          return typeof value?.cooked === 'string' ? value.cooked : '';
        })
        .join('');
    }
    case 'UnaryExpression': {
      const argument = field<AstNode>(node, 'argument');
      if (
        field<string>(node, 'operator') === '-' &&
        argument?.type === 'Literal' &&
        typeof field<unknown>(argument, 'value') === 'number'
      ) {
        return -(field<number>(argument, 'value') ?? 0);
      }
      throw new Error('only negative-number unary allowed in meta');
    }
    default:
      throw new Error(`non-literal node type in meta: ${node.type}`);
  }
}

function objectLiteralValue(node: AstNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rawProperties = field<unknown>(node, 'properties');
  const properties = Array.isArray(rawProperties) ? rawProperties : [];
  for (const propertyNode of properties) {
    const property = propertyNode as AstNode;
    if (property.type !== 'Property') {
      throw new Error('only plain properties allowed in meta');
    }
    if (field<boolean>(property, 'computed')) {
      throw new Error('computed keys not allowed in meta');
    }
    if (
      field<boolean>(property, 'method') ||
      field<string>(property, 'kind') !== 'init'
    ) {
      throw new Error('methods/accessors not allowed in meta');
    }
    const keyNode = field<AstNode>(property, 'key');
    const valueNode = field<AstNode>(property, 'value');
    if (!keyNode || !valueNode) {
      throw new Error('malformed property in meta');
    }
    const key = propertyKey(keyNode);
    out[key] = literalValue(valueNode);
  }
  return out;
}

function propertyKey(key: AstNode): string {
  let name: string;
  if (key.type === 'Identifier') name = String(field<unknown>(key, 'name'));
  else if (key.type === 'Literal') name = String(field<unknown>(key, 'value'));
  else throw new Error(`unsupported key type in meta: ${key.type}`);
  if (RESERVED_META_KEYS.has(name)) {
    throw new Error(`reserved key name not allowed in meta: ${name}`);
  }
  return name;
}

function validateMeta(raw: unknown): WorkflowMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('meta must be an object literal');
  }
  const record = raw as Record<string, unknown>;
  const name = record['name'];
  const description = record['description'];
  const title = record['title'];
  const whenToUse = record['whenToUse'];
  const inputSchema = record['inputSchema'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('meta.name must be a non-empty string');
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('meta.description must be a non-empty string');
  }

  const meta: WorkflowMeta = {
    name,
    description,
  };
  if (typeof title === 'string' && title.length > 0) {
    meta.title = title;
  }
  if (typeof whenToUse === 'string') {
    meta.whenToUse = whenToUse;
  }
  const phases = parsePhases(record['phases']);
  if (phases) meta.phases = phases;
  if (inputSchema !== undefined) {
    if (!isPlainObject(inputSchema)) {
      throw new Error('meta.inputSchema must be an object literal');
    }
    const schemaError = SchemaValidator.validateSchema(inputSchema);
    if (schemaError) {
      throw new Error(`meta.inputSchema is invalid: ${schemaError}`);
    }
    meta.inputSchema = inputSchema;
  }
  return meta;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parsePhases(value: unknown): WorkflowPhaseSeed[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: WorkflowPhaseSeed[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = record['title'];
    const detail = record['detail'];
    const model = record['model'];
    if (typeof title !== 'string') continue;
    phases.push({
      title,
      ...(typeof detail === 'string' ? { detail } : {}),
      ...(typeof model === 'string' ? { model } : {}),
    });
  }
  return phases.length > 0 ? phases : undefined;
}

/** Preserve the parser's original line/column and the native 80-column excerpt. */
function formatScriptParseError(error: unknown, script: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const hint = 'Workflow scripts must be plain JavaScript — common causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping.';
  const loc = error && typeof error === 'object' && 'loc' in error
    ? error.loc as { line?: number; column?: number } : undefined;
  const line = typeof loc?.line === 'number' ? script.split('\n')[loc.line - 1] : undefined;
  if (line === undefined || typeof loc?.column !== 'number') {
    return `Script parse error: ${message}. ${hint}`;
  }
  const column = Math.max(0, Math.min(loc.column, line.length));
  const start = Math.max(0, Math.min(column - 40, line.length - 80));
  return `Script parse error: ${message}\n\n${line.slice(start, start + 80)}\n${' '.repeat(column - start)}^\n\n${hint}`;
}
